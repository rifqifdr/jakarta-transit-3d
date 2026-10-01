/**
 * `?bench` — the on-device render benchmark (JAKAR-60, JAKAR-63).
 *
 * Every frame-rate number this project has is from an Apple M4. The audience
 * is Jabodetabek commuters on mid-range Android, and Chrome can throttle a CPU
 * but not a GPU, so the desktop harnesses answer everything except the
 * question the ticket is actually about. This runs the same measurement on
 * whatever device is holding it.
 *
 *   ?bench          everything: the static views, then the moving camera
 *   ?bench=static   the three static views only — the JAKAR-60 series
 *   ?bench=motion   the moving camera only — JAKAR-63
 *
 * Dynamically imported, so a visitor who never types `?bench` downloads none
 * of it — the same arrangement `hls.js` has in `cameras.js`.
 *
 * **A device number is "what a person sees", not attribution.** Vsync cannot
 * be turned off on a phone, so a frame that fits in the budget reports the
 * budget and the ceiling here is the display's own refresh rate: 60 fps means
 * "kept up", not "took 16.7 ms". That is the right measurement for this
 * ticket — the question is whether the map is usable, not what it costs — but
 * it is the opposite of what `scratchpad/gpu-bench.mjs` does, and the two must
 * not be read as one series. See "What the render path actually costs" in
 * CLAUDE.md.
 *
 * **A scripted camera is not a finger.** The motion arms move the camera the
 * way a gesture's own animation does — `easeTo`, `flyTo`, a `jumpTo` per
 * frame — so tile loading, symbol placement and the fleet's re-projection all
 * land exactly as they would. What they cannot reproduce is input: no touch
 * events, no input latency, and no refresh-rate boost a phone may grant while
 * a finger is down. They measure rendering under motion, which is the half of
 * "feels bad on a phone" a page can measure about itself.
 */

// Long enough that a stutter is a tail rather than the average; short enough
// that the whole run fits in the time somebody will stand still holding a
// phone. Six arms at four seconds is under a minute with settling.
const SAMPLE_MS = 4000,
    WARMUP_MS = 1200,
    // A moving arm needs less warm-up: the start of the move is settled, and
    // what is being measured is the move itself.
    MOTION_WARMUP_MS = 600,
    MOTION_MS = 4000,
    // How long the frame budget is read for, at rest, before anything runs.
    CALIBRATE_MS = 1500,

    // A frame this long is a stall a person feels at any refresh rate. It is
    // the threshold Chrome uses for long tasks and long animation frames, so
    // the count means the same thing on a 60 Hz phone and a 120 Hz laptop —
    // where "dropped" is relative to the display and does not.
    LONG_MS = 50,

    // How fast the pan arm drags, in CSS pixels a second. A quick flick across
    // a 390px screen is nearer 900; 600 sustained is a steady drag. Pixels
    // rather than metres because that is what a thumb moves, and at a fixed
    // zoom it is a fixed ground speed anyway — 0.68 m a pixel at z16.8.
    PAN_PX_S = 600,

    // A search result flies for a second (`onSelectStop` in main.js), so the
    // flyTo arm is four of those back to back, sampled only while flying.
    FLY_MS = 1000,
    FLY_HOLD_MS = 500,

    // The tour's opening — the title card and most of the ease-in — is not
    // what a tour costs once it is moving.
    TOUR_SKIP_MS = 2000,

    // The line the tour and Navigasi arms ride. Corridor 1 runs Blok M to
    // Kota down Sudirman and Thamrin, which is the densest 3D city on the map
    // and the corridor most people would pick first.
    BENCH_LINE = '1',

    // The clock speed the Navigasi arm follows at. At 1x a corridor bus moved
    // ten metres in a four-second sample — measured — which is a parked
    // pitch-78 view with a label saying otherwise. 16x is one of the follow
    // HUD's own speeds and puts a few hundred metres of new road under the
    // camera, so the horizon has to keep loading.
    NAV_SPEED = 16;

const VIEWS = {
    street: {
        label: 'Street level',
        camera: {center: [106.8230, -6.2010], zoom: 16.8, pitch: 65, bearing: 20}
    },
    default: {
        label: 'Default view',
        camera: {center: [106.8272, -6.1754], zoom: 12.4, pitch: 55, bearing: 0}
    },
    wide: {
        label: 'City-wide',
        camera: {center: [106.8272, -6.2], zoom: 10.5, pitch: 55, bearing: 0}
    }
};

