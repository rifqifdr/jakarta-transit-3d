/**
 * KRL Commuter Line: KCI snapshot + OSM geometry -> canonical entities.
 *
 * The one rail source that hands over trip identity. `train-schedule` returns
 * a whole ordered stop sequence with times, so nothing here is inferred —
 * unlike MRT and LRT, where trips have to be reconstructed from station
 * departure boards.
 *
 * Two things this module owns:
 *
 *   1. Unwrapping past midnight. A train leaving Bogor at 23:10 and reaching
 *      Jakarta Kota at 00:37 runs for 87 minutes, not minus thirteen hours.
 *      Times come out as seconds from the service day's midnight and are
 *      allowed past 86400.
 *
 *   2. Attaching geometry. KCI has no coordinates at all, so stations are
 *      joined to OSM by name and each pattern is matched to the OSM route
 *      relation that best covers its stops — by position, not by name, because
 *      the two sides name lines quite differently ("COMMUTER LINE BOGOR"
 *      against "Lin Bogor: Bogor → Jakarta Kota").
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join as pathJoin} from 'node:path';

import {MODES, pattern, route, shape, trip} from '../model.mjs';
import {joinStations, loadAliases, relationToShape} from '../join.mjs';
import {distanceToPolyline} from '../geometry.mjs';

const AGENCY = 'kai-commuter',

    // KAI Commuter also runs Yogyakarta, Solo, Merak, Walahar and Jatiluhur.
    // They share this API and are not part of this map.
    JABODETABEK = /(BOGOR|CIKARANG|RANGKASBITUNG|TANGERANG|TANJUNGPRIUK)/i,

    // How close a pattern stop must be to a relation's *track* before that
    // relation is believable as the pattern's geometry.
    //
    // This is deliberately the same threshold the validator uses. Matching on
    // a looser criterion than you validate on guarantees builds that fail:
    // scoring purely by how many stops a relation covered once matched a
    // Jakarta Kota pattern to the Cikarang loop, which does not serve Jakarta
    // Kota — the overlap elsewhere was enough to win. Requiring *every* stop
    // to lie near the track removes the whole class of error.
    SHAPE_MAX_STOP_DISTANCE_M = 400,

    // Cheap pre-filter before the expensive polyline test.
    SHAPE_SHORTLIST = 5;

const M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function metres(aLat, aLon, bLat, bLon) {
    return Math.hypot((aLat - bLat) * M_PER_DEG_LAT, (aLon - bLon) * M_PER_DEG_LON);
}

// "23:10:00" -> seconds. Times are clock times on the service day.
function toSeconds(clock) {
    const [h, m, s] = String(clock).split(':').map(Number);

    return h * 3600 + m * 60 + (s || 0);
}

/**
 * Turns a train's clock times into a monotonic sequence.
 *
 * Any step backwards is midnight, because a train does not travel back in
 * time along its own route — so a full day is added and stays added. This is
 * trap 6 in CLAUDE.md, arriving in a second feed.
 */
function unwrap(times) {
    const out = [];
    let offset = 0;

    for (let i = 0; i < times.length; i++) {
        if (i && times[i] + offset < out[i - 1]) {
            offset += 86400;
        }
        out.push(times[i] + offset);
    }
    return out;
}


function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}


// Stations named by the trips themselves, which is a superset of the published
// list. Cheap to read: the trip files are already on disk.
function collectStationsFromTrips(tripsDir) {
    const found = new Map();

    if (!existsSync(tripsDir)) {
        return found;
    }
    for (const file of readdirSync(tripsDir)) {
        if (!file.endsWith('.json')) {
            continue;
        }

        let rows;

        try {
            rows = JSON.parse(readFileSync(pathJoin(tripsDir, file), 'utf8')).data;
        } catch {
            continue;
        }
        if (!Array.isArray(rows)) {
            continue;
        }
        for (const row of rows) {
            if (row.station_id && !found.has(row.station_id)) {
                found.set(row.station_id, row.station_name || row.station_id);
            }
        }
    }
    return found;
}

