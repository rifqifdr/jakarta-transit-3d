/**
 * The journey planner: picking two stops, ranking the results, drawing the
 * chosen one on the map.
 *
 * The card lives in the same slot as the bus and stop inspectors — they are
 * mutually exclusive contexts, and sharing the slot keeps the layout honest.
 *
 * Origin and destination used to need their own bar, because they could only be
 * set from a stop card and had to stay visible while you hunted for the second
 * one. The finder's two fields now hold that state and can be typed into
 * directly, so the bar had nothing left to say and was removed.
 */
import {formatClock} from './clock-control';
import {lineOf, routeCode, routeColor, routeMark} from '../kodefikasi';
import {formatFare} from '../routing/fares';
import {formatDuration} from './format';

// How results are ordered. "Cheapest" is a real axis on this network: 101 of
// 240 routes are free, and a premium leg can cost 5x a standard one.
const SORTS = [
    {id: 'fastest', label: 'Tercepat', compare: (a, b) => a.arrival - b.arrival},
    {id: 'transfers', label: 'Transit paling sedikit', compare: (a, b) =>
        a.rides - b.rides || a.arrival - b.arrival},
    {id: 'cheapest', label: 'Termurah', compare: (a, b) =>
        a.fare.total - b.fare.total || a.arrival - b.arrival}
];

const minutes = formatDuration;

export default class Journey {

    constructor({network, router, onChange}) {
        const me = this;

        me.network = network;
        me.router = router;
        me.onChange = onChange;

        me.from = null;
        me.to = null;
        me.results = [];
        me.selected = 0;
        me.sort = 'fastest';
        me.error = null;
    }

    get active() {
        return !!(this.from && this.to);
    }

    get pending() {
        return !!(this.from && !this.to) || !!(this.to && !this.from);
    }

    /** Sets one end of the journey and replans when both are known. */
    setEnd(which, stop, time, dayOfWeek) {
        const me = this;

        me[which] = stop;
        me.selected = 0;
        if (me.from && me.to) {
            me.plan(time, dayOfWeek);
        } else {
            me.results = [];
            me.error = null;
        }
        me.onChange();
        return me;
    }

    clear() {
        const me = this;

        me.from = me.to = null;
        me.results = [];
        me.error = null;
        me.onChange();
        return me;
    }

    plan(time, dayOfWeek) {
        const me = this,
            result = me.router.plan({
                from: me.from,
                to: me.to,
                time: Math.floor(time),
                dayOfWeek
            });

        me.results = result.itineraries;
        me.error = result.error || null;
        me.time = time;
        me.sortResults();
        return me;
    }

    sortResults() {
        const me = this,
            sort = SORTS.find(s => s.id === me.sort);

        me.results = [...me.results].sort(sort.compare);
        return me;
    }

    get chosen() {
        return this.results[this.selected] || null;
    }

    /**
     * Reverses the journey. Kept here rather than in the finder because
     * swapping has to replan, and the planner is what knows the clock.
     */
    swap(time, dayOfWeek) {
        const me = this,
            from = me.from;

        me.from = me.to;
        me.to = from;
        me.selected = 0;
        if (me.from && me.to) {
            me.plan(time ?? me.time, dayOfWeek ?? me.dayOfWeek ?? new Date().getUTCDay());
        }
        me.onChange();
        return me;
    }

    // ------------------------------------------------------- results card

    /** Renders the itinerary list into the shared detail panel. */
    renderInto(el) {
        const me = this;

        if (me.error || !me.results.length) {
            el.innerHTML = `
                <div class="detail-head">
                    <div>
                        <div class="detail-title">${me.from.name} → ${me.to.name}</div>
                        <div class="detail-sub">${me._errorText()}</div>
                    </div>
                    <button class="detail-close" type="button" title="Tutup">&times;</button>
                </div>
            `;
            return;
        }

        const options = SORTS.map(s =>
            `<button class="btn btn-sm js-sort ${s.id === me.sort ? 'on' : ''}" data-sort="${s.id}">${s.label}</button>`
        ).join('');

        el.innerHTML = `
            <div class="detail-head">
                <div>
                    <div class="detail-title">${me.from.name} → ${me.to.name}</div>
                    <div class="detail-sub">
                        Berangkat ${formatClock(me.time)} &middot; ${me.results.length} pilihan
                    </div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="sorts">${options}</div>
            <div class="detail-body">
                ${me.results.map((itinerary, index) => me._card(itinerary, index)).join('')}
            </div>
        `;
    }

    _errorText() {
        const me = this;

        if (me.error === 'same-stop') {
            return 'Titik awal dan tujuan sama.';
        }
        if (me.error === 'unknown-stop') {
            return 'Halte tidak dikenal.';
        }
        // Service runs 00:00-23:59, so an empty result is nearly always about
        // the hour rather than the geography.
        return 'Tidak ada rute pada jam ini. Coba ubah waktu keberangkatan.';
    }