// Shipped first, so a run abandoned halfway still answers the only question
// that matters on its own: does this device cope as the map is delivered?
//
// `no3d` was called `flat`, which was a bad name and cost a reader a whole
// wrong conclusion: a research brief read "flat" as a 2D map mode and built a
// 3D/Flat/Auto product hypothesis on it. This arm toggles exactly one thing —
// Mapbox Standard's extruded buildings. The camera pitch is identical in both
// arms (65 degrees at street level), the three.js vehicle layer is untouched,
// and nothing switches to a 2D renderer. Name an arm after what it changes.
const ARMS = [
    {id: 'shipped', label: 'As shipped', show3d: true},
    {id: 'no3d', label: 'Gedung 3D off', show3d: false},
    // Motion streaks ship off, so this is the arm that adds work rather than
    // removing it: one more draw call and a second pass over the fleet. It is
    // run in every view because the streaks are never culled by zoom — a city
    // zoom draws all six thousand of them.
    {id: 'trails', label: 'Jejak kendaraan', show3d: true, trails: true}
];

/*
   Every motion runs the same path four times.

   The first pass is the first time this run has seen that ground, so it pays
   for tiles; every later pass would find them cached and be cheaper for a
   reason that has nothing to do with the arm. So the first pass is reported
   as its own row rather than passed off as "as shipped", and each lever gets
   a pass of its own to warm up on before it is measured.

   The priming pass is not optional. Switching `show3dObjects` re-parses every
   tile Standard holds, and measuring across that is what once made turning 3D
   *off* look more expensive than leaving it on — `settle` below carries the
   same lesson for the static arms.

   Gedung 3D off runs last, so if the phone warms over the run it is the lever
   that pays for it. A lever that still wins under that handicap has won.
*/
const PASSES = [
    {id: 'first', label: 'First pass', show3d: true, measured: true},
    {id: 'shipped', label: 'As shipped', show3d: true, measured: true},
    {id: 'no3d-prime', label: 'Gedung 3D off, priming', show3d: false, measured: false},
    {id: 'no3d', label: 'Gedung 3D off', show3d: false, measured: true}
];

const linear = t => t;

// Four stops a search might fly between, each 3-9 km from the last — far
// enough that `flyTo` zooms out and back in, which is the expensive part.
const HOPS = [
    [106.7987, -6.2433], // Blok M
    [106.8230, -6.1950], // Bundaran HI
    [106.8133, -6.1376], // Kota
    [106.8500, -6.2100], // Manggarai
    [106.8228, -6.2005]  // Dukuh Atas
];

