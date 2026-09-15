/**
 * Reachability: everywhere you can get to from one stop within a time budget.
 *
 * The same forward search as the journey planner, with the destination removed
 * and a ceiling put on instead — which is why this cost almost nothing to add
 * once the router existed.
 *
 * The free-routes filter is the part worth having. 101 of Transjakarta's 240
 * routes cost nothing, so "how far can you get in 45 minutes without paying?"
 * is a question this dataset can answer and most cannot.
 */

// Bands darken as the journey lengthens, so the ramp reads as ordered rather
// than as four unrelated categories.
const BANDS = [
    {minutes: 15, color: '#00b8a0'},
    {minutes: 30, color: '#2a8fd8'},
    {minutes: 45, color: '#5d5fc4'},
    {minutes: 60, color: '#8b3f9e'}
];

/*
   How long the sweep takes, in real milliseconds, and how wide its leading
   edge is in simulated seconds.

   The search already returns an arrival *time* per stop and the map was
   throwing that away, painting the whole set at once in four bands. Releasing
   it in arrival order instead costs nothing — the same points, filtered on a
   rising threshold — and it is the difference between a blob and watching the
   network work: the frontier crawls along the corridors and jumps down the
   rail lines, which is a fact about Jakarta that four static bands flatten.

   Six seconds regardless of budget, so 15 minutes and 60 minutes take the same
   time to watch. The thing being read is the *shape* of the spread, not its
   duration.
*/
const SWEEP_MS = 6000,
    EDGE_SECONDS = 150;

export default class Reach {

    constructor({network, router, onChange}) {
        const me = this;

        me.network = network;
        me.router = router;
        me.onChange = onChange;

        me.origin = null;
        me.budget = 45;
        me.freeOnly = false;
        me.results = [];
        me.elapsed = 0;

        // How far the sweep has got, in seconds of journey time. `Infinity`
        // means "not sweeping" and therefore "show everything", which is what
        // the set should look like at rest and after the sweep ends.
        me.frontier = Infinity;
        me._raf = null;
        // Set by `main.js`, which owns the map layer this drives.
        me.onFrontier = null;
    }

    get active() {
        return !!this.origin;
    }

    setOrigin(stop, time, dayOfWeek) {
        const me = this;

        me.origin = stop;
        me.compute(time, dayOfWeek);
        me.onChange();
        // A new origin is a new question, so it is answered by showing the
        // answer arrive. Changing the budget or the free filter is not — it is
        // an adjustment to a question already on screen, and re-running a
        // six-second animation on every tap of `30 mnt` would be a toll rather
        // than a flourish. That is what the replay button is for.
        me.play();
        return me;
    }

    clear() {
        const me = this;

        me.stopSweep();
        me.origin = null;
        me.results = [];
        me.onChange();
        return me;
    }

    /**
     * Releases the reachable set in arrival order.
     *
     * Its own `requestAnimationFrame` loop, like `Tour` and `bench.js`, rather
     * than a branch in the frame loop: nothing else needs to know this is
     * happening, and the loop ends by itself.
     */
    play() {
        const me = this;

        if (!me.results.length) {
            return me;
        }
        me.stopSweep();

        const ceiling = me.budget * 60,
            started = performance.now(),
            tick = () => {
                const p = Math.min(1, (performance.now() - started) / SWEEP_MS);

                // Past the ceiling at the end rather than exactly on it, so
                // the last band is not left flickering on a rounding error.
                me.frontier = p >= 1 ? Infinity : p * (ceiling + EDGE_SECONDS);
                me.onFrontier?.();
                me._raf = p >= 1 ? null : requestAnimationFrame(tick);
            };

        me.frontier = 0;
        me._raf = requestAnimationFrame(tick);
        return me;
    }

    /** Ends a sweep and shows the whole set. Idempotent. */
    stopSweep() {
        const me = this;

        if (me._raf) {
            cancelAnimationFrame(me._raf);
            me._raf = null;
        }
        me.frontier = Infinity;
        me.onFrontier?.();
        return me;
    }

    get sweeping() {
        return this._raf !== null;
    }

