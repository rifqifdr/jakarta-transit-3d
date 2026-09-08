const DAY = 86400,
    // Room for every bus that can be in service at once. The evening peak puts
    // about 6,600 on the road, so this leaves generous headroom.
    CAPACITY = 12000,

    // How far a vehicle travels before its drawn heading has caught up with the
    // track, in metres. Long enough to smooth a simplified shape's vertices,
    // short enough that a real corner still reads as a corner.
    BEARING_SMOOTHING_M = 18;

/**
 * Expands the frequency-based timetable into individual vehicle runs and
 * positions them.
 *
 * Transjakarta's feed is headway-based: a trip is a pattern, and
 * frequencies.txt says how often it departs within a window. One run here is
 * one bus setting out on that pattern at one particular time.
 */
export default class Fleet {

    constructor(network) {
        const me = this;

        me.network = network;
        me.hidden = new Set();

        me._buildRuns();
        me._allocate();

        me._day = -1;
        me._second = NaN;
        me.activeCount = 0;

        // Bumped whenever the membership of the active list changes, so the
        // renderer knows when per-bus attributes such as colour need rewriting.
        me.generation = 0;
    }

    // Enumerate every departure of every trip across the service day.
    _buildRuns() {
        const me = this,
            trips = me.network.trips,
            tripIndex = [],
            starts = [],
            ends = [];

        for (const trip of trips) {
            // No geometry, no vehicle. Four Cikarang patterns match no OSM
            // relation, and their trips reached `locate()` with an undefined
            // shape — which threw inside the frame loop, so the clock froze at
            // 00:00:00 and the whole fleet stopped. They stay in the timetable,
            // because a train you cannot draw is still one you can catch.
            if (!trip.shape) {
                continue;
            }

            // Rail trips are scheduled rather than headway-based; the adapter
            // expresses each as a single-departure window so both kinds expand
            // through the same loop. A trip with neither is a data fault, not a
            // vehicle.
            for (const [start, end, headway] of trip.windows ?? []) {
                if (headway <= 0) {
                    continue;
                }
                for (let t = start; t < end; t += headway) {
                    tripIndex.push(trip.index);
                    starts.push(t);
                    ends.push(t + trip.duration);
                }
            }
        }

        // Sorting by departure is not required by the scan below, but it keeps
        // buses that set out together adjacent in the instance buffer, which
        // makes the fleet read as a procession rather than a shuffle.
        const order = starts
            .map((v, i) => i)
            .sort((a, b) => starts[a] - starts[b]);

        me.runCount = order.length;
        me.runTrip = new Int16Array(me.runCount);
        me.runStart = new Int32Array(me.runCount);
        me.runEnd = new Int32Array(me.runCount);

        for (let i = 0; i < order.length; i++) {
            const j = order[i];

            me.runTrip[i] = tripIndex[j];
            me.runStart[i] = starts[j];
            me.runEnd[i] = ends[j];
        }
    }

    _allocate() {
        const me = this;

        me.active = new Int32Array(CAPACITY);
        // Mercator coordinates need more than 24 bits of mantissa: at float32
        // precision a position would quantise to several metres.
        me.mercX = new Float64Array(CAPACITY);
        me.mercY = new Float64Array(CAPACITY);
        me.bearing = new Float32Array(CAPACITY);
        me.offset = new Float32Array(CAPACITY);
        me.section = new Int32Array(CAPACITY);
        me.standing = new Uint8Array(CAPACITY);

        // Per-run scratch, so a bus resumes its search where it left off.
        me.hintVertex = new Int32Array(me.runCount);
        // Smoothed heading, and the offset it was last computed at, per run.
        // Kept per run rather than per slot because the active list is rebuilt
        // whenever the fleet changes and slot n is then a different vehicle.
        me.smoothBearing = new Float32Array(me.runCount);
        me.smoothFrom = new Float32Array(me.runCount).fill(-1);
        me.hintSection = new Int32Array(me.runCount);

        me._loc = {x: 0, y: 0, bearing: 0, vertex: 0};
    }

    /** Marks a service category hidden or visible. */
    setCategoryVisible(category, visible) {
        const me = this;

        if (visible) {
            me.hidden.delete(category);
        } else {
            me.hidden.add(category);
        }
        me._second = NaN;
        return me;
    }

    isCategoryVisible(category) {
        return !this.hidden.has(category);
    }

