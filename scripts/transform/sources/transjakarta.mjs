/**
 * Transjakarta GTFS snapshot -> canonical entities.
 *
 * The only source here with a real contract, and the one everything else was
 * modelled against — so most of this is reading a standard rather than
 * reverse-engineering a website. What is peculiar to this feed:
 *
 *   - **There are no departure rows.** A trip is a pattern plus headway
 *     windows from frequencies.txt, so it is the first source to use the
 *     canonical trip's `frequency` arm instead of `times`. 700 trips expand
 *     into roughly 6,600 vehicles at the evening peak.
 *
 *   - **Stations are containers.** stop_times references platforms, which point
 *     at a station through parent_station. Anything asking "what serves this
 *     stop?" has to fold platforms in — the same shape as OSM returning stop
 *     and platform nodes for one place.
 *
 *   - **Times pass midnight.** A last bus at 24:44 is 00:44 tomorrow and
 *     belongs to today's service. Wrapping it once made a 24-hour route look
 *     28 minutes long.
 *
 *   - **Category is not mode.** BRT, Mikrotrans, Royaltrans and the rest are
 *     Transjakarta's own product names. They stay, one level below mode.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join as pathJoin} from 'node:path';

import {MODES, agency, pattern, route, shape, trip} from '../model.mjs';

const AGENCY_ID = 'transjakarta',

    // The feed states the category outright in route_desc — "BRT", "Mikrotrans",
    // "Royaltrans" and so on. Deriving it from route names instead produced
    // "Lainnya" for 136 of 252 routes, which is what guessing at something the
    // data already says buys you.
    CATEGORY_FIELD = 'route_desc';

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

function readTable(dir, name) {
    const file = pathJoin(dir, `${name}.txt`);

    if (!existsSync(file)) {
        return [];
    }

    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

    if (!lines.length) {
        return [];
    }

    const header = splitRow(lines[0].replace(/^﻿/, ''));

    return lines.slice(1).map(line => {
        const values = splitRow(line),
            row = {};

        header.forEach((key, i) => {
            row[key] = values[i] ?? '';
        });
        return row;
    });
}

// "24:44:00" -> 88 or more thousand seconds. Deliberately not wrapped.
function toSeconds(clock) {
    const [h, m, s] = String(clock).split(':').map(Number);

    return Number.isFinite(h) ? h * 3600 + m * 60 + (s || 0) : null;
}

export default function normaliseTransjakarta({dir, dataset, log}) {
    const gtfs = pathJoin(dir, 'gtfs');

    if (!existsSync(gtfs)) {
        throw new Error(`transjakarta snapshot is not unpacked (${gtfs}) — re-run ingest`);
    }

    const agencyRow = readTable(gtfs, 'agency')[0] ?? {},
        routeRows = readTable(gtfs, 'routes'),
        stopRows = readTable(gtfs, 'stops'),
        tripRows = readTable(gtfs, 'trips'),
        calendarRows = readTable(gtfs, 'calendar'),
        frequencyRows = readTable(gtfs, 'frequencies'),
        shapeRows = readTable(gtfs, 'shapes'),
        stopTimeRows = readTable(gtfs, 'stop_times'),
        fareAttributeRows = readTable(gtfs, 'fare_attributes'),
        fareRuleRows = readTable(gtfs, 'fare_rules');

    // ---- agency, calendar, routes -----------------------------------------
    dataset.agencies.push(agency({
        id: AGENCY_ID,
        name: agencyRow.agency_name || 'Transjakarta',
        url: agencyRow.agency_url || null,
        timezone: agencyRow.agency_timezone || 'Asia/Jakarta'
    }));

    for (const row of calendarRows) {
        dataset.calendar[`tj-${row.service_id}`] = {
            monday: Number(row.monday), tuesday: Number(row.tuesday),
            wednesday: Number(row.wednesday), thursday: Number(row.thursday),
            friday: Number(row.friday), saturday: Number(row.saturday),
            sunday: Number(row.sunday)
        };
    }

    const categories = new Map();

    for (const row of routeRows) {
        const category = row[CATEGORY_FIELD] || 'Lainnya';

        categories.set(category, (categories.get(category) || 0) + 1);
        dataset.routes.push(route({
            id: `tj-${row.route_id}`,
            mode: MODES.bus.id,
            agency: AGENCY_ID,
            shortName: row.route_short_name || '',
            longName: row.route_long_name || '',
            category,
            color: row.route_color ? `#${row.route_color}` : null,
            textColor: row.route_text_color ? `#${row.route_text_color}` : null
        }));
    }

    // ---- stops, folding platforms into their station -----------------------
    const stopById = new Map(stopRows.map(row => [row.stop_id, row]));
    let stations = 0;

    for (const row of stopRows) {
        const lat = Number(row.stop_lat),
            lon = Number(row.stop_lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) {
            continue;
        }

        const isStation = row.location_type === '1';

        if (isStation) {
            stations++;
            dataset.stations.push({
                id: `tj-${row.stop_id}`,
                name: row.stop_name || row.stop_id,
                lat,
                lon,
                modes: [MODES.bus.id]
            });
        }
        dataset.stops.push({
            id: `tj-${row.stop_id}`,
            name: row.stop_name || row.stop_id,
            lat,
            lon,
            station: row.parent_station && stopById.has(row.parent_station)
                ? `tj-${row.parent_station}`
                : (isStation ? `tj-${row.stop_id}` : null),
            modes: [MODES.bus.id],
            accessible: row.wheelchair_boarding === '1',
            platform: row.platform_code || null
        });
    }

    // A corridor station is reachable if any of its platforms is, but the feed
    // records the flag on the platforms and only stations are drawn. Propagate
    // it upwards so the station tells the truth.
    const stopIndex = new Map(dataset.stops.map(stop => [stop.id, stop]));

    for (const stop of dataset.stops) {
        if (stop.accessible && stop.station && stop.station !== stop.id) {
            const station = stopIndex.get(stop.station);

            if (station) {
                station.accessible = true;
            }
        }
    }

    // ---- shapes ------------------------------------------------------------
    const byShape = new Map();

    for (const row of shapeRows) {
        if (!byShape.has(row.shape_id)) {
            byShape.set(row.shape_id, []);
        }
        byShape.get(row.shape_id).push({
            sequence: Number(row.shape_pt_sequence),
            lon: Number(row.shape_pt_lon),
            lat: Number(row.shape_pt_lat)
        });
    }
    for (const [id, points] of byShape) {
        points.sort((a, b) => a.sequence - b.sequence);
        if (points.length < 2) {
            continue;
        }
        dataset.shapes.push(shape({
            id: `tj-${id}`,
            coords: points.flatMap(point => [point.lon, point.lat])
        }));
    }

    // ---- patterns and trips ------------------------------------------------
    const stopsByTrip = new Map();

    for (const row of stopTimeRows) {
        if (!stopsByTrip.has(row.trip_id)) {
            stopsByTrip.set(row.trip_id, []);
        }
        stopsByTrip.get(row.trip_id).push({
            sequence: Number(row.stop_sequence),
            stop: row.stop_id,
            departure: toSeconds(row.departure_time)
        });
    }

    const frequenciesByTrip = new Map();

    for (const row of frequencyRows) {
        if (!frequenciesByTrip.has(row.trip_id)) {
            frequenciesByTrip.set(row.trip_id, []);
        }
        frequenciesByTrip.get(row.trip_id).push({
            start: toSeconds(row.start_time),
            end: toSeconds(row.end_time),
            headway: Number(row.headway_secs)
        });
    }

    const knownStops = new Set(dataset.stops.map(s => s.id)),
        patterns = new Map(),
        skipped = {noStops: 0, noFrequency: 0, unknownStop: 0};
    let trips = 0,
        windows = 0;

    for (const row of tripRows) {
        const calls = stopsByTrip.get(row.trip_id);

        if (!calls || calls.length < 2) {
            skipped.noStops++;
            continue;
        }
        calls.sort((a, b) => a.sequence - b.sequence);

        const stops = calls.map(call => `tj-${call.stop}`);

        if (stops.some(id => !knownStops.has(id))) {
            skipped.unknownStop++;
            continue;
        }

        const shapeId = row.shape_id ? `tj-${row.shape_id}` : null,
            key = `tj-${row.route_id}|${stops.join('>')}`;

        let patternId = patterns.get(key)?.id;

        if (!patternId) {
            patternId = `tj-${row.route_id}-p${patterns.size + 1}`;
            patterns.set(key, {
                id: patternId,
                route: `tj-${row.route_id}`,
                stops,
                shape: shapeId,
                headsign: row.trip_headsign || null,
                direction: Number(row.direction_id || 0),
                // Offsets from the trip's own first call, which is what a
                // headway-expanded vehicle needs to position itself.
                offsets: calls.map(call => (call.departure ?? 0) - (calls[0].departure ?? 0))
            });
        }

        const frequencies = frequenciesByTrip.get(row.trip_id);

        if (!frequencies?.length) {
            skipped.noFrequency++;
            continue;
        }
        windows += frequencies.length;
        dataset.trips.push(trip({
            id: `tj-${row.trip_id}`,
            route: `tj-${row.route_id}`,
            pattern: patternId,
            service: `tj-${row.service_id}`,
            frequency: {windows: frequencies}
        }));
        trips++;
    }

    for (const p of patterns.values()) {
        const emitted = pattern({
            id: p.id,
            route: p.route,
            mode: MODES.bus.id,
            stops: p.stops,
            shape: p.shape,
            headsign: p.headsign,
            direction: p.direction
        });

        // Seconds from the pattern's first call. Identical for every trip that
        // runs it, so it lives here once rather than on each of them — which is
        // the same reason stop identity does.
        emitted.offsets = p.offsets;
        dataset.patterns.push(emitted);
    }

    // ---- fares -------------------------------------------------------------
    for (const row of fareAttributeRows) {
        dataset.fares.attributes[`tj-${row.fare_id}`] = {
            price: Number(row.price),
            currency: row.currency_type || 'IDR',
            transfers: row.transfers === '' ? null : Number(row.transfers),
            transferDuration: row.transfer_duration ? Number(row.transfer_duration) : null
        };
    }
    for (const row of fareRuleRows) {
        if (row.route_id) {
            dataset.fares.byRoute[`tj-${row.route_id}`] = `tj-${row.fare_id}`;
        }
    }

    const free = Object.entries(dataset.fares.byRoute)
        .filter(([, fare]) => dataset.fares.attributes[fare]?.price === 0).length;

    log(`  transjakarta: ${trips} trips, ${patterns.size} patterns, ${windows} headway windows`);
    log(`       ${dataset.routes.filter(r => r.mode === MODES.bus.id).length} routes, ` +
        `${dataset.stops.filter(s => s.modes.includes(MODES.bus.id)).length} stops (${stations} stations), ` +
        `${byShape.size} shapes`);
    log(`       categories: ${[...categories].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}=${c}`).join(' ')}`);
    log(`       fares: ${Object.keys(dataset.fares.attributes).length} attributes, ${free} free routes`);
    if (skipped.noStops || skipped.noFrequency || skipped.unknownStop) {
        log(`       skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }

    return {
        trips,
        patterns: patterns.size,
        windows,
        stops: stopRows.length,
        stations,
        shapes: byShape.size,
        freeRoutes: free,
        skipped
    };
}
