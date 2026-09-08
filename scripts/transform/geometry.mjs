/**
 * Run times from track geometry rather than from the timetable.
 *
 * Inferring a leg's duration from departure boards works while a board holds
 * one direction. It fails on a merged board, because a symmetric timetable
 * puts opposite-direction trains at a consistent offset that is
 * indistinguishable from a journey — LRT Jabodebek's Halim→Cawang peaks at
 * 60 s, twelve times above background, and it is a train passing the other way.
 *
 * Distance along the track cannot be fooled by that. It knows nothing about
 * the timetable, so it is independent evidence.
 *
 * The speed is not hardcoded. It is fitted from the legs where the two
 * directions already agree with each other — those estimates are trustworthy
 * precisely because the disagreement that marks an ambiguous leg is absent —
 * and then applied to every leg, including the ambiguous ones.
 */

const M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function metres(aLat, aLon, bLat, bLon) {
    return Math.hypot((aLat - bLat) * M_PER_DEG_LAT, (aLon - bLon) * M_PER_DEG_LON);
}

/**
 * Cumulative along-track distance of the point on `coords` nearest to a
 * station, which is what makes two stations comparable on the same line.
 *
 * The same projection the bus pipeline does at build time, for the same
 * reason: once a station is a distance along a shape, everything else is
 * arithmetic.
 */
export function projectOntoShape(lat, lon, coords) {
    let travelled = 0,
        bestDistance = Infinity,
        bestOffset = 0;

    for (let i = 0; i < coords.length - 2; i += 2) {
        const ax = coords[i],
            ay = coords[i + 1],
            bx = coords[i + 2],
            by = coords[i + 3],
            dx = (bx - ax) * M_PER_DEG_LON,
            dy = (by - ay) * M_PER_DEG_LAT,
            lengthSquared = dx * dx + dy * dy,
            px = (lon - ax) * M_PER_DEG_LON,
            py = (lat - ay) * M_PER_DEG_LAT,
            t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0,
            distance = Math.hypot(px - t * dx, py - t * dy),
            segment = Math.sqrt(lengthSquared);

        if (distance < bestDistance) {
            bestDistance = distance;
            bestOffset = travelled + t * segment;
        }
        travelled += segment;
    }
    return {offset: bestOffset, distance: bestDistance, total: travelled};
}

/**
 * Along-track distance between each adjacent pair of stations.
 *
 * Returns null for a leg whose stations do not both project cleanly onto the
 * shape — better to fall back to the timetable estimate there than to invent
 * a distance.
 */
export function legDistances(stations, coords, {maxOffTrack = 400} = {}) {
    const offsets = stations.map(station => {
        const projection = projectOntoShape(station.lat, station.lon, coords);

        return projection.distance <= maxOffTrack ? projection.offset : null;
    });

    const distances = [];

    for (let i = 0; i < offsets.length - 1; i++) {
        distances.push(offsets[i] === null || offsets[i + 1] === null
            ? null
            : Math.abs(offsets[i + 1] - offsets[i]));
    }
    return distances;
}

/**
 * Fits speed and per-station dwell from the legs whose two direction estimates
 * already agree, then predicts every leg from its distance.
 *
 * A leg is treated as reliable when the outbound and inbound estimates are
 * close: the ambiguity this whole module exists to route around shows up
 * precisely as the two directions disagreeing.
 *
 * @param distances  along-track metres per leg, nulls allowed
 * @param forward    board-inferred run times in the forward direction
 * @param backward   board-inferred run times for the same legs, reversed
 * @returns {runTimes, speed, dwell, calibratedOn, fallbacks}
 */
