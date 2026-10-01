/**
 * Runs `?bench` in a real Chrome on this machine's GPU and saves the report.
 *
 * The device benchmark is meant for a phone, but it has to work before a
 * phone is handed it, and a laptop number is still a number. Unlike
 * `gpu-bench.mjs` this leaves vsync **on** and patches nothing: it runs the
 * shipped bundle exactly as a visitor would, so its rows mean what a phone's
 * rows mean — "kept up", not "cost this much".
 *
 *   node scratchpad/bench-local.mjs                     # ?bench=motion, 1440x900
 *   BENCH=static node scratchpad/bench-local.mjs        # or static, or all
 *   PHONE=1 node scratchpad/bench-local.mjs             # 390x844 at dpr 3
 *   BENCH_URL=http://localhost:5173/ node ...           # against the dev server
 *   BENCH_OUT=scratchpad/device-bench/x.json node ...   # where the report goes
 *   BENCH_SHOTS=/some/dir node ...                      # a screenshot per arm
 *
 * BENCH_SHOTS is for checking that an arm does what its name says — that
 * Navigasi really is following something, that the tour really flies. A
 * screenshot forces a readback mid-sample, so a run that takes them is not a
 * run whose numbers mean anything.
 *
 * PHONE=1 is a phone's viewport and density on a laptop GPU — fill rate, not a
 * phone. See the header of `mobile-bench.mjs` for what that can and cannot say.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const BASE = process.env.BENCH_URL || 'http://localhost:4173/',
    ARMS = process.env.BENCH || 'motion',
    PHONE = !!process.env.PHONE,
    OUT = process.env.BENCH_OUT || 'scratchpad/bench-local.json',
    SHOTS = process.env.BENCH_SHOTS || '',
    CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    PORT = 9200 + Math.floor(Math.random() * 300);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'benchlocal-'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--window-size=1440,900',
    'about:blank'
], {stdio: 'ignore'});

async function target() {
    for (let attempt = 0; attempt < 120; attempt++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(),
                page = list.find(t => t.type === 'page');

            if (page) {
                return page.webSocketDebuggerUrl;
            }
        } catch {
            // Still starting.
        }
        await sleep(250);
    }
    throw new Error('Chrome never exposed a page target');
}

const socket = new WebSocket(await target()),
    pending = new Map(),
    errors = [];
let nextId = 1;

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data),
        waiter = pending.get(message.id);

    if (waiter) {
        pending.delete(message.id);
        waiter(message);
    }
    if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails.exception?.description ||
            message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        errors.push(message.params.args.map(a => a.value ?? a.description).join(' '));
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
        expression,
        returnByValue: true
    });

    return result.result?.value;
}

await send('Runtime.enable');
await send('Page.enable');

if (PHONE) {
    await send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 3, mobile: true
    });
}

const url = `${BASE}${BASE.includes('?') ? '&' : '?'}bench${ARMS === 'all' ? '' : `=${ARMS}`}`;

process.stderr.write(`${url}\n`);
await send('Page.navigate', {url});

// A full run is a few minutes; a stuck one should not hang the shell forever.
const deadline = Date.now() + 10 * 60 * 1000;
let report = null,
    lastStatus = '',
    shot = 0;

while (!report && Date.now() < deadline) {
    await sleep(2000);
    report = await evaluate('window.__benchResult || null');

    const status = await evaluate(
        "document.querySelector('#bench-panel .status')?.textContent || ''");

    if (status && status !== lastStatus) {
        lastStatus = status;
        process.stderr.write(`  ${status}\n`);
        if (SHOTS && status.endsWith('…')) {
            // Far enough in to be past settling and into the move.
            await sleep(2500);
            const {result} = await send('Page.captureScreenshot', {format: 'jpeg', quality: 70}),
                name = status.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

            mkdirSync(SHOTS, {recursive: true});
            writeFileSync(join(SHOTS, `${String(++shot).padStart(2, '0')}-${name}.jpg`),
                Buffer.from(result.data, 'base64'));
        }
    }
}

chrome.kill();

if (!report) {
    console.error('no report within ten minutes', errors);
    process.exit(1);
}

report.harness = {script: 'scratchpad/bench-local.mjs', phone: PHONE, url};
if (errors.length) {
    report.harness.errors = errors;
}
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

console.log(`${report.env.renderer} · budget ${report.env.frameBudgetMs} ms · ` +
    `${report.env.canvas.join('x')}`);
console.table(report.results.map(r => ({
    view: r.view, arm: r.arm, fps: r.interrupted ? 'interrupted' : r.fps, 'drop%': r.droppedPct, long: r.long,
    p50: r.p50, p99: r.p99, max: r.max, tiles: r.tiles,
    moved: `${r.moved.km} km ${r.moved.zoom}z ${r.moved.bearing}°`,
    loaf: r.loaf ? `${r.loaf.count} / ${r.loaf.blockingMs} ms` : '—'
})));
if (errors.length) {
    console.error('page errors:', errors);
}
console.log(`saved ${OUT}`);