    compute(time, dayOfWeek) {
        const me = this;

        if (!me.origin) {
            return me;
        }

        const started = performance.now();

        me.time = time;
        me.dayOfWeek = dayOfWeek;
        me.results = me.router.reachable({
            from: me.origin,
            time: Math.floor(time),
            dayOfWeek,
            maxSeconds: me.budget * 60,
            freeOnly: me.freeOnly
        });
        me.elapsed = performance.now() - started;
        return me;
    }

    set(option, value) {
        const me = this;

        me[option] = value;
        me.compute(me.time, me.dayOfWeek);
        me.onChange();
        return me;
    }

    /** Reachable stops as points carrying their arrival band. */
    toGeoJSON() {
        const me = this,
            features = [];

        for (const {stop, seconds} of me.results) {
            const band = BANDS.find(b => seconds <= b.minutes * 60);

            if (!band || band.minutes > me.budget) {
                continue;
            }
            features.push({
                type: 'Feature',
                properties: {
                    band: band.minutes,
                    color: band.color,
                    // Seconds as well as minutes: the sweep filters on this,
                    // and a value already rounded to the minute would release
                    // the set in sixty visible steps rather than smoothly.
                    secs: Math.round(seconds),
                    minutes: Math.round(seconds / 60),
                    name: stop.name
                },
                geometry: {type: 'Point', coordinates: [stop.lon, stop.lat]}
            });
        }

        if (me.origin) {
            features.push({
                type: 'Feature',
                // `secs` of -1 so the origin is inside every frontier,
                // including a frontier of zero: the sweep starts from
                // somewhere, and that somewhere should be on screen first.
                properties: {
                    band: 0, color: '#ffffff', origin: 1,
                    secs: -1, name: me.origin.name
                },
                geometry: {type: 'Point', coordinates: [me.origin.lon, me.origin.lat]}
            });
        }
        return {type: 'FeatureCollection', features};
    }

    renderInto(el) {
        const me = this,
            counts = BANDS.map(band => ({
                ...band,
                count: me.results.filter(r =>
                    r.seconds <= band.minutes * 60 && band.minutes <= me.budget
                ).length
            })),
            reached = me.results.length;

        el.innerHTML = `
            <div class="detail-head">
                <div>
                    <div class="detail-title">Jangkauan dari ${me.origin.name}</div>
                    <div class="detail-sub">
                        ${reached.toLocaleString('id-ID')} halte dalam ${me.budget} menit
                        ${me.freeOnly ? '&middot; hanya rute gratis' : ''}
                    </div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="sorts">
                ${[15, 30, 45, 60].map(m =>
                    `<button class="btn btn-sm js-budget ${m === me.budget ? 'on' : ''}" data-budget="${m}">${m} mnt</button>`
                ).join('')}
            </div>
            <button class="btn btn-block js-reach-play" type="button">
                Putar penyebaran
            </button>
            <div class="detail-body">
                <label class="toggle free-toggle">
                    <input type="checkbox" class="js-free" ${me.freeOnly ? 'checked' : ''}>
                    Hanya rute gratis
                </label>
                <div class="reach-legend">
                    ${counts.filter(c => c.minutes <= me.budget).map(c => `
                        <div class="reach-row">
                            <span class="reach-dot" style="background:${c.color}"></span>
                            <span>dalam ${c.minutes} menit</span>
                            <span class="t">${c.count.toLocaleString('id-ID')}</span>
                        </div>
                    `).join('')}
                </div>
                ${me.freeOnly && reached < 5 ? `
                    <div class="reach-note">
                        Tidak ada rute gratis dari halte ini — hanya koridor berbayar
                        yang melayani ${me.origin.name}.
                    </div>
                ` : ''}
                <div class="reach-note muted">
                    Dihitung dalam ${me.elapsed.toFixed(0)} ms &middot;
                    berangkat pukul ${String(Math.floor(me.time / 3600)).padStart(2, '0')}:${
                        String(Math.floor(me.time / 60) % 60).padStart(2, '0')
                    }. Ubah jam pada penggeser waktu untuk melihat perbedaannya.
                </div>
            </div>
        `;
    }

}

export {BANDS, EDGE_SECONDS};