export function fitRunTimes(distances, forward, backward, {
    agreementRatio = 0.34,
    agreementFloor = 45,
    minSamples = 4,

    // Urban light rail, averaged over a leg: about 45 km/h running, half a
    // minute standing. The end-to-end figure this produces for LRT Jabodebek
    // (29.3 km, thirteen legs) is roughly 43 minutes against a published ~40,
    // which is the right order for a model this simple.
    defaultSpeed = 12.5,
    defaultDwell = 30,

    // A fitted speed outside this band is not a speed, it is a degenerate fit.
    // The board estimates are quantised to whole minutes and barely correlate
    // with distance — a 586 m leg and a 5,470 m leg both read 240 s — so least
    // squares happily returns 150 km/h with a three-minute dwell to fit a flat
    // line. Calibrating on numbers this module exists to distrust is circular,
    // so the fit has to earn its use.
    minSpeed = 6,
    maxSpeed = 25,
    maxDwell = 90
} = {}) {
    const reliable = [];

    for (let i = 0; i < distances.length; i++) {
        const a = forward[i],
            b = backward[backward.length - 1 - i];

        if (distances[i] === null || !a || !b) {
            continue;
        }
        if (Math.abs(a - b) <= Math.max(agreementFloor, agreementRatio * Math.max(a, b))) {
            reliable.push({distance: distances[i], time: (a + b) / 2});
        }
    }

    // Least squares through time = distance / speed + dwell, on the legs we
    // trust. Falls back to a plausible LRT speed if too few agree — but says so.
    let speed = defaultSpeed,
        dwell = defaultDwell,
        calibrated = false;

    if (reliable.length >= minSamples) {
        const n = reliable.length,
            sumX = reliable.reduce((acc, r) => acc + r.distance, 0),
            sumY = reliable.reduce((acc, r) => acc + r.time, 0),
            sumXY = reliable.reduce((acc, r) => acc + r.distance * r.time, 0),
            sumXX = reliable.reduce((acc, r) => acc + r.distance * r.distance, 0),
            denominator = n * sumXX - sumX * sumX,
            slope = denominator ? (n * sumXY - sumX * sumY) / denominator : 1 / defaultSpeed,
            intercept = (sumY - slope * sumX) / n;

        if (slope > 0) {
            const fittedSpeed = 1 / slope,
                fittedDwell = Math.max(0, intercept);

            if (fittedSpeed >= minSpeed && fittedSpeed <= maxSpeed && fittedDwell <= maxDwell) {
                speed = fittedSpeed;
                dwell = fittedDwell;
                calibrated = true;
            }
        }
    }

    const runTimes = [],
        fallbacks = [];

    for (let i = 0; i < distances.length; i++) {
        if (distances[i] === null) {
            fallbacks.push(i);
            runTimes.push(forward[i] || 0);
            continue;
        }
        runTimes.push(Math.round(distances[i] / speed + dwell));
    }

    return {runTimes, speed, dwell, calibrated, calibratedOn: reliable.length, fallbacks};
}

/**
 * Douglas-Peucker, returning the flat coordinate array with the redundant
 * vertices dropped.
 *
 * The feed's shapes carry far more detail than a vehicle moving along them can
 * express. At 1e-5 degrees — a little over a metre at this latitude — roughly
 * half the vertices go and nothing visible changes. This is the same tolerance
 * `build-data.mjs` has always used for the simulation path; it lives here now
 * so both pipelines mean the same thing by it.
 */
export function simplify(coords, tolerance = 1e-5) {
    const n = coords.length / 2;

    if (n < 3) {
        return coords;
    }

    const keep = new Uint8Array(n),
        toleranceSquared = tolerance * tolerance,
        stack = [[0, n - 1]];

    keep[0] = 1;
    keep[n - 1] = 1;

    while (stack.length) {
        const [first, last] = stack.pop(),
            ax = coords[first * 2],
            ay = coords[first * 2 + 1],
            bx = coords[last * 2],
            by = coords[last * 2 + 1],
            dx = bx - ax,
            dy = by - ay,
            lengthSquared = dx * dx + dy * dy;

        let worst = -1,
            index = -1;

        for (let i = first + 1; i < last; i++) {
            const px = coords[i * 2] - ax,
                py = coords[i * 2 + 1] - ay,
                t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0,
                ox = px - t * dx,
                oy = py - t * dy,
                distanceSquared = ox * ox + oy * oy;

            if (distanceSquared > worst) {
                worst = distanceSquared;
                index = i;
            }
        }

        if (worst > toleranceSquared && index > 0) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }

    const out = [];

    for (let i = 0; i < n; i++) {
        if (keep[i]) {
            out.push(coords[i * 2], coords[i * 2 + 1]);
        }
    }
    return out;
}

/**
 * Walking transfers between every stop within a radius, across all modes.
 *
 * The feed declares seven interchange pairs. Derived from coordinates the real
 * number is tens of thousands — walking nearly doubles the network's
 * interchange options, and it is the only way a bus stop and a rail platform
 * ever connect, because no operator publishes a transfer to another operator.
 *
 * Bucketed by a grid the size of the radius, so each stop only tests its own
 * cell and the eight around it. The naive form is 34 million comparisons.
 */
export function walkTransfers(stops, {radius = 400, speed = 4.8 / 3.6} = {}) {
    const cell = radius,
        grid = new Map(),
        key = (x, y) => `${x}:${y}`,
        cellOf = stop => [
            Math.floor((stop.lon * M_PER_DEG_LON) / cell),
            Math.floor((stop.lat * M_PER_DEG_LAT) / cell)
        ];

    stops.forEach((stop, index) => {
        const [x, y] = cellOf(stop),
            id = key(x, y);

        if (!grid.has(id)) {
            grid.set(id, []);
        }
        grid.get(id).push(index);
    });

    const edges = [];

    stops.forEach((stop, index) => {
        const [cx, cy] = cellOf(stop);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const other of grid.get(key(cx + dx, cy + dy)) ?? []) {
                    if (other <= index) {
                        continue;
                    }

                    const distance = metres(stop.lat, stop.lon, stops[other].lat, stops[other].lon);

                    if (distance <= radius) {
                        // Straight line at 4.8 km/h, which is measurably
                        // optimistic — median 1.36x against real pedestrian
                        // routing, worst 2.6x, and the error concentrates
                        // exactly where a major road intervenes. See JAKAR-24.
                        edges.push([index, other, Math.round(distance / speed)]);
                    }
                }
            }
        }
    });

    return edges;
}

