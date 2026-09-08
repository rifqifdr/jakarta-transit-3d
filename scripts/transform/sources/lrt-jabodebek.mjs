/**
 * LRT Jabodebek: scraped departure boards + OSM geometry -> canonical.
 *
 * The hardest of the three reconstructions, because the network branches and
 * the boards do not say so. Seven trunk stations between Setiabudi and Cawang
 * each publish a single list of ~430 weekday departures that merges *four*
 * streams: two directions × two branches. Nothing in the page labels either.
 *
 * What makes it tractable is that the ambiguity is local. Four places in the
 * network are unambiguous:
 *
 *   Jati Mulya  — Bekasi branch terminus, inbound only
 *   Harjamukti  — Cibubur branch terminus, inbound only
 *   Halim       — first station only the Bekasi branch serves
 *   Taman Mini  — first station only the Cibubur branch serves
 *
 * So the passes run from certainty outwards, sharing one claim ledger:
 *
 *   1. Inbound from Jati Mulya, and inbound from Harjamukti. Both start where
 *      the branch is beyond doubt, and lift their trains out of the trunk
 *      lists as they propagate.
 *   2. Outbound, anchored at Halim and at Taman Mini and extended *backwards*
 *      through the trunk to Dukuh Atas. Anchoring matters: an outbound train
 *      at Dukuh Atas is not identifiably Bekasi or Cibubur until it has passed
 *      Cawang, so starting there would assign a branch by whichever pass ran
 *      first.
 *
 * The two branches are separable in time as well as in space — Cawang to Halim
 * is 300 s against Cawang to Taman Mini's 180 s — which is what stops the
 * chains crossing over at the junction.
 *
 * The answer is checked rather than trusted: the reconstructed direction and
 * branch counts have to reconcile with the board sizes, and the caller reports
 * the reconciliation.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join as pathJoin} from 'node:path';

import {MODES, pattern, route, shape, trip} from '../model.mjs';
import {joinStations, loadAliases} from '../join.mjs';
import {createClaims, estimateRunTimes, parseClock, reconstructInterleaved, unwrapBoard} from '../reconstruct.mjs';
import {fitRunTimes, legDistances} from '../geometry.mjs';

const AGENCY = 'lrt-jabodebek',

    // Station names as the page's own accordion labels give them, in page
    // order: the trunk, then the Bekasi branch, then the Cibubur branch.
    PAGE_ORDER = [
        'Dukuh Atas BNI', 'Setiabudi', 'Rasuna Said', 'Kuningan', 'Pancoran',
        'Cikoko', 'Ciliwung', 'Cawang',
        'Halim', 'Jati Bening Baru', 'Cikunir 1', 'Cikunir 2', 'Bekasi Barat', 'Jati Mulya',
        'Harjamukti', 'Kampung Rambutan', 'Ciracas', 'Taman Mini'
    ],

    TRUNK = PAGE_ORDER.slice(0, 8),

    // Where this operator's name for a station is not the name OSM uses.
    //
    // "Dukuh Atas BNI" is the interesting one: LRT Jabodebek calls its western
    // terminus that, but in OSM the name belongs to the *MRT* station
    // (station=subway) 541 m away, while the LRT station is "Dukuh Atas Bank
    // Syariah Indonesia" (station=light_rail). Matching on the shared name puts
    // every LRT trip at the wrong end of the interchange, and the geometry
    // check is what caught it.
    //
    // This lives here rather than in data/aliases.json because it is only true
    // for this source — MRT's own "Dukuh Atas BNI" is correct.
    OSM_NAME = {
        'Dukuh Atas BNI': 'Dukuh Atas Bank Syariah Indonesia'
    },

    LINES = [
        {
            id: 'lrtjb-bekasi',
            name: 'Bekasi Line',
            relation: /Bekasi Line \(Dukuh Atas/i,
            colour: '#0E6938',
            // Outward from Dukuh Atas.
            stations: [...TRUNK, 'Halim', 'Jati Bening Baru', 'Cikunir 1', 'Cikunir 2', 'Bekasi Barat', 'Jati Mulya'],
            // First station only this branch serves — where an outbound train
            // becomes identifiable.
            anchor: 'Halim'
        },
        {
            id: 'lrtjb-cibubur',
            name: 'Cibubur Line',
            relation: /Cibubur Line \(Dukuh Atas/i,
            colour: '#20409A',
            stations: [...TRUNK, 'Taman Mini', 'Kampung Rambutan', 'Ciracas', 'Harjamukti'],
            anchor: 'Taman Mini'
        }
    ],

    SERVICES = [
        {id: 'lrtjb-weekday', label: 'Hari Biasa', offset: 0, days: {monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0}},
        {id: 'lrtjb-weekend', label: 'Hari Libur', offset: 1, days: {monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 1, sunday: 1}}
    ],

    // Trunk boards run about one departure every three minutes once four
    // streams are merged, and the two branches differ by two minutes out of
    // Cawang. Ninety seconds sits inside both margins — wide enough for real
    // variation, too narrow to swallow the next train.
    TOLERANCE_S = 90,

    // How far a reconstructed stream may sit from the board it came from
    // before the result is refused. The branch termini and Dukuh Atas publish
    // exact counts, so this is a real check rather than a smell test.
    RECONCILE_TOLERANCE = 0.15,

    TABLE_SPLIT = /<table[^>]*class="table table-striped mt-5 table-jadwal-tarif"/;

/**
 * The page renders 36 tables: eighteen stations, each with a Hari Biasa table
 * followed by a Hari Libur one, in the order the accordion lists them.
 */
