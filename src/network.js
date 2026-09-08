import configs from './configs';

/**
 * Loads the prebuilt network bundle and exposes the geometry queries the
 * simulation needs.
 *
 * The bundle is produced by scripts/build-data.mjs; shape vertices arrive as
 * delta-encoded integers in a side-car binary rather than inside the JSON,
 * which keeps 164k coordinate pairs down to about a megabyte.
 */

const DEG_TO_RAD = Math.PI / 180;

export default class Network {

    /**
     * The multi-modal path: manifest, core, then one mode at a time.
     *
     * Behind `?data=artifacts` while both pipelines exist, so the bus-only
     * build stays one reload away and the two can be compared rather than
     * swapped on faith.
     */
    static async loadArtifacts(onProgress = () => {}, options = {}) {
        const {loadArtifactBundle} = await import('./data/network-artifacts'),
            {meta, shapeBuffer, lines} = await loadArtifactBundle('artifacts/', {
                ...options,
                onProgress
            });

        onProgress('Menyiapkan geometri rute…');
        return new Network(meta, shapeBuffer, lines);
    }

    static async load(onProgress = () => {}) {
        onProgress('Memuat jaringan…');

        const [meta, shapeBuffer, lines] = await Promise.all([
            fetch('data/network.json').then(r => r.json()),
            fetch('data/shapes.bin').then(r => r.arrayBuffer()),
            fetch('data/routes.geojson').then(r => r.json())
        ]);

        onProgress('Menyiapkan geometri rute…');
        return new Network(meta, shapeBuffer, lines);
    }

    constructor(meta, shapeBuffer, lines) {
        const me = this;

        me.agency = meta.agency;
        me.timezone = meta.timezone;
        me.calendar = meta.calendar;
        me.lines = lines;

        me.routes = new Map(meta.routes.map(r => [r.id, r]));
        me.fares = meta.fares;
        me.transfers = meta.transfers;
        me.walk = meta.walk;
        me.stops = new Map(meta.stops.map(s => ({
            id: s.i,
            name: s.n,
            lat: s.y,
            lon: s.x,
            station: !!s.s,
            accessible: !!s.a,
            parent: s.p
        })).map(s => [s.id, s]));

        me._decodeShapes(meta, shapeBuffer);
        me._buildTrips(meta);
        me._buildStopIndex();
        me._buildStopGroups();
    }

    // Undo the delta encoding into one flat coordinate array, then record where
    // each shape begins and precompute its cumulative length so a distance
    // along the shape can be resolved by binary search.
    _decodeShapes(meta, buffer) {
        const me = this,
            deltas = new Int32Array(buffer),
            scale = meta.coordScale,
            coords = me.coords = new Float64Array(deltas.length);
        let lon = 0,
            lat = 0;

        for (let i = 0; i < deltas.length; i += 2) {
            lon += deltas[i];
            lat += deltas[i + 1];
            coords[i] = lon / scale;
            coords[i + 1] = lat / scale;
        }

        // Mercator x/y in [0, 1], the space Mapbox's projection matrix works
        // in. Precomputing it here keeps the per-frame work to a lerp.
        const merc = me.merc = new Float64Array(deltas.length);

        for (let i = 0; i < coords.length; i += 2) {
            merc[i] = (coords[i] + 180) / 360;
            merc[i + 1] = (180 - Math.log(
                Math.tan(Math.PI / 4 + coords[i + 1] * DEG_TO_RAD / 2)
            ) / DEG_TO_RAD) / 360;
        }

        const cum = me.cum = new Float32Array(deltas.length / 2);

        me.shapes = new Map();
        for (const shape of meta.shapes) {
            const {start, count} = shape;

            cum[start] = 0;
            for (let i = 1; i < count; i++) {
                const j = (start + i) * 2,
                    // Local planar approximation; Jakarta spans half a degree,
                    // where the error is far below a metre.
                    dx = (coords[j] - coords[j - 2]) * 110.6 *
                        Math.cos(coords[j + 1] * DEG_TO_RAD),
                    dy = (coords[j + 1] - coords[j - 1]) * 110.574;

                cum[start + i] = cum[start + i - 1] + Math.sqrt(dx * dx + dy * dy);
            }
            me.shapes.set(shape.id, {id: shape.id, start, count});
        }
    }