    _card(itinerary, index) {
        const me = this,
            selected = index === me.selected,
            legs = itinerary.legs.map(leg => {
                if (leg.type === 'walk') {
                    return `<span class="leg walk">${minutes(leg.seconds)} jalan</span>`;
                }

                const route = me.network.routes.get(leg.route);

                // No glyph on a leg chip: three of them wrap at 390px as it
                // is, and the itinerary is read as a sequence of codes. A
                // coded line still wears its ring here, or rail would be a
                // disc in the summary and a ring everywhere else.
                const coded = lineOf(route),
                    color = routeColor(route);

                return `<span class="leg ride${coded ? ' leg-line' : ''}" style="--mark:${
                    color}${coded ? '' : `;background:${color}`}">${routeCode(route)}</span>`;
            }).join('<span class="leg-sep">›</span>');

        return `
            <div class="itin ${selected ? 'on' : ''}" data-index="${index}">
                <div class="itin-top">
                    <span class="itin-time">${minutes(itinerary.duration)}</span>
                    <span class="itin-clock">${formatClock(itinerary.departure)} – ${formatClock(itinerary.arrival)}</span>
                    <span class="itin-fare ${itinerary.fare.total === 0 ? 'free' : ''}">${formatFare(itinerary.fare.total)}</span>
                </div>
                <div class="itin-legs">${legs}</div>
                <div class="itin-meta">
                    ${itinerary.transfers === 0 ? 'Langsung' : `${itinerary.transfers} transit`}
                    ${itinerary.fare.singleTap && itinerary.rides > 1 ? ' &middot; sekali tap' : ''}
                    ${itinerary.legs[0].wait > 0 ? ` &middot; tunggu ${minutes(itinerary.legs[0].wait)}` : ''}
                </div>
                ${selected ? me._detail(itinerary) : ''}
                ${selected ? '<button class="btn btn-accent btn-lg btn-block js-ride" type="button">Jalankan perjalanan</button>' : ''}
            </div>
        `;
    }

    // The expanded step-by-step view for whichever itinerary is selected.
    _detail(itinerary) {
        const me = this,
            rows = itinerary.legs.map(leg => {
                const from = me.network.stops.get(leg.from),
                    to = me.network.stops.get(leg.to);

                /*
                   Two rows, not one: the mark and the time take the top line
                   with the whole width between them, and the stops sit under
                   it. Side by side the three fought over a 344px rail, which
                   is what kept the departure time at 11px — the one number on
                   the step somebody is actually reading.
                */
                if (leg.type === 'walk') {
                    return `
                        <div class="step walk">
                            <div class="step-top">
                                <span class="step-icon">⇢</span>
                                <span class="t">${minutes(leg.seconds)}</span>
                            </div>
                            <div class="step-body">${
                                leg.fromPoint ? 'Jalan dari titik Anda ke' : 'Jalan ke'}
                                <strong>${to ? to.name : leg.to}</strong></div>
                        </div>
                    `;
                }

                const route = me.network.routes.get(leg.route);

                // The headsign and the stop count are dropped deliberately.
                // Where you get on and where you get off is what a step is
                // for; the rest was three lines of prose per leg, and four
                // legs of it read as a paragraph rather than a journey.
                return `
                    <div class="step">
                        <div class="step-top">
                            ${routeMark(route)}
                            <span class="t">${formatClock(leg.departure)}</span>
                        </div>
                        <div class="step-body">
                            <div>Naik di <strong>${from ? from.name : leg.from}</strong></div>
                            <div>Turun di <strong>${to ? to.name : leg.to}</strong></div>
                        </div>
                    </div>
                `;
            }).join('');

        return `<div class="steps">${rows}</div>`;
    }

    /**
     * The chosen itinerary as GeoJSON.
     *
     * Ride legs follow the route's real geometry, sliced between the boarding
     * and alighting stops; walk legs are a straight line, which is honest about
     * how little the feed knows about pavements.
     */
    toGeoJSON() {
        const me = this,
            itinerary = me.chosen,
            features = [];

        if (!itinerary) {
            return {type: 'FeatureCollection', features};
        }

        for (const leg of itinerary.legs) {
            const from = me.network.stops.get(leg.from),
                to = me.network.stops.get(leg.to);

            if (leg.type === 'walk') {
                // A journey that began at a tapped point has no origin stop.
                if (leg.fromPoint && to) {
                    features.push({
                        type: 'Feature',
                        properties: {kind: 'walk'},
                        geometry: {
                            type: 'LineString',
                            coordinates: [leg.fromPoint, [to.lon, to.lat]]
                        }
                    });
                    continue;
                }
                if (from && to) {
                    features.push({
                        type: 'Feature',
                        properties: {kind: 'walk'},
                        geometry: {
                            type: 'LineString',
                            coordinates: [[from.lon, from.lat], [to.lon, to.lat]]
                        }
                    });
                }
                continue;
            }

            const trip = me.network.tripById.get(leg.trip);

            if (!trip) {
                continue;
            }

            const route = me.network.routes.get(leg.route),
                coordinates = me.network.sliceShape(
                    trip.shape,
                    trip.offsets[leg.boardIndex],
                    trip.offsets[leg.alightIndex]
                );

            features.push({
                type: 'Feature',
                properties: {
                    kind: 'ride',
                    color: routeColor(route)
                },
                geometry: {type: 'LineString', coordinates}
            });
        }

        // Endpoints of every leg, so boarding and alighting points are visible.
        for (const leg of itinerary.legs) {
            for (const [id, role] of [[leg.from, 'board'], [leg.to, 'alight']]) {
                const stop = me.network.stops.get(id);

                if (stop) {
                    features.push({
                        type: 'Feature',
                        properties: {kind: 'point', role, name: stop.name},
                        geometry: {type: 'Point', coordinates: [stop.lon, stop.lat]}
                    });
                }
            }
        }
        return {type: 'FeatureCollection', features};
    }

}

export {SORTS};
