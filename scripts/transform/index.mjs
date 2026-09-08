/**
 * Transform runner: snapshots -> canonical dataset -> validation gate.
 *
 * Reads only from data/snapshots, never from the network, so a build is
 * reproducible offline and produces identical bytes from identical input.
 * Nothing is published if the gate reports an error.
 *
 *   npm run transform
 *   npm run transform -- --json     write the canonical dataset for inspection
 *
 * Geometry and stations are built here because every mode needs them and none
 * of the operators supply them. The per-mode timetable normalisers live
 * alongside in sources/ and land with their own tickets — KRL in JAKAR-28,
 * MRT and both LRTs in JAKAR-29.
 */
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {latest} from '../ingest/snapshot.mjs';
import {MODES, camera, emptyDataset, shape, sortDataset, stableStringify, station, stop} from './model.mjs';
import {indexOsmStations, joinStations, loadAliases, relationToShape} from './join.mjs';
import {walkTransfers} from './geometry.mjs';
import {applyRoutedWalk, loadRoutedWalk} from './walk-routed.mjs';
import {applyRailFares} from './fares-rail.mjs';
import normaliseCctv from './sources/cctv.mjs';
import normaliseCctvTol from './sources/cctv-tol.mjs';
import normaliseKci from './sources/kci.mjs';
import normaliseLrtJabodebek from './sources/lrt-jabodebek.mjs';
import normaliseLrtJakarta from './sources/lrt-jakarta.mjs';
import normaliseMrt from './sources/mrt.mjs';
import normaliseTransjakarta from './sources/transjakarta.mjs';
import {writeArtifacts} from './artifacts.mjs';
import {counts, formatReport, validate} from './validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    OUT_DIR = join(ROOT, 'data', 'build'),
    ARTIFACT_DIR = join(ROOT, 'public', 'artifacts'),
    STATE_FILE = join(OUT_DIR, 'last-build.json'),
    PLACES_FILE = join(ROOT, 'data', 'camera-places.json'),

    args = new Set(process.argv.slice(2).map(a => a.replace(/^--/, '')));

// OSM route types map onto our modes; operator is used only to separate
// commuter rail from the airport line, which share a route type.
function modeForRelation(relation) {
    const {route, operator = '', name = ''} = relation;

    if (route === 'subway') {
        return MODES.metro.id;
    }
    if (route === 'light_rail') {
        return MODES.lightRail.id;
    }
    if (/Soekarno|Bandara/i.test(name)) {
        return MODES.airportRail.id;
    }
    if (route === 'train' && /Commuter|KCJ/i.test(operator)) {
        return MODES.commuterRail.id;
    }
    return null;
}

