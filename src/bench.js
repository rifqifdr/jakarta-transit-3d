/**
 * `?bench` — the on-device half of JAKAR-60.
 *
 * Every frame-rate number this project has is from an Apple M4. The audience
 * is Jabodetabek commuters on mid-range Android, and Chrome can throttle a CPU
 * but not a GPU, so the desktop harnesses answer everything except the
 * question the ticket is actually about. This runs the same measurement on
 * whatever device is holding it.
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
 */

// Long enough that a stutter is a tail rather than the average; short enough
// that the whole run fits in the time somebody will stand still holding a
// phone. Six arms at four seconds is under a minute with settling.
const SAMPLE_MS = 4000,
    WARMUP_MS = 1200;

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
    },
    // The crowd's own view (JAKAR-79). Street level as this project
    // benchmarks it is z16.8, where a person is 2.5 px tall and the walkers
    // do not exist at all — their band starts at z17.2. Tanah Abang is the
    // densest interchange measured, and where the cap of 800 is reached.
    crowd: {
        label: 'Crowd (Tanah Abang)',
        camera: {center: [106.8112, -6.1858], zoom: 18.4, pitch: 65, bearing: 20}
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
    // Only in the view where there is a crowd to turn off. Everywhere else it
    // would measure the shipped arm twice and cost somebody another eight
    // seconds of standing still holding a phone.
    {id: 'nocrowd', label: 'Pejalan kaki off', show3d: true, walkers: false,
        views: ['crowd']}
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function percentile(sorted, p) {
    return sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
        : null;
}

/** Frame intervals over one window, as the browser actually delivered them. */
function sample(ms) {
    return new Promise(resolve => {
        const frames = [];
        let last = 0,
            stop = 0;

        const tick = now => {
            if (!stop) {
                stop = now + ms;
            }
            if (last) {
                frames.push(now - last);
            }
            last = now;
            if (now < stop) {
                requestAnimationFrame(tick);
            } else {
                resolve(frames);
            }
        };

        requestAnimationFrame(tick);
    });
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
        // Filled in after the run: the fastest frame anything achieved. Named
        // for what it is rather than for the display, because it is not the
        // display — an S25 reported 60 here on a 120 Hz panel, because Chrome
        // was targeting 60 for the page. Frame intervals still landed on
        // 8.33 ms boundaries (16.7, 25.0, 33.4), which is the panel showing
        // through. Read it as "the best this page was allowed", not as
        // hardware.
        observedCeilingHz: null
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
            #bench-panel th:first-child, #bench-panel td:first-child { text-align: left; }
            #bench-panel .status { opacity: .75; margin: 6px 0 0; }
            #bench-panel .env { opacity: .6; margin: 8px 0 0; word-break: break-all; }
            #bench-panel button {
                font: inherit; margin: 10px 8px 0 0; padding: 6px 10px; cursor: pointer;
                background: #2b6cb0; color: #fff; border: 0; border-radius: 6px;
            }
            #bench-panel button.ghost { background: rgba(255,255,255,.12); }
        </style>
        <h2>Render benchmark — JAKAR-60</h2>
        <table><thead><tr>
            <th>View</th><th>Arm</th><th>fps</th><th>p50</th><th>p99</th>
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

export default async function runBench(app) {
    const ui = panel(),
        map = app.map,
        env = environment(app),
        results = [];

    ui.close.addEventListener('click', () => ui.root.remove());
    ui.env.textContent = `${env.renderer || 'unknown GPU'} · dpr ${env.dpr} · ` +
        `${env.canvas.join('x')} · ${env.cores || '?'} cores`;

    // The clock drives the fleet, so the fleet size has to be pinned or the
    // arms are measured against different numbers of vehicles. The evening
    // peak at speed 1, exactly as every other measurement in this project.
    app.clock.setSpeed(1);
    app.clock.setTimeOffset(17.5 * 3600);

    const was3d = map.getConfigProperty('basemap', 'show3dObjects');

    const wasWalkers = app.walkersOn;

    for (const [id, view] of Object.entries(VIEWS)) {
        for (const arm of ARMS) {
            if (arm.views && !arm.views.includes(id)) {
                continue;
            }
            ui.status.textContent = `${view.label} — ${arm.label}…`;

            map.setConfigProperty('basemap', 'show3dObjects', arm.show3d);
            app.walkersOn = arm.walkers !== false;
            if (!app.walkersOn) {
                app.walkers.clear();
            }
            map.jumpTo(view.camera);
            await sleep(400);
            await settle(map);
            await sleep(WARMUP_MS);

            const frames = (await sample(SAMPLE_MS)).sort((a, b) => a - b),
                mean = frames.reduce((a, c) => a + c, 0) / (frames.length || 1),
                row = {
                    view: id,
                    arm: arm.id,
                    samples: frames.length,
                    fps: frames.length ? 1000 / mean : null,
                    p50: percentile(frames, 0.5),
                    p90: percentile(frames, 0.9),
                    p99: percentile(frames, 0.99),
                    fleet: app.fleet.activeCount,
                    walkers: app.walkers ? app.walkers.count : 0
                };

            results.push(row);

            const tr = document.createElement('tr');

            tr.innerHTML = `<td>${view.label}</td><td>${arm.label}</td>` +
                `<td>${row.fps.toFixed(0)}</td><td>${row.p50.toFixed(1)}</td>` +
                `<td>${row.p99.toFixed(0)}</td>`;
            ui.body.appendChild(tr);
        }
    }

    map.setConfigProperty('basemap', 'show3dObjects', was3d);
    // Both levers back as they were found: a benchmark that leaves the map
    // changed is a benchmark somebody has to undo by reloading.
    app.walkersOn = wasWalkers;

    // A frame that fits the budget reports the budget, so the fastest median
    // across the arms is the ceiling this page was scheduled against. It is
    // not necessarily the panel's rate and must not be labelled as such.
    const all = results.flatMap(r => [r.p50]).sort((a, b) => a - b);

    env.observedCeilingHz = all.length ? Math.round(1000 / all[0]) : null;

    const report = {ticket: 'JAKAR-60', when: new Date().toISOString(), env, results};

    ui.status.textContent = 'done — vsync cannot be disabled on a device, ' +
        'so fps is capped by the display and means "kept up", not "cost this much".';
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