const MOTIONS = [
    {
        id: 'pan',
        label: 'Pan',
        // Sideways across the screen at street level, which is where tiles
        // turn over fastest: 1.6 km in four seconds at z16.8.
        camera: () => VIEWS.street.camera,
        async run({map, rec}) {
            rec.on();
            await move(map, () => map.panBy([PAN_PX_S * MOTION_MS / 1000, 0], {
                duration: MOTION_MS, easing: linear, essential: true
            }), MOTION_MS);
            rec.off();
        }
    },
    {
        id: 'zoom',
        label: 'Zoom in',
        // A pinch from district to street over Bundaran HI. It crosses z15,
        // where Standard's buildings come up, and `trueScaleZoom` at 16, where
        // the fleet stops being inflated — the two thresholds the ticket names.
        camera: () => ({center: [106.8230, -6.1950], zoom: 12.5, pitch: 55, bearing: 0}),
        async run({map, rec}) {
            rec.on();
            await move(map, () => map.easeTo({
                zoom: 16.5, duration: MOTION_MS, easing: linear, essential: true
            }), MOTION_MS);
            rec.off();
        }
    },
    {
        id: 'rotate',
        label: 'Rotate',
        // Bearing changes re-sort every symbol and turn every building, so
        // this is the arm the ticket expects to be ugly. Sudirman, at a zoom
        // where both are dense. 170 degrees rather than 180, because Mapbox
        // takes the shortest way round and 180 has two.
        camera: () => ({center: [106.8215, -6.2100], zoom: 15.5, pitch: 60, bearing: 0}),
        async run({map, rec}) {
            rec.on();
            await move(map, () => map.easeTo({
                bearing: 170, duration: MOTION_MS, easing: linear, essential: true
            }), MOTION_MS);
            rec.off();
        }
    },
    {
        id: 'flyTo',
        label: 'Search flyTo',
        // The transition a search result triggers, with the app's own zoom
        // and duration, so this is a real user path rather than a synthetic
        // one. Sampled only while flying; the holds between are not the move.
        camera: () => ({center: HOPS[0], zoom: 15, pitch: 55, bearing: 0}),
        async run({map, rec}) {
            for (const center of HOPS.slice(1)) {
                rec.on();
                await move(map, () => map.flyTo({
                    center, zoom: 15, duration: FLY_MS, essential: true
                }), FLY_MS);
                rec.off();
                await sleep(FLY_HOLD_MS);
            }
        }
    },
    {
        id: 'tour',
        label: 'Jelajahi jalur',
        // The app's own tour, at its own ground speed, so the camera path is
        // scripted and of known length — a better benchmark subject than a
        // hand-driven pan. A `jumpTo` every frame, for as long as it runs.
        camera: ({app, line}) => {
            const path = linePath(app, line);

            return path && {center: path[0], zoom: 14.5, pitch: 60, bearing: 0};
        },
        async run({app, rec, line}) {
            app.tour.start(linePath(app, line), {title: '', subtitle: ''});
            await sleep(TOUR_SKIP_MS);
            rec.on();
            await sleep(MOTION_MS);
            rec.off();
            app.tour.stop();
        }
    },
    {
        id: 'navigasi',
        label: 'Navigasi',
        // Following a vehicle in the egocentric view: pitch 78, the camera
        // jumped every frame, and the route ribbon re-trimmed every frame.
        camera: () => VIEWS.default.camera,
        async run({app, map, rec, line}) {
            // The clock was reset for this pass, so the fleet has to catch up
            // before a vehicle can be chosen from it.
            await frames(2);

            const run = followableRun(app, line);

            if (run < 0) {
                return false;
            }
            app.clock.setSpeed(NAV_SPEED);
            app.selectedRun = run;
            app.trackedRun = run;
            await until(() => app.nav.run === run && !app.nav.settling, 4000);

            // A follow that never engaged would measure the default view and
            // label it Navigasi.
            const engaged = app.nav.run === run && app.trackedRun === run;

            if (engaged) {
                // Never fully settles: at pitch 78 the horizon keeps asking
                // for tiles while the camera moves, so this is bounded rather
                // than waited out.
                await settle(map, 4000);
                await sleep(MOTION_WARMUP_MS);

                rec.on();
                await sleep(MOTION_MS);
                rec.off();
            }

            // What the follow HUD's own stop does, plus `nav.run`: the frame
            // loop only clears that while a vehicle is still selected, and the
            // next pass follows the same one.
            app.clock.setSpeed(1);
            app.trackedRun = -1;
            app.selectedRun = -1;
            app.nav.run = -1;
            app.vehicleLayer.setSelection(-1);
            app.detail.close();
            await frames(2);
            return engaged;
        }
    }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const frames = n => new Promise(resolve => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));

    requestAnimationFrame(step);
});

async function until(test, timeout) {
    const deadline = Date.now() + timeout;

    while (!test() && Date.now() < deadline) {
        await sleep(50);
    }
}

/**
 * Starts a camera animation and resolves when it ends.
 *
 * Bounded, because `moveend` is the only signal and an animation that is
 * interrupted — by a stray touch on a phone, say — may never send it.
 */
function move(map, start, duration) {
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            map.off('moveend', done);
            resolve();
        };
        const timer = setTimeout(done, duration + 3000);

        map.on('moveend', done);
        start();
    });
}

function percentile(sorted, p) {
    return sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
        : null;
}

/** The route the tour and Navigasi arms ride, on either boot path. */
function benchRoute(app) {
    for (const route of app.network.routes.values()) {
        if (route.shortName === BENCH_LINE) {
            return route;
        }
    }
    return null;
}

/** The longest pattern's path — the same choice a line preview's tour makes. */
function linePath(app, route) {
    const {network} = app;
    let best = null,
        bestLength = -1;

    for (const trip of network.trips) {
        if (trip.route !== route?.id || !trip.shape) {
            continue;
        }
        const {start, count} = trip.shape,
            length = network.cum[start + count - 1];

        if (length > bestLength) {
            bestLength = length;
            best = trip;
        }
    }
    return best ? network.sliceShape(best.shape, 0, bestLength) : null;
}

