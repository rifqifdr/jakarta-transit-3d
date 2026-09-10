import configs from '../configs';

/**
 * Mapbox Standard's own themes. Three, not four — `custom` is in the schema but
 * needs a `theme-data` payload, which is a style-authoring feature rather than
 * something to put in front of a rider.
 *
 * This is a legibility control, not a performance one. `monochrome` was
 * measured as no help at all to a phone's frame times (JAKAR-60); what it does
 * is take the colour out of the city so six thousand vehicles have it to
 * themselves, which is the trade the README has described since the basemap
 * stopped being a private style.
 */
const BASEMAP_THEMES = [
    {id: 'default', label: 'Warna', hint: 'Peta Mapbox Standard apa adanya'},
    {id: 'faded', label: 'Pudar', hint: 'Kota diredam, armada lebih menonjol'},
    {id: 'monochrome', label: 'Mono', hint: 'Kota tanpa warna — armada paling menonjol'}
];

/**
 * Toggles for the service categories and the supporting map layers.
 *
 * Categories are how an operator segments its own network — BRT corridors,
 * feeder Mikrotrans, commuter Transjabodetabek — so they stay the thing you
 * filter on. But **mode sits above them** (JAKAR-27/39): category is a product
 * line, mode is what the vehicle actually is, and "no trains" is a mode
 * decision that a flat list of eleven product names cannot express.
 *
 * The category-to-mode mapping is read off the routes rather than hardcoded, so
 * the legacy bus-only path — where routes carry no mode at all — still groups
 * correctly instead of showing an empty rail section.
 */
export default class LayerPanel {

    constructor(fleet, {onCategoryToggle, onLayerToggle, onBasemapTheme, basemapTheme}) {
        const me = this;

        me.fleet = fleet;
        me.onCategoryToggle = onCategoryToggle;
        me.onLayerToggle = onLayerToggle;
        me.onBasemapTheme = onBasemapTheme;
        me.basemapTheme = basemapTheme || 'default';
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div'),
            counts = me._countRoutes(),
            groups = me._groupByMode(counts);

        el.className = 'panel';
        el.id = 'layers';
        el.innerHTML = `
            <div class="panel-title js-fold">Layanan<span class="chevron"></span></div>
            <div class="layer-body">
            ${groups.map(group => `
                <div class="mode-group" data-mode="${group.id}">
                    <div class="mode-head js-mode">
                        <span class="mode-name">${group.label}</span>
                        <span class="n">${group.count}</span>
                    </div>
                    ${group.categories.map(c => `
                        <div class="cat" data-cat="${c.id}">
                            <span class="dot" style="background:${c.color}"></span>
                            <span class="name">${c.label}</span>
                            <span class="n">${counts.get(c.id) || 0}</span>
                        </div>
                    `).join('')}
                </div>
            `).join('')}
            <div class="layer-sep"></div>
            <div class="panel-title">Tampilan peta</div>
            <div class="sorts js-basemap">
                ${BASEMAP_THEMES.map(t => `
                    <button class="btn btn-sm js-theme${t.id === me.basemapTheme ? ' on' : ''}"
                            type="button" data-theme="${t.id}" title="${t.hint}">${t.label}</button>
                `).join('')}
            </div>
            <div class="layer-sep"></div>
            <label class="toggle"><input type="checkbox" data-layer="routes" checked> Jalur rute</label>
            <label class="toggle"><input type="checkbox" data-layer="stops" checked> Halte</label>
            <label class="toggle"><input type="checkbox" data-layer="buildings" checked> Gedung 3D</label>
            <label class="toggle"><input type="checkbox" data-layer="accessible"> Hanya halte aksesibel</label>
            <label class="toggle"><input type="checkbox" data-layer="headway"> Warnai per frekuensi</label>
            <div class="headway-legend"></div>
            <label class="toggle cam-toggle"><input type="checkbox" data-layer="cameras"> Kamera langsung</label>
            <div class="cam-hint" hidden>Hanya tersedia dalam mode LIVE</div>
            </div>
        `;
        document.body.appendChild(el);

        el.querySelector('.js-fold').addEventListener('click', () => me.toggle());

        // A mode header turns its whole group off, or back on. "All off"
        // means the next click turns everything on, which is what people
        // expect from a group toggle.
        for (const head of el.querySelectorAll('.js-mode')) {
            head.addEventListener('click', () => {
                const group = head.closest('.mode-group'),
                    rows = [...group.querySelectorAll('.cat')],
                    turningOn = rows.every(row =>
                        !me.fleet.isCategoryVisible(row.dataset.cat));

                for (const row of rows) {
                    const category = row.dataset.cat;

                    if (me.fleet.isCategoryVisible(category) !== turningOn) {
                        me.fleet.setCategoryVisible(category, turningOn);
                        row.classList.toggle('off', !turningOn);
                        me.onCategoryToggle(category, turningOn);
                    }
                }
                group.classList.toggle('off', !turningOn);
            });
        }

        for (const row of el.querySelectorAll('.cat')) {
            row.addEventListener('click', () => {
                const category = row.dataset.cat,
                    visible = !me.fleet.isCategoryVisible(category);

                me.fleet.setCategoryVisible(category, visible);
                row.classList.toggle('off', !visible);
                me.onCategoryToggle(category, visible);
                me._syncGroup(row.closest('.mode-group'));
            });
        }
        for (const box of el.querySelectorAll('input[data-layer]')) {
            box.addEventListener('change', () => {
                me.onLayerToggle(box.dataset.layer, box.checked);
            });
        }

        el.querySelector('.js-basemap').addEventListener('click', event => {
            const button = event.target.closest('.js-theme');

            if (!button || button.classList.contains('on')) {
                return;
            }
            for (const other of el.querySelectorAll('.js-theme')) {
                other.classList.toggle('on', other === button);
            }
            me.basemapTheme = button.dataset.theme;
            me.onBasemapTheme?.(me.basemapTheme);
        });
    }