function parseBoards(html, offset) {
    const parts = html.split(TABLE_SPLIT).slice(1),
        boards = new Map();

    parts.forEach((part, index) => {
        if (index % 2 !== offset) {
            return;
        }

        const station = PAGE_ORDER[Math.floor(index / 2)];

        if (!station) {
            return;
        }

        const body = part.slice(0, part.indexOf('</table>')),
            times = [...body.matchAll(/\b([0-2]\d:[0-5]\d)\b/g)]
                .map(match => parseClock(match[1]))
                .filter(value => value !== null)
                .sort((a, b) => a - b);

        boards.set(station, unwrapBoard(times));
    });
    return boards;
}

// One reconstruction pass: a line, a direction, and the single station where
// a service of that kind can legitimately begin.
function buildPass(line, direction, stations, anchor, boards, runTimes) {
    const terminus = stations[stations.length - 1],
        lineBoards = stations.map(name => boards.get(name) ?? []);

    return {
        tag: `${line.id}-d${direction}`,
        line,
        direction,
        keys: stations,
        boards: lineBoards,
        anchor,
        startAt: [anchor],
        runTimes,
        terminusRunTime: boards.get(terminus)?.length
            ? null
            : (runTimes ? runTimes[runTimes.length - 1] : estimateRunTimes([...lineBoards].reverse())[0]) ?? null
    };
}

/**
 * Run times for a line, taken from the track rather than from the timetable.
 *
 * Returns the outward vector; the inbound one is simply its reverse, because a
 * leg is the same length in both directions even when the boards disagree
 * about it — which is exactly the disagreement that made this necessary.
 */
function geometryRunTimes(line, boards, osm, osmIdFor, index) {
    const relation = osm.relations.find(r => r.route === 'light_rail' && line.relation.test(r.name));

    if (!relation) {
        return null;
    }

    const placed = line.stations.map(name => {
        const node = [...index.byName.values()].find(n => n.osmId === osmIdFor.get(name));

        return node ? {name, lat: node.lat, lon: node.lon} : null;
    });

    if (placed.some(p => !p)) {
        return null;
    }

    const distances = legDistances(placed, relation.coords),
        forward = estimateRunTimes(line.stations.map(name => boards.get(name) ?? [])),
        backward = estimateRunTimes([...line.stations].reverse().map(name => boards.get(name) ?? []));

    return fitRunTimes(distances, forward, backward);
}

