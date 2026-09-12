import {routeCode, routeMark, stopMark} from '../kodefikasi';

/**
 * The finder: one field, over everything on the map.
 *
 * It used to be two tabs, because the app asked two different questions and a
 * mixed list made both ambiguous — typing "Bogor" returned a corridor and
 * eleven stations with no way to say which you meant. That ambiguity was never
 * really about the list. It was about what happened *next*: a stop was an
 * origin to plan from, a line was a thing to look at, and the two could not be
 * told apart by looking.
 *
 * With journey planning gone there is one next step — show me this — so one
 * list is unambiguous by construction, and the kind is carried by the mark:
 * a halte or stasiun glyph in a plate, against a line's ring or corridor
 * badge. The picture says which without a tab having to be chosen first.
 *
 * Trap 1 applies with force here. The shell is built exactly once. Only
 * `.results` is ever rewritten, and only on input, never between a mousedown
 * and its mouseup.
 */
export default class SearchControl {

    constructor(network, {onSelectRoute, onSelectStop, onClear}) {
        const me = this;

        me.network = network;
        me.onSelectRoute = onSelectRoute;
        me.onSelectStop = onSelectStop;
        me.onClear = onClear;

        // Stations stand in for their platforms so a search for "Harmoni"
        // returns one corridor station rather than a dozen bay entries.
        //
        // Stops no route serves are dropped. 43 of 8,281 are in the feeds and
        // never appear in a pattern — including a dead Transjakarta record for
        // "Manggarai", which sat in the results next to the real KRL station
        // reading "0 rute" and could not be planned to or from. Offering a stop
        // you cannot board at is worse than not listing it.
        me._stops = [...network.stops.values()].filter(s =>
            (s.station || !s.parent) && network.routesAt(s).size > 0
        );
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'panel';
        el.id = 'search';
        el.innerHTML = `
            <div class="field">
                <svg class="field-glyph" aria-hidden="true"><use href="#kf-cari"></use></svg>
                <input type="search" data-field="q" placeholder="Cari halte, stasiun atau jalur"
                       autocomplete="off" spellcheck="false" aria-label="Cari halte, stasiun atau jalur">
                <button class="field-clear" type="button" title="Bersihkan">&times;</button>
            </div>
            <div class="results"></div>
        `;
        document.body.appendChild(el);

        const results = el.querySelector('.results');

        me._results = results;

        el.addEventListener('click', event => {
            if (event.target.closest('.field-clear')) {
                me._input().value = '';
                me._clearResults();
                me.onClear();
            }
        });

        el.querySelector('input').addEventListener('input', event => {
            me._show(event.target.value.trim().toLowerCase());
        });

        // A result is chosen on mousedown-prevented click: without this the
        // input blurs before the click lands.
        results.addEventListener('mousedown', event => event.preventDefault());

        results.addEventListener('click', event => {
            const row = event.target.closest('.result');

            if (!row) {
                return;
            }
            if (row.dataset.kind === 'route') {
                me.onSelectRoute(me.network.routes.get(row.dataset.id));
            } else {
                me.onSelectStop(me.network.stops.get(row.dataset.id));
            }
            me._clearResults();
        });
    }

    _input() {
        return this.el.querySelector('input');
    }

    _clearResults() {
        this._results.innerHTML = '';
    }

    _show(query) {
        const me = this;

        me._results.innerHTML = !query ? '' : me._match(query)
            .map(item => `
                <div class="result" data-kind="${item.kind}" data-id="${item.id}">
                    ${item.mark}
                    <span>
                        <div>${item.title}</div>
                        <div class="meta">${item.meta}</div>
                    </span>
                </div>
            `).join('');
    }

    _match(query) {
        const me = this,
            rows = [];

        for (const route of me.network.routes.values()) {
            const short = (route.shortName || '').toLowerCase(),
                code = routeCode(route).toLowerCase(),
                long = (route.longName || '').toLowerCase();

            if (short.includes(query) || code.includes(query) || long.includes(query)) {
                rows.push({
                    kind: 'route',
                    id: route.id,
                    mark: routeMark(route),
                    // An exact or prefix hit on the code is nearly always what
                    // was meant: `C` and `1` are the shortest queries there are.
                    rank: code === query || short === query ? 0
                        : code.startsWith(query) || short.startsWith(query) ? 1 : 3,
                    title: route.longName || route.shortName,
                    meta: route.category
                });
            }
        }

        for (const stop of me._stops) {
            const name = stop.name.toLowerCase();

            if (name.includes(query)) {
                rows.push({
                    kind: 'stop',
                    id: stop.id,
                    mark: stopMark(stop),
                    rank: name.startsWith(query) ? 2 : 4,
                    title: stop.name,
                    meta: `${me.network.routesAt(stop).size} rute`
                });
            }
        }
        return rows
            .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
            .slice(0, 14);
    }

}