    _buildTrips(meta) {
        const me = this;

        me.trips = meta.trips.map((t, index) => {
            const stopCount = t.stops.length,
                // Offsets ship in metres as integers; the simulation works in
                // kilometres, matching the cumulative-distance table.
                offsets = new Float32Array(stopCount),
                arrivals = new Int32Array(t.arrivals),
                departures = new Int32Array(t.departures);

            for (let i = 0; i < stopCount; i++) {
                offsets[i] = t.offsets[i] / 1000;
            }

            const trip = {
                index,
                id: t.id,
                route: t.route,
                service: t.service,
                shape: me.shapes.get(t.shape),
                headsign: t.headsign,
                direction: t.direction,
                stops: t.stops,
                offsets,
                arrivals,
                departures,
                windows: t.windows,
                duration: arrivals[stopCount - 1]
            };

            trip.accelFractions = me._accelFractions(trip);
            return trip;
        });
        me.tripById = new Map(me.trips.map(t => [t.id, t]));
    }

    /**
     * For each leg between consecutive stops, the fraction of the leg's
     * duration spent accelerating (and, symmetrically, braking).
     *
     * Movement between stops follows a trapezoidal speed profile: accelerate
     * at a comfortable rate, hold, then brake. Given a leg of distance d
     * covered in time t, the accelerating fraction k satisfies
     * k(1 - k) = d / (a t^2). Short legs never reach cruising speed, which
     * shows up as no real root and is handled as a triangular profile.
     */
    _accelFractions(trip) {
        const {offsets, arrivals, departures} = trip,
            n = offsets.length,
            fractions = new Float32Array(Math.max(0, n - 1)),
            // Per mode: a heavy EMU pulls away slower than a metro set, and
            // both differ from a bus. Falls back where a route carries no mode,
            // which is every route on the legacy bus-only path.
            mode = configs.modes[this.routes.get(trip.route)?.mode],
            // km/s^2, from the comfortable m/s^2 in the config.
            a = (mode?.acceleration ?? configs.acceleration) / 1000;

        for (let i = 0; i < n - 1; i++) {
            const d = offsets[i + 1] - offsets[i],
                t = arrivals[i + 1] - departures[i],
                ratio = t > 0 ? d / (a * t * t) : 1;

            fractions[i] = ratio >= 0.25 ?
                0.5 :
                (1 - Math.sqrt(1 - 4 * ratio)) / 2;
        }
        return fractions;
    }

    // Which routes call at each stop, for the stop detail panel.
    _buildStopIndex() {
        const me = this,
            index = me.routesByStop = new Map();

        for (const trip of me.trips) {
            for (const stopId of trip.stops) {
                let set = index.get(stopId);

                if (!set) {
                    index.set(stopId, set = new Set());
                }
                set.add(trip.route);
            }
        }
    }

    // BRT corridor stations are containers: stop_times references their
    // platforms, which point back at the station through parent_station.
    _buildStopGroups() {
        const children = this.children = new Map();

        for (const stop of this.stops.values()) {
            if (!stop.parent) {
                continue;
            }

            let list = children.get(stop.parent);

            if (!list) {
                children.set(stop.parent, list = []);
            }
            list.push(stop.id);
        }
    }

    /**
     * Every stop id a passenger standing at `stop` could board from.
     *
     * A station stands for all of its platforms, so that asking about
     * "Harmoni" answers with the services calling at Harmoni's bays rather
     * than with nothing.
     */
    stopIdsFor(stop) {
        const children = this.children.get(stop.id);

        return children ? [stop.id, ...children] : [stop.id];
    }

    /** The routes calling at a stop, or at any platform of a station. */
    routesAt(stop) {
        const routes = new Set();

        for (const id of this.stopIdsFor(stop)) {
            for (const route of this.routesByStop.get(id) || []) {
                routes.add(route);
            }
        }
        return routes;
    }

    /**
     * The fare for a route.
     *
     * Transjakarta prices by route rather than by distance, and a little over
     * 40% of the network - the Mikrotrans and Rusun services - is free.
     */
    fareForRoute(routeId) {
        const id = this.fares.byRoute[routeId];

        return id ? this.fares.attributes[id] : null;
    }

