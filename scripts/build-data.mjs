/**
 * Builds the runtime data bundle from the Transjakarta GTFS feed.
 *
 * The heavy geometry work happens here rather than in the browser: every stop
 * of every trip is projected onto its route shape and stored as a distance
 * along that shape ("offset"). At runtime a bus is then positioned by
 * interpolating between two offsets, which is a binary search and a lerp.
 */
import {createReadStream, existsSync, readdirSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url)),
    ROOT = join(__dirname, '..'),
    // This used to point at a folder on one laptop, which made the control
    // for every data bug found so far unrunnable by anybody else. It now
    // falls back to the newest Transjakarta snapshot in the repo, so a fresh
    // clone can rebuild the legacy bundle and run `npm run test-routing`.
    //
    // The two are not the same feed. The committed snapshot came from the
    // Mobility Database mirror and carries 252 routes against the origin's
    // 240 (see "The Transjakarta feed host" in CLAUDE.md), while the
    // `public/data/` in the repo was built from the origin. Rebuilding here
    // therefore changes the network under the routing checks — which is fine,
    // and worth knowing before reading a diff in their output as a regression.
    GTFS_DIR = process.env.GTFS_DIR || newestSnapshotGtfs(),
    OUT_DIR = join(ROOT, 'public', 'data'),

    // Shape simplification tolerances in degrees. ~1e-5 deg is a little over a
    // metre at this latitude - imperceptible for bus movement, but it removes
    // roughly half the vertices. Display lines can be coarser still.
    PATH_TOLERANCE = 1e-5,
    LINE_TOLERANCE = 6e-5,

    // Degrees -> kilometres at Jakarta's latitude (-6.2). Using a local planar
    // approximation keeps distance maths cheap and is accurate to well under a
    // metre over the length of a single segment.
    KM_PER_DEG_LAT = 110.574,
    KM_PER_DEG_LON = 111.320 * Math.cos(-6.2 * Math.PI / 180),

    // Coordinates ship as integers scaled by 1e6 (~11 cm), delta-encoded.
    COORD_SCALE = 1e6;

// ---------------------------------------------------------------------------
// CSV reading
// ---------------------------------------------------------------------------