/**
 * Projects a pattern's stops onto its shape in order, forwards only.
 *
 * Taking each stop's globally nearest point on the polyline is the obvious
 * method and it is wrong on any route that doubles back — which is most of
 * them here, since Mikrotrans and JAK routes are loops. A stop near the start
 * of the loop is genuinely close to the shape twice, and the nearest match can
 * be the *later* pass, so the offsets run backwards and a vehicle would drive
 * in reverse. Measured on the real feed: 343 of 803 patterns.
 *
 * So the scan is monotonic. Each stop may only match a segment at or after the
 * one its predecessor matched, which is the same constraint the timetable
 * itself expresses — a bus visits its stops in order.
 */
// A stop may only be matched as far ahead as the vehicle could plausibly have
// travelled since the previous one. Without this, `projectForward` takes the
// globally nearest segment, and on an out-and-back shape an early stop matches
// the *return* leg — after which every later stop is forced to the tail and
// clamps there. 158 of 806 patterns came out collapsed that way: one 63 km jump
// in 54 seconds, then 50 stops at an identical offset. Borrowed from
// build-data.mjs, which bounds its search the same way and has none of them.
const SEARCH_MAX_MS = 100 / 3.6,
    SEARCH_MIN_WINDOW_M = 500,
    // Beyond this the match is bad enough that a wider search is worth trying.
    MATCH_TOLERANCE_M = 400,
    // Two points on an out-and-back shape can both sit within a few metres of
    // the same stop. Where the search is unconstrained — the first stop, which
    // has nothing to be after — the nearest match may be the *return* leg, and
    // that alone collapses the whole pattern behind it. So an earlier match
    // this much worse still wins.
    TIE_TOLERANCE_M = 60;