    /**
     * Walkable interchanges from a stop, as {stop, seconds}.
     *
     * The feed's own transfers.txt lists 7 pairs for the whole network; this
     * table is derived at build time from stop coordinates and holds 28,737
     * edges, which is what makes journey planning possible at all. Edges only
     * exist where the walk reaches a route the origin does not already serve.
     */
    walkTransfersFrom(stop) {
        const me = this,
            walk = me.walk;

        if (!walk) {
            return [];
        }

        // Boarding happens at the station, not at one of its platforms.
        const node = stop.parent || stop.id,
            index = (me._walkIndex ??= new Map(walk.ids.map((id, i) => [id, i]))).get(node);

        if (index === undefined) {
            return [];
        }

        const results = [];

        for (let i = walk.offsets[index]; i < walk.offsets[index + 1]; i++) {
            const target = me.stops.get(walk.ids[walk.targets[i]]);

            if (target) {
                results.push({stop: target, seconds: walk.seconds[i]});
            }
        }
        return results;
    }

    /** Official interchange walks from a stop, or from any platform of a station. */
    transfersFrom(stop) {
        const seen = new Set(this.stopIdsFor(stop)),
            results = [];

        for (const id of this.stopIdsFor(stop)) {
            for (const {to, minTime} of this.transfers[id] || []) {
                const target = this.stops.get(to);

                // Skip walks that lead back into the same station.
                if (!target || seen.has(to)) {
                    continue;
                }
                seen.add(to);
                results.push({stop: target, minTime});
            }
        }
        return results;
    }

    /**
     * Resolves a distance along a shape to a position and heading.
     *
     * `hint` is the vertex the caller looked at last time. Buses advance
     * monotonically, so resuming the search there turns a binary search into a
     * step or two of linear scan for almost every call.
     */
    locate(shape, distance, hint, out) {
        const {cum, merc} = this,
            {start, count} = shape,
            last = start + count - 1;
        let i = start + (hint || 0);

        if (i < start || i > last) {
            i = start;
        }
        if (cum[i] > distance) {
            i = start;
        }
        while (i < last && cum[i + 1] <= distance) {
            i++;
        }
        // Long jumps (a seek, or a bus wrapping to a new run) make the linear
        // walk above expensive, so fall back to a binary search when it stalls.
        if (i < last && cum[i + 1] <= distance) {
            let lo = i,
                hi = last;

            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;

                if (cum[mid] <= distance) {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            i = lo;
        }

        const j = Math.min(i, last - 1),
            span = cum[j + 1] - cum[j],
            t = span > 0 ? Math.min(1, Math.max(0, (distance - cum[j]) / span)) : 0,
            ax = merc[j * 2],
            ay = merc[j * 2 + 1],
            bx = merc[j * 2 + 2],
            by = merc[j * 2 + 3];

        out.x = ax + (bx - ax) * t;
        out.y = ay + (by - ay) * t;
        // Mercator y grows southward, so a north-bound leg has a negative dy.
        out.bearing = Math.atan2(bx - ax, ay - by);
        out.vertex = i - start;
        return out;
    }

    /**
     * The stretch of a shape between two distances along it, as coordinates.
     *
     * Used to draw one leg of a journey along the road the bus actually takes,
     * rather than a straight line between the boarding and alighting stops.
     */
    sliceShape(shape, fromDistance, toDistance) {
        const {cum, coords} = this,
            {start, count} = shape,
            points = [this.lngLatAt(shape, fromDistance)];

        for (let i = 0; i < count; i++) {
            const distance = cum[start + i];

            if (distance > fromDistance && distance < toDistance) {
                points.push([coords[(start + i) * 2], coords[(start + i) * 2 + 1]]);
            }
        }
        points.push(this.lngLatAt(shape, toDistance));
        return points;
    }

    lngLatAt(shape, distance) {
        const {cum, coords} = this,
            {start, count} = shape,
            last = start + count - 1;
        let i = start;

        while (i < last && cum[i + 1] <= distance) {
            i++;
        }

        const j = Math.min(i, last - 1),
            span = cum[j + 1] - cum[j],
            t = span > 0 ? (distance - cum[j]) / span : 0;

        return [
            coords[j * 2] + (coords[j * 2 + 2] - coords[j * 2]) * t,
            coords[j * 2 + 1] + (coords[j * 2 + 3] - coords[j * 2 + 1]) * t
        ];
    }

}