/**
 * The vehicle on the line with the most of its run still ahead.
 *
 * Deterministic for a given clock and service day, so every pass follows the
 * same vehicle from the same place. Not standing, or the first seconds of the
 * sample would be a camera parked at a halte.
 */
function followableRun(app, route) {
    const {fleet, network} = app;
    let best = -1,
        bestLeft = -1;

    for (let slot = 0; slot < fleet.activeCount; slot++) {
        const run = fleet.active[slot],
            trip = network.trips[fleet.runTrip[run]];

        if (trip.route !== route?.id || fleet.standing[slot]) {
            continue;
        }
        const left = trip.offsets[trip.offsets.length - 1] - fleet.offset[slot];

        if (left > bestLeft) {
            bestLeft = left;
            best = run;
        }
    }
    return best;
}

/** Great-circle distance in kilometres. */
function km([lon1, lat1], [lon2, lat2]) {
    const rad = Math.PI / 180,
        dLat = (lat2 - lat1) * rad,
        dLon = (lon2 - lon1) * rad,
        h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;

    return 12742 * Math.asin(Math.sqrt(h));
}

/**
 * Frame intervals, as the browser actually delivered them, while switched on.
 *
 * Switched rather than timed because a flyTo arm is four flights with holds
 * between, and the holds are not the move. Tiles and long animation frames are
 * counted over the same windows, so a row says how much work the motion
 * forced and whether it landed on the main thread.
 *
 * It also says how far the camera went while it was recording. A screenshot
 * proves an arm was in the right place; only this proves it moved — and a
 * motion row whose camera stood still is a static row with the wrong label,
 * which no frame time would ever reveal.
 *
 * And it says when a sample is not one. A hidden page gets no animation
 * frames at all — a locked phone, a switched app, a desktop window gone behind
 * another — while the timer that ends the sample runs on regardless. That
 * produced a row of zero frames and zero movement that passed for Navigasi
 * the first time it happened. It is flagged rather than reported.
 */
function recorder(map) {
    const intervals = [],
        windows = [],
        loaf = [],
        moved = {km: 0, zoom: 0, bearing: 0};
    let from = null,
        last = 0,
        live = true,
        on = false,
        tiles = 0,
        hidden = false,
        observer = null;

    const tick = now => {
        if (on && last) {
            intervals.push(now - last);
        }
        last = on ? now : 0;
        if (live) {
            requestAnimationFrame(tick);
        }
    };

    const onData = event => {
        if (on && event.dataType === 'source' && event.tile) {
            tiles++;
        }
    };

    const onVisibility = () => {
        if (on && document.hidden) {
            hidden = true;
        }
    };

    map.on('data', onData);
    document.addEventListener('visibilitychange', onVisibility);

    // Chrome only. It is the one attribution a device can give about itself:
    // dropped frames with little main-thread blocking point at the GPU or the
    // compositor; dropped frames with a lot of it point at script, which on
    // this map is Mapbox's placement and upload as much as our frame loop.
    // Safari and Firefox report null rather than a misleading zero.
    if (window.PerformanceObserver &&
            PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
        observer = new PerformanceObserver(list => loaf.push(...list.getEntries()));
        observer.observe({type: 'long-animation-frame'});
    }

    requestAnimationFrame(tick);

    return {
        on() {
            on = true;
            hidden = hidden || document.hidden;
            windows.push([performance.now(), Infinity]);
            from = {center: map.getCenter().toArray(), zoom: map.getZoom(),
                bearing: map.getBearing()};
        },
        off() {
            on = false;
            windows[windows.length - 1][1] = performance.now();
            moved.km += km(from.center, map.getCenter().toArray());
            moved.zoom += Math.abs(map.getZoom() - from.zoom);
            moved.bearing += Math.abs(((map.getBearing() - from.bearing + 540) % 360) - 180);
        },
        async stop() {
            live = false;
            map.off('data', onData);
            document.removeEventListener('visibilitychange', onVisibility);

            let blocking = null;

            if (observer) {
                // Entries are delivered after the frame they describe.
                await sleep(150);
                loaf.push(...observer.takeRecords());
                observer.disconnect();

                const inside = loaf.filter(entry => windows.some(([from, to]) =>
                    entry.startTime >= from && entry.startTime <= to));

                blocking = {
                    count: inside.length,
                    blockingMs: Math.round(inside.reduce((a, e) => a + e.blockingDuration, 0))
                };
            }
            return {
                intervals,
                tiles,
                loaf: blocking,
                moved,
                // Two frames is the least that makes one interval.
                interrupted: hidden || intervals.length < 2
            };
        }
    };
}