    /**
     * Advances the simulation to `now`, seconds since local midnight.
     *
     * The set of buses in service is rebuilt once per simulated second;
     * positions are recomputed every frame.
     */
    update(now, dayOfWeek) {
        const me = this,
            second = Math.floor(now);

        if (second !== me._second || dayOfWeek !== me._day) {
            me._second = second;
            me._day = dayOfWeek;
            me._selectActive(now, dayOfWeek);
        }
        me._positionAll(now);
        return me;
    }

    _serviceRuns(dayOfWeek) {
        const me = this,
            {calendar, trips} = me.network,
            runs = new Uint8Array(trips.length);

        for (const trip of trips) {
            const service = calendar[trip.service];

            runs[trip.index] = service && service.days[dayOfWeek] ? 1 : 0;
        }
        return runs;
    }

    _selectActive(now, dayOfWeek) {
        const me = this,
            {runCount, runTrip, runStart, runEnd, active} = me,
            trips = me.network.trips,
            routes = me.network.routes,
            serviceToday = me._serviceToday && me._serviceDay === dayOfWeek ?
                me._serviceToday :
                (me._serviceDay = dayOfWeek,
                    me._serviceToday = me._serviceRuns(dayOfWeek));
        let count = 0;

        for (let i = 0; i < runCount; i++) {
            const tripIndex = runTrip[i];

            if (!serviceToday[tripIndex]) {
                continue;
            }

            const start = runStart[i],
                end = runEnd[i];
            // A run that departs late in the evening may still be out after
            // midnight, when `now` has wrapped; comparing against the next
            // day's clock catches it.
            const running = (now >= start && now <= end) ||
                (now + DAY >= start && now + DAY <= end);

            if (!running) {
                continue;
            }

            const trip = trips[tripIndex];

            if (me.hidden.size &&
                me.hidden.has(routes.get(trip.route).category)) {
                continue;
            }
            if (count === CAPACITY) {
                break;
            }
            active[count++] = i;
        }
        me.activeCount = count;
        me.generation++;
    }

