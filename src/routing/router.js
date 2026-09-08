/**
 * Journey planning over the network timetable.
 *
 * Mode-agnostic by construction: RAPTOR sees patterns, stops and times, so a
 * train is the same shape of thing as a bus and rail extends this without
 * structural change.
 *
 * Implements RAPTOR: instead of building a time-expanded graph and running
 * Dijkstra over it, the search proceeds in rounds, each round scanning every
 * trip pattern reachable from the stops improved in the previous one. Two
 * reasons that suits this feed:
 *
 *   1. A round is exactly one additional ride, so the round index *is* the
 *      transfer count — the thing riders care about — instead of something to
 *      reconstruct afterwards.
 *   2. There is no graph to materialise. The 700 patterns and their stop
 *      sequences are already in memory.
 *
 * The search runs over *nodes* rather than raw stops: a BRT station stands for
 * all of its platforms, matching how boarding actually works and how the walk
 * transfer table is built.
 */
import {nextDeparture, servesOn} from './timetable.js';
import {fareForLegs, fareForRoute} from './fares.js';

const INFINITY = Number.POSITIVE_INFINITY,

    // Up to three transfers. Beyond that a journey stops being one anybody
    // would accept, and each extra round costs a full pattern scan.
    DEFAULT_MAX_ROUNDS = 4,

    // Charged on top of the walk itself, for finding the other stop and the
    // uncertainty of making the connection.
    TRANSFER_PENALTY_S = 60,

    // How far someone will walk to reach their first stop. Larger than the
    // 400 m transfer radius on purpose - starting a journey is worth more
    // effort than a connection halfway through one.
    ACCESS_RADIUS_M = 800,

    // 4.8 km/h.
    WALK_SPEED_MPS = 4.8 * 1000 / 3600;

export default class Router {

    constructor(network) {
        const me = this;

        me.network = network;
        me._build();
    }