/**
 * The numbers a row reports.
 *
 * Percentiles alone are hard to act on — p90 25 ms says little — so this also
 * counts what a person experiences: how many display refreshes went by with
 * nothing new on them, and how many frames were long enough to feel as a
 * stall. "1 frame in 9 missed while dragging" is a sentence somebody can act
 * on.
 */
function summarise({intervals, tiles, loaf, moved, interrupted}, budget) {
    const sorted = [...intervals].sort((a, b) => a - b),
        n = sorted.length,
        total = sorted.reduce((a, c) => a + c, 0),
        round = x => (x === null ? null : Math.round(x * 10) / 10);
    let missed = 0,
        long = 0;

    for (const interval of sorted) {
        missed += Math.max(0, Math.round(interval / budget) - 1);
        if (interval >= LONG_MS) {
            long++;
        }
    }
    return {
        // When true, nothing else in the row is a measurement.
        interrupted,
        samples: n,
        fps: n ? round(1000 / (total / n)) : null,
        p50: round(percentile(sorted, 0.5)),
        p90: round(percentile(sorted, 0.9)),
        p99: round(percentile(sorted, 0.99)),
        max: round(n ? sorted[n - 1] : null),
        // Refreshes with no new frame, over all the refreshes that went by.
        droppedPct: n ? round(100 * missed / (n + missed)) : null,
        long,
        tiles,
        loaf,
        // Straight-line, start to end of each window: a tour that curves
        // travels further than this says, and a rotation goes nowhere at all
        // and says so in `bearing` instead.
        moved: {
            km: Math.round(moved.km * 100) / 100,
            zoom: Math.round(moved.zoom * 10) / 10,
            bearing: Math.round(moved.bearing)
        }
    };
}

/**
 * Waits for the tiles, then waits again.
 *
 * `areTilesLoaded` goes true when the last tile arrives, not when the style
 * has finished re-evaluating it — and switching `show3dObjects` re-parses
 * every loaded tile. Measuring across that is what made turning 3D *off* look
 * more expensive than leaving it on when the desktop harness first tried it.
 */
async function settle(map, timeout = 20000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (map.areTilesLoaded()) {
            await sleep(700);
            if (map.areTilesLoaded()) {
                return true;
            }
        }
        await sleep(250);
    }
    return false;
}

function environment(app) {
    const canvas = app.map.getCanvas(),
        gl = canvas.getContext('webgl2') || canvas.getContext('webgl'),
        info = gl && gl.getExtension('WEBGL_debug_renderer_info');

    return {
        ua: navigator.userAgent,
        dpr: window.devicePixelRatio,
        viewport: [window.innerWidth, window.innerHeight],
        canvas: [canvas.width, canvas.height],
        cores: navigator.hardwareConcurrency || null,
        // Chrome on Android reports this; Safari does not, and null is a
        // better answer than a guess.
        memoryGb: navigator.deviceMemory || null,
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null,
        // The frame interval at rest, read before anything runs; every
        // dropped-frame count is relative to it. Named for what it is rather
        // than for the display, because it is not the display — an S25
        // reported 60 here on a 120 Hz panel, because Chrome was targeting 60
        // for the page. Frame intervals still landed on 8.33 ms boundaries
        // (16.7, 25.0, 33.4), which is the panel showing through. Read it as
        // "the best this page was allowed", not as hardware.
        frameBudgetMs: null,
        observedCeilingHz: null,
        wakeLock: null
    };
}

