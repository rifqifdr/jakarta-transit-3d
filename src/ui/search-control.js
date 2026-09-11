import {routeCode, routeMark, stopMark} from '../kodefikasi';

/**
 * The finder: one panel at the top of the left rail, in two modes.
 *
 * The app answers two different questions and they want different searches.
 * "How do I get from here to there" wants stops and wants two of them;
 * "what is the Bogor line" wants a route and wants one. Mixing both into a
 * single result list made every query ambiguous - typing "Bogor" returned a
 * corridor and eleven stations with no way to say which kind you meant.
 *
 * So the mode is chosen first and the result list is unambiguous by
 * construction. Navigation mode owns the origin and destination fields, which
 * is why the old pending-origin bar is gone: the fields *are* the bar, and they
 * are editable, which the bar never was.
 *
 * Trap 1 applies with force here. The shell - tabs, inputs, buttons - is built
 * exactly once. Only `.results` is ever rewritten, and only on input, never
 * between a mousedown and its mouseup.
 */
export default class SearchControl {

    constructor(network, {onSelectRoute, onSetEnd, onSwap, onClear}) {
        const me = this;

        me.network = network;
        me.onSelectRoute = onSelectRoute;
        me.onSetEnd = onSetEnd;
        me.onSwap = onSwap;
        me.onClear = onClear;

        me.mode = 'nav';
        // Which field a result should land in. Held rather than read from
        // document.activeElement, because clicking a result blurs the input
        // before the handler runs.
        me.field = 'from';

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
            <div class="finder-tabs">
                <button class="finder-tab on" type="button" data-mode="nav">Navigasi</button>
                <button class="finder-tab" type="button" data-mode="line">Jalur</button>
            </div>
            <div class="finder-pane" data-pane="nav">
                <div class="field">
                    <span class="jb-dot from"></span>
                    <input type="search" data-field="from" placeholder="Titik awal"
                           autocomplete="off" spellcheck="false">
                    <button class="field-swap" type="button" title="Tukar arah">⇅</button>
                </div>
                <div class="field">
                    <span class="jb-dot to"></span>
                    <input type="search" data-field="to" placeholder="Tujuan"
                           autocomplete="off" spellcheck="false">
                    <button class="field-clear" type="button" title="Bersihkan">&times;</button>
                </div>
            </div>
            <div class="finder-pane" data-pane="line" hidden>
                <div class="field">
                    <span class="jb-dot line"></span>
                    <input type="search" data-field="line" placeholder="Cari jalur atau koridor…"
                           autocomplete="off" spellcheck="false">
                </div>
            </div>
            <div class="results"></div>
        `;
        document.body.appendChild(el);

        const results = el.querySelector('.results');

        me._results = results;

        el.addEventListener('click', event => {
            const tab = event.target.closest('.finder-tab');

            if (tab) {
                me.setMode(tab.dataset.mode);
                return;
            }
            if (event.target.closest('.field-swap')) {
                me.onSwap();
                return;
            }
            if (event.target.closest('.field-clear')) {
                me._clearResults();
                me.onClear();
            }
        });

        for (const input of el.querySelectorAll('input')) {
            input.addEventListener('focus', () => {
                me.field = input.dataset.field;
            });
            input.addEventListener('input', () => {
                me.field = input.dataset.field;
                me._show(input.value.trim().toLowerCase());
            });
        }

        // A result is chosen on mousedown-prevented click: without this the
        // input blurs first, and on a two-field form that blur can move the
        // target field out from under the selection.
        results.addEventListener('mousedown', event => event.preventDefault());

        results.addEventListener('click', event => {
            const row = event.target.closest('.result');

            if (!row) {
                return;
            }
            if (row.dataset.kind === 'route') {
                me.onSelectRoute(me.network.routes.get(row.dataset.id));
            } else {
                const stop = me.network.stops.get(row.dataset.id),
                    field = me.field === 'to' ? 'to' : 'from';

                me._input(field).value = stop.name;
                me.onSetEnd(field, stop);

                // Filling the origin almost always means filling the
                // destination next, so go there rather than making them click.
                if (field === 'from' && !me._input('to').value) {
                    me.field = 'to';
                    me._input('to').focus();
                }
            }
            me._clearResults();
        });
    }

    _input(field) {
        return this.el.querySelector(`input[data-field="${field}"]`);
    }

    _clearResults() {
        this._results.innerHTML = '';
    }

    setMode(mode) {
        const me = this;

        if (me.mode === mode) {
            return;
        }
        me.mode = mode;
        me.field = mode === 'line' ? 'line' : 'from';
        for (const tab of me.el.querySelectorAll('.finder-tab')) {
            tab.classList.toggle('on', tab.dataset.mode === mode);
        }
        for (const pane of me.el.querySelectorAll('.finder-pane')) {
            pane.hidden = pane.dataset.pane !== mode;
        }
        me._clearResults();
        me._input(mode === 'line' ? 'line' : 'from').focus();
    }

    /** Reflects journey state that was set elsewhere - a map click, or a link. */
    syncEnds(from, to) {
        const me = this;

        me._input('from').value = from ? from.name : '';
        me._input('to').value = to ? to.name : '';
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
            routes = [],
            stops = [];

        if (me.mode === 'line') {
            for (const route of me.network.routes.values()) {
                const short = (route.shortName || '').toLowerCase(),
                    long = (route.longName || '').toLowerCase();

                if (short.includes(query) || long.includes(query)) {
                    routes.push({
                        kind: 'route',
                        id: route.id,
                        badge: routeCode(route),
                        mark: routeMark(route),
                        // Exact and prefix matches on the route number are what
                        // a rider usually means, so rank those first.
                        rank: short === query ? 0 : short.startsWith(query) ? 1 : 2,
                        title: route.longName || route.shortName,
                        meta: route.category
                    });
                }
            }
            return routes.sort((a, b) => a.rank - b.rank || a.badge.localeCompare(b.badge)).slice(0, 12);
        }

        for (const stop of me._stops) {
            const name = stop.name.toLowerCase();

            if (name.includes(query)) {
                stops.push({
                    kind: 'stop',
                    id: stop.id,
                    badge: stop.station ? 'ST' : 'H',
                    mark: stopMark(stop),
                    rank: name.startsWith(query) ? 0 : 1,
                    title: stop.name,
                    meta: `${me.network.routesAt(stop).size} rute`
                });
            }
        }
        return stops.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).slice(0, 12);
    }

}