    /** Swaps the panel between explaining categories and explaining frequency. */
    setMode(mode, bands) {
        const me = this,
            legend = me.el.querySelector('.headway-legend'),
            showing = mode === 'headway';

        me.el.classList.toggle('by-headway', showing);
        legend.innerHTML = showing ? bands.map(b => `
            <div class="cat static">
                <span class="dot" style="background:${b.color}"></span>
                <span class="name">${b.label}</span>
            </div>
        `).join('') : '';
        return me;
    }

    /** Reflects a category's visibility in the UI, without firing callbacks. */
    setCategoryUI(category, visible) {
        const row = this.el.querySelector(`.cat[data-cat="${category}"]`);

        if (row) {
            row.classList.toggle('off', !visible);
        }
        return this;
    }

    /**
     * Whether the live camera layer can be switched on at all.
     *
     * A camera is showing the street *now*; the clock can be replaying a
     * Tuesday in March at 1200x. There is no honest way to put those together,
     * so outside live mode the toggle is disabled rather than left to produce
     * a view that quietly means nothing. Mini Tokyo 3D's camera plugin makes
     * the same call — it declares `clockModes: ['realtime']` and switches
     * itself off otherwise.
     */
    setCamerasAvailable(available) {
        const me = this,
            box = me.el.querySelector('input[data-layer="cameras"]'),
            hint = me.el.querySelector('.cam-hint');

        if (!box) {
            return me;
        }
        box.disabled = !available;
        box.closest('.toggle').classList.toggle('disabled', !available);
        hint.hidden = available;
        return me;
    }

    /** Reflects a layer toggle in the UI, without firing callbacks. */
    setLayerUI(layer, on) {
        const box = this.el.querySelector(`input[data-layer="${layer}"]`);

        if (box) {
            box.checked = on;
        }
        return this;
    }

    /** Folds the panel down to its title bar, or back open. */
    toggle(folded = !this.el.classList.contains('folded')) {
        this.el.classList.toggle('folded', folded);
        return this;
    }

    /** Greys a mode header once every category under it is off. */
    _syncGroup(group) {
        if (!group) {
            return;
        }

        const rows = [...group.querySelectorAll('.cat')];

        group.classList.toggle('off', rows.every(row => row.classList.contains('off')));
    }

    /**
     * Categories under their mode, in `configs.modeLabels` order.
     *
     * A mode with no routes is dropped rather than shown empty — the legacy
     * path has only buses, and four empty rail headings would be noise.
     */
    _groupByMode(counts) {
        const me = this,
            modeOf = new Map();

        for (const route of me.fleet.network.routes.values()) {
            if (route.category && !modeOf.has(route.category)) {
                modeOf.set(route.category, route.mode || 'bus');
            }
        }

        return configs.modeLabels.map(mode => {
            const categories = configs.categories.filter(c =>
                    (modeOf.get(c.id) || 'bus') === mode.id && (counts.get(c.id) || 0) > 0
                );

            return {
                id: mode.id,
                label: mode.label,
                categories,
                count: categories.reduce((total, c) => total + (counts.get(c.id) || 0), 0)
            };
        }).filter(group => group.categories.length);
    }

    _countRoutes() {
        const counts = new Map();

        for (const route of this.fleet.network.routes.values()) {
            counts.set(route.category, (counts.get(route.category) || 0) + 1);
        }
        return counts;
    }

}