/** The panel is built once and only its rows are rewritten (trap 1). */
function panel() {
    const root = document.createElement('div');

    root.id = 'bench-panel';
    root.innerHTML = `
        <style>
            #bench-panel {
                position: fixed; inset: auto 12px 12px 12px; z-index: 9999;
                background: rgba(16, 18, 22, 0.94); color: #e8eaed;
                font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
                border-radius: 10px; padding: 12px 14px; max-height: 70vh;
                overflow: auto; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            }
            #bench-panel h2 { font-size: 13px; margin: 0 0 8px; font-weight: 600; }
            #bench-panel table { border-collapse: collapse; width: 100%; }
            #bench-panel th, #bench-panel td {
                text-align: right; padding: 3px 6px; border-bottom: 1px solid rgba(255,255,255,.08);
            }
            #bench-panel th:nth-child(-n+2), #bench-panel td:nth-child(-n+2) { text-align: left; }
            #bench-panel .status { opacity: .75; margin: 6px 0 0; }
            #bench-panel .env { opacity: .6; margin: 8px 0 0; word-break: break-all; }
            #bench-panel button {
                font: inherit; margin: 10px 8px 0 0; padding: 6px 10px; cursor: pointer;
                background: #2b6cb0; color: #fff; border: 0; border-radius: 6px;
            }
            #bench-panel button.ghost { background: rgba(255,255,255,.12); }
        </style>
        <h2>Render benchmark — JAKAR-60 / 63</h2>
        <table><thead><tr>
            <th>View</th><th>Arm</th><th>fps</th><th>drop</th><th>long</th><th>p99</th>
        </tr></thead><tbody></tbody></table>
        <p class="status">starting…</p>
        <p class="env"></p>
        <button data-act="copy" hidden>Copy result</button>
        <button data-act="close" class="ghost">Close</button>
    `;
    document.body.appendChild(root);

    return {
        root,
        body: root.querySelector('tbody'),
        status: root.querySelector('.status'),
        env: root.querySelector('.env'),
        copy: root.querySelector('[data-act="copy"]'),
        close: root.querySelector('[data-act="close"]')
    };
}

function addRow(ui, view, arm, row) {
    const tr = document.createElement('tr'),
        cell = (value, digits = 0) => (value === null || value === undefined ?
            '—' : Number(value).toFixed(digits));

    tr.innerHTML = `<td>${view}</td><td>${arm}</td>` + (row?.interrupted ?
        '<td colspan="4">interrupted — page was hidden</td>' :
        `<td>${cell(row?.fps)}</td><td>${row ? `${cell(row.droppedPct)}%` : '—'}</td>` +
        `<td>${cell(row?.long)}</td><td>${cell(row?.p99)}</td>`);
    ui.body.appendChild(tr);
}