async function build() {
    const dataset = emptyDataset(),
        snapshots = [],
        report = {sources: {}};

    // ---- provenance ------------------------------------------------------
    for (const source of ['transjakarta', 'osm', 'mrt', 'lrt-jabodebek', 'lrt-jakarta', 'kci', 'cctv', 'cctv-tol']) {
        const meta = await latest(source);

        if (!meta) {
            console.log(`  ${source.padEnd(14)} no snapshot`);
            continue;
        }
        snapshots.push({source, date: meta.date, ageDays: meta.ageDays});
        dataset.provenance[source] = {
            date: meta.date,
            fetchedAt: meta.fetchedAt,
            ageDays: meta.ageDays,
            checksum: meta.checksum,
            counts: meta.counts
        };
        console.log(`  ${source.padEnd(14)} ${meta.date}  ${String(meta.ageDays).padStart(3)}d  ${meta.files} files`);
    }

    // ---- OSM: geometry, stations, and the name index ---------------------
    const osm = await latest('osm');

    if (!osm) {
        throw new Error('no OSM snapshot — run `npm run ingest -- --source=osm` first');
    }

    const read = name => JSON.parse(readFileSync(join(osm.dir, name), 'utf8')),
        railNodes = read('rail-stations.json').elements,
        metroNodes = read('metro-stations.json').elements,
        index = indexOsmStations([...railNodes, ...metroNodes]),
        relations = read('rail-routes.json').elements.map(relationToShape);

    console.log(`\n  OSM: ${index.byName.size} distinct station names ` +
        `(${index.duplicates} platform/stop duplicates folded), ${relations.length} route relations`);

    let underConstruction = 0,
        unmapped = 0;

    for (const relation of relations) {
        // A relation with geometry but no ordered stops is a line being built.
        // MRT East-West is the live case; excluding it needs no special rule.
        if (relation.underConstruction) {
            underConstruction++;
            continue;
        }

        const mode = modeForRelation(relation);

        if (!mode) {
            unmapped++;
            continue;
        }
        dataset.shapes.push(shape({id: `osm-${relation.id}`, coords: relation.coords}));
    }

    console.log(`  shapes: ${dataset.shapes.length} usable, ` +
        `${underConstruction} under construction, ${unmapped} not a mode we model`);

    // Stations come from the OSM index, deduplicated by normalised name. The
    // operator sources supply timetables against these, by name.
    for (const [key, node] of index.byName) {
        dataset.stations.push(station({
            id: `osm-${node.osmId}`,
            name: node.name,
            lat: node.lat,
            lon: node.lon
        }));
        dataset.stops.push(stop({
            id: `osm-${node.osmId}`,
            name: node.name,
            lat: node.lat,
            lon: node.lon,
            station: `osm-${node.osmId}`
        }));
        void key;
    }

    // ---- per-mode timetables ---------------------------------------------
    const tj = await latest('transjakarta');

    if (tj && existsSync(join(tj.dir, 'gtfs'))) {
        console.log('\n  Transjakarta:');
        report.transjakarta = normaliseTransjakarta({
            dir: tj.dir,
            dataset,
            log: message => console.log(message)
        });
    } else {
        console.log('\n  Transjakarta: snapshot not unpacked — re-run ingest');
    }

    const kci = await latest('kci');

    if (kci && existsSync(join(kci.dir, 'stations.json'))) {
        console.log('\n  KRL Commuter Line:');
        report.kci = normaliseKci({
            dir: kci.dir,
            osm: {relations, index},
            dataset,
            log: message => console.log(message)
        });
    } else {
        console.log('\n  KRL: no complete kci snapshot — run `npm run ingest -- --source=kci`');
    }

    const mrt = await latest('mrt');

    if (mrt && existsSync(join(mrt.dir, 'stations'))) {
        console.log('\n  MRT Jakarta:');
        report.mrt = normaliseMrt({
            dir: mrt.dir,
            osm: {relations, index},
            dataset,
            log: message => console.log(message)
        });
    } else {
        console.log('\n  MRT: no complete mrt snapshot');
    }

    const lrtJakarta = await latest('lrt-jakarta');

    if (lrtJakarta && existsSync(join(lrtJakarta.dir, 'schedules'))) {
        console.log('\n  LRT Jakarta:');
        report.lrtJakarta = normaliseLrtJakarta({
            dir: lrtJakarta.dir,
            osm: {relations, index},
            dataset,
            log: message => console.log(message)
        });
    } else {
        console.log('\n  LRT Jakarta: no complete snapshot');
    }

    const lrtJabodebek = await latest('lrt-jabodebek');

    if (lrtJabodebek && existsSync(join(lrtJabodebek.dir, 'jadwal-keberangkatan.html'))) {
        console.log('\n  LRT Jabodebek:');
        report.lrtJabodebek = normaliseLrtJabodebek({
            dir: lrtJabodebek.dir,
            osm: {relations, index},
            dataset,
            log: message => console.log(message)
        });
    } else {
        console.log('\n  LRT Jabodebek: no complete snapshot');
    }

    // Rail has no fares in any operator feed; fill the gap from published
    // tariffs so the UI states a real number rather than "not available".
    const railFares = applyRailFares(dataset);

    if (railFares) {
        console.log(`\n  Fares: attached published tariffs to ${railFares} rail routes`);
    }

    // ---- one walk table across every mode ---------------------------------
    //
    // Built last, once every source has contributed its stops, because the
    // whole value is the edges that cross between them: a bus stop and a rail
    // platform never appear in the same operator's feed, so this is the only
    // place interchange between modes can come from.
    const walkStart = Date.now(),
        edges = walkTransfers(dataset.stops),
        modeOfStop = new Map();

    for (const pattern of dataset.patterns) {
        const mode = pattern.mode ?? dataset.routes.find(r => r.id === pattern.route)?.mode;

        for (const stopId of pattern.stops) {
            if (!modeOfStop.has(stopId)) {
                modeOfStop.set(stopId, new Set());
            }
            modeOfStop.get(stopId).add(mode);
        }
    }

    let crossMode = 0;

    // Stop *ids*, not the indices walkTransfers works in. The canonical
    // dataset is sorted after this point, which silently repointed every index
    // at a different stop — 40,083 of 40,817 edges ended up over 500 m apart in
    // a table whose whole contract is 400 m. Ids survive any reordering; the
    // encoder maps them back to indices where indices are actually wanted.
    for (const [from, to, seconds] of edges) {
        const fromId = dataset.stops[from].id,
            toId = dataset.stops[to].id,
            a = modeOfStop.get(fromId),
            b = modeOfStop.get(toId);

        if (a && b && [...a].some(mode => !b.has(mode))) {
            crossMode++;
        }
        dataset.transfers.push({from: fromId, to: toId, seconds, kind: 'walk'});
    }

    report.walk = {edges: edges.length, crossMode, ms: Date.now() - walkStart};
    console.log(`\n  Walk transfers: ${edges.length.toLocaleString()} edges within 400 m, ` +
        `${crossMode.toLocaleString()} of them between different modes (${report.walk.ms} ms)`);

    // Straight-line times are an estimate; a `walk` snapshot replaces them with
    // what a pedestrian router actually returns. Absent one the build still
    // works and says so, because the snapshot depends on a transform having run
    // first and a first build therefore cannot have it.
    const routed = loadRoutedWalk();

    if (routed) {
        const applied = applyRoutedWalk(dataset, routed);

        report.walk.routed = {date: routed.date, ...applied};
        console.log(`  Walk routing:   ${applied.matched.toLocaleString()} edges from the ${routed.date} ` +
            `snapshot, ${applied.missing.toLocaleString()} left as straight-line estimates`);
        console.log(`                  ${applied.worsened.toLocaleString()} longer than estimated, ` +
            `${applied.improved.toLocaleString()} shorter`);
        console.log(`                  change p50 ${applied.p50 > 0 ? '+' : ''}${applied.p50} s, ` +
            `p90 +${applied.p90} s, p99 +${applied.p99} s, worst +${Math.round(applied.max / 60)} min; ` +
            `${applied.over3min.toLocaleString()} edges were out by over 3 min`);
    } else {
        console.log('  Walk routing:   no walk snapshot — times are straight-line estimates ' +
            '(run `npm run ingest -- --source=walk`)');
    }

    // ---- cameras ---------------------------------------------------------
    // Last, because the proximity filter needs every mode's stops to exist.
    // Absent snapshot is not a failure: cameras are an overlay on the network,
    // not part of it, and a build without them is a working map.
    const cctv = await latest('cctv');

    if (cctv) {
        const readIf = name => existsSync(join(cctv.dir, name))
                ? readFileSync(join(cctv.dir, name), 'utf8')
                : null,
            jsonIf = name => {
                const text = readIf(name);

                return text ? JSON.parse(text) : null;
            },
            {cameras, report: cameraReport} = normaliseCctv({
                coordinates: readFileSync(join(cctv.dir, 'coordinates.json'), 'utf8'),
                liveness: readdirSync(join(cctv.dir, 'liveness'))
                    .sort()
                    .flatMap(name => JSON.parse(readFileSync(join(cctv.dir, 'liveness', name), 'utf8'))),

                // The portal half is optional: its page is fetched best-effort
                // and has gone dark once already.
                portalHtml: readIf('portal.html'),
                portalLiveness: jsonIf('portal-liveness.json') ?? [],
                streets: jsonIf('streets.json'),
                places: existsSync(PLACES_FILE)
                    ? JSON.parse(readFileSync(PLACES_FILE, 'utf8'))
                    : {},
                stops: dataset.stops
            });

        for (const item of cameras) {
            dataset.cameras.push(camera(item));
        }
        report.cameras = cameraReport;
        console.log(`\n  Cameras: ${cameras.length} live and on the network`);
        console.log(`    geolocated  ${cameras.filter(c => c.precision === 'exact').length} of ` +
            `${cameraReport.listed.toLocaleString()} listed (${cameraReport.live} answering); ` +
            `${cameraReport.offNetwork} too far from any stop` +
            `${cameraReport.badCoords ? `, ${cameraReport.badCoords} with unusable coordinates` : ''}`);
        console.log(`    portal      ${cameraReport.portalPlaced} placed from street names ` +
            `(${cameraReport.portalLive} live), position ESTIMATED` +
            `${cameraReport.portalOffNetwork ? `, ${cameraReport.portalOffNetwork} too far from any stop` : ''}`);
        if (cameraReport.portalUnmapped.length) {
            // Named rather than counted: each one is a row somebody has to add
            // to data/camera-places.json, and a count does not say which.
            console.log(`    unmapped    ${cameraReport.portalUnmapped.length}: ` +
                cameraReport.portalUnmapped.join(', '));
        }
    } else {
        console.log('\n  Cameras: no cctv snapshot — the live camera layer will be absent');
    }

    // ---- toll cameras ----------------------------------------------------
    // A separate source because it is a separate upstream on its own cadence:
    // Jasa Marga rotates its stream ids, so this half goes stale in a way the
    // street cameras do not.
    const tol = await latest('cctv-tol');

    if (tol) {
        const roads = JSON.parse(readFileSync(join(tol.dir, 'roads.json'), 'utf8')),
            pages = {};

        for (const {id} of roads) {
            const file = join(tol.dir, 'roads', `${id}.html`);

            if (existsSync(file)) {
                pages[id] = readFileSync(file, 'utf8');
            }
        }

        const {cameras, report: tolReport} = normaliseCctvTol({
            bpjtHtml: readFileSync(join(tol.dir, 'bpjt.html'), 'utf8'),
            roads,
            pages,
            liveness: JSON.parse(readFileSync(join(tol.dir, 'liveness.json'), 'utf8')),
            shapes: dataset.shapes,
            stops: dataset.stops
        });

        for (const item of cameras) {
            dataset.cameras.push(camera(item));
        }
        report.tollCameras = tolReport;
        console.log(`\n  Toll cameras: ${cameras.length} on the network, of ` +
            `${tolReport.inRegion} in region (${tolReport.nationwide.toLocaleString()} nationwide)`);
        console.log(`    ${tolReport.direct} from BPJT's own url, ` +
            `${tolReport.joined} recovered by the (road, KM) join to Bina Marga`);
        console.log(`    ${tolReport.noStream} had no live stream, ` +
            `${tolReport.offNetwork} were too far from any route path`);
        console.log(`    BPJT's table was last written ${tolReport.tableWritten} ` +
            `(${tolReport.tableAgeDays} days ago) — the only source of toll coordinates`);

        // Road by road, because a road quietly falling to zero is invisible in
        // the totals: Jasa Marga is 61% of the network and masks the rest.
        // Only roads that gave a camera or left one unclaimed are worth a line.
        const interesting = tolReport.byRoad.filter(r =>
            r.matchedDirect + r.matchedJoined > 0 || r.pageUnused > 0);

        // `own`/`join` are what the source resolved; `kept` is what survived the
        // proximity filter and shipped. They differ wherever a toll road runs
        // somewhere the fleet does not.
        console.log(`\n    ${'road'.padEnd(44)} ${'in'.padStart(4)} ${'own'.padStart(4)} ` +
            `${'join'.padStart(5)} ${'kept'.padStart(5)} ${'km?'.padStart(5)} ` +
            `${'feed'.padStart(5)} ${'free'.padStart(5)}`);
        for (const road of interesting) {
            console.log(`    ${road.road.slice(0, 44).padEnd(44)} ${String(road.inRegion).padStart(4)} ` +
                `${String(road.matchedDirect).padStart(4)} ${String(road.matchedJoined).padStart(5)} ` +
                `${String(road.direct + road.joined).padStart(5)} ` +
                `${String(road.statesKm).padStart(5)} ${String(road.pageStreams).padStart(5)} ` +
                `${String(road.pageUnused).padStart(5)}`);
        }
        console.log(`    (${tolReport.byRoad.length - interesting.length} further road(s) contributed nothing; ` +
            `\`free\` is a live Bina Marga stream no camera could be joined to)`);
    } else {
        console.log('\n  Toll cameras: no cctv-tol snapshot');
    }

    sortDataset(dataset);
    return {dataset, snapshots, report};
}

