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
 *   PROBE_WIDTH=390 PROBE_HEIGHT=844 node ...     # the one-column layout
 *
 * A step of the form {_click: [x, y]} in the returned array is dispatched as a
 * genuine mouse press and release at those viewport coordinates; PROBE_JS2 is
 * then evaluated afterwards, so a check can straddle a real interaction.
 *
 * {_tap: [x, y]} and {_press: [x, y, ms]} are the same idea for a finger, as
 * real touch events with a real `pointerType`. Trap 2 has a touch half: a
 * `click` synthesised by the harness carries no touch at all, so anything
 * that distinguishes a thumb from a mouse — which "sekitar sini" now does
 * (JAKAR-66) — cannot be tested with `_click` either way round.
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const URL_UNDER_TEST = process.env.PROBE_URL || 'http://localhost:5173/',
    CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    PORT = 9222 + Math.floor(Math.random() * 300),
    // `--window-size` floors out well above a phone in headless, so the size
    // that actually decides the layout is the metrics override below.
    WIDTH = Number(process.env.PROBE_WIDTH || 1440),
    HEIGHT = Number(process.env.PROBE_HEIGHT || 900);

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

// Touch emulation is enabled on first use rather than up front: it changes
// what the page detects about the device, and the mouse arms are meant to be
// a mouse.
let touchEnabled = false;

/*
   A finger down for `holdMs`, then up.

   The duration is stated in the events rather than waited out, and that is
   not a shortcut — it is the only way this harness can express a tap at all.
   Omit `timestamp` and Chrome stamps each event as it ingests it, which on
   this rasteriser runs seconds behind: a 60ms tap dispatched here arrived in
   the page as `touchstart` at 5518 and `touchend` at 8545, three seconds
   apart, and no gesture told apart by its duration could be tested either
   way round. Same lesson as the frame timings — this harness is for what the
   app does, never for how long anything took (trap 2's other half).

   The wall-clock hold is kept, and short, because the events still have to
   arrive in order.
*/
async function touch(x, y, holdMs) {
    if (!touchEnabled) {
        await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
        touchEnabled = true;
    }

    const at = Date.now() / 1000,
        point = (px, py) => [{x: px, y: py, id: 1, radiusX: 12, radiusY: 12, force: 1}];

    await send('Input.dispatchTouchEvent', {
        type: 'touchStart', timestamp: at, touchPoints: point(x, y)
    });

    // A real finger is never perfectly still. Nudging it inside the slop
    // proves the press survives what a hand actually does — and a harness
    // that only ever holds a pixel still would pass a press detector with no
    // tolerance at all.
    await send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        timestamp: at + holdMs / 2000,
        touchPoints: point(x + 2, y - 1)
    });
    await send('Input.dispatchTouchEvent', {
        type: 'touchEnd', timestamp: at + holdMs / 1000, touchPoints: []
    });
    await sleep(120);
}

/*
   A finger dragged from one point to another over `ms`, in eight steps.

   Slow on purpose. A quick flick is not what JAKAR-66 is about: the tap that
   opened a card was the tail of someone moving the map around deliberately,
   and a press detector that only rejects fast gestures would still fire on
   that.
*/
async function drag(x1, y1, x2, y2, ms) {
    if (!touchEnabled) {
        await send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
        touchEnabled = true;
    }

    const at = Date.now() / 1000,
        steps = 8,
        point = (px, py) => [{x: px, y: py, id: 1, radiusX: 12, radiusY: 12, force: 1}];

    await send('Input.dispatchTouchEvent', {
        type: 'touchStart', timestamp: at, touchPoints: point(x1, y1)
    });
    for (let i = 1; i <= steps; i++) {
        await send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            timestamp: at + (ms / 1000) * (i / steps),
            touchPoints: point(
                Math.round(x1 + (x2 - x1) * i / steps),
                Math.round(y1 + (y2 - y1) * i / steps)
            )
        });
    }
    await send('Input.dispatchTouchEvent', {
        type: 'touchEnd', timestamp: at + ms / 1000, touchPoints: []
    });
    await sleep(120);
}

await send('Runtime.enable');
await send('Page.enable');

// PROBE_WIDTH=390 PROBE_HEIGHT=844 puts the app in the one-column layout
// (JAKAR-62), which is where a control that grew a few pixels stops fitting —
// bumping the ride HUD's buttons up one size step wrapped "Tahap 1 / 4" onto
// two lines here while the 1440px arm showed nothing at all.
await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: WIDTH < 700
});

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
//   {_tap: [x, y]}    the same as a finger — real touch events, pointerType touch
//   {_press: [x, y]}  a finger held down, for a long press ([x, y, ms] to set it)
//   {_drag: [x1, y1, x2, y2, ms]}  a finger dragged slowly — a pan, not a flick
//   {_wait: ms}       let the app settle; the map needs frames, not promises
//   {_eval: 'expr'}   evaluate between interactions, and keep the result
//
// `_eval` may itself return further steps, which is how a click can be aimed
// at something whose position is only known once the previous step has run.
async function run(step) {
    if (step && step._click) {
        await click(step._click[0], step._click[1]);
        output.push({clicked: step._click});
    } else if (step && step._tap) {
        await touch(step._tap[0], step._tap[1], 60);
        output.push({tapped: step._tap});
    } else if (step && step._press) {
        const [x, y, ms = 700] = step._press;

        await touch(x, y, ms);
        output.push({pressed: [x, y, ms]});
    } else if (step && step._drag) {
        const [x1, y1, x2, y2, ms = 600] = step._drag;

        await drag(x1, y1, x2, y2, ms);
        output.push({dragged: step._drag});
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
