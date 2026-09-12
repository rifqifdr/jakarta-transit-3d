/**
 * Measures the render path on the real GPU (JAKAR-58).
 *
 * Every frame-rate number this project has ever produced came from
 * `probe.mjs`, which runs headless Chrome on `--use-gl=swiftshader`. That is
 * deliberate there — the probe exists to click things, and a software
 * rasteriser is the cheapest way to have something to click. It is also why
 * none of its timings mean anything.
 *
 * This one is the opposite trade: a real windowed Chrome on the machine's own
 * GPU, with vsync off so a frame interval is the frame's actual cost rather
 * than 16.7 ms of waiting. Nothing here is clicked; the app is driven through
 * `window.__tj` and measured.
 *
 *   node scratchpad/gpu-bench.mjs                  # against the preview build
 *   BENCH_URL=http://localhost:5173/ node ...      # against the dev server
 *
 * Scenarios are A/B patches applied to the live layer between runs, so the
 * fleet, the clock and the tiles are identical across them and only the thing
 * under test moves.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const URL_UNDER_TEST = process.env.BENCH_URL || 'http://localhost:4173/',
    CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    PORT = 9500 + Math.floor(Math.random() * 300),
    WIDTH = 1440,
    HEIGHT = 900,
    // Long enough that a slow frame is a tail rather than the average, short
    // enough that the whole matrix runs while the tiles stay warm.
    SAMPLE_MS = Number(process.env.BENCH_SAMPLE || 5000),
    WARMUP_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Headed, and on whatever GL the machine actually has. `--disable-gpu-vsync`
// plus `--disable-frame-rate-limit` is the whole point: with the presentation
// clock removed, requestAnimationFrame runs as fast as the frame costs, so the
// interval between callbacks becomes the measurement instead of a constant.
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gpubench-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Vsync off is what makes a frame interval a measurement rather than a
    // constant 8.33 ms of waiting — but it also decouples rAF from
    // presentation, so the CPU can run ahead of a GPU that is falling behind.
    // BENCH_VSYNC=1 keeps the presentation clock, which is the arm that says
    // what a person actually sees.
    ...(process.env.BENCH_VSYNC ? [] : [
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit'
    ]),
    '--hide-crash-restore-bubble',
    `--window-size=${WIDTH},${HEIGHT}`,
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
            // Still starting; the endpoint refuses connections until it listens.
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

const consoleErrors = [];

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);

    if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails.exception?.description ||
            message.params.exceptionDetails.text);
    }
});

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

// --------------------------------------------------------- page-side probes
//
// Installed into the running app rather than compiled in: the thing being
// measured has to be the shipped bundle, unmodified, or the number is about
// some other program.
//
// Four arms, applied to the live layer so the fleet, the clock and the tiles
// are identical across them:
//
//   full      as shipped
//   nofleet   the custom layer returns without drawing — Mapbox Standard alone
//   nodraw    the per-instance matrix loop runs, the GL draw does not
//   noupload  `addUpdateRange` suppressed, so three re-sends the whole
//             instance buffer every frame instead of the written prefix
const INSTALL = `
window.__benchInstall = () => {
    if (window.__bench) {
        return 'already installed';
    }

    const app = window.__tj,
        layer = app.vehicleLayer,
        fleet = app.fleet,
        gl = layer.renderer.getContext(),
        // The one honest way to attribute GPU time to this layer rather than
        // to the basemap. Absent on some drivers, in which case the nofleet
        // arm is what separates them.
        ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'),
        debugInfo = gl.getExtension('WEBGL_debug_renderer_info'),
        origRender = layer.render.bind(layer),
        origThree = layer.renderer.render.bind(layer.renderer),
        origUpdate = fleet.update.bind(fleet);

    const b = window.__bench = {
        mode: 'full',
        recording: false,
        frame: [], render: [], gpu: [], sim: [],
        queries: [],
        disjoint: 0,
        gpuTimer: !!ext,
        renderer: debugInfo
            ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
        vendor: debugInfo
            ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
            : gl.getParameter(gl.VENDOR),
        webgl2: typeof WebGL2RenderingContext !== 'undefined' &&
            gl instanceof WebGL2RenderingContext
    };

    layer.render = function (context, matrix) {
        if (b.mode === 'nofleet') {
            // Still ask for the next frame, or the map goes idle and the
            // comparison is against a still image rather than against Mapbox
            // drawing continuously.
            app.map.triggerRepaint();
            return;
        }

        const t0 = performance.now();
        let query = null;

        if (b.recording && ext && b.queries.length < 90) {
            query = gl.createQuery();
            gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        }
        origRender(context, matrix);
        if (query) {
            gl.endQuery(ext.TIME_ELAPSED_EXT);
            b.queries.push(query);
        }
        if (b.recording) {
            b.render.push(performance.now() - t0);
        }
    };

    layer.renderer.render = function (scene, camera) {
        if (b.mode === 'nodraw') {
            return;
        }
        return origThree(scene, camera);
    };

    fleet.update = function (now, day) {
        const t0 = performance.now(),
            out = origUpdate(now, day);

        if (b.recording) {
            b.sim.push(performance.now() - t0);
        }
        return out;
    };

    // The geometry JAKAR-49 replaced, rebuilt to the same bounding box so the
    // only variable is triangle count: 12 against 360-792. Pricing that trade
    // is the reason this ticket exists, and reasoning about it from the
    // triangle count alone is what it exists to stop.
    //
    // Built by hand rather than with BoxGeometry because three is not in
    // scope here — only the constructors reachable through the live meshes.
    const Geometry = layer.meshes[0].geometry.constructor,
        Attribute = layer.meshes[0].geometry.attributes.position.constructor;

    const boxGeometry = source => {
        source.computeBoundingBox();

        const {min, max} = source.boundingBox,
            corner = (i, j, k) => [i ? max.x : min.x, j ? max.y : min.y, k ? max.z : min.z],
            faces = [
                // Each face as four corners, wound so the outward normal is
                // the one given beside it.
                [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [0, 0, 1]],
                [[[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], [0, 0, -1]],
                [[[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], [1, 0, 0]],
                [[[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], [-1, 0, 0]],
                [[[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], [0, 1, 0]],
                [[[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [0, -1, 0]]
            ],
            position = [],
            normal = [],
            color = [];

        for (const [quad, n] of faces) {
            for (const t of [[0, 1, 2], [0, 2, 3]]) {
                for (const index of t) {
                    position.push(...corner(...quad[index]));
                    normal.push(...n);
                    color.push(1, 1, 1);
                }
            }
        }

        const geometry = new Geometry();

        geometry.setAttribute('position', new Attribute(new Float32Array(position), 3));
        geometry.setAttribute('normal', new Attribute(new Float32Array(normal), 3));
        // The material is \`vertexColors: true\` for the window band, so a
        // replacement geometry without a colour attribute would draw black.
        geometry.setAttribute('color', new Attribute(new Float32Array(color), 3));

        return geometry;
    };

    const kapsul = layer.meshes.map(m => m.geometry),
        boxes = layer.meshes.map(m => boxGeometry(m.geometry));

    b.setGeometry = which => {
        const source = which === 'box' ? boxes : kapsul;

        layer.meshes.forEach((mesh, i) => {
            mesh.geometry = source[i];
        });
    };

    // The crowd (JAKAR-79) is switched at its own flag rather than in the
    // render patch above, because the simulation runs in the frame loop and
    // the drawing is only the second half of it — turning it off here measures
    // both, which is what the ticket asks about.
    b.setWalkers = on => {
        app.walkersOn = on;
        if (!on) {
            app.walkers.clear();
        }
    };

    for (const mesh of layer.meshes) {
        const attribute = mesh.instanceMatrix,
            add = attribute.addUpdateRange.bind(attribute);

        // Suppressing the call leaves \`updateRanges\` empty, and three then
        // bufferSubData's the entire array — which is the arm the ticket asks
        // for: is uploading a 12,000-instance buffer instead of the ~6,150
        // written prefix material at all?
        attribute.addUpdateRange = (start, count) => {
            if (b.mode !== 'noupload') {
                add(start, count);
            }
        };
    }

    b.start = () => {
        b.frame.length = 0;
        b.render.length = 0;
        b.gpu.length = 0;
        b.sim.length = 0;
        for (const q of b.queries) {
            gl.deleteQuery(q);
        }
        b.queries.length = 0;
        b.disjoint = 0;
        b.recording = true;

        let last = 0;
        const tick = t => {
            if (last) {
                b.frame.push(t - last);
            }
            last = t;

            // Results land a frame or three after the draw, so they are
            // drained here rather than waited on — waiting would stall the
            // pipeline and measure the stall.
            while (b.queries.length) {
                const q = b.queries[0];

                if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
                    break;
                }
                b.queries.shift();
                if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
                    b.disjoint++;
                } else {
                    b.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
                }
                gl.deleteQuery(q);
            }
            if (b.recording) {
                requestAnimationFrame(tick);
            }
        };

        requestAnimationFrame(tick);
    };

    b.stop = () => {
        b.recording = false;
    };

    const pct = (xs, p) => {
        if (!xs.length) {
            return null;
        }
        const sorted = [...xs].sort((a, c) => a - c);

        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };

    b.summary = () => ({
        samples: b.frame.length,
        fleet: fleet.activeCount,
        walkers: app.walkers ? app.walkers.count : 0,
        zoom: Number(app.map.getZoom().toFixed(2)),
        frame: {
            p50: pct(b.frame, 0.5), p90: pct(b.frame, 0.9), p99: pct(b.frame, 0.99),
            max: b.frame.length ? Math.max(...b.frame) : null,
            fps: b.frame.length ? 1000 / (b.frame.reduce((a, c) => a + c, 0) / b.frame.length) : null
        },
        render: {p50: pct(b.render, 0.5), p90: pct(b.render, 0.9), p99: pct(b.render, 0.99)},
        gpu: {n: b.gpu.length, p50: pct(b.gpu, 0.5), p90: pct(b.gpu, 0.9), p99: pct(b.gpu, 0.99)},
        sim: {p50: pct(b.sim, 0.5), p90: pct(b.sim, 0.9)},
        disjoint: b.disjoint
    });

    return 'installed';
};
`;

await evaluate(INSTALL + '\nreturn window.__benchInstall();');

const environment = await evaluate(`
    const b = window.__bench, app = window.__tj;
    return {
        renderer: b.renderer, vendor: b.vendor, webgl2: b.webgl2, gpuTimer: b.gpuTimer,
        dpr: window.devicePixelRatio,
        canvas: [app.map.getCanvas().width, app.map.getCanvas().height],
        triangles: Object.fromEntries(app.vehicleLayer.meshes.map((m, i) => [
            ['bus', 'commuter_rail', 'metro', 'light_rail'][i],
            m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3
        ]))
    };
`);

// The evening peak, on a weekday. Speed 1 so the fleet's generation does not
// churn mid-sample: a regenerated active list rewrites the colour buffer and
// the mode tables, which is a real cost but not the one being measured here.
await evaluate(`
    const app = window.__tj;
    app.clock.setSpeed(1);
    app.clock.setTimeOffset(17.5 * 3600);
    return true;
`);

// Standard draws extruded buildings, and at street level they are most of
// what is on screen. BENCH_NO3D turns them off — the app already exposes the
// same switch as "Gedung 3D" — so the street-level cost can be attributed to
// the basemap's geometry rather than guessed at.
if (process.env.BENCH_NO3D) {
    await evaluate(`
        window.__tj.map.setConfigProperty('basemap', 'show3dObjects', false);
        return true;
    `);
}

async function settle(timeout = 25000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (await evaluate('return window.__tj.map.areTilesLoaded();')) {
            return true;
        }
        await sleep(300);
    }
    return false;
}

async function view(camera) {
    await evaluate(`
        window.__tj.map.jumpTo(${JSON.stringify(camera)});
        return true;
    `);
    await sleep(500);
    return settle();
}

// A crude stand-in for a slower machine. Chrome can throttle the CPU but not
// the GPU, so this only answers half the question — it says whether the
// simulation and the per-instance loop start to bind before the draw does,
// which is the half that decides whether the fleet size is the problem or the
// geometry is.
if (process.env.BENCH_THROTTLE) {
    await send('Emulation.setCPUThrottlingRate', {rate: Number(process.env.BENCH_THROTTLE)});
}

async function scenario(label, mode) {
    // Neither `box` nor `nowalkers` is a render mode: both are the shipped
    // path with one thing swapped, so the layer runs `full` and only the
    // meshes or the crowd change.
    await evaluate(`
        window.__bench.setGeometry(${JSON.stringify(mode === 'box' ? 'box' : 'kapsul')});
        window.__bench.setWalkers(${mode !== 'nowalkers'});
        window.__bench.mode = ${JSON.stringify(
        mode === 'box' || mode === 'nowalkers' ? 'full' : mode
    )};
        return true;
    `);
    await sleep(WARMUP_MS);
    await evaluate('window.__bench.start(); return true;');
    await sleep(SAMPLE_MS);
    await evaluate('window.__bench.stop(); return true;');

    const summary = await evaluate('return window.__bench.summary();');

    // A sample can come back empty — the window losing focus is enough for
    // Chrome to stop scheduling frames — and an arm reporting nothing is worth
    // saying rather than crashing the matrix eight arms from the end.
    const p50 = summary.frame.p50 === null ? null : summary.frame.p50.toFixed(2);

    process.stderr.write(`  ${label.padEnd(28)} ${
        p50 === null ? 'no frames recorded' : `${p50} ms p50, ${
            summary.frame.fps.toFixed(0)} fps`}, fleet ${summary.fleet}, walkers ${
        summary.walkers}\n`);
    return {label, mode, ...summary};
}

// Three views, because the cost moves for different reasons at each. Wide is
// the whole network on screen at 11x inflation; street is a handful of
// vehicles at true size over Standard's 3D buildings, which is where the
// basemap is most expensive and the fleet least.
const VIEWS = [
    {
        id: 'wide',
        label: 'city-wide (z10.5)',
        camera: {center: [106.8272, -6.2], zoom: 10.5, pitch: 55, bearing: 0}
    },
    {
        id: 'default',
        label: 'default view (z12.4)',
        camera: {center: [106.8272, -6.1754], zoom: 12.4, pitch: 55, bearing: 0}
    },
    {
        id: 'street',
        label: 'street level (z16.8)',
        camera: {center: [106.8230, -6.2010], zoom: 16.8, pitch: 65, bearing: 20}
    },
    // The crowd's own view. Street level as this project benchmarks it is
    // z16.8, and the walkers do not exist there at all — a person is 2.5 px
    // tall, so their band starts at z17.2. Tanah Abang because it is the
    // densest interchange measured, 24 km of eligible street in view, which
    // is where the cap of 800 is actually reached.
    {
        id: 'crowd',
        label: 'crowd (z18.4, Tanah Abang)',
        camera: {center: [106.8112, -6.1858], zoom: 18.4, pitch: 65, bearing: 20}
    }
];

const results = [];

// BENCH_VIEWS=crowd,street runs a subset. The matrix is four views by six
// arms at five seconds each, and a question about one of them should not cost
// two minutes of the other three.
const only = (process.env.BENCH_VIEWS || '').split(',').filter(Boolean);

for (const v of VIEWS.filter(v => !only.length || only.includes(v.id))) {
    process.stderr.write(`\n${v.label}\n`);
    await view(v.camera);

    for (const [label, mode] of [
        ['full (Kapsul, as shipped)', 'full'],
        ['box geometry (pre-JAKAR-49)', 'box'],
        ['no fleet (basemap only)', 'nofleet'],
        ['no draw (CPU loop only)', 'nodraw'],
        ['full-buffer upload', 'noupload'],
        // Only means anything in the crowd view, and it is run everywhere
        // anyway: a walker arm that measures the same as `full` at z12 is the
        // evidence that the zoom band really does cost nothing below it.
        ['no crowd (JAKAR-79 off)', 'nowalkers']
    ]) {
        results.push({view: v.id, ...await scenario(label, mode)});
    }
}

await evaluate('window.__bench.setGeometry("kapsul"); window.__bench.mode = "full"; return true;');

const report = {
    when: new Date().toISOString(),
    url: URL_UNDER_TEST,
    sampleMs: SAMPLE_MS,
    vsync: !!process.env.BENCH_VSYNC,
    cpuThrottle: Number(process.env.BENCH_THROTTLE || 1),
    show3dObjects: !process.env.BENCH_NO3D,
    environment,
    results,
    consoleErrors
};

const out = process.env.BENCH_OUT || 'scratchpad/gpu-bench.json';

writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

socket.close();
chrome.kill();
process.exit(0);