export default async function runBench(app, {only = ''} = {}) {
    const ui = panel(),
        map = app.map,
        env = environment(app),
        results = [],
        wants = kind => !only || only === kind,
        line = benchRoute(app);

    ui.close.addEventListener('click', () => ui.root.remove());

    // A full run is three minutes, and a phone dims long before that — after
    // which there are no frames to measure. Released automatically if the
    // page is hidden anyway; null where the API is not offered, in which case
    // the screen timeout has to be longer than the run.
    let wakeLock = null;

    try {
        wakeLock = await navigator.wakeLock?.request('screen') ?? null;
    } catch {
        // Refused, or not a secure context. The run still works.
    }
    env.wakeLock = !!wakeLock;

    // The clock drives the fleet, so the fleet size has to be pinned or the
    // arms are measured against different numbers of vehicles. The evening
    // peak at speed 1, exactly as every other measurement in this project.
    app.clock.setSpeed(1);
    app.clock.setTimeOffset(17.5 * 3600);

    const was3d = map.getConfigProperty('basemap', 'show3dObjects'),
        wasTrails = app.vehicleLayer._trailOn;

    // The budget every dropped frame is counted against, read at rest in the
    // view the app opens on. The tenth percentile rather than the median, so a
    // device that cannot hold its rate even at rest still reports the rate it
    // was asked to hold.
    ui.status.textContent = 'reading the frame budget… keep this tab in front';
    map.setConfigProperty('basemap', 'show3dObjects', true);
    map.jumpTo(VIEWS.default.camera);
    await sleep(400);
    await settle(map);
    // Every row is counted against this, so a budget read from a hidden page
    // would quietly poison the whole run. It waits for the page to be in front
    // rather than guessing a refresh rate.
    for (;;) {
        const rec = recorder(map);

        rec.on();
        await sleep(CALIBRATE_MS);
        rec.off();

        const {intervals, interrupted} = await rec.stop();

        if (!interrupted) {
            env.frameBudgetMs = Math.round(
                percentile(intervals.sort((a, b) => a - b), 0.1) * 100) / 100;
            env.observedCeilingHz = Math.round(1000 / env.frameBudgetMs);
            break;
        }
        ui.status.textContent = 'waiting for this tab to be in front…';
        await sleep(1000);
    }
    ui.env.textContent = `${env.renderer || 'unknown GPU'} · dpr ${env.dpr} · ` +
        `${env.canvas.join('x')} · ${env.cores || '?'} cores · ` +
        `budget ${env.frameBudgetMs} ms`;

    if (wants('static')) {
        for (const [id, view] of Object.entries(VIEWS)) {
            for (const arm of ARMS) {
                ui.status.textContent = `${view.label} — ${arm.label}…`;

                map.setConfigProperty('basemap', 'show3dObjects', arm.show3d);
                app.vehicleLayer.setTrails(!!arm.trails);
                map.jumpTo(view.camera);
                await sleep(400);
                await settle(map);
                await sleep(WARMUP_MS);

                const rec = recorder(map);

                rec.on();
                await sleep(SAMPLE_MS);
                rec.off();

                const row = {
                    kind: 'static',
                    view: id,
                    arm: arm.id,
                    ...summarise(await rec.stop(), env.frameBudgetMs),
                    fleet: app.fleet.activeCount,
                    trails: !!arm.trails
                };

                results.push(row);
                addRow(ui, view.label, arm.label, row);
            }
        }
        app.vehicleLayer.setTrails(false);
    }

    if (wants('motion')) {
        for (const motion of MOTIONS) {
            for (const pass of PASSES) {
                ui.status.textContent = `${motion.label} — ${pass.label}…`;

                // Reset per pass, so Navigasi follows the same vehicle from the
                // same place every time and every pass draws the same fleet.
                app.clock.setTimeOffset(17.5 * 3600);
                map.setConfigProperty('basemap', 'show3dObjects', pass.show3d);

                const context = {app, map, line},
                    camera = motion.camera(context);

                if (!camera) {
                    if (pass.measured) {
                        addRow(ui, motion.label, pass.label, null);
                    }
                    continue;
                }
                map.jumpTo(camera);
                await sleep(400);
                await settle(map);
                await sleep(MOTION_WARMUP_MS);

                const rec = recorder(map),
                    ran = await motion.run({...context, rec}),
                    measured = await rec.stop();

                // Only Navigasi can fail to start — there may be no vehicle on
                // the line at this hour on this day — and a row of zeros would
                // read as a measurement.
                if (ran === false) {
                    if (pass.measured) {
                        addRow(ui, motion.label, pass.label, null);
                    }
                    continue;
                }
                if (!pass.measured) {
                    continue;
                }

                const row = {
                    kind: 'motion',
                    view: motion.id,
                    arm: pass.id,
                    ...summarise(measured, env.frameBudgetMs),
                    fleet: app.fleet.activeCount,
                    clockSpeed: motion.id === 'navigasi' ? NAV_SPEED : 1
                };

                results.push(row);
                addRow(ui, motion.label, pass.label, row);
            }
        }
    }

    wakeLock?.release().catch(() => {});
    map.setConfigProperty('basemap', 'show3dObjects', was3d);
    // Both levers back as they were found: a benchmark that leaves the map
    // changed is a benchmark somebody has to undo by reloading.
    app.vehicleLayer.setTrails(wasTrails);

    const report = {
        ticket: only === 'static' ? 'JAKAR-60' : 'JAKAR-63',
        // 2 added the moving camera, dropped frames, long frames, tiles and
        // long animation frames. The static rows measure exactly what 1 did.
        bench: 2,
        only: only || 'all',
        when: new Date().toISOString(),
        env,
        results
    };

    ui.status.textContent = 'done — "drop" is refreshes that showed no new frame, ' +
        `"long" is frames over ${LONG_MS} ms. Vsync cannot be disabled on a device, ` +
        'so fps means "kept up", not "cost this much".';
    ui.copy.hidden = false;
    ui.copy.addEventListener('click', async () => {
        const text = JSON.stringify(report, null, 2);

        try {
            await navigator.clipboard.writeText(text);
            ui.copy.textContent = 'Copied';
        } catch {
            // Clipboard needs a secure context and a user gesture, and a phone
            // browser may still refuse. Showing the text is the fallback that
            // always works — it can be selected by hand.
            const pre = document.createElement('textarea');

            pre.value = text;
            pre.style.cssText = 'width:100%;height:180px;margin-top:8px';
            ui.root.appendChild(pre);
            pre.select();
        }
    });

    window.__benchResult = report;
    return report;
}
