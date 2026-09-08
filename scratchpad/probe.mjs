/**
 * Drives the real app in a real Chrome, over the DevTools protocol.
 *
 * Rebuilt from the description in CLAUDE.md; the original lived in a scratchpad
 * that did not survive. It exists because of trap 2: `element.click()`
 * synthesises an event and skips the press/release pairing, so it passes on
 * buttons that a person cannot actually operate. `Input.dispatchMouseEvent`
 * sends the real thing.
 *
 *   node scratchpad/probe.mjs                     # run PROBE_JS
 *   PROBE_JS='...' node scratchpad/probe.mjs      # evaluate an expression
 *
 * A step of the form {_click: [x, y]} in the returned array is dispatched as a
 * genuine mouse press and release at those viewport coordinates; PROBE_JS2 is
 * then evaluated afterwards, so a check can straddle a real interaction.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const URL_UNDER_TEST = process.env.PROBE_URL || 'http://localhost:5173/',
    CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    PORT = 9222 + Math.floor(Math.random() * 300),
    WIDTH = 1440,
    HEIGHT = 900;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'probe-'))}`,
    '--headless=new',
    '--no-first-run',
    '--disable-gpu',
    `--window-size=${WIDTH},${HEIGHT}`,
    // The fleet is a WebGL layer; without a rasteriser there is nothing to
    // click on. This is also why every frame-rate number from this harness is
    // meaningless — see "GPU performance is unmeasured" in CLAUDE.md.
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    URL_UNDER_TEST
], {stdio: 'ignore'});

async function target() {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(),
                page = list.find(t => t.type === 'page' && t.url.startsWith('http'));

            if (page) {
                return page.webSocketDebuggerUrl;
            }
        } catch {
            // Chrome is still starting; the endpoint refuses connections until
            // it is listening.
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

async function click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
            type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0
        });
        await sleep(60);
    }
}

await send('Runtime.enable');
await send('Page.enable');

// Collect console errors: a thrown exception inside the frame loop is exactly
// how trap 8 presented — the clock froze and the fleet stopped, with nothing
// shown on screen.
const consoleErrors = [];

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);

    if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails.exception?.description ||
            message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map(a => a.value ?? a.description).join(' '));
    }
});

// The app is ready when it publishes itself for exactly this purpose.
for (let attempt = 0; attempt < 160; attempt++) {
    if (await evaluate('return !!window.__tj')) {
        break;
    }
    await sleep(500);
}

// `window.__tj` is not the same thing as "clickable". The loader fades out
// over 0.6s and `visibility` only flips at the end of that, so for the first
// half second after boot it still sits over the whole viewport and swallows
// every click. Waiting on the element rather than on a fixed delay, because the
// thing that matters is whether a click can land.
for (let attempt = 0; attempt < 40; attempt++) {
    const blocked = await evaluate(
        'return getComputedStyle(document.getElementById("loader")).visibility !== "hidden";'
    );

    if (!blocked) {
        break;
    }
    await sleep(200);
}

const script = process.env.PROBE_JS || 'return {ok: !!window.__tj};',
    steps = await evaluate(script),
    output = [];

// A step list rather than a single script, because a useful check usually has
// to straddle several real interactions — turn a layer on, let it load, aim at
// something, click it — and only real clicks prove anything (trap 2).
//
//   {_click: [x, y]}  a genuine press and release at those viewport coordinates
//   {_wait: ms}       let the app settle; the map needs frames, not promises
//   {_eval: 'expr'}   evaluate between interactions, and keep the result
//
// `_eval` may itself return further steps, which is how a click can be aimed
// at something whose position is only known once the previous step has run.
async function run(step) {
    if (step && step._click) {
        await click(step._click[0], step._click[1]);
        output.push({clicked: step._click});
    } else if (step && step._wait !== undefined) {
        await sleep(step._wait);
    } else if (step && step._shot) {
        const {result} = await send('Page.captureScreenshot', {format: 'png'});

        writeFileSync(step._shot, Buffer.from(result.data, 'base64'));
        output.push({screenshot: step._shot});
    } else if (step && step._eval) {
        const value = await evaluate(step._eval);

        if (Array.isArray(value)) {
            for (const inner of value) {
                await run(inner);
            }
        } else {
            output.push(value);
        }
    } else {
        output.push(step);
    }
}

for (const step of [].concat(steps ?? [])) {
    await run(step);
}

if (process.env.PROBE_JS2) {
    await sleep(Number(process.env.PROBE_WAIT || 900));
    output.push(await evaluate(process.env.PROBE_JS2));
}

console.log(JSON.stringify({result: output, consoleErrors}, null, 2));

socket.close();
chrome.kill();
process.exit(0);
