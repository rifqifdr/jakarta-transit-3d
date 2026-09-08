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
    }

    get active() {
        return !!this.origin;
    }

    setOrigin(stop, time, dayOfWeek) {
        const me = this;

        me.origin = stop;
        me.compute(time, dayOfWeek);
        me.onChange();
        return me;
    }

    clear() {
        const me = this;

        me.origin = null;
        me.results = [];
        me.onChange();
        return me;
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
                    minutes: Math.round(seconds / 60),
                    name: stop.name
                },
                geometry: {type: 'Point', coordinates: [stop.lon, stop.lat]}
            });
        }

        if (me.origin) {
            features.push({
                type: 'Feature',
                properties: {band: 0, color: '#ffffff', origin: 1, name: me.origin.name},
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
                    `<button class="js-budget ${m === me.budget ? 'on' : ''}" data-budget="${m}">${m} mnt</button>`
                ).join('')}
            </div>
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

export {BANDS};