    /**
     * Indexes the network into the flat arrays the search walks.
     *
     * Nodes come from the walk table, which already collapses platforms into
     * their station and covers every stop with service.
     */
    _build() {
        const me = this,
            {network} = me,
            walk = network.walk;

        me.nodeIds = walk.ids;
        me.nodeIndex = new Map(walk.ids.map((id, i) => [id, i]));
        me.nodeCount = walk.ids.length;

        // Patterns, with their stop sequence expressed in node indices.
        me.patterns = network.trips.map(trip => {
            const nodes = new Int32Array(trip.stops.length);

            for (let i = 0; i < trip.stops.length; i++) {
                const stop = network.stops.get(trip.stops[i]),
                    nodeId = stop && stop.parent ? stop.parent : trip.stops[i];

                nodes[i] = me.nodeIndex.get(nodeId) ?? -1;
            }
            const fare = fareForRoute(network, trip.route);

            return {trip, nodes, free: !!fare && fare.price === 0};
        });

        // Which patterns call at each node, and at which position.
        const byNode = me.patternsByNode = Array.from(
            {length: me.nodeCount}, () => []
        );

        for (let p = 0; p < me.patterns.length; p++) {
            const nodes = me.patterns[p].nodes;

            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i] >= 0) {
                    byNode[nodes[i]].push(p, i);
                }
            }
        }
    }

    /**
     * A coarse grid over the network, so an arbitrary map point can find the
     * stops around it without scanning all 7,488.
     */
    _buildGrid() {
        const me = this,
            grid = me._grid = new Map();

        me._cell = 0.005;
        for (let i = 0; i < me.nodeCount; i++) {
            const stop = me.network.stops.get(me.nodeIds[i]);

            if (!stop) {
                continue;
            }

            const key = `${Math.floor(stop.lon / me._cell)}:${Math.floor(stop.lat / me._cell)}`;
            let cell = grid.get(key);

            if (!cell) {
                grid.set(key, cell = []);
            }
            cell.push(i);
        }
    }

    /**
     * Stops within walking distance of a point, nearest first.
     *
     * The radius is deliberately larger than the 400 m used for transfers:
     * people will walk further to start a journey than they will halfway
     * through one.
     */
    nearestNodes(lon, lat, radiusM = ACCESS_RADIUS_M, limit = 6) {
        const me = this;

        if (!me._grid) {
            me._buildGrid();
        }

        const cosLat = Math.cos(lat * Math.PI / 180),
            mPerDegLat = 110574,
            mPerDegLon = 111320 * cosLat,
            span = Math.ceil(radiusM / (mPerDegLat * me._cell)),
            gx = Math.floor(lon / me._cell),
            gy = Math.floor(lat / me._cell),
            found = [];

        for (let dx = -span; dx <= span; dx++) {
            for (let dy = -span; dy <= span; dy++) {
                for (const index of me._grid.get(`${gx + dx}:${gy + dy}`) || []) {
                    const stop = me.network.stops.get(me.nodeIds[index]),
                        metres = Math.hypot(
                            (stop.lon - lon) * mPerDegLon,
                            (stop.lat - lat) * mPerDegLat
                        );

                    if (metres <= radiusM) {
                        found.push({
                            node: index,
                            stop,
                            metres: Math.round(metres),
                            seconds: Math.round(metres / WALK_SPEED_MPS)
                        });
                    }
                }
            }
        }
        found.sort((a, b) => a.metres - b.metres);
        return found.slice(0, limit);
    }

    /** Resolves a stop, stop id or node id to a node index. */
    nodeOf(stop) {
        const id = typeof stop === 'string' ? stop : stop.id,
            resolved = this.network.stops.get(id),
            nodeId = resolved && resolved.parent ? resolved.parent : id;

        return this.nodeIndex.get(nodeId) ?? -1;
    }

    /**
     * The core round-based search.
     *
     * Returns the per-round arrival times and the parent pointers needed to
     * reconstruct a journey. `target` may be -1 to explore the whole network,
     * which is what a reachability map wants.
     */
    _search({origin, seeds, target, time, dayOfWeek, maxRounds, maxSeconds, freeOnly = false}) {
        const me = this,
            {patterns, patternsByNode, network} = me,
            n = me.nodeCount,
            best = new Float64Array(n).fill(INFINITY),
            rounds = [],
            parents = [];
        let previous = new Float64Array(n).fill(INFINITY),
            marked = new Set();

        // Only patterns running today are worth scanning. `freeOnly` narrows
        // that to the 101 routes that cost nothing — walking stays free either
        // way, so the walk table is left alone.
        const running = patterns.map(({trip, free}) =>
            servesOn(trip, network.calendar, dayOfWeek) && (!freeOnly || free));

        const walk = network.walk,
            access = new Array(n).fill(null);

        // A journey may begin on foot, from a stop or from an arbitrary point.
        // Walk relaxation between rounds only ever sees nodes a ride improved,
        // so without seeding here the search could reach a better stop 200 m
        // away only after boarding something first — which is to say, never.
        //
        // No transfer penalty is charged: there is no connection to miss, you
        // are simply setting off.
        for (const seed of seeds) {
            if (seed.seconds > 0 && time + seed.seconds >= best[seed.node]) {
                continue;
            }
            best[seed.node] = time + seed.seconds;
            previous[seed.node] = time + seed.seconds;
            marked.add(seed.node);
            if (seed.seconds > 0) {
                access[seed.node] = {seconds: seed.seconds};
            }
        }

        // From a stop, the walk table supplies the neighbours worth starting at.
        if (origin >= 0) {
            for (let i = walk.offsets[origin]; i < walk.offsets[origin + 1]; i++) {
                const to = walk.targets[i],
                    arrival = time + walk.seconds[i];

                if (arrival < best[to]) {
                    best[to] = arrival;
                    previous[to] = arrival;
                    marked.add(to);
                    access[to] = {seconds: walk.seconds[i]};
                }
            }
        }

        const limit = maxSeconds === undefined ? INFINITY : time + maxSeconds,
            // Pruning bound: never explore anything that cannot beat the best
            // known arrival at the target (or the time budget, when exploring).
            bound = () => Math.min(
                target >= 0 ? best[target] : INFINITY,
                limit
            );

        for (let round = 1; round <= maxRounds && marked.size; round++) {
            const current = Float64Array.from(previous),
                parent = new Array(n).fill(null),
                nextMarked = new Set();

            // Every pattern touching a marked node, entered at the earliest
            // position any marked node occupies.
            const entry = new Map();

            for (const node of marked) {
                const list = patternsByNode[node];

                for (let i = 0; i < list.length; i += 2) {
                    const pattern = list[i],
                        position = list[i + 1];

                    if (!running[pattern]) {
                        continue;
                    }

                    const existing = entry.get(pattern);

                    if (existing === undefined || position < existing) {
                        entry.set(pattern, position);
                    }
                }
            }

            // Ride each pattern from its entry point, hopping to an earlier
            // run whenever one becomes catchable further along.
            for (const [patternIndex, from] of entry) {
                const {trip, nodes} = patterns[patternIndex];
                let runStart = null,
                    boardAt = -1;

                for (let i = from; i < nodes.length; i++) {
                    const node = nodes[i];

                    if (node < 0) {
                        continue;
                    }

                    if (runStart !== null) {
                        const arrival = runStart + trip.arrivals[i];

                        if (arrival < Math.min(best[node], bound())) {
                            best[node] = arrival;
                            current[node] = arrival;
                            parent[node] = {
                                type: 'ride',
                                pattern: patternIndex,
                                runStart,
                                boardIndex: boardAt,
                                alightIndex: i,
                                from: nodes[boardAt]
                            };
                            nextMarked.add(node);
                        }
                    }

                    // Boarding uses the previous round's arrival, which is what
                    // keeps a round equal to exactly one ride.
                    const ready = previous[node];

                    if (ready === INFINITY) {
                        continue;
                    }

                    // A rider already aboard only switches to an earlier run.
                    const catchable = nextDeparture(trip, i, ready);

                    if (catchable && (runStart === null || catchable.runStart < runStart)) {
                        runStart = catchable.runStart;
                        boardAt = i;
                    }
                }
            }

            // Walking between nearby stops, which is where most of Jakarta's
            // real interchanges live.
            for (const node of [...nextMarked]) {
                const arrival = current[node];

                for (let i = me.network.walk.offsets[node]; i < me.network.walk.offsets[node + 1]; i++) {
                    const to = me.network.walk.targets[i],
                        viaWalk = arrival + me.network.walk.seconds[i] + TRANSFER_PENALTY_S;

                    if (viaWalk < Math.min(best[to], bound())) {
                        best[to] = viaWalk;
                        current[to] = viaWalk;
                        parent[to] = {
                            type: 'walk',
                            from: node,
                            seconds: me.network.walk.seconds[i]
                        };
                        nextMarked.add(to);
                    }
                }
            }

            rounds.push(current);
            parents.push(parent);
            previous = current;
            marked = nextMarked;
        }
        return {best, rounds, parents, access};
    }

    /**
     * Plans journeys from one stop to another.
     *
     * Returns a Pareto set: the best itinerary for each number of rides, so a
     * slower journey survives only if it uses fewer transfers.
     */
    plan({from, to, time, dayOfWeek, maxRounds = DEFAULT_MAX_ROUNDS}) {
        const me = this,
            // `from` may be a stop, a stop id, or a {lon, lat} point tapped on
            // the map — in which case the journey starts with a walk to
            // whichever stops are within reach.
            point = from && from.lon !== undefined && from.id === undefined ? from : null,
            origin = point ? -1 : me.nodeOf(from),
            target = me.nodeOf(to);

        let seeds;

        if (point) {
            seeds = me.nearestNodes(point.lon, point.lat);
            if (!seeds.length) {
                return {error: 'nothing-nearby', itineraries: []};
            }
        } else {
            if (origin < 0) {
                return {error: 'unknown-stop', itineraries: []};
            }
            seeds = [{node: origin, seconds: 0}];
        }

        if (target < 0) {
            return {error: 'unknown-stop', itineraries: []};
        }
        if (origin >= 0 && origin === target) {
            return {error: 'same-stop', itineraries: []};
        }

        const {rounds, parents, access} = me._search({
                origin, seeds, target, time, dayOfWeek, maxRounds
            }),
            itineraries = [];
        let bestSoFar = INFINITY;

        for (let round = 0; round < rounds.length; round++) {
            const arrival = rounds[round][target];

            // Only keep a round that actually improves on fewer rides.
            if (arrival === INFINITY || arrival >= bestSoFar) {
                continue;
            }
            bestSoFar = arrival;

            const legs = me._reconstruct(parents, round, origin, target, time, access, point);

            if (legs) {
                const rides = legs.filter(l => l.type === 'ride');

                // When you have to leave the origin. Walking before the first
                // ride counts backwards from its departure. (Today the search
                // never walks before the first ride — see `_search` — but this
                // must not silently produce NaN if that changes.)
                const firstRide = legs.find(l => l.type === 'ride');
                let departure = firstRide ? firstRide.departure : time;

                for (const leg of legs) {
                    if (leg.type === 'ride') {
                        break;
                    }
                    departure -= leg.seconds;
                }

                itineraries.push({
                    legs,
                    departure,
                    arrival,
                    duration: arrival - time,
                    rides: rides.length,
                    transfers: Math.max(0, rides.length - 1),
                    fare: fareForLegs(legs, me.network)
                });
            }
        }

        return itineraries.length ?
            {itineraries} :
            {error: 'unreachable', itineraries: []};
    }

    /**
     * Walks the parent pointers back from the target.
     *
     * Each round's parent table only records how a node was reached *in that
     * round*, so the walk steps down through rounds as it passes each ride.
     */
    _reconstruct(parents, round, origin, target, time, access, point) {
        const me = this,
            legs = [];
        let node = target,
            level = round,
            guard = 0;

        while (node !== origin) {
            if (guard++ > 64) {
                return null;
            }

            // Stepping back past the first round means the journey began on
            // foot, before any bus.
            if (level < 0) {
                const start = access && access[node];

                if (!start) {
                    return null;
                }
                legs.push({
                    type: 'walk',
                    from: origin >= 0 ? me.nodeIds[origin] : null,
                    fromPoint: point ? [point.lon, point.lat] : undefined,
                    to: me.nodeIds[node],
                    seconds: start.seconds
                });
                node = origin;
                break;
            }

            let step = parents[level][node];

            // A node may have been reached in an earlier round and simply
            // carried forward; drop back until the round that set it.
            while (!step && level > 0) {
                level--;
                step = parents[level][node];
            }
            if (!step) {
                return null;
            }

            if (step.type === 'walk') {
                legs.push({
                    type: 'walk',
                    from: me.nodeIds[step.from],
                    to: me.nodeIds[node],
                    seconds: step.seconds
                });
                node = step.from;
            } else {
                const {trip} = me.patterns[step.pattern];

                legs.push({
                    type: 'ride',
                    route: trip.route,
                    trip: trip.id,
                    headsign: trip.headsign,
                    from: me.nodeIds[step.from],
                    to: me.nodeIds[node],
                    boardIndex: step.boardIndex,
                    alightIndex: step.alightIndex,
                    stops: step.alightIndex - step.boardIndex,
                    departure: step.runStart + trip.departures[step.boardIndex],
                    arrival: step.runStart + trip.arrivals[step.alightIndex],
                    runStart: step.runStart
                });
                node = step.from;
                level--;
            }
        }

        legs.reverse();
        return me._collapse(legs, time);
    }

    /**
     * Tidies an itinerary reconstructed from the parent tables.
     *
     * Two artefacts fall out of a round-based search. Walking can chain across
     * rounds, which should read as one walk rather than three; and a pattern can
     * be alighted and reboarded on the same vehicle, which is not a transfer at
     * all. Both are correct journeys, described badly.
     */
    _collapse(legs, time) {
        const merged = [];

        for (const leg of legs) {
            const previous = merged[merged.length - 1];

            if (previous && previous.type === 'walk' && leg.type === 'walk') {
                previous.to = leg.to;
                previous.seconds += leg.seconds;
                continue;
            }
            if (previous && previous.type === 'ride' && leg.type === 'ride' &&
                previous.trip === leg.trip && previous.runStart === leg.runStart) {
                previous.to = leg.to;
                previous.alightIndex = leg.alightIndex;
                previous.arrival = leg.arrival;
                previous.stops = leg.alightIndex - previous.boardIndex;
                continue;
            }
            merged.push(leg);
        }

        // The wait before the first ride belongs to the journey, not to nowhere.
        const firstRide = merged.find(l => l.type === 'ride');

        if (firstRide) {
            const walkBefore = merged
                .slice(0, merged.indexOf(firstRide))
                .reduce((total, l) => total + l.seconds, 0);

            firstRide.wait = firstRide.departure - time - walkBefore;
        }
        return merged;
    }

    /**
     * Every node reachable from a stop within a time budget.
     *
     * This is the same search with no target and a ceiling instead — which is
     * why an isochrone costs almost nothing once the router exists.
     */
    reachable({from, time, dayOfWeek, maxSeconds, maxRounds = DEFAULT_MAX_ROUNDS, freeOnly = false}) {
        const me = this,
            origin = me.nodeOf(from);

        if (origin < 0) {
            return [];
        }

        const {best} = me._search({
                origin,
                seeds: [{node: origin, seconds: 0}],
                target: -1, time, dayOfWeek, maxRounds, maxSeconds, freeOnly
            }),
            results = [];

        for (let i = 0; i < best.length; i++) {
            if (best[i] !== INFINITY && best[i] - time <= maxSeconds) {
                results.push({
                    stop: me.network.stops.get(me.nodeIds[i]),
                    arrival: best[i],
                    seconds: best[i] - time
                });
            }
        }
        return results;
    }

}

export {ACCESS_RADIUS_M, DEFAULT_MAX_ROUNDS, TRANSFER_PENALTY_S};
