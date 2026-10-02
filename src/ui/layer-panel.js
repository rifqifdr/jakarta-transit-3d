import configs from '../configs';
import {icon} from '../kodefikasi';
import {foldHead, setFolded} from './fold-head';

/** A mode's glyph, for the group header. Same four the fleet is drawn with. */
const MODE_GLYPH = {
    bus: 'bus',
    commuter_rail: 'krl',
    metro: 'mrt',
    light_rail: 'lrt'
};

/**
 * Layanan: which services the map shows.
 *
 * Only that. The map's own layers — route lines, stops, buildings, cameras —
 * were in this panel too, under the filters and the map style, and a panel
 * holding three different kinds of thing read as a settings dump. They have a
 * panel of their own now (`map-layers.js`), and the map style is a control in
 * the map's corner (`map-style.js`), where Google Maps keeps it.
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

    constructor(fleet, {onCategoryToggle}) {
        const me = this;

        me.fleet = fleet;
        me.onCategoryToggle = onCategoryToggle;
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div'),
            counts = me._countRoutes(),
            groups = me._groupByMode(counts);

        // What the summary counts against: the routes this panel can filter,
        // which is every route a listed category holds.
        me._counts = counts;
        me._total = groups.reduce((total, group) => total + group.count, 0);

        el.className = 'panel fold-panel';
        el.id = 'layers';
        el.innerHTML = `
            ${foldHead({id: 'layers', glyph: 'saring', title: 'Layanan'})}
            <div class="fold-body" id="layers-body">
            ${groups.map(group => `
                <div class="mode-group" data-mode="${group.id}">
                    <div class="mode-head js-mode">
                        ${icon(MODE_GLYPH[group.id] || 'bus', 'mode-icon')}
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
            </div>
        `;
        document.body.appendChild(el);

        el.querySelector('.js-fold').addEventListener('click', () => me.toggle());
        me._summarise();

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
                me._summarise();
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
                me._summarise();
            });
        }
    }

    /**
     * While the lines are coloured by frequency, the category swatches no
     * longer describe them, so they step back.
     *
     * The whole list used to be hidden instead, which was fine while the
     * frequency legend sat in this panel to take its place. With the legend
     * gone to Lapisan peta, hiding the filters would leave Layanan empty — and
     * the filters still filter, whatever colour the lines are.
     */
    setColouring(byHeadway) {
        this.el.classList.toggle('by-headway', byHeadway);
        return this;
    }

    /** Reflects a category's visibility in the UI, without firing callbacks. */
    setCategoryUI(category, visible) {
        const row = this.el.querySelector(`.cat[data-cat="${category}"]`);

        if (row) {
            row.classList.toggle('off', !visible);
        }
        this._summarise();
        return this;
    }

    /** Folds the panel down to its header bar, or back open. */
    toggle(folded) {
        setFolded(this.el, folded);
        return this;
    }

    /**
     * How much of the network the filters are holding, for the header.
     *
     * "249 rute" when nothing is hidden, "180 dari 249 rute" when something
     * is — so a folded panel still says that a filter is on, which is the one
     * thing worth knowing about it without opening it.
     */
    _summarise() {
        const me = this,
            summary = me.el.querySelector('.js-summary');
        let shown = 0;

        for (const row of me.el.querySelectorAll('.cat[data-cat]')) {
            if (me.fleet.isCategoryVisible(row.dataset.cat)) {
                shown += me._counts.get(row.dataset.cat) || 0;
            }
        }
        summary.textContent = shown === me._total ?
            `${me._total} rute` :
            `${shown} dari ${me._total} rute`;
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