function projectForward(stops, coords, times) {
    const segments = coords.length / 2 - 1,
        cumulative = new Float64Array(segments + 1),
        offsets = new Array(stops.length).fill(0);

    for (let i = 0; i < segments; i++) {
        const dx = (coords[(i + 1) * 2] - coords[i * 2]) * M_PER_DEG_LON,
            dy = (coords[(i + 1) * 2 + 1] - coords[i * 2 + 1]) * M_PER_DEG_LAT;

        cumulative[i + 1] = cumulative[i] + Math.hypot(dx, dy);
    }

    let from = 0,
        error = 0;

    for (let s = 0; s < stops.length; s++) {
        const stop = stops[s];

        if (!stop) {
            offsets[s] = s ? offsets[s - 1] : 0;
            continue;
        }

        // Monotonic on the *offset*, not merely on the segment. Constraining
        // the segment alone still lets a later stop land earlier within the
        // same one, which left 229 patterns running backwards.
        const floor = s ? offsets[s - 1] : 0,
            // The first stop is unconstrained: it has nothing to be after, and
            // a loop's terminus is equidistant from offset 0 and offset L.
            gap = s && times ? times[s] - times[s - 1] : null,
            ceiling = gap === null || gap < 0
                ? Infinity
                : floor + Math.max(SEARCH_MIN_WINDOW_M, gap * SEARCH_MAX_MS);

        let bestDistance = Infinity,
            bestOffset = floor,
            bestSegment = from,
            limited = false;

        for (let i = from; i < segments; i++) {
            const ax = coords[i * 2],
                ay = coords[i * 2 + 1],
                dx = (coords[(i + 1) * 2] - ax) * M_PER_DEG_LON,
                dy = (coords[(i + 1) * 2 + 1] - ay) * M_PER_DEG_LAT,
                lengthSquared = dx * dx + dy * dy,
                px = (stop.lon - ax) * M_PER_DEG_LON,
                py = (stop.lat - ay) * M_PER_DEG_LAT,
                t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0,
                distance = Math.hypot(px - t * dx, py - t * dy);

            const candidate = cumulative[i] + t * Math.sqrt(lengthSquared);

            if (candidate > ceiling) {
                limited = true;
                break;
            }
            if (candidate >= floor && distance < bestDistance) {
                bestDistance = distance;
                bestOffset = candidate;
                bestSegment = i;
            }
        }

        // Nothing credible within reach: the schedule and the geometry disagree
        // here, so search the rest of the shape rather than drop the stop on
        // the floor. Same fallback build-data.mjs uses.
        if (limited && bestDistance > MATCH_TOLERANCE_M) {
            for (let i = from; i < segments; i++) {
                const ax = coords[i * 2],
                    ay = coords[i * 2 + 1],
                    dx = (coords[(i + 1) * 2] - ax) * M_PER_DEG_LON,
                    dy = (coords[(i + 1) * 2 + 1] - ay) * M_PER_DEG_LAT,
                    lengthSquared = dx * dx + dy * dy,
                    px = (stop.lon - ax) * M_PER_DEG_LON,
                    py = (stop.lat - ay) * M_PER_DEG_LAT,
                    t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0,
                    distance = Math.hypot(px - t * dx, py - t * dy),
                    candidate = cumulative[i] + t * Math.sqrt(lengthSquared);

                if (candidate >= floor && distance < bestDistance) {
                    bestDistance = distance;
                    bestOffset = candidate;
                    bestSegment = i;
                }
            }
        }

        // Unconstrained search: prefer the earliest match that is essentially
        // as good, rather than the globally nearest.
        if (ceiling === Infinity && bestDistance < Infinity) {
            for (let i = from; i <= bestSegment; i++) {
                const ax = coords[i * 2],
                    ay = coords[i * 2 + 1],
                    dx = (coords[(i + 1) * 2] - ax) * M_PER_DEG_LON,
                    dy = (coords[(i + 1) * 2 + 1] - ay) * M_PER_DEG_LAT,
                    lengthSquared = dx * dx + dy * dy,
                    px = (stop.lon - ax) * M_PER_DEG_LON,
                    py = (stop.lat - ay) * M_PER_DEG_LAT,
                    t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0,
                    distance = Math.hypot(px - t * dx, py - t * dy),
                    candidate = cumulative[i] + t * Math.sqrt(lengthSquared);

                if (candidate >= floor && distance <= bestDistance + TIE_TOLERANCE_M) {
                    bestOffset = candidate;
                    bestSegment = i;
                    break;
                }
            }
        }

        offsets[s] = bestOffset;

        // The next stop starts looking from here, which is what keeps the
        // sequence monotonic on a route that revisits its own path.
        from = bestSegment;
        error += bestDistance === Infinity ? 0 : bestDistance;
    }
    let collapsed = 0;

    for (let s = 1; s < offsets.length; s++) {
        if (offsets[s] === offsets[s - 1]) {
            collapsed++;
        }
    }

    return {
        offsets,
        total: cumulative[segments],
        span: offsets[offsets.length - 1] - offsets[0],
        collapsed,
        error
    };
}

/**
 * Projects a pattern onto its shape, whichever way the shape happens to run.
 *
 * A shape has a direction and a pattern has a direction, and nothing guarantees
 * they agree — the shape matcher picks by which line covers the stops, which
 * cannot tell an outbound relation from its inbound twin. Projected forwards
 * against a shape running the other way, every stop clamps to the first
 * offset and the pattern comes out with zero length: 80 of 803 did.
 *
 * So both are tried and the better one wins, judged on span rather than on
 * fitting error — a reversed shape fits the stops just as closely, and it is
 * the collapse to zero length that gives it away.
 */
export function projectSequential(stops, coords, times) {
    const forward = projectForward(stops, coords, times);

    if (stops.length < 2) {
        return forward;
    }

    const reversed = [];

    for (let i = coords.length - 2; i >= 0; i -= 2) {
        reversed.push(coords[i], coords[i + 1]);
    }

    const backward = projectForward(stops, reversed, times);

    // Span alone cannot separate these. A collapsed projection — one stop
    // flung to the far end, the rest piled against it — has a *large* span and
    // is entirely wrong, so the count of zero-length legs decides first.
    if (backward.collapsed !== forward.collapsed) {
        return backward.collapsed < forward.collapsed ? backward : forward;
    }
    return backward.span > forward.span ? backward : forward;
}

/**
 * Distance from a point to a polyline, in metres.
 *
 * Shared so the shape matcher and the validation gate cannot disagree about
 * what "near the track" means — the whole matching rule is stated in this
 * number, and two implementations of it is two rules.
 */
export function distanceToPolyline(lat, lon, coords) {
    let best = Infinity;

    for (let i = 0; i < coords.length - 2; i += 2) {
        const dx = (coords[i + 2] - coords[i]) * M_PER_DEG_LON,
            dy = (coords[i + 3] - coords[i + 1]) * M_PER_DEG_LAT,
            px = (lon - coords[i]) * M_PER_DEG_LON,
            py = (lat - coords[i + 1]) * M_PER_DEG_LAT,
            lengthSquared = dx * dx + dy * dy,
            t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0,
            d = Math.hypot(px - t * dx, py - t * dy);

        if (d < best) {
            best = d;
        }
    }
    return best;
}