// ---------------------------------------------------------------------------

console.log('Sources:');

const {dataset, snapshots, report} = await build(),
    lastBuild = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null,
    result = validate(dataset, {
        // Drift compares this build with the last one, which is meaningless
        // while sources are still being added. --accept-drift says the change
        // was expected; it has to be typed deliberately rather than inferred.
        previous: args.has('accept-drift') ? null : lastBuild?.counts ?? null,
        snapshots,
        toll: report.tollCameras ?? null,
        previousToll: args.has('accept-drift') ? null : lastBuild?.tollCameras ?? null
    });

console.log('\nValidation:');
console.log(formatReport(result));

const summary = counts(dataset),
    kb = bytes => bytes < 1048576
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1048576).toFixed(2)} MB`;

console.log(`\n${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(' ')}`);

if (!result.ok) {
    console.error(`\nFAIL — ${result.errors.length} error(s). Nothing published.`);
    process.exit(1);
}

await mkdir(OUT_DIR, {recursive: true});

// Stable serialisation: identical snapshots must give identical bytes, or the
// content hashing in JAKAR-34 has nothing to stand on.
const serialised = stableStringify(dataset);

if (args.has('json')) {
    writeFileSync(join(OUT_DIR, 'canonical.json'), serialised);
    console.log(`\nwrote data/build/canonical.json (${(serialised.length / 1048576).toFixed(2)} MB)`);
}

// ---- artifacts ------------------------------------------------------------

const previousManifest = existsSync(join(ARTIFACT_DIR, 'manifest.json'))
        ? JSON.parse(readFileSync(join(ARTIFACT_DIR, 'manifest.json'), 'utf8'))
        : null,
    {manifest, files, removed} = await writeArtifacts(dataset, ARTIFACT_DIR, {previousManifest});

console.log('\nArtifacts:');
console.log(`  ${'file'.padEnd(38)} ${'raw'.padStart(9)} ${'gzip'.padStart(9)} ${'brotli'.padStart(9)}`);
for (const file of files) {
    console.log(`  ${file.file.padEnd(38)} ${kb(file.bytes).padStart(9)} ${kb(file.gzip).padStart(9)} ${kb(file.brotli).padStart(9)}`);
}
console.log(`  ${'TOTAL'.padEnd(38)} ${kb(manifest.totals.bytes).padStart(9)} ` +
    `${kb(manifest.totals.gzip).padStart(9)} ${kb(manifest.totals.brotli).padStart(9)}`);
if (removed.length) {
    console.log(`  (${removed.length} file(s) from a previous build removed)`);
}

writeFileSync(STATE_FILE, JSON.stringify({
    builtAt: new Date().toISOString(),
    counts: summary,
    provenance: dataset.provenance,
    join: report.join ?? null,
    // The toll split and its per-road breakdown, so the next build can see the
    // layer decay rather than only its current shape (JAKAR-56).
    tollCameras: report.tollCameras ?? null,
    warnings: result.warnings.map(w => `${w.check}: ${w.message}`)
}, null, 2));

console.log(`\nPASS — ${result.warnings.length} warning(s). data/build/last-build.json updated.`);
