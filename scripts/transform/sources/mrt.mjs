/**
 * MRT Jakarta: Strapi snapshot + OSM geometry -> canonical entities.
 *
 * Unlike KRL, this source states no trip identity — only a list of departure
 * times per station per direction. Trips are rebuilt by reconstruct.mjs, and
 * every pattern produced here is flagged `inferred` so the validation gate
 * knows to hold it to a higher standard.
 *
 * Station order comes from the OSM route relation rather than from anything
 * MRT publishes. That matters: order is what makes the temporal check
 * meaningful, and taking it from the geometry means the two cannot drift apart.
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join as pathJoin} from 'node:path';

import {MODES, pattern, route, shape, trip} from '../model.mjs';
import {joinStations, loadAliases} from '../join.mjs';
import {estimateRunTimes, parseClock, reconstructTrips, unwrapBoard} from '../reconstruct.mjs';

const AGENCY = 'mrt-jakarta',
    ROUTE_ID = 'mrt-north-south',

    // The line, as OSM names it in the direction Lebak Bulus -> Bundaran HI.
    RELATION_NAME = /North-South Line/i,

    // Which schedule field holds which direction. `End` runs towards the
    // station named in `end`; `Start` runs back towards `start`.
    DIRECTIONS = [
        {id: 0, field: 'End', reverse: false},
        {id: 1, field: 'Start', reverse: true}
    ],

    // How close a relation stop and a named station must be to be the same
    // place. Platforms are long and the two node sets sit at different points
    // along them, so this is about identity, not precision.
    STATION_MATCH_M = 300,

    SERVICES = [
        {id: 'mrt-weekday', prefix: 'weekdays', days: {monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0}},
        {id: 'mrt-weekend', prefix: 'weekends', days: {monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1}}
    ];

const M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function metres(aLat, aLon, bLat, bLon) {
    return Math.hypot((aLat - bLat) * M_PER_DEG_LAT, (aLon - bLon) * M_PER_DEG_LON);
}

function board(schedule, key) {
    if (!schedule || !schedule[key]) {
        return [];
    }

    const times = String(schedule[key])
        .split(';')
        .map(part => parseClock(part.trim()))
        .filter(value => value !== null)
        .sort((a, b) => a - b);

    return unwrapBoard(times);
}

export default function normaliseMrt({dir, osm, dataset, log}) {
    const stationsDir = pathJoin(dir, 'stations');

    if (!existsSync(stationsDir)) {
        throw new Error(`mrt snapshot has no stations/ (${dir})`);
    }

    // ---- stations, and their schedules -----------------------------------
    const records = [];

    for (const file of readdirSync(stationsDir).sort()) {
        if (!file.endsWith('.json')) {
            continue;
        }

        let record;

        try {
            record = JSON.parse(readFileSync(pathJoin(stationsDir, file), 'utf8')).data?.[0];
        } catch {
            continue;
        }
        if (record?.name) {
            records.push({slug: record.slug, name: record.name, schedule: record.object?.schedule ?? null});
        }
    }

    const joined = joinStations(
            records.map(r => ({id: r.slug, name: r.name})),
            osm.index,
            {aliases: loadAliases()}
        ),
        osmIdFor = new Map();

    for (const [slug, node] of joined.matched) {
        osmIdFor.set(slug, node.osmId);
    }

    // ---- geographic order, taken from the OSM relation --------------------
    const relation = osm.relations.find(r =>
        r.route === 'subway' && !r.underConstruction && RELATION_NAME.test(r.name));

    if (!relation) {
        throw new Error('no usable MRT North-South relation in the OSM snapshot');
    }

    // The relation lists its stops in running order, but its `stop` members are
    // railway=stop nodes while the name join matched railway=station nodes —
    // the same places with different ids. So the two are matched by position,
    // which is what actually identifies a station on the ground.
    const bySlug = new Map(records.map(r => [r.slug, r])),
        placed = [...joined.matched].map(([slug, node]) => ({slug, lat: node.lat, lon: node.lon})),
        used = new Set(),
        ordered = [];

    for (const stop of relation.stops) {
        let best = null,
            bestDistance = Infinity;

        for (const candidate of placed) {
            if (used.has(candidate.slug)) {
                continue;
            }

            const distance = metres(stop.lat, stop.lon, candidate.lat, candidate.lon);

            if (distance < bestDistance) {
                bestDistance = distance;
                best = candidate;
            }
        }
        if (best && bestDistance <= STATION_MATCH_M && bySlug.has(best.slug)) {
            used.add(best.slug);
            ordered.push(bySlug.get(best.slug));
        }
    }

    if (ordered.length < 3) {
        throw new Error(`MRT station order could not be established (${ordered.length} matched to the relation)`);
    }

    // ---- reconstruct trips, per direction and per service day -------------
    const routeId = ROUTE_ID,
        patterns = new Map(),
        trips = [],
        stats = {stations: records.length, joined: joined.matched.size, ordered: ordered.length, byDirection: {}};

    for (const service of SERVICES) {
        for (const direction of DIRECTIONS) {
            const line = direction.reverse ? [...ordered].reverse() : ordered,
                boards = line.map(station => board(station.schedule, `${service.prefix}${direction.field}`));

            if (boards.every(b => !b.length)) {
                continue;
            }

            // The far terminus publishes no departures, so its arrival time is
            // taken from the same leg measured in the opposite direction.
            const opposite = (direction.reverse ? ordered : [...ordered].reverse())
                    .map(station => board(station.schedule, `${service.prefix}${direction.reverse ? 'End' : 'Start'}`)),
                oppositeRun = estimateRunTimes(opposite),
                {trips: rebuilt, stats: rebuiltStats} = reconstructTrips(boards, {
                    terminusRunTime: oppositeRun[0] ?? null
                });

            stats.byDirection[`${service.id}-${direction.id}`] = {
                trips: rebuilt.length,
                fullLine: rebuilt.filter(t => t.stops.length === line.length).length,
                originating: rebuiltStats.originatingAt.reduce((acc, n, i) => {
                    if (n) {
                        acc[line[i].name] = n;
                    }
                    return acc;
                }, {}),
                terminusArrivalsAdded: rebuiltStats.terminusArrivalsAdded
            };

            for (const rebuiltTrip of rebuilt) {
                const stops = rebuiltTrip.stops.map(i => `osm-${osmIdFor.get(line[i].slug)}`),
                    key = `${direction.id}|${stops.join('>')}`;

                let patternId = patterns.get(key)?.id;

                if (!patternId) {
                    patternId = `${routeId}-d${direction.id}-p${patterns.size + 1}`;
                    patterns.set(key, {
                        id: patternId,
                        stops,
                        direction: direction.id,
                        headsign: line[line.length - 1].name
                    });
                }

                trips.push(trip({
                    id: `mrt-${service.id}-${direction.id}-${String(trips.length + 1).padStart(4, '0')}`,
                    route: routeId,
                    pattern: patternId,
                    service: service.id,
                    times: rebuiltTrip.times
                }));
            }
        }
    }

    // ---- emit --------------------------------------------------------------
    dataset.agencies.push({
        id: AGENCY,
        name: 'MRT Jakarta',
        url: 'https://www.jakartamrt.co.id/',
        timezone: 'Asia/Jakarta'
    });
    for (const service of SERVICES) {
        dataset.calendar[service.id] = service.days;
    }
    dataset.routes.push(route({
        id: routeId,
        mode: MODES.metro.id,
        agency: AGENCY,
        shortName: 'M',
        longName: 'North-South Line',
        category: 'MRT',
        color: relation.colour || '#CE0037',
        textColor: '#FFFFFF'
    }));
    if (!dataset.shapes.some(s => s.id === `osm-${relation.id}`)) {
        dataset.shapes.push(shape({id: `osm-${relation.id}`, coords: relation.coords}));
    }
    for (const p of patterns.values()) {
        dataset.patterns.push(pattern({
            id: p.id,
            route: routeId,
            mode: MODES.metro.id,
            stops: p.stops,
            shape: `osm-${relation.id}`,
            headsign: p.headsign,
            direction: p.direction,
            // Rebuilt from departure boards, not stated by the source.
            inferred: true
        }));
    }
    for (const t of trips) {
        dataset.trips.push(t);
    }

    stats.routes = 1;
    stats.patterns = patterns.size;
    stats.trips = trips.length;
    stats.stopTimes = trips.reduce((total, t) => total + t.times.length, 0);

    log(`  mrt: ${stats.trips} trips, ${stats.patterns} patterns, ${stats.stopTimes.toLocaleString()} stop_times`);
    log(`       ${ordered.length} stations in line order, join ${joined.matched.size}/${records.length}`);
    for (const [key, value] of Object.entries(stats.byDirection)) {
        log(`       ${key}: ${value.trips} trips (${value.fullLine} full line), ` +
            `originating ${Object.entries(value.originating).map(([n, c]) => `${n}×${c}`).join(', ')}`);
    }

    return stats;
}