// The published name wins where both exist — it is the operator's own
// spelling and the one the aliases are written against.
function mergeStations(listed, fromTrips) {
    const merged = new Map(listed.map(s => [s.sta_id, {sta_id: s.sta_id, sta_name: s.sta_name}]));

    for (const [id, name] of fromTrips) {
        if (!merged.has(id)) {
            merged.set(id, {sta_id: id, sta_name: name});
        }
    }
    return [...merged.values()].sort((a, b) => a.sta_id.localeCompare(b.sta_id));
}

/**
 * @param dir       the kci snapshot directory
 * @param osm       {relations, index} already loaded by the runner
 * @param dataset   canonical dataset to add to
 */
export default function normaliseKci({dir, osm, dataset, log}) {
    const stationsFile = pathJoin(dir, 'stations.json');

    if (!existsSync(stationsFile)) {
        throw new Error(`kci snapshot has no stations.json (${dir})`);
    }

    // ---- stations, joined to OSM for coordinates -------------------------
    //
    // The published station list is not the whole universe. Grogol and Karet
    // appear in train-schedule stop sequences but are absent from /stations
    // altogether — not flagged disabled, simply missing. Joining from the list
    // alone silently dropped 121 trips, 120 of them through Grogol, which OSM
    // maps perfectly well. So the station set is the union of what the list
    // declares and what the trips actually call at.
    const listed = JSON.parse(readFileSync(stationsFile, 'utf8'))
            .data.filter(s => s.fg_enable === 1),
        fromTrips = collectStationsFromTrips(pathJoin(dir, 'trains')),
        kciStations = mergeStations(listed, fromTrips),
        joined = joinStations(
            kciStations.map(s => ({id: s.sta_id, name: s.sta_name})),
            osm.index,
            {aliases: loadAliases()}
        ),
        // KCI station id -> canonical stop id, which is the OSM node so that
        // every mode calling at one place shares its identity.
        stopFor = new Map();

    for (const [kciId, node] of joined.matched) {
        stopFor.set(kciId, `osm-${node.osmId}`);
    }

    // ---- trips ------------------------------------------------------------
    const tripsDir = pathJoin(dir, 'trains'),
        files = existsSync(tripsDir) ? readdirSync(tripsDir).filter(f => f.endsWith('.json')) : [],
        routes = new Map(),
        patterns = new Map(),
        trips = [],
        skipped = {notJabodetabek: 0, unparsable: 0, tooShort: 0, unmatchedStops: 0};

    for (const file of files.sort()) {
        let rows;

        try {
            rows = JSON.parse(readFileSync(pathJoin(tripsDir, file), 'utf8')).data;
        } catch {
            skipped.unparsable++;
            continue;
        }
        if (!Array.isArray(rows) || rows.length < 2) {
            skipped.tooShort++;
            continue;
        }

        const line = rows[0].ka_name || '';

        if (!JABODETABEK.test(line)) {
            skipped.notJabodetabek++;
            continue;
        }

        // Every station on the trip has to resolve, or the geometry would have
        // a hole in it and the vehicle would jump.
        const stops = rows.map(r => stopFor.get(r.station_id));

        if (stops.some(s => !s)) {
            skipped.unmatchedStops++;
            continue;
        }

        const routeId = `krl-${slug(line)}`;

        if (!routes.has(routeId)) {
            routes.set(routeId, route({
                id: routeId,
                mode: MODES.commuterRail.id,
                agency: AGENCY,
                shortName: line.replace(/^COMMUTER ?LINE /i, '').trim(),
                longName: line,
                // Operator product name — below mode, never instead of it.
                category: 'Commuter Line',
                color: rows[0].color || null,
                textColor: '#FFFFFF'
            }));
        }

        const key = `${routeId}|${stops.join('>')}`;
        let patternId = patterns.get(key)?.id;

        if (!patternId) {
            patternId = `${routeId}-p${patterns.size + 1}`;
            patterns.set(key, {
                id: patternId,
                route: routeId,
                stops,
                headsign: rows[rows.length - 1].station_name || null
            });
        }

        trips.push(trip({
            id: `krl-${rows[0].train_id}`,
            route: routeId,
            pattern: patternId,
            service: 'krl-snapshot',
            times: unwrap(rows.map(r => toSeconds(r.time_est)))
        }));
    }

    // ---- geometry: match each pattern to the OSM relation covering it ------
    const candidates = osm.relations
            .filter(r => !r.underConstruction && r.route === 'train')
            .map(relationToShapeCached),
        stopById = new Map(dataset.stops.map(s => [s.id, s])),
        shapesUsed = new Map();
    let unmatchedShapes = 0;

    for (const p of patterns.values()) {
        const points = p.stops.map(id => stopById.get(id)).filter(Boolean);
        let best = null,
            bestScore = 0;

        // Shortlist cheaply on how many of the pattern's stops sit near one of
        // the relation's own stops, then decide precisely against the track.
        const shortlist = candidates
            .filter(c => c.stops.length)
            .map(candidate => {
                let covered = 0;

                for (const point of points) {
                    if (candidate.stops.some(t => metres(point.lat, point.lon, t.lat, t.lon) <= SHAPE_MAX_STOP_DISTANCE_M)) {
                        covered++;
                    }
                }
                return {candidate, covered};
            })
            .sort((a, b) => b.covered - a.covered)
            .slice(0, SHAPE_SHORTLIST);

        let bestWorst = Infinity;

        for (const {candidate} of shortlist) {
            // The worst-placed stop decides it: a line that carries most of the
            // pattern but misses its terminus is the wrong line.
            let worst = 0;

            for (const point of points) {
                const d = distanceToPolyline(point.lat, point.lon, candidate.coords);

                if (d > worst) {
                    worst = d;
                }
                if (worst >= bestWorst) {
                    break;
                }
            }
            if (worst < bestWorst) {
                bestWorst = worst;
                best = candidate;
                bestScore = worst;
            }
        }

        if (best && bestWorst <= SHAPE_MAX_STOP_DISTANCE_M) {
            p.shape = `osm-${best.id}`;
            if (!shapesUsed.has(best.id)) {
                shapesUsed.set(best.id, best);
            }
        } else {
            // Better to draw nothing than to draw a train along the wrong line.
            unmatchedShapes++;
        }
    }

    // ---- emit --------------------------------------------------------------
    dataset.agencies.push({
        id: AGENCY,
        name: 'KAI Commuter',
        url: 'https://commuterline.id/',
        timezone: 'Asia/Jakarta'
    });

    // The API serves one timetable with no date parameter, and Saturday and
    // Sunday harvests came back byte-identical — so whether it varies by day
    // at all is unresolved until a weekday harvest. Modelled as a single
    // service covering every day rather than pretending to know.
    dataset.calendar['krl-snapshot'] = {
        monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1
    };

    for (const r of routes.values()) {
        dataset.routes.push(r);
    }
    for (const relation of shapesUsed.values()) {
        if (!dataset.shapes.some(s => s.id === `osm-${relation.id}`)) {
            dataset.shapes.push(shape({id: `osm-${relation.id}`, coords: relation.coords}));
        }
    }
    for (const p of patterns.values()) {
        dataset.patterns.push(pattern({
            id: p.id,
            route: p.route,
            mode: MODES.commuterRail.id,
            stops: p.stops,
            shape: p.shape ?? null,
            headsign: p.headsign
        }));
    }
    for (const t of trips) {
        dataset.trips.push(t);
    }

    const stats = {
        stations: kciStations.length,
        fromTripsOnly: [...fromTrips.keys()].filter(id => !listed.some(s => s.sta_id === id)),
        unjoined: joined.unmatched.map(s => `${s.id} ${s.name}`),
        joined: joined.matched.size,
        joinRate: joined.rate,
        routes: routes.size,
        patterns: patterns.size,
        trips: trips.length,
        stopTimes: trips.reduce((total, t) => total + t.times.length, 0),
        shapes: shapesUsed.size,
        patternsWithoutShape: unmatchedShapes,
        skipped
    };

    log(`  kci: ${stats.trips} trips, ${stats.patterns} patterns, ${stats.stopTimes.toLocaleString()} stop_times`);
    log(`       join ${joined.matched.size}/${kciStations.length} (${(joined.rate * 100).toFixed(1)}%), ` +
        `${stats.shapes} shapes, ${unmatchedShapes} patterns without geometry`);
    log(`       skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(' ')}`);

    return stats;
}

// relationToShape is pure but not free; patterns are matched against every
// relation, so the conversion is done once.
const cache = new Map();

function relationToShapeCached(relation) {
    if (!cache.has(relation)) {
        cache.set(relation, relation.coords ? relation : relationToShape(relation));
    }
    return cache.get(relation);
}
