/**
 * LRT Jakarta (Kelapa Gading — Velodrome): form snapshot + OSM -> canonical.
 *
 * The smallest network here and the simplest to rebuild: six stations, no
 * branches, no short workings observed, and a flat ten-minute headway.
 *
 * One difference from MRT. Station order is taken from the operator rather
 * than from the OSM relation, because the relation only lists four of the six
 * stops — a known upstream gap. The six stations themselves all resolve to OSM
 * nodes, so every one has coordinates; it is only the running order the
 * relation cannot supply. The form's own station ids happen to be the line
 * order (6 Kelapa Gading down to 1 Velodrome), which is what makes that safe.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join as pathJoin} from 'node:path';

import {MODES, pattern, route, shape, trip} from '../model.mjs';
import {joinStations, loadAliases} from '../join.mjs';
import {estimateRunTimes, parseClock, reconstructTrips, unwrapBoard} from '../reconstruct.mjs';

const AGENCY = 'lrt-jakarta',
    ROUTE_ID = 'lrtj-lin-selatan',
    RELATION_NAME = /Lin Selatan/i,

    // Line order, north to south, as the form's own ids give it.
    ORDER = [6, 5, 4, 3, 2, 1],

    SERVICE = {
        id: 'lrtj-daily',
        days: {monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1}
    };

// Times sit in the result box as <div class="... item-time ...">HH:MM</div>.
function board(html) {
    if (!html) {
        return [];
    }

    const times = [...html.matchAll(/item-time[^>]*>\s*([0-2]?\d:[0-5]\d)\s*</g)]
        .map(match => parseClock(match[1]))
        .filter(value => value !== null)
        .sort((a, b) => a - b);

    return unwrapBoard(times);
}

export default function normaliseLrtJakarta({dir, osm, dataset, log}) {
    const stationsFile = pathJoin(dir, 'stations.json');

    if (!existsSync(stationsFile)) {
        throw new Error(`lrt-jakarta snapshot has no stations.json (${dir})`);
    }

    const stations = JSON.parse(readFileSync(stationsFile, 'utf8')),
        byId = new Map(stations.map(s => [Number(s.id), s])),
        joined = joinStations(
            stations.map(s => ({id: String(s.id), name: s.name})),
            osm.index,
            {aliases: loadAliases()}
        ),
        osmIdFor = new Map([...joined.matched].map(([id, node]) => [Number(id), node.osmId]));

    if (osmIdFor.size < ORDER.length) {
        log(`       ! only ${osmIdFor.size}/${ORDER.length} stations resolved to OSM`);
    }

    const read = name => {
            const file = pathJoin(dir, 'schedules', name);

            return existsSync(file) ? readFileSync(file, 'utf8') : null;
        },
        relation = osm.relations.find(r =>
            r.route === 'light_rail' && RELATION_NAME.test(r.name)),
        patterns = new Map(),
        trips = [],
        stats = {stations: stations.length, joined: osmIdFor.size, byDirection: {}};

    // Two directions, each towards one end of the line. A terminus has no
    // board of its own, which reconstructTrips handles by extending the last
    // leg using the run time measured in the opposite direction.
    for (const [directionId, line] of [[0, ORDER], [1, [...ORDER].reverse()]]) {
        const terminus = line[line.length - 1],
            boards = line.map(id => id === terminus ? [] : board(read(`${id}-to-${terminus}.html`)));

        if (boards.every(b => !b.length)) {
            continue;
        }

        const oppositeLine = [...line].reverse(),
            oppositeTerminus = oppositeLine[oppositeLine.length - 1],
            opposite = oppositeLine.map(id =>
                id === oppositeTerminus ? [] : board(read(`${id}-to-${oppositeTerminus}.html`))),
            {trips: rebuilt, stats: rebuiltStats} = reconstructTrips(boards, {
                terminusRunTime: estimateRunTimes(opposite)[0] ?? null
            });

        stats.byDirection[directionId] = {
            trips: rebuilt.length,
            fullLine: rebuilt.filter(t => t.stops.length === line.length).length
        };

        for (const rebuiltTrip of rebuilt) {
            const stops = rebuiltTrip.stops.map(i => `osm-${osmIdFor.get(line[i])}`);

            if (stops.some(s => s.endsWith('undefined'))) {
                continue;
            }

            const key = `${directionId}|${stops.join('>')}`;
            let patternId = patterns.get(key)?.id;

            if (!patternId) {
                patternId = `${ROUTE_ID}-d${directionId}-p${patterns.size + 1}`;
                patterns.set(key, {
                    id: patternId,
                    stops,
                    direction: directionId,
                    headsign: byId.get(terminus)?.name ?? null
                });
            }

            trips.push(trip({
                id: `lrtj-${directionId}-${String(trips.length + 1).padStart(4, '0')}`,
                route: ROUTE_ID,
                pattern: patternId,
                service: SERVICE.id,
                times: rebuiltTrip.times
            }));
        }
    }

    dataset.agencies.push({
        id: AGENCY,
        name: 'LRT Jakarta',
        url: 'https://lrtjakarta.co.id/',
        timezone: 'Asia/Jakarta'
    });
    dataset.calendar[SERVICE.id] = SERVICE.days;
    dataset.routes.push(route({
        id: ROUTE_ID,
        mode: MODES.lightRail.id,
        agency: AGENCY,
        shortName: 'LRT-J',
        longName: 'Lin Selatan',
        category: 'LRT Jakarta',
        color: relation?.colour || '#f16227',
        textColor: '#FFFFFF'
    }));

    // The relation covers the line even though it names only four stops, so it
    // is still the right geometry to draw.
    if (relation && !dataset.shapes.some(s => s.id === `osm-${relation.id}`)) {
        dataset.shapes.push(shape({id: `osm-${relation.id}`, coords: relation.coords}));
    }
    for (const p of patterns.values()) {
        dataset.patterns.push(pattern({
            id: p.id,
            route: ROUTE_ID,
            mode: MODES.lightRail.id,
            stops: p.stops,
            shape: relation ? `osm-${relation.id}` : null,
            headsign: p.headsign,
            direction: p.direction,
            inferred: true
        }));
    }
    for (const t of trips) {
        dataset.trips.push(t);
    }

    stats.patterns = patterns.size;
    stats.trips = trips.length;
    stats.stopTimes = trips.reduce((total, t) => total + t.times.length, 0);

    log(`  lrt-jakarta: ${stats.trips} trips, ${stats.patterns} patterns, ${stats.stopTimes.toLocaleString()} stop_times`);
    log(`       join ${osmIdFor.size}/${stations.length}, ` +
        Object.entries(stats.byDirection).map(([d, v]) => `dir${d}=${v.trips} (${v.fullLine} full)`).join(' '));

    return stats;
}