    _positionAll(now) {
        const me = this,
            {active, activeCount, runStart, runTrip, hintVertex, hintSection} = me,
            {network, _loc: loc} = me,
            trips = network.trips;

        for (let n = 0; n < activeCount; n++) {
            const run = active[n],
                trip = trips[runTrip[run]],
                {offsets, arrivals, departures, accelFractions} = trip,
                lastStop = offsets.length - 1;
            let elapsed = now - runStart[run];

            if (elapsed < 0) {
                elapsed += DAY;
            }

            // Walk forward from the leg this bus was on last frame.
            let i = hintSection[run];

            if (i > lastStop || departures[i] > elapsed) {
                i = 0;
            }
            while (i < lastStop && departures[i + 1] <= elapsed) {
                i++;
            }
            hintSection[run] = i;

            let distance,
                standing;

            if (i >= lastStop) {
                distance = offsets[lastStop];
                standing = 1;
            } else {
                const from = offsets[i],
                    to = offsets[i + 1],
                    leaves = departures[i],
                    arrives = arrivals[i + 1];

                if (elapsed >= arrives || arrives <= leaves) {
                    // Dwelling at the stop ahead until its departure time.
                    distance = to;
                    standing = 1;
                } else {
                    const u = (elapsed - leaves) / (arrives - leaves);

                    distance = from + (to - from) * ease(u, accelFractions[i]);
                    standing = 0;
                }
            }

            network.locate(trip.shape, distance, hintVertex[run], loc);
            hintVertex[run] = loc.vertex;

            // `locate` reports the heading of the segment the vehicle is on, so
            // it is a step function: at every shape vertex the drawn vehicle
            // snaps to a new angle, and on a curve that reads as jitter. The
            // follow camera takes its bearing from here too, so it inherits it.
            //
            // Smoothed over *distance travelled*, not time. A time constant
            // would lag badly at 1200x playback and do nothing at all while a
            // vehicle stands at a stop; a length constant behaves the same at
            // every speed, converges immediately when a vehicle covers ground
            // quickly, and holds the heading steady when it is not moving.
            const previous = me.smoothFrom[run];

            if (previous < 0) {
                me.smoothBearing[run] = loc.bearing;
            } else {
                const moved = Math.abs(distance - previous) * 1000,
                    alpha = 1 - Math.exp(-moved / BEARING_SMOOTHING_M),
                    turn = ((loc.bearing - me.smoothBearing[run] + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

                me.smoothBearing[run] += turn * alpha;
            }
            me.smoothFrom[run] = distance;
            loc.bearing = me.smoothBearing[run];

            me.mercX[n] = loc.x;
            me.mercY[n] = loc.y;
            me.bearing[n] = loc.bearing;
            me.offset[n] = distance;
            me.section[n] = i;
            me.standing[n] = standing;
        }
    }

    /** Describes the bus occupying the given slot in the active list. */
    describe(slot) {
        const me = this;

        if (slot < 0 || slot >= me.activeCount) {
            return null;
        }

        const run = me.active[slot],
            trip = me.network.trips[me.runTrip[run]],
            section = me.section[slot],
            standing = !!me.standing[slot],
            last = trip.stops.length - 1,
            // `section` is the stop the bus most recently departed. While
            // moving it is bound for the next one; while standing it is at the
            // next one, having just pulled in.
            nextIndex = Math.min(section + 1, last),
            atIndex = standing ? nextIndex : section,
            stops = me.network.stops;

        return {
            run,
            trip,
            route: me.network.routes.get(trip.route),
            standing,
            // Where the bus is now, when standing; otherwise the stop behind it.
            atStop: stops.get(trip.stops[atIndex]),
            nextStop: stops.get(trip.stops[nextIndex]),
            stopIndex: atIndex,
            stopCount: trip.stops.length,
            // Compass degrees, for the chase camera.
            bearing: me.bearing[slot] * 180 / Math.PI,
            progress: trip.offsets[trip.offsets.length - 1] > 0 ?
                me.offset[slot] / trip.offsets[trip.offsets.length - 1] :
                0,
            departure: me.runStart[run],
            lngLat: me.network.lngLatAt(trip.shape, me.offset[slot])
        };
    }

    /**
     * How many buses are in service across the whole day, in buckets.
     *
     * Counted with a difference array rather than by simulating each bucket:
     * every run adds one at its departure and removes one at its arrival, so
     * the whole 69,761-run day costs a single pass.
     */
    profile(dayOfWeek, buckets = 144) {
        const me = this,
            {runCount, runTrip, runStart, runEnd} = me,
            trips = me.network.trips,
            routes = me.network.routes,
            serviceToday = me._serviceRuns(dayOfWeek),
            width = DAY / buckets,
            delta = new Int32Array(buckets + 2);

        for (let i = 0; i < runCount; i++) {
            const tripIndex = runTrip[i];

            if (!serviceToday[tripIndex]) {
                continue;
            }
            if (me.hidden.size &&
                me.hidden.has(routes.get(trips[tripIndex].route).category)) {
                continue;
            }

            const from = Math.max(0, Math.floor(runStart[i] / width)),
                to = Math.min(buckets, Math.ceil(Math.min(runEnd[i], DAY) / width));

            if (to > from) {
                delta[from]++;
                delta[to]--;
            }
        }

        const counts = new Int32Array(buckets);
        let running = 0;

        for (let i = 0; i < buckets; i++) {
            running += delta[i];
            counts[i] = running;
        }
        return counts;
    }

    /**
     * The run index for a specific departure of a trip pattern.
     *
     * A planned journey names a pattern and a departure time; this turns that
     * into the actual vehicle in the simulation, so a ride-along follows a bus
     * that is really out there rather than one invented for the animation.
     */
    findRun(tripIndex, runStart) {
        const me = this;

        if (!me._runLookup) {
            me._runLookup = new Map();
            for (let i = 0; i < me.runCount; i++) {
                me._runLookup.set(`${me.runTrip[i]}:${me.runStart[i]}`, i);
            }
        }
        const found = me._runLookup.get(`${tripIndex}:${runStart}`);

        return found === undefined ? -1 : found;
    }

    /** Finds the active slot currently running the given run index. */
    slotOfRun(run) {
        const me = this;

        for (let i = 0; i < me.activeCount; i++) {
            if (me.active[i] === run) {
                return i;
            }
        }
        return -1;
    }

}

/**
 * Distance covered, as a fraction of the leg, after fraction `u` of its
 * duration under a trapezoidal speed profile that spends `k` of the time
 * accelerating and the same braking.
 */
function ease(u, k) {
    if (!(k > 0)) {
        return u;
    }

    const denom = 2 * k * (1 - k);

    if (u < k) {
        return u * u / denom;
    }
    if (u < 1 - k) {
        return (u - k / 2) / (1 - k);
    }
    return 1 - (1 - u) * (1 - u) / denom;
}

export {CAPACITY};