// Splits one CSV record, honouring double-quoted fields with embedded commas.
function splitRow(line) {
    const fields = [];
    let field = '',
        quoted = false;

    for (let i = 0; i < line.length; i++) {
        const c = line[i];

        if (quoted) {
            if (c === '"') {
                if (line[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                field += c;
            }
        } else if (c === '"') {
            quoted = true;
        } else if (c === ',') {
            fields.push(field);
            field = '';
        } else {
            field += c;
        }
    }
    fields.push(field);
    return fields;
}

// Streams a GTFS table, invoking `onRow` with a plain object per record. The
// files are read line by line so shapes.txt (240k rows) never lands in memory
// as an array of strings.
async function readTable(name, onRow) {
    const stream = createReadStream(join(GTFS_DIR, `${name}.txt`), 'utf8'),
        lines = createInterface({input: stream, crlfDelay: Infinity});
    let header = null;

    for await (const line of lines) {
        if (!line) {
            continue;
        }
        if (!header) {
            header = splitRow(line.replace(/^﻿/, '')).map(h => h.trim());
            continue;
        }

        const fields = splitRow(line),
            row = {};

        for (let i = 0; i < header.length; i++) {
            row[header[i]] = (fields[i] ?? '').trim();
        }
        onRow(row);
    }
    return header;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Perpendicular distance from p to the segment ab, in squared degrees. Longitude
// is pre-scaled so the comparison is isotropic despite the latitude convergence.
const LON_W = KM_PER_DEG_LON / KM_PER_DEG_LAT;

function segmentDistSq(px, py, ax, ay, bx, by) {
    const dx = (bx - ax) * LON_W,
        dy = by - ay,
        lenSq = dx * dx + dy * dy;
    let t = 0;

    if (lenSq > 0) {
        t = (((px - ax) * LON_W * dx) + (py - ay) * dy) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
    }

    const ex = (px - (ax + (bx - ax) * t)) * LON_W,
        ey = py - (ay + (by - ay) * t);

    return {distSq: ex * ex + ey * ey, t};
}

// Iterative Douglas-Peucker. Returns the retained indices of `pts` (flat
// [lon, lat, ...]). Recursion is unrolled because a few shapes run past 1000
// points and deep recursion here is needless risk.
function simplifyIndices(pts, tolerance) {
    const n = pts.length / 2;

    if (n < 3) {
        return Array.from({length: n}, (_, i) => i);
    }

    const keep = new Uint8Array(n),
        tolSq = tolerance * tolerance,
        stack = [[0, n - 1]];

    keep[0] = keep[n - 1] = 1;

    while (stack.length) {
        const [first, last] = stack.pop();
        let maxDistSq = -1,
            index = -1;

        for (let i = first + 1; i < last; i++) {
            const {distSq} = segmentDistSq(
                pts[i * 2], pts[i * 2 + 1],
                pts[first * 2], pts[first * 2 + 1],
                pts[last * 2], pts[last * 2 + 1]
            );

            if (distSq > maxDistSq) {
                maxDistSq = distSq;
                index = i;
            }
        }

        if (maxDistSq > tolSq && index > first) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }

    const indices = [];

    for (let i = 0; i < n; i++) {
        if (keep[i]) {
            indices.push(i);
        }
    }
    return indices;
}

// Cumulative along-path distance in kilometres, one entry per vertex.
function cumulativeDistances(coords) {
    const n = coords.length / 2,
        cum = new Float64Array(n);

    for (let i = 1; i < n; i++) {
        const dx = (coords[i * 2] - coords[i * 2 - 2]) * KM_PER_DEG_LON,
            dy = (coords[i * 2 + 1] - coords[i * 2 - 1]) * KM_PER_DEG_LAT;

        cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }
    return cum;
}

// Upper bound on how fast a bus may be assumed to travel between two stops,
// in km/h. Used only to bound the geometric search, so it is set well above
// any real Transjakarta service (including toll-road Transjabodetabek runs).
const SEARCH_MAX_KMPH = 100,

    // Never search a window shorter than this, in km; some stop_times rows sit
    // only a second or two apart.
    SEARCH_MIN_WINDOW = 0.5,

    // A stop matched further than this from the shape is treated as a failed
    // match, in km.
    MATCH_TOLERANCE = 0.25;

/**
 * Scans the segments of `coords` in [start, end) for the point closest to the
 * given position.
 *
 * Where several parts of the shape are near-equally close - the two sides of a
 * loop's seam, or an out-and-back that doubles over itself - the earliest match
 * wins. Preferring the earliest keeps stops advancing along the shape in step
 * with the stop sequence instead of leaping to a later pass over the same
 * street, which would drag every subsequent stop along with it.
 */
function scanSegments(coords, cum, lon, lat, start, end) {
    let best = {distSq: Infinity, offset: cum[start], vertex: start};

    for (let i = start; i < end; i++) {
        const {distSq, t} = segmentDistSq(
            lon, lat,
            coords[i * 2], coords[i * 2 + 1],
            coords[i * 2 + 2], coords[i * 2 + 3]
        );

        if (distSq < best.distSq) {
            best = {
                distSq,
                offset: cum[i] + (cum[i + 1] - cum[i]) * t,
                vertex: t > 0.5 ? i + 1 : i
            };
        }
    }
    if (best.distSq === Infinity) {
        return best;
    }

    // Second pass: accept anything up to twice as far, or 50 m further,
    // whichever is more permissive, and take the earliest of those.
    const dist = Math.sqrt(best.distSq),
        margin = Math.max(dist * 2, dist + 0.05 / KM_PER_DEG_LAT) ** 2;

    for (let i = start; i < end; i++) {
        const {distSq, t} = segmentDistSq(
            lon, lat,
            coords[i * 2], coords[i * 2 + 1],
            coords[i * 2 + 2], coords[i * 2 + 3]
        );

        if (distSq <= margin) {
            const offset = cum[i] + (cum[i + 1] - cum[i]) * t;

            if (offset < best.offset) {
                best = {distSq, offset, vertex: t > 0.5 ? i + 1 : i};
            }
            break;
        }
    }
    return best;
}

// Index of the segment containing the given distance along the shape.
function vertexAtOffset(cum, offset) {
    let lo = 0,
        hi = cum.length - 1;

    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;

        if (cum[mid] <= offset) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return lo;
}

/**
 * Projects a stop onto the stretch of shape the bus could plausibly have
 * reached since the previous stop.
 *
 * Bounding the search by time is what keeps loop and out-and-back routes
 * honest. Around one segment in a hundred is otherwise matched to a later pass
 * over the same street - one Mikrotrans trip appeared to cover 25 km in 13
 * seconds - and because offsets may never decrease, a single bad match pins
 * every stop after it to the same point.
 */
function projectStop(coords, cum, lon, lat, minOffset, seconds) {
    const n = coords.length / 2,
        total = cum[n - 1],
        reach = Math.max(SEARCH_MIN_WINDOW, seconds * SEARCH_MAX_KMPH / 3600),
        first = vertexAtOffset(cum, minOffset),
        last = Math.min(n - 1, vertexAtOffset(cum, minOffset + reach) + 1);
    let best = scanSegments(coords, cum, lon, lat, first, last);

    // Nothing credible within reach: the schedule and the geometry disagree
    // here, so search the whole remaining shape rather than drop the stop.
    if (best.distSq > (MATCH_TOLERANCE / KM_PER_DEG_LAT) ** 2 && last < n - 1) {
        const wider = scanSegments(coords, cum, lon, lat, first, n - 1);

        if (wider.distSq < best.distSq) {
            best = wider;
        }
    }

    best.offset = Math.min(Math.max(best.offset, minOffset), total);
    return best;
}

/**
 * Projects a trip's first stop.
 *
 * Many shapes are closed loops whose first and last vertex coincide, so a
 * terminus that both starts and ends the trip is equidistant from offset 0 and
 * offset L. scanSegments already breaks that tie towards the earlier match,
 * which is what a trip's first stop should get.
 */
function projectFirstStop(coords, cum, lon, lat) {
    return scanSegments(coords, cum, lon, lat, 0, coords.length / 2 - 1);
}

// ---------------------------------------------------------------------------
// Load the feed
// ---------------------------------------------------------------------------

function parseTime(value) {
    const [h, m, s] = value.split(':');

    // GTFS times may exceed 24:00:00 for trips running past midnight; the
    // runtime clock wraps them, so keep the raw seconds-from-noon-minus-12h.
    return (+h) * 3600 + (+m) * 60 + (+s);
}

// Resolved with plain fs rather than through `scripts/ingest/snapshot.mjs`:
// this file is the regression control for the artifact pipeline, and a control
// that imports the thing it controls is not one.
function newestSnapshotGtfs() {
    const dir = join(ROOT, 'data', 'snapshots', 'transjakarta');

    if (!existsSync(dir)) {
        return '';
    }

    const dates = readdirSync(dir)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();

    for (const date of dates) {
        const gtfs = join(dir, date, 'gtfs');

        if (existsSync(join(gtfs, 'routes.txt'))) {
            return gtfs;
        }
    }
    return '';
}

console.log(`Reading GTFS from ${GTFS_DIR}`);

const routes = new Map(),
    stops = new Map(),
    trips = new Map(),
    stopTimes = new Map(),
    frequencies = new Map(),
    calendar = new Map(),
    shapePoints = new Map(),
    fareAttributes = new Map(),
    fareByRoute = new Map(),
    transfers = new Map();

await readTable('agency', row => {
    globalThis.__agency ??= row;
});

await readTable('calendar', row => {
    calendar.set(row.service_id, {
        days: [
            +row.sunday, +row.monday, +row.tuesday, +row.wednesday,
            +row.thursday, +row.friday, +row.saturday
        ]
    });
});

await readTable('routes', row => {
    routes.set(row.route_id, {
        id: row.route_id,
        shortName: row.route_short_name,
        longName: row.route_long_name,
        category: row.route_desc || 'Lainnya',
        color: row.route_color ? `#${row.route_color}` : '#cccccc',
        textColor: row.route_text_color ? `#${row.route_text_color}` : '#000000'
    });
});

await readTable('stops', row => {
    stops.set(row.stop_id, {
        id: row.stop_id,
        name: row.stop_name,
        lat: +row.stop_lat,
        lon: +row.stop_lon,
        // location_type 1 marks a BRT corridor station; its platforms reference
        // it through parent_station.
        station: row.location_type === '1',
        parent: row.parent_station || null,
        // 1 means boarding is possible for a wheelchair user; 2 means it is
        // not, and blank or 0 means unknown. Only an explicit 1 counts.
        accessible: row.wheelchair_boarding === '1'
    });
});

// A corridor station is reachable if any of its platforms is, but the flag is
// recorded on the platforms rather than the station, and only stations are
// drawn on the map. Propagate it upwards so the station tells the truth.
for (const stop of stops.values()) {
    if (stop.accessible && stop.parent) {
        const station = stops.get(stop.parent);

        if (station) {
            station.accessible = true;
        }
    }
}

await readTable('trips', row => {
    trips.set(row.trip_id, {
        id: row.trip_id,
        route: row.route_id,
        service: row.service_id,
        shape: row.shape_id,
        headsign: row.trip_headsign,
        shortName: row.trip_short_name,
        direction: +row.direction_id || 0
    });
});

await readTable('stop_times', row => {
    let list = stopTimes.get(row.trip_id);

    if (!list) {
        stopTimes.set(row.trip_id, list = []);
    }
    list.push({
        seq: +row.stop_sequence,
        stop: row.stop_id,
        arrival: parseTime(row.arrival_time),
        departure: parseTime(row.departure_time),
        headsign: row.stop_headsign
    });
});

await readTable('frequencies', row => {
    let list = frequencies.get(row.trip_id);

    if (!list) {
        frequencies.set(row.trip_id, list = []);
    }
    list.push({
        start: parseTime(row.start_time),
        end: parseTime(row.end_time),
        headway: +row.headway_secs
    });
});

await readTable('fare_attributes', row => {
    fareAttributes.set(row.fare_id, {
        id: row.fare_id,
        price: +row.price,
        currency: row.currency_type,
        // Blank means an unlimited number of transfers is permitted within
        // transfer_duration; a number caps them.
        transfers: row.transfers === '' ? null : +row.transfers,
        transferDuration: row.transfer_duration ? +row.transfer_duration : null
    });
});

// This feed prices purely by route: origin_id, destination_id and contains_id
// are empty throughout, so one fare applies to a whole route.
await readTable('fare_rules', row => {
    if (row.route_id) {
        fareByRoute.set(row.route_id, row.fare_id);
    }
});

await readTable('transfers', row => {
    let list = transfers.get(row.from_stop_id);

    if (!list) {
        transfers.set(row.from_stop_id, list = []);
    }
    list.push({to: row.to_stop_id, minTime: row.min_transfer_time ? +row.min_transfer_time : null});
});

await readTable('shapes', row => {
    let list = shapePoints.get(row.shape_id);

    if (!list) {
        shapePoints.set(row.shape_id, list = []);
    }
    list.push([+row.shape_pt_sequence, +row.shape_pt_lon, +row.shape_pt_lat]);
});

console.log(
    `  ${routes.size} routes, ${stops.size} stops, ${trips.size} trips, ` +
    `${shapePoints.size} shapes`
);
console.log(
    `  ${fareAttributes.size} fares over ${fareByRoute.size} routes, ` +
    `${transfers.size} stops with transfers`
);
{
    const drawn = [...stops.values()].filter(s => !s.parent);

    console.log(
        `  ${[...stops.values()].filter(s => s.accessible).length} accessible stops ` +
        `(${drawn.filter(s => s.accessible).length} of ${drawn.length} drawn on the map)`
    );
}

// ---------------------------------------------------------------------------
// Build shape geometry
// ---------------------------------------------------------------------------

const shapeIndex = new Map(),
    pathCoords = [],
    lineFeatures = [];
let rawPointCount = 0,
    keptPointCount = 0;

for (const [shapeId, points] of shapePoints) {
    points.sort((a, b) => a[0] - b[0]);

    const flat = new Float64Array(points.length * 2);

    for (let i = 0; i < points.length; i++) {
        flat[i * 2] = points[i][1];
        flat[i * 2 + 1] = points[i][2];
    }
    rawPointCount += points.length;

    const kept = simplifyIndices(flat, PATH_TOLERANCE),
        coords = new Float64Array(kept.length * 2);

    for (let i = 0; i < kept.length; i++) {
        coords[i * 2] = flat[kept[i] * 2];
        coords[i * 2 + 1] = flat[kept[i] * 2 + 1];
    }
    keptPointCount += kept.length;

    shapeIndex.set(shapeId, {
        id: shapeId,
        coords,
        cum: cumulativeDistances(coords),
        start: pathCoords.length / 2
    });
    for (const v of coords) {
        pathCoords.push(v);
    }
}

console.log(
    `  shape vertices ${rawPointCount} -> ${keptPointCount} ` +
    `(${(100 - keptPointCount / rawPointCount * 100).toFixed(0)}% reduction)`
);

// ---------------------------------------------------------------------------
// Build trips: stop offsets along the shape + timings
// ---------------------------------------------------------------------------

const tripList = [],
    usedStops = new Set();
let unmatchedStops = 0,
    worstStopDistance = 0;

for (const trip of trips.values()) {
    const times = stopTimes.get(trip.id),
        shape = shapeIndex.get(trip.shape),
        windows = frequencies.get(trip.id);

    if (!times || !shape || !windows) {
        continue;
    }
    times.sort((a, b) => a.seq - b.seq);

    const {coords, cum} = shape,
        offsets = new Array(times.length),
        stopIds = new Array(times.length),
        arrivals = new Array(times.length),
        departures = new Array(times.length);

    for (let i = 0; i < times.length; i++) {
        const t = times[i],
            stop = stops.get(t.stop),
            best = i === 0 ?
                projectFirstStop(coords, cum, stop.lon, stop.lat) :
                projectStop(
                    coords, cum, stop.lon, stop.lat, offsets[i - 1],
                    Math.max(0, t.arrival - times[i - 1].departure)
                ),
            metres = Math.sqrt(best.distSq) * KM_PER_DEG_LAT * 1000;

        offsets[i] = best.offset;
        stopIds[i] = t.stop;
        arrivals[i] = t.arrival;
        departures[i] = t.departure;
        usedStops.add(t.stop);

        if (metres > 200) {
            unmatchedStops++;
        }
        worstStopDistance = Math.max(worstStopDistance, metres);
    }

    tripList.push({
        id: trip.id,
        route: trip.route,
        service: trip.service,
        shape: trip.shape,
        headsign: trip.headsign,
        direction: trip.direction,
        stops: stopIds,
        // Times are stored relative to the trip's own start so a frequency
        // window can shift a whole run by simply adding its departure time.
        arrivals: arrivals.map(v => v - departures[0]),
        departures: departures.map(v => v - departures[0]),
        offsets: offsets.map(v => Math.round(v * 1000)),
        windows: windows.map(w => [w.start, w.end, w.headway])
    });
}

console.log(
    `  ${tripList.length} trips projected; ${unmatchedStops} stop matches ` +
    `over 200 m (worst ${worstStopDistance.toFixed(0)} m)`
);

// ---------------------------------------------------------------------------
// Display lines, one feature per shape, coarsely simplified
// ---------------------------------------------------------------------------

const routeOfShape = new Map();

for (const trip of tripList) {
    if (!routeOfShape.has(trip.shape)) {
        routeOfShape.set(trip.shape, trip.route);
    }
}

for (const [shapeId, {coords}] of shapeIndex) {
    const routeId = routeOfShape.get(shapeId);

    if (!routeId) {
        continue;
    }

    const route = routes.get(routeId),
        kept = simplifyIndices(coords, LINE_TOLERANCE),
        line = kept.map(i => [
            +coords[i * 2].toFixed(5),
            +coords[i * 2 + 1].toFixed(5)
        ]);

    lineFeatures.push({
        type: 'Feature',
        properties: {
            route: routeId,
            category: route.category,
            color: route.color,
            name: route.shortName
        },
        geometry: {type: 'LineString', coordinates: line}
    });
}

// ---------------------------------------------------------------------------
// Walk transfers
//
// transfers.txt declares 7 interchange pairs for the whole network, which is
// nowhere near the truth: thousands of stops sit a short walk from another stop
// on a different route. A journey planner using only the declared list would
// miss almost every real interchange in Jakarta, so the walkable ones are
// derived here and shipped with the network.
// ---------------------------------------------------------------------------

// Boarding happens at a station, not at its individual platforms, so platforms
// collapse into their parent before any of this.
const nodeOf = id => {
        const stop = stops.get(id);

        return stop && stop.parent ? stop.parent : id;
    },
    routesByNode = new Map();

for (const trip of tripList) {
    for (const stopId of trip.stops) {
        const node = nodeOf(stopId);
        let set = routesByNode.get(node);

        if (!set) {
            routesByNode.set(node, set = new Set());
        }
        set.add(trip.route);
    }
}

const walkNodes = [...routesByNode.keys()].filter(id => stops.has(id)),
    nodeIndex = new Map(walkNodes.map((id, i) => [id, i])),
    // A 400 m walk at 4.8 km/h is about five minutes - roughly the point past
    // which a rider mid-journey would rather wait for a direct bus.
    //
    // Measured sensitivity, since the edge count grows with the square of the
    // radius while the connectivity it buys does not:
    //
    //   300 m ->  16,014 edges, 1,775 new route pairs
    //   400 m ->  28,929 edges, 1,905 new route pairs   <- chosen
    //   500 m ->  45,866 edges, 2,052 new route pairs
    //   800 m -> 128,420 edges, 2,653 new route pairs
    //
    // Going from 400 m to 800 m costs 4.4x the data for 1.39x the interchange
    // options, and asks the rider for a ten-minute walk between buses.
    //
    // Note this is the *transfer* radius. Walking to the first stop or from the
    // last one is a different question - people will walk further to start a
    // journey than they will halfway through - and is handled at runtime.
    WALK_RADIUS_M = 400,
    WALK_SPEED_MPS = 4.8 * 1000 / 3600,
    M_PER_DEG_LAT = KM_PER_DEG_LAT * 1000,
    M_PER_DEG_LON = KM_PER_DEG_LON * 1000,
    // Cell size chosen so any pair within the radius shares a cell or touches
    // an adjacent one, making a 3x3 sweep sufficient.
    CELL = WALK_RADIUS_M / M_PER_DEG_LAT,
    grid = new Map(),
    cellKey = (gx, gy) => `${gx}:${gy}`;

for (const id of walkNodes) {
    const stop = stops.get(id),
        gx = Math.floor(stop.lon / CELL),
        gy = Math.floor(stop.lat / CELL);
    let cell = grid.get(cellKey(gx, gy));

    if (!cell) {
        grid.set(cellKey(gx, gy), cell = []);
    }
    cell.push(id);
}

const walkOffsets = [0],
    walkTargets = [],
    walkSeconds = [];
let walkPairs = 0,
    walkMaxDegree = 0;

for (const id of walkNodes) {
    const from = stops.get(id),
        fromRoutes = routesByNode.get(id),
        gx = Math.floor(from.lon / CELL),
        gy = Math.floor(from.lat / CELL),
        found = [];

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (const otherId of grid.get(cellKey(gx + dx, gy + dy)) || []) {
                if (otherId === id) {
                    continue;
                }

                const to = stops.get(otherId),
                    metres = Math.hypot(
                        (to.lon - from.lon) * M_PER_DEG_LON,
                        (to.lat - from.lat) * M_PER_DEG_LAT
                    );

                if (metres > WALK_RADIUS_M) {
                    continue;
                }

                // A walk that reaches nothing new is not a transfer. Keeping
                // only edges that add a route holds the table to a useful size
                // and stops the search wandering between adjacent stops on the
                // same line.
                let adds = false;

                for (const route of routesByNode.get(otherId)) {
                    if (!fromRoutes.has(route)) {
                        adds = true;
                        break;
                    }
                }
                if (adds) {
                    found.push([nodeIndex.get(otherId), Math.round(metres / WALK_SPEED_MPS)]);
                }
            }
        }
    }

    found.sort((a, b) => a[1] - b[1]);
    for (const [target, seconds] of found) {
        walkTargets.push(target);
        walkSeconds.push(seconds);
    }
    walkPairs += found.length;
    walkMaxDegree = Math.max(walkMaxDegree, found.length);
    walkOffsets.push(walkTargets.length);
}

console.log(
    `  walk transfers: ${walkPairs} edges over ${walkNodes.length} nodes ` +
    `(max ${walkMaxDegree} from one stop, radius ${WALK_RADIUS_M} m)`
);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

await mkdir(OUT_DIR, {recursive: true});

// Delta-encoded int32 pairs; consecutive vertices differ by a handful of units
// at 1e-6 degrees, so this compresses far better than raw floats.
const coordBuffer = new Int32Array(pathCoords.length);
let prevLon = 0,
    prevLat = 0;

for (let i = 0; i < pathCoords.length; i += 2) {
    const lon = Math.round(pathCoords[i] * COORD_SCALE),
        lat = Math.round(pathCoords[i + 1] * COORD_SCALE);

    coordBuffer[i] = lon - prevLon;
    coordBuffer[i + 1] = lat - prevLat;
    prevLon = lon;
    prevLat = lat;
}

await writeFile(join(OUT_DIR, 'shapes.bin'), Buffer.from(coordBuffer.buffer));

const network = {
    agency: globalThis.__agency?.agency_name ?? 'Transjakarta',
    timezone: globalThis.__agency?.agency_timezone ?? 'Asia/Jakarta',
    coordScale: COORD_SCALE,
    calendar: Object.fromEntries(calendar),
    categories: [...new Set([...routes.values()].map(r => r.category))].sort(),
    routes: [...routes.values()],
    fares: {
        attributes: Object.fromEntries(fareAttributes),
        byRoute: Object.fromEntries(fareByRoute)
    },
    // Official interchange walks between nearby stops.
    transfers: Object.fromEntries(transfers),
    // Only ship stops that a trip actually serves, plus the parent stations
    // they belong to.
    stops: [...stops.values()].filter(s =>
        usedStops.has(s.id) || s.station
    ).map(s => ({
        i: s.id,
        n: s.name,
        y: +s.lat.toFixed(6),
        x: +s.lon.toFixed(6),
        s: s.station ? 1 : 0,
        a: s.accessible ? 1 : 0,
        p: s.parent
    })),
    // Walkable interchanges, as a flat adjacency list. `ids` maps an index to a
    // stop id; edges for node i are offsets[i] .. offsets[i + 1].
    walk: {
        radius: WALK_RADIUS_M,
        ids: walkNodes,
        offsets: walkOffsets,
        targets: walkTargets,
        seconds: walkSeconds
    },
    shapes: [...shapeIndex.values()].map(s => ({
        id: s.id,
        start: s.start,
        count: s.coords.length / 2
    })),
    trips: tripList
};

await writeFile(join(OUT_DIR, 'network.json'), JSON.stringify(network));
await writeFile(join(OUT_DIR, 'routes.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: lineFeatures
}));

const {statSync} = await import('node:fs');

for (const f of ['network.json', 'shapes.bin', 'routes.geojson']) {
    console.log(`  ${f}: ${(statSync(join(OUT_DIR, f)).size / 1e6).toFixed(2)} MB`);
}
console.log('Done.');
