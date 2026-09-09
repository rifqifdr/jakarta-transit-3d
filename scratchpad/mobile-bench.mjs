/**
 * The half of JAKAR-60 that does not need a phone.
 *
 * JAKAR-58 measured the render path on an M4 at 1440x900, dpr 2, and found the
 * basemap is nearly all of it. JAKAR-60 asks whether that holds on the
 * hardware this map is actually for — mid-range Android — and names three
 * unknowns. Chrome can answer two of them on a laptop:
 *
 *   1. Fill rate. Every previous number came from a 2880x1602 canvas. A phone
 *      is a narrow viewport at dpr 3, which is a different shape of problem:
 *      fewer tiles, more pixels per tile, and the same fragment shaders run
 *      over all of them. `Emulation.setDeviceMetricsOverride` gives a real
 *      canvas of that shape on the real GPU.
 *   2. Whether the levers are enough. `show3dObjects: false` and the
 *      `monochrome` theme are both one call away, and neither has ever been
 *      priced at a phone's aspect and density.
 *
 * The third — an actual mid-range mobile GPU — is not reachable from here and
 * is not pretended at. A tile-based deferred renderer with a shared memory bus
 * fails differently from a desktop GPU, and CPU throttling does not stand in
 * for it. That number comes from `?bench` on a real device; see JAKAR-60.
 *
 *   node scratchpad/mobile-bench.mjs
 *   BENCH_URL=http://localhost:5173/ node scratchpad/mobile-bench.mjs
 *
 * What this shares with `gpu-bench.mjs`, deliberately: vsync off, so a frame
 * interval is the frame's own cost. What it does not share: it never patches
 * the vehicle layer. JAKAR-58 settled that the fleet is not where the time
 * goes, and re-litigating it here would only make the matrix twice as long.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const URL_UNDER_TEST = process.env.BENCH_URL || 'http://localhost:4173/',
    CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    PORT = 9800 + Math.floor(Math.random() * 300),
    SAMPLE_MS = Number(process.env.BENCH_SAMPLE || 4000),
    WARMUP_MS = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'mobilebench-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    // Same reasoning as gpu-bench: with the presentation clock removed the
    // interval between rAF callbacks is the frame's cost rather than a
    // constant. Everything here is comparative, so both arms pay it equally.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
    '--window-size=900,900',
    URL_UNDER_TEST
], {stdio: 'ignore'});

async function target() {
    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(),
                page = list.find(t => t.type === 'page' && t.url.startsWith('http'));

            if (page) {
                return page.webSocketDebuggerUrl;
            }
        } catch {
            // Chrome is still starting.
        }
        await sleep(250);
    }
    throw new Error('Chrome never exposed a page target');
}

const socket = new WebSocket(await target()),
    pending = new Map();
let nextId = 1;

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data),
        waiter = pending.get(message.id);

    if (waiter) {
        pending.delete(message.id);
        waiter(message);
    }
});

await new Promise(resolve => socket.addEventListener('open', resolve));

function send(method, params = {}) {
    const id = nextId++;

    socket.send(JSON.stringify({id, method, params}));
    return new Promise(resolve => pending.set(id, resolve));
}

async function evaluate(expression) {
    const {result} = await send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true
    });

    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return result.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

process.stderr.write('waiting for the app...\n');
for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate('return !!window.__tj;')) {
        break;
    }
    await sleep(500);
}
if (!await evaluate('return !!window.__tj;')) {
    throw new Error('the app never published window.__tj');
}

// ---------------------------------------------------------------- boot
//
// Everything after a reload has to be reinstalled, because a reload is how the
// pixel ratio is changed at all: Mapbox fixes `pixelRatio` at construction and
// 3.30 exposes no setter, so `setDeviceMetricsOverride` alone resizes the CSS
// box and leaves the drawing buffer exactly where it was. The first version of
// this file did that and reported three dpr arms that were all the same 1170 x
// 2532 canvas — three identical measurements presented as a sweep.

async function boot() {
    for (let attempt = 0; attempt < 240; attempt++) {
        if (await evaluate('return !!window.__tj;')) {
            break;
        }
        await sleep(500);
    }
    if (!await evaluate('return !!window.__tj;')) {
        throw new Error('the app never published window.__tj');
    }

    // A frame-interval recorder, and nothing else. The vehicle layer is never
    // patched here: JAKAR-58 settled that the fleet is not where the time
    // goes, and re-testing it would double the matrix to re-confirm a result.
    await evaluate(`
        window.__mb = {frame: [], recording: false};
        window.__mb.start = () => {
            const b = window.__mb;
            b.frame.length = 0;
            b.recording = true;
            let last = 0;
            const tick = t => {
                if (last) { b.frame.push(t - last); }
                last = t;
                if (b.recording) { requestAnimationFrame(tick); }
            };
            requestAnimationFrame(tick);
        };
        window.__mb.stop = () => { window.__mb.recording = false; };
        window.__mb.summary = () => {
            const xs = [...window.__mb.frame].sort((a, c) => a - c),
                pct = p => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null,
                mean = xs.reduce((a, c) => a + c, 0) / (xs.length || 1);
            return {
                samples: xs.length,
                p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
                meanFps: xs.length ? 1000 / mean : null,
                fleet: window.__tj.fleet.activeCount,
                canvas: [window.__tj.map.getCanvas().width, window.__tj.map.getCanvas().height],
                dpr: window.devicePixelRatio
            };
        };
        return true;
    `);

    // The evening peak, speed 1, exactly as JAKAR-58 measured it — so these
    // numbers sit beside those rather than starting a second, incompatible
    // series.
    await evaluate(`
        window.__tj.clock.setSpeed(1);
        window.__tj.clock.setTimeOffset(17.5 * 3600);
        return true;
    `);
}

await boot();

const environment = await evaluate(`
    const gl = window.__tj.vehicleLayer.renderer.getContext(),
        info = gl.getExtension('WEBGL_debug_renderer_info');
    return {
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
    };
`);

async function settle(timeout = 25000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (await evaluate('return window.__tj.map.areTilesLoaded();')) {
            // `areTilesLoaded` goes true the moment the last tile arrives, not
            // when the style has finished re-evaluating it. Changing a config
            // property re-parses every loaded tile, and measuring across that
            // is what made turning 3D *off* look more expensive than leaving
            // it on. Confirm it twice, a beat apart.
            await sleep(700);
            if (await evaluate('return window.__tj.map.areTilesLoaded();')) {
                return true;
            }
        }
        await sleep(300);
    }
    return false;
}

/** A phone-shaped viewport at a real pixel density, via a reload. */
async function device(scale) {
    await send('Emulation.setDeviceMetricsOverride', {
        width: PHONE[0], height: PHONE[1], deviceScaleFactor: scale, mobile: true
    });
    await send('Page.reload');
    await sleep(1500);
    await boot();
    await settle();
}