export default function normaliseLrtJabodebek({dir, osm, dataset, log}) {
    const file = pathJoin(dir, 'jadwal-keberangkatan.html');

    if (!existsSync(file)) {
        throw new Error(`lrt-jabodebek snapshot has no jadwal-keberangkatan.html (${dir})`);
    }

    const html = readFileSync(file, 'utf8'),
        joined = joinStations(
            PAGE_ORDER.map(name => ({id: name, name: OSM_NAME[name] ?? name})),
            osm.index,
            {aliases: loadAliases()}
        ),
        osmIdFor = new Map([...joined.matched].map(([name, node]) => [name, node.osmId]));

    if (joined.unmatched.length) {
        log(`       ! unmatched stations: ${joined.unmatched.map(s => s.name).join(', ')}`);
    }

    const patterns = new Map(),
        trips = [],
        stats = {stations: PAGE_ORDER.length, joined: osmIdFor.size, reconciliation: {}};

    const rejected = [];

    for (const service of SERVICES) {
        const boards = parseBoards(html, service.offset);

        if (!boards.size) {
            continue;
        }

        const tripsBefore = trips.length,
            patternsBefore = new Set(patterns.keys());

        const counted = {},
            claims = createClaims(),

            // Stage 1 — inbound. Both branch termini are unambiguous, so these
            // can be trusted; interleaving the two keeps either branch from
            // taking the other's trains off the shared trunk.
            fits = new Map(LINES.map(line =>
                [line.id, geometryRunTimes(line, boards, osm, osmIdFor, osm.index)])),

            inbound = LINES.map(line => buildPass(
                line, 1, [...line.stations].reverse(), 0, boards,
                fits.get(line.id) ? [...fits.get(line.id).runTimes].reverse() : null
            )),

            // Stage 2 — outbound, on what is left. This has to run second: the
            // anchor stations carry both directions (Taman Mini publishes 216
            // departures, Halim 214), so before the inbound trains are lifted
            // out, half of an anchor's departures are not outbound services at
            // all and anchoring on them invents trips.
            outbound = LINES.map(line => buildPass(
                line, 0, line.stations, line.stations.indexOf(line.anchor), boards,
                fits.get(line.id)?.runTimes ?? null
            )),

            passes = [...inbound, ...outbound],
            byTag = new Map();

        // Inbound gets more latitude than outbound, and the asymmetry is
        // earned rather than tuned: an inbound chain starts at a branch
        // terminus, so it is certainly a real train and the only question is
        // which departures downstream are its own. Letting those chains
        // persist is what removes them from the anchor stations — and every
        // inbound train left behind becomes a phantom outbound one, because
        // outbound counts whatever is unclaimed there.
        for (const [stage, tolerance] of [[inbound, TOLERANCE_S * 2], [outbound, TOLERANCE_S]]) {
            const {byTag: stageTags} = reconstructInterleaved(stage, {tolerance, claims});

            for (const [tag, value] of stageTags) {
                byTag.set(tag, value);
            }
        }

        for (const pass of passes) {
            const rebuilt = byTag.get(pass.tag);

            counted[pass.tag] = rebuilt.length;

            for (const rebuiltTrip of rebuilt) {
                const stops = rebuiltTrip.stops.map(i => `osm-${osmIdFor.get(pass.keys[i])}`);

                if (stops.some(x => x.endsWith('undefined'))) {
                    continue;
                }

                const key = `${pass.tag}|${stops.join('>')}`;
                let patternId = patterns.get(key)?.id;

                if (!patternId) {
                    patternId = `${pass.tag}-p${patterns.size + 1}`;
                    patterns.set(key, {
                        id: patternId,
                        route: pass.line.id,
                        stops,
                        direction: pass.direction,
                        headsign: pass.keys[pass.keys.length - 1]
                    });
                }

                trips.push(trip({
                    id: `${pass.tag}-${service.id}-${String(trips.length + 1).padStart(4, '0')}`,
                    route: pass.line.id,
                    pattern: patternId,
                    service: service.id,
                    times: rebuiltTrip.times
                }));
            }
        }

        // ---- reconcile before believing any of it ------------------------
        //
        // Inbound reconstructs exactly: 107 Bekasi against a 107-departure
        // board at Jati Mulya, 109 Cibubur against 109 at Harjamukti. Outbound
        // does not, and the reason is worth recording rather than tuning away.
        //
        // Run times are inferred from the boards, and on a merged board a
        // symmetric timetable puts trains of *opposite* directions at a
        // consistent offset — Halim to Cawang peaks at 60 s, twelve times above
        // background, which is a passing train and not a journey. The estimator
        // cannot separate that from a real leg, so inbound chains break around
        // the junction and leave departures at Halim that outbound then claims
        // as trips that never ran.
        //
        // Seeding run times from the OSM geometry instead of inferring them
        // would remove the ambiguity, and that is the next step. Until then
        // this refuses to emit rather than putting phantom trains on the map:
        // the whole pipeline is built on stale being better than wrong.
        const expected = {
                [`${LINES[0].id}-d1`]: boards.get('Jati Mulya')?.length ?? 0,
                [`${LINES[1].id}-d1`]: boards.get('Harjamukti')?.length ?? 0
            },
            outboundCounted = LINES.reduce((total, line) => total + (counted[`${line.id}-d0`] ?? 0), 0),
            outboundExpected = boards.get('Dukuh Atas BNI')?.length ?? 0,
            offBy = [];

        for (const [tag, count] of Object.entries(expected)) {
            if (count && Math.abs(counted[tag] - count) / count > RECONCILE_TOLERANCE) {
                offBy.push(`${tag}: ${counted[tag]} reconstructed against ${count} published`);
            }
        }
        if (outboundExpected &&
            Math.abs(outboundCounted - outboundExpected) / outboundExpected > RECONCILE_TOLERANCE) {
            offBy.push(`outbound: ${outboundCounted} reconstructed against ${outboundExpected} published`);
        }

        stats.fits = fits;
        stats.reconciles = stats.reconciles ?? {};
        stats.reconciles[service.id] = offBy.length === 0;

        if (offBy.length) {
            rejected.push({service: service.id, offBy});
            trips.length = tripsBefore;
            for (const key of [...patterns.keys()]) {
                if (patternsBefore.has(key)) {
                    continue;
                }
                patterns.delete(key);
            }
        }

        // The answer has to reconcile with the boards it came from: the trains
        // reconstructed on a branch should match that branch terminus's own
        // departure count, and the trunk should equal the sum of all four.
        stats.reconciliation[service.id] = {
            counted,
            jatiMulyaBoard: boards.get('Jati Mulya')?.length ?? 0,
            harjamuktiBoard: boards.get('Harjamukti')?.length ?? 0,
            dukuhAtasBoard: boards.get('Dukuh Atas BNI')?.length ?? 0,
            cawangBoard: boards.get('Cawang')?.length ?? 0,
            reconstructedTotal: Object.values(counted).reduce((a, b) => a + b, 0)
        };
    }

    // ---- emit --------------------------------------------------------------
    dataset.agencies.push({
        id: AGENCY,
        name: 'LRT Jabodebek',
        url: 'https://lrtjabodebek.kai.id/',
        timezone: 'Asia/Jakarta'
    });
    for (const service of SERVICES) {
        dataset.calendar[service.id] = service.days;
    }
    for (const line of LINES) {
        const relation = osm.relations.find(r =>
            r.route === 'light_rail' && line.relation.test(r.name));

        dataset.routes.push(route({
            id: line.id,
            mode: MODES.lightRail.id,
            agency: AGENCY,
            shortName: line.name.replace(' Line', ''),
            longName: line.name,
            category: 'LRT Jabodebek',
            color: relation?.colour || line.colour,
            textColor: '#FFFFFF'
        }));
        if (relation && !dataset.shapes.some(s => s.id === `osm-${relation.id}`)) {
            dataset.shapes.push(shape({id: `osm-${relation.id}`, coords: relation.coords}));
        }
        line.shapeId = relation ? `osm-${relation.id}` : null;
    }

    const shapeFor = new Map(LINES.map(l => [l.id, l.shapeId]));

    for (const p of patterns.values()) {
        dataset.patterns.push(pattern({
            id: p.id,
            route: p.route,
            mode: MODES.lightRail.id,
            stops: p.stops,
            shape: shapeFor.get(p.route) ?? null,
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

    stats.rejected = rejected;

    log(`  lrt-jabodebek: ${stats.trips} trips, ${stats.patterns} patterns, ${stats.stopTimes.toLocaleString()} stop_times`);
    log(`       join ${osmIdFor.size}/${PAGE_ORDER.length}`);
    for (const [lineId, fit] of stats.fits ?? []) {
        if (fit) {
            log(`       ${lineId}: run times from geometry — ${(fit.speed * 3.6).toFixed(0)} km/h, ` +
                `${fit.dwell.toFixed(0)} s dwell${fit.calibrated ? ' (fitted)' : ' (default model)'}`);
        }
    }
    for (const {service, offBy} of rejected) {
        log(`       ! ${service} REJECTED — does not reconcile with the published boards:`);
        for (const line of offBy) {
            log(`         ${line}`);
        }
    }
    for (const [serviceId, r] of Object.entries(stats.reconciliation)) {
        log(`       ${serviceId}: ${Object.entries(r.counted).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        log(`       ${' '.repeat(serviceId.length)}  boards — Jati Mulya ${r.jatiMulyaBoard}, Harjamukti ${r.harjamuktiBoard}, ` +
            `Dukuh Atas ${r.dukuhAtasBoard}, Cawang ${r.cawangBoard} (reconstructed ${r.reconstructedTotal})`);
    }

    return stats;
}