async function config({show3d, theme}) {
    await evaluate(`
        const map = window.__tj.map;
        map.setConfigProperty('basemap', 'show3dObjects', ${show3d});
        map.setConfigProperty('basemap', 'theme', ${JSON.stringify(theme)});
        return true;
    `);
    await sleep(500);
    return settle(15000);
}

async function view(camera) {
    await evaluate(`window.__tj.map.jumpTo(${JSON.stringify(camera)}); return true;`);
    await sleep(500);
    return settle();
}

/**
 * Throttles, samples, unthrottles.
 *
 * The throttle is applied around the measurement rather than held across the
 * whole run, and that is not a shortcut — it is the difference between
 * measuring a frame and measuring a page load. Held across a reload it made
 * booting the app and fetching tiles four times slower too, so round 1 sampled
 * a map still assembling itself: a +/-85 ms spread across three repeats of one
 * arm, and one arm that returned no frames at all because the app had not
 * finished booting when the recorder started. Steady-state render cost is the
 * question; load time is a different ticket.
 */
async function measure(throttle) {
    await send('Emulation.setCPUThrottlingRate', {rate: throttle});
    await sleep(WARMUP_MS);
    await evaluate('window.__mb.start(); return true;');
    await sleep(SAMPLE_MS);
    await evaluate('window.__mb.stop(); return true;');

    const summary = await evaluate('return window.__mb.summary();');

    await send('Emulation.setCPUThrottlingRate', {rate: 1});

    // A silent zero here would sail through the median and print as a number.
    if (!summary || !summary.samples) {
        throw new Error('no frames recorded — the app was not ready when sampling started');
    }
    return summary;
}

const VIEWS = {
    street: {center: [106.8230, -6.2010], zoom: 16.8, pitch: 65, bearing: 20},
    default: {center: [106.8272, -6.1754], zoom: 12.4, pitch: 55, bearing: 0}
};

// 390 x 844 CSS pixels is the common mid-range Android viewport; dpr 3 is what
// most of them report. dpr 2 is what capping would give, dpr 1 the floor.
const PHONE = [390, 844],
    ROUNDS = Number(process.env.BENCH_ROUNDS || 3),
    // BENCH_ONLY=B runs one pass. The lever pass is the noisy one — it
    // changes a config property between arms, which re-parses every loaded
    // tile — so it is the one worth re-running at more rounds on its own.
    ONLY = process.env.BENCH_ONLY || '';

const results = [];
const median = xs => [...xs].sort((a, c) => a - c)[Math.floor(xs.length / 2)];

/**
 * One arm, measured `ROUNDS` times in round-robin with its siblings rather
 * than back to back. Consecutive repeats share whatever the machine was doing
 * at that moment; interleaved ones spread it across every arm instead, so a
 * thermal ramp or a background task shifts them all rather than whichever
 * happened to run during it.
 */
async function sweep(group, arms, {scale, throttle, viewId}) {
    const runs = new Map(arms.map(a => [a.label, []]));

    for (let round = 0; round < ROUNDS; round++) {
        for (const arm of arms) {
            await config(arm);
            await view(VIEWS[viewId]);
            runs.get(arm.label).push(await measure(throttle));
        }
    }

    for (const arm of arms) {
        const rs = runs.get(arm.label),
            p50 = median(rs.map(r => r.p50)),
            fps = median(rs.map(r => r.meanFps)),
            p99 = median(rs.map(r => r.p99)),
            spread = Math.max(...rs.map(r => r.p50)) - Math.min(...rs.map(r => r.p50));

        process.stderr.write(`  ${arm.label.padEnd(34)} ${p50.toFixed(1)} ms p50  ${
            fps.toFixed(0)} fps  p99 ${p99.toFixed(0)} ms  ±${spread.toFixed(1)}  ${
            rs[0].canvas.join('x')}\n`);

        results.push({
            group, viewId, scale, throttle, ...arm,
            p50, meanFps: fps, p99, spreadMs: spread,
            canvas: rs[0].canvas, fleet: rs[0].fleet, rounds: rs.length
        });
    }
}

const SHIPPED = {label: 'shipped (3D, default theme)', show3d: true, theme: 'default'},
    FLAT = {label: 'Gedung 3D off', show3d: false, theme: 'default'},
    MONO = {label: 'monochrome theme', show3d: true, theme: 'monochrome'},
    BOTH = {label: 'both levers', show3d: false, theme: 'monochrome'};

// --- Pass A: is fill rate the problem? -------------------------------------
// Street level, shipped config, 4x CPU throttle, and only the pixel count
// moving. Each dpr needs its own reload, which is the whole reason for boot().
if (!ONLY || ONLY === 'A') {
process.stderr.write('\nA. fill rate — street, shipped, 4x CPU, dpr sweep\n');
for (const scale of [3, 2, 1]) {
    await device(scale);
    await sweep('fill-rate', [{...SHIPPED, label: `dpr ${scale}`}],
        {scale, throttle: 4, viewId: 'street'});
}

// --- Pass B: are the levers enough? ----------------------------------------
}

if (!ONLY || ONLY === 'B') {
}

process.stderr.write('\nB. levers — street, dpr 3, 4x CPU\n');
await device(3);
await sweep('levers', [SHIPPED, FLAT, MONO, BOTH], {scale: 3, throttle: 4, viewId: 'street'});

// --- Pass C: and at the view people actually open on? ----------------------
if (!ONLY || ONLY === 'C') {
}

process.stderr.write('\nC. default view — dpr 3, 4x CPU\n');
await sweep('default-view', [SHIPPED, BOTH], {scale: 3, throttle: 4, viewId: 'default'});

// --- Pass D: unthrottled, for the ratio against JAKAR-58 -------------------
if (!ONLY || ONLY === 'D') {
}

process.stderr.write('\nD. street, dpr 3, no CPU throttle\n');
await sweep('unthrottled', [SHIPPED, BOTH], {scale: 3, throttle: 1, viewId: 'street'});

await send('Emulation.clearDeviceMetricsOverride');

const report = {
    when: new Date().toISOString(),
    url: URL_UNDER_TEST,
    sampleMs: SAMPLE_MS,
    rounds: ROUNDS,
    note: 'Emulated phone metrics on a desktop GPU. The canvas shape, the pixel count and the ' +
        'lever costs are real; the GPU is not a phone GPU and no number here stands in for one.',
    environment,
    results
};

writeFileSync(process.env.BENCH_OUT || 'scratchpad/mobile-bench.json',
    JSON.stringify(report, null, 2));

socket.close();
chrome.kill();
process.exit(0);
