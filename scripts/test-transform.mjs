/**
 * Tests for the canonical model and the validation gate.
 *
 * Fixtures rather than the real feed here, unlike test-routing: the point is
 * to prove the gate *catches* things, which means constructing data that is
 * deliberately wrong. Every failing case below is one that has actually
 * occurred in this project's sources.
 *
 *   npm run test-transform
 */
import {
    MODES, SCHEMA_VERSION, agency, camera, emptyDataset, pattern, route, shape,
    sortDataset, stableStringify, station, stop, trip
} from './transform/model.mjs';
import normaliseCctv from './transform/sources/cctv.mjs';
import normaliseCctvTol from './transform/sources/cctv-tol.mjs';
import {encodeShapes, encodeTrips} from './transform/artifacts.mjs';
import {counts, formatReport, validate} from './transform/validate.mjs';

let passed = 0,
    failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

function throws(fn) {
    try {
        fn();
        return null;
    } catch (error) {
        return error.message;
    }
}

const errorsFrom = report => report.errors.map(e => e.check),
    hasError = (report, name) => report.errors.some(e => e.check === name),
    hasWarning = (report, name) => report.warnings.some(e => e.check === name);

// ---------------------------------------------------------------------------
// A minimal but valid MRT-shaped dataset, used as the base for the mutations
// below. Six stations in geographic order along one straight line.
// ---------------------------------------------------------------------------

const STATION_NAMES = [
    ['LB', 'Lebak Bulus', -6.28930, 106.77493],
    ['FT', 'Fatmawati', -6.29247, 106.79246],
    ['CP', 'Cipete Raya', -6.27837, 106.79734],
    ['HN', 'Haji Nawi', -6.26670, 106.79734],
    ['BA', 'Blok A', -6.25579, 106.79717],
    ['BM', 'Blok M', -6.24442, 106.79824]
];

function baseDataset({times = [0, 190, 370, 500, 640, 780]} = {}) {
    const data = emptyDataset();

    data.agencies.push(agency({id: 'mrtj', name: 'MRT Jakarta'}));
    data.routes.push(route({
        id: 'M', mode: MODES.metro.id, agency: 'mrtj',
        shortName: 'M', longName: 'North-South Line', color: '#CE0037'
    }));
    data.calendar.weekday = {monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0};

    for (const [id, name, lat, lon] of STATION_NAMES) {
        data.stations.push(station({id: `st-${id}`, name, lat, lon, modes: [MODES.metro.id]}));
        data.stops.push(stop({id, name, lat, lon, station: `st-${id}`, modes: [MODES.metro.id]}));
    }

    // A shape that runs through every station, so the geometry check has
    // something honest to measure against.
    data.shapes.push(shape({
        id: 'M-north',
        coords: STATION_NAMES.flatMap(([, , lat, lon]) => [lon, lat])
    }));
    data.patterns.push(pattern({
        id: 'M-north-p', route: 'M', mode: MODES.metro.id,
        stops: STATION_NAMES.map(([id]) => id), shape: 'M-north'
    }));
    data.trips.push(trip({
        id: 'M-north-0500', route: 'M', pattern: 'M-north-p',
        service: 'weekday', times
    }));
    return sortDataset(data);
}

// ---------------------------------------------------------------------------

section('Model constructors reject what they cannot represent');
{
    check('an unknown mode is refused',
        /unknown mode/.test(throws(() => route({id: 'X', mode: 'hovercraft', agency: 'a'})) || ''));
    check('a route without an agency is refused',
        /missing required field "agency"/.test(throws(() => route({id: 'X', mode: 'bus'})) || ''));
    check('a coordinate of exactly 0 is refused (null island, not a location)',
        /exactly 0/.test(throws(() => stop({id: 'X', name: 'X', lat: 0, lon: 106.8})) || ''));
    check('a non-numeric coordinate is refused',
        /not a number/.test(throws(() => stop({id: 'X', name: 'X', lat: 'abc', lon: 106.8})) || ''));
    check('a one-stop pattern is refused',
        /at least two stops/.test(throws(() => pattern({id: 'p', route: 'r', stops: ['a']})) || ''));
    check('a trip with neither times nor frequency is refused',
        /needs either times or frequency/.test(throws(() => trip({id: 't', route: 'r', pattern: 'p', service: 's'})) || ''));
    check('a trip with both times and frequency is refused',
        /pick one/.test(throws(() => trip({
            id: 't', route: 'r', pattern: 'p', service: 's',
            times: [0, 1], frequency: {start: 0, end: 100, headway: 10}
        })) || ''));
    check('a frequency-based trip is accepted (the bus feed has no departure rows)',
        trip({id: 't', route: 'r', pattern: 'p', service: 's', frequency: {start: 0, end: 100, headway: 10}}).frequency !== null);
}

section('A clean dataset passes the gate');
{
    const report = validate(baseDataset(), {snapshots: [{source: 'mrt', date: '2026-09-06', ageDays: 0}]});

    check('no errors', report.ok, errorsFrom(report).join(', '));
    check('every check reported', report.checks.length >= 6, `${report.checks.length} checks`);
    if (!report.ok) {
        console.log(formatReport(report));
    }
}

section('Trap 6 — times that were never unwrapped past midnight');
{
    // Bogor 23:10 -> Jakarta Kota 00:37. Stored as clock time this reads as a
    // journey that ends thirteen hours before it began.
    const data = baseDataset({times: [83400, 84000, 84600, 1200, 1800, 2220]}),
        report = validate(data, {snapshots: [{source: 'kci', date: '2026-09-06', ageDays: 0}]});

    check('the wrap is caught', hasError(report, 'temporal-order'));
    check('it is reported as a wrap, not as a splice',
        report.errors.some(e => /unwrapped past midnight/.test(e.message)));

    const unwrapped = baseDataset({times: [83400, 84000, 84600, 87600, 88200, 88620]}),
        after = validate(unwrapped, {snapshots: [{source: 'kci', date: '2026-09-06', ageDays: 0}]});

    check('the same trip passes once unwrapped past 86400', !hasError(after, 'temporal-order'),
        errorsFrom(after).join(', '));
}

section('The MRT short working at Blok M');
{
    // The real observation, in geographic order: five stations ascend from
    // Lebak Bulus, then Blok M reads 05:00:00 because a *second* train starts
    // there. Chaining naively splices them into one train that goes backwards.
    const spliced = baseDataset({
            times: [
                5 * 3600,             // Lebak Bulus 05:00:00
                5 * 3600 + 190,       // Fatmawati   05:03:10
                5 * 3600 + 370,       // Cipete Raya 05:06:10
                5 * 3600 + 500,       // Haji Nawi   05:08:20
                5 * 3600 + 640,       // Blok A      05:10:40
                5 * 3600              // Blok M      05:00:00  <- the short working
            ]
        }),
        report = validate(spliced, {snapshots: [{source: 'mrt', date: '2026-09-06', ageDays: 0}]});

    check('the splice is caught', hasError(report, 'temporal-order'));
    check('it is reported as a splice, not as a midnight wrap',
        report.errors.some(e => /spliced separate vehicles/.test(e.message)));
    check('the offending station is named in the sample',
        report.errors.some(e => e.sample.some(s => /BM/.test(s))),
        JSON.stringify(report.errors.map(e => e.sample)));

    // The check has to be against geographic order. Sorting by time first and
    // then asserting the times ascend is circular — it would pass this exact
    // dataset, which is how the bug hid in the first place.
    const sorted = [...spliced.trips[0].times].sort((a, b) => a - b);

    check('sorting by time would have hidden it (why the check uses stop order)',
        sorted.every((t, i) => i === 0 || t >= sorted[i - 1]));
}

section('Referential integrity');
{
    const data = baseDataset();

    data.patterns[0].stops[2] = 'GHOST';

    const report = validate(data, {snapshots: []});

    check('a pattern referencing a missing stop is caught', hasError(report, 'referential-integrity'));

    const short = baseDataset();

    short.trips[0].times = [0, 100, 200];

    check('a trip whose times do not match its stop count is caught',
        hasError(validate(short, {snapshots: []}), 'referential-integrity'));

    const noService = baseDataset();

    noService.trips[0].service = 'nonexistent';
    check('a trip referencing an unknown service is caught',
        hasError(validate(noService, {snapshots: []}), 'referential-integrity'));
}

section('A station joined to the wrong coordinates');
{
    const data = baseDataset();

    // Cipete Raya moved to Tanah Abang — the shape of a bad OSM name join,
    // which is a near-miss on a name rather than an outright failure.
    data.stops.find(s => s.id === 'CP').lat = -6.1857;
    data.stops.find(s => s.id === 'CP').lon = 106.8112;

    const report = validate(data, {snapshots: []});

    check('a stop far from its own route is caught', hasError(report, 'stops-near-shapes'));
    check('the distance is reported', report.errors.some(e => e.sample.some(s => /\d+ m from shape/.test(s))));
}

section('Mode is a first-class field, not a guess');
{
    const data = baseDataset();

    data.patterns[0].mode = MODES.bus.id;

    check('a pattern disagreeing with its route about mode is caught',
        hasError(validate(data, {snapshots: []}), 'mode-integrity'));
}

section('Branch assignment is only checked where trips were inferred');
{
    // Six patterns on one route, five ending at the same terminus and one
    // ending alone. That is a mis-assigned branch if the trips were
    // reconstructed, and an ordinary short working if the source stated them.
    function routeWithOddTerminus(inferred) {
        const data = baseDataset(),
            ids = STATION_NAMES.map(([id]) => id);

        data.patterns = [];
        data.trips = [];
        for (let i = 0; i < 6; i++) {
            // The last pattern stops one station early.
            const stops = i === 5 ? ids.slice(0, 5) : ids.slice();

            data.patterns.push(pattern({
                id: `p${i}`, route: 'M', mode: MODES.metro.id,
                stops, shape: 'M-north', inferred
            }));
            data.trips.push(trip({
                id: `t${i}`, route: 'M', pattern: `p${i}`, service: 'weekday',
                times: stops.map((_, n) => n * 180)
            }));
        }
        return sortDataset(data);
    }

    check('an inferred pattern ending alone is flagged',
        hasWarning(validate(routeWithOddTerminus(true), {snapshots: []}), 'pattern-termini'));
    check('the same shape with stated trip identity is not flagged',
        !hasWarning(validate(routeWithOddTerminus(false), {snapshots: []}), 'pattern-termini'));
    check('patterns default to not inferred',
        pattern({id: 'p', route: 'r', stops: ['a', 'b']}).inferred === false);
}

section('Snapshot freshness — the check Comuline would have failed');
{
    const fresh = validate(baseDataset(), {snapshots: [{source: 'kci', date: '2026-09-06', ageDays: 0}]}),
        stale = validate(baseDataset(), {snapshots: [{source: 'kci', date: '2026-08-01', ageDays: 36}]}),
        dead = validate(baseDataset(), {snapshots: [{source: 'comuline', date: '2025-03-30', ageDays: 525}]});

    check('a fresh source passes', !hasError(fresh, 'snapshot-freshness') && !hasWarning(fresh, 'snapshot-freshness'));
    check('a month-old source warns but does not fail', hasWarning(stale, 'snapshot-freshness') && stale.ok);
    check('a source frozen for 17 months fails the build', hasError(dead, 'snapshot-freshness'));
}

section('Volume drift against the previous build');
{
    const data = baseDataset(),
        previous = counts(data);

    check('no drift against itself', validate(data, {previous, snapshots: []}).ok);

    const halved = {...previous, trips: previous.trips * 4};

    check('a scrape that returned a quarter of the trips fails',
        hasError(validate(data, {previous: halved, snapshots: []}), 'volume-drift'));

    const nudged = {...previous, stops: Math.round(previous.stops / 0.88)};

    check('a 12% move warns but does not fail',
        hasWarning(validate(data, {previous: nudged, snapshots: []}), 'volume-drift'));
}

section('Binary encoding round-trips without loss');
{
    const patternIndex = new Map([['p0', 0], ['p1', 1]]),
        trips = [
            {id: 't0', pattern: 'p0', times: [18000, 18190, 18370, 18500]},
            // Past midnight: a train leaving 23:10 and arriving 00:37 is today's.
            {id: 't1', pattern: 'p1', times: [83400, 84000, 87600, 88620]}
        ],
        buffer = encodeTrips(trips, patternIndex),
        stopsPerPattern = [4, 4];

    // Decode exactly as a client would.
    const decoded = [];
    let offset = 0;

    const count = buffer.readUInt32LE(offset);

    offset += 4;
    for (let i = 0; i < count; i++) {
        const patternIdx = buffer.readUInt16LE(offset);

        offset += 2;

        const times = [buffer.readUInt32LE(offset)];

        offset += 4;
        for (let k = 1; k < stopsPerPattern[patternIdx]; k++) {
            times.push(times[k - 1] + buffer.readUInt16LE(offset));
            offset += 2;
        }
        decoded.push({patternIdx, times});
    }

    check('trip count survives', decoded.length === trips.length);
    check('times survive exactly', JSON.stringify(decoded.map(d => d.times)) === JSON.stringify(trips.map(t => t.times)),
        JSON.stringify(decoded.map(d => d.times)));
    check('times past 86400 survive (trap 6)', decoded[1].times[3] === 88620);
    check('every byte is consumed', offset === buffer.length, `${offset} of ${buffer.length}`);

    // 4 bytes per stop entry after the first call of each trip.
    check('encoding is the promised size',
        buffer.length === 4 + trips.length * 6 + (trips.length * 3) * 2, `${buffer.length} bytes`);

    // A leg longer than a uint16 means times were never unwrapped — which is
    // the failure this guard exists to name rather than silently truncate.
    check('a leg too large for a uint16 is refused, and says why',
        /not unwrapped past midnight/.test(
            throws(() => encodeTrips([{id: 'bad', pattern: 'p0', times: [0, 70000]}], patternIndex)) || ''));
    check('a negative leg is refused',
        throws(() => encodeTrips([{id: 'bad', pattern: 'p0', times: [100, 50]}], patternIndex)) !== null);
}

section('Shape encoding round-trips');
{
    const shapes = [
            {id: 's0', coords: [106.8272, -6.2088, 106.8281, -6.2091, 106.8290, -6.2095]},
            {id: 's1', coords: [106.7749, -6.2893, 106.7924, -6.2924]}
        ],
        buffer = encodeShapes(shapes),
        count = buffer.readUInt32LE(0);

    check('shape count survives', count === shapes.length);

    const lengths = [];

    for (let i = 0; i < count; i++) {
        lengths.push(buffer.readUInt32LE(4 + i * 4));
    }
    check('vertex counts survive', JSON.stringify(lengths) === JSON.stringify([3, 2]));

    const coords = new Int32Array(buffer.buffer, buffer.byteOffset + 4 + count * 4,
            lengths.reduce((a, b) => a + b, 0) * 2),
        recovered = [];
    let lon = 0,
        lat = 0;

    for (let i = 0; i < coords.length; i += 2) {
        lon += coords[i];
        lat += coords[i + 1];
        recovered.push(lon / 1e6, lat / 1e6);
    }

    const expected = shapes.flatMap(s => s.coords.map(v => Math.round(v * 1e6) / 1e6));

    check('coordinates survive delta encoding to 1e-6 degrees',
        JSON.stringify(recovered) === JSON.stringify(expected),
        `${JSON.stringify(recovered.slice(0, 4))} vs ${JSON.stringify(expected.slice(0, 4))}`);
}

section('Determinism — identical input must produce identical bytes');
{
    const a = stableStringify(baseDataset()),
        b = stableStringify(baseDataset());

    check('the same dataset serialises identically', a === b);

    // Key insertion order differs, content does not. Content hashing
    // downstream depends on this being invisible.
    const reordered = stableStringify({b: 1, a: {d: 4, c: 3}}),
        original = stableStringify({a: {c: 3, d: 4}, b: 1});

    check('key order does not change the serialisation', reordered === original, `${reordered} vs ${original}`);
    check('schema version is carried', JSON.parse(a).schemaVersion === SCHEMA_VERSION);
}

section('The walk table must join stops that are actually close');
{
    const snapshots = [{source: 'mrt', date: '2026-09-06', ageDays: 0}],
        near = baseDataset(),
        // Lebak Bulus and Fatmawati are ~2 km apart; Cipete Raya sits 560 m
        // from Fatmawati. Only a genuinely short pair may appear in the table.
        close = {from: 'LB', to: 'LB2', seconds: 60, kind: 'walk'};

    near.stops.push(stop({
        id: 'LB2', name: 'Lebak Bulus 2', lat: -6.28950, lon: 106.77520, mode: MODES.METRO
    }));
    near.transfers.push(close);
    sortDataset(near);
    check('a short walk edge passes', !hasError(validate(near, {snapshots}), 'walk-table'),
        errorsFrom(validate(near, {snapshots})).join(','));

    // The bug this check was written for: the edge was built as an index into
    // the stop array, the dataset was then sorted, and the index came to mean a
    // different stop entirely — here, one 2 km away.
    const far = baseDataset();

    far.transfers.push({from: 'LB', to: 'FT', seconds: 60, kind: 'walk'});
    sortDataset(far);
    check('a walk edge across 2 km is an error', hasError(validate(far, {snapshots}), 'walk-table'));

    // The other half of the same failure: an id that survived a remap it
    // should not have, and now names nothing.
    const missing = baseDataset();

    missing.transfers.push({from: 'LB', to: 'nonexistent', seconds: 60, kind: 'walk'});
    sortDataset(missing);
    check('a walk edge to an unknown stop is an error',
        hasError(validate(missing, {snapshots}), 'walk-table'));
}


// ---------------------------------------------------------------------------

section('Live cameras must stand where they claim');
{
    const snapshots = [],
        HOST = 'https://cctv-jsc.balitower.co.id:8011',
        url = name => `${HOST}/${name}/index.m3u8`,
        // Lebak Bulus, and a point about 90 m away from it.
        atLebakBulus = {lat: -6.28930, lon: 106.77493},
        nearby = {lat: -6.29010, lon: 106.77493};

    function withCamera(fields) {
        const data = baseDataset();

        data.cameras.push(camera({
            id: 'cctv-X', name: 'X', stream: url('X-001-700001_1'),
            stop: 'LB', ...fields
        }));
        return sortDataset(data);
    }

    check('a camera beside the stop it names passes',
        !hasError(validate(withCamera({...nearby, distance: 89}), {snapshots}), 'cameras'));

    // The failure this check exists for: the coordinate table and the liveness
    // probe are joined by stream name, and nothing else compares the result
    // against geography. This is trap 7's shape.
    check('a camera 2 km from the stop it names is an error',
        hasError(validate(withCamera({lat: -6.29247, lon: 106.79246, distance: 89}), {snapshots}), 'cameras'));

    check('a camera naming a stop that does not exist is an error',
        hasError(validate(withCamera({...nearby, distance: 89, stop: 'nope'}), {snapshots}), 'cameras'));

    // `distance` is shown to the viewer, so a wrong one is a wrong statement
    // rather than a harmless field.
    check('a camera that misstates its distance is an error',
        hasError(validate(withCamera({...nearby, distance: 5}), {snapshots}), 'cameras'));

    // These URLs come from third-party pages and end up in the DOM.
    check('a stream that is not an https URL is rejected outright',
        throws(() => camera({
            id: 'c', name: 'n', lat: -6.2, lon: 106.8, stream: 'javascript:alert(1)'
        })) !== null);

    check('a build with no cameras passes', !hasError(validate(baseDataset(), {snapshots}), 'cameras'));

    check('camera() rejects a missing stream',
        throws(() => camera({id: 'c', name: 'n', lat: -6.2, lon: 106.8})) !== null);
    check('camera() rejects null island',
        throws(() => camera({id: 'c', name: 'n', lat: 0, lon: 106.8, stream: url('s')})) !== null);
    check('camera() rejects an unknown kind',
        throws(() => camera({
            id: 'c', name: 'n', lat: -6.2, lon: 106.8, stream: url('s'), kind: 'drone'
        })) !== null);
}

section('The CCTV normaliser keeps only live cameras on the network');
{
    const stops = STATION_NAMES.map(([id, name, lat, lon]) => ({id, name, lat, lon})),
        // Two rows beside Lebak Bulus, one far out in Bekasi, one with its
        // coordinates the wrong way round — all four shapes the real file has.
        coordinates = JSON.stringify([
            {url: 'http://cctv.balitower.co.id:80/Live-001-700001_1/embed.html',
                location: {latitude: -6.28935, longitude: 106.77500}},
            {url: 'http://cctv.balitower.co.id:80/Dead-002-700002_1/embed.html',
                location: {latitude: -6.28935, longitude: 106.77500}},
            {url: 'http://cctv.balitower.co.id:80/Far-003-700003_1/embed.html',
                location: {latitude: -6.24000, longitude: 107.00000}},
            {url: 'http://cctv.balitower.co.id:80/Swapped-004-700004_1/embed.html',
                location: {latitude: 106.77500, longitude: -6.28935}}
        ]),
        liveness = [
            {stream: 'Live-001-700001_1', status: 200},
            {stream: 'Dead-002-700002_1', status: 404},
            {stream: 'Far-003-700003_1', status: 200},
            {stream: 'Swapped-004-700004_1', status: 200}
        ],
        {cameras, report} = normaliseCctv({coordinates, liveness, stops});

    check('only the live camera near a stop survives', cameras.length === 1,
        `got ${cameras.length}`);
    check('it is the live one', (cameras[0]?.stream || '').includes('Live-001-700001_1'));
    check('a camera that no longer answers is dropped', report.live === 3);
    check('a camera far from the network is dropped', report.offNetwork === 1);
    check('coordinates the wrong way round are dropped', report.badCoords === 1);
    check('the surviving camera names its nearest stop', cameras[0]?.stop === 'LB');
    check('its stream is a full https URL', /^https:\/\/\S+\.m3u8$/.test(cameras[0]?.stream || ''));
    check('its distance is measured, not assumed', cameras[0]?.distance <= 20);

    // The device id and channel are not part of any place name.
    check('the stream name is humanised', cameras[0]?.name === 'Live 001',
        cameras[0]?.name);

    // Every camera the encoder writes must pass the gate that guards them.
    const data = baseDataset();

    for (const item of cameras) {
        data.cameras.push(camera(item));
    }
    sortDataset(data);
    check('normaliser output passes the validation gate',
        !hasError(validate(data, {snapshots: []}), 'cameras'));
}


section('Portal cameras are placed from the street named in their stream id');
{
    const stops = STATION_NAMES.map(([id, name, lat, lon]) => ({id, name, lat, lon})),
        // A street running north past three of the fixture's stations, so a
        // camera placed anywhere along it is near one of them.
        streets = {elements: [{
            type: 'way',
            tags: {name: 'Jalan Fatmawati'},
            geometry: [
                {lat: -6.29247, lon: 106.79246},
                {lat: -6.28000, lon: 106.79500},
                {lat: -6.26670, lon: 106.79734}
            ]
        }, {
            type: 'node',
            tags: {name: 'Taman Uji'},
            lat: -6.24442,
            lon: 106.79824
        }]},
        portalHtml = [
            'https://dki-jkt.balitower.co.id:7028/1_JKS_DISHUB_JL.-FATMAWATI-C01_CCTV-01/embed.html',
            'https://dki-jkt.balitower.co.id:7028/1_JKS_DISHUB_JL.-FATMAWATI-C01_CCTV-02/embed.html',
            'https://dki-jkt.balitower.co.id:7028/2_JKS_DISHUB_JL.-FATMAWATI-C02_CCTV-01/embed.html',
            'https://dki-jkt.balitower.co.id:7028/3_JKS_DISHUB_TAMAN-UJI-C01_CCTV-01/embed.html',
            'https://dki-jkt.balitower.co.id:7028/4_JKS_DISHUB_JL.-HANTU-C01_CCTV-01/embed.html'
        ].join(' '),
        portalLiveness = [
            {stream: '1_JKS_DISHUB_JL.-FATMAWATI-C01_CCTV-01', status: 200},
            {stream: '1_JKS_DISHUB_JL.-FATMAWATI-C01_CCTV-02', status: 200},
            {stream: '2_JKS_DISHUB_JL.-FATMAWATI-C02_CCTV-01', status: 200},
            {stream: '3_JKS_DISHUB_TAMAN-UJI-C01_CCTV-01', status: 200},
            {stream: '4_JKS_DISHUB_JL.-HANTU-C01_CCTV-01', status: 404}
        ],
        places = {
            'JL.-FATMAWATI-C01': {street: 'Jalan Fatmawati'},
            'JL.-FATMAWATI-C02': {street: 'Jalan Fatmawati'},
            'TAMAN-UJI-C01': {street: 'Taman Uji'}
        },
        {cameras, report} = normaliseCctv({
            coordinates: '[]', liveness: [], portalHtml, portalLiveness, streets, places, stops
        });

    check('every live portal stream is placed', report.portalPlaced === 4, `got ${report.portalPlaced}`);
    check('a dead portal stream is not', !cameras.some(c => c.stream.includes('/4_')));
    check('portal cameras are marked estimated',
        cameras.every(c => c.precision === 'estimated'));

    const c01 = cameras.filter(c => c.stream.includes('FATMAWATI-C01')),
        c02 = cameras.filter(c => c.stream.includes('FATMAWATI-C02'));

    // Channels of one device are cameras on one pole and share a position.
    check('channels of one site share a position',
        c01.length === 2 && c01[0].lat === c01[1].lat && c01[0].lon === c01[1].lon);
    check('channel number is carried', c01.map(c => c.channel).sort().join() === '1,2');

    // Two sites on one street must not land in a heap at its midpoint.
    check('two sites on one street are spread along it',
        c01[0].lat !== c02[0].lat || c01[0].lon !== c02[0].lon);

    // A node has neither `geometry` nor `center`; handling only those two
    // silently lost Taman Literasi on the real data.
    check('a site placed on an OSM node is found',
        cameras.some(c => c.stream.includes('TAMAN-UJI')));

    check('placed cameras lie on the street they were placed from',
        cameras.filter(c => c.stream.includes('FATMAWATI'))
            .every(c => c.lon >= 106.79 && c.lon <= 106.80));

    // A site nobody has mapped is named, not silently dropped: somebody has to
    // add a row to data/camera-places.json and a count does not say which.
    const unmapped = normaliseCctv({
        coordinates: '[]', liveness: [], portalHtml, portalLiveness,
        streets, places: {}, stops
    });

    check('an unmapped site is reported by name',
        unmapped.report.portalUnmapped.some(x => x.includes('FATMAWATI-C01')));
    check('an unmapped site places nothing', unmapped.cameras.length === 0);

    // The portal half is optional — its page has already gone dark once.
    const noPortal = normaliseCctv({coordinates: '[]', liveness: [], stops});

    check('a build with no portal snapshot still works', noPortal.cameras.length === 0);

    // And whatever comes out still has to satisfy the gate.
    const data = baseDataset();

    for (const item of cameras) {
        data.cameras.push(camera(item));
    }
    sortDataset(data);
    check('placed portal cameras pass the validation gate',
        !hasError(validate(data, {snapshots: []}), 'cameras'));

    check('camera() rejects an unknown precision',
        throws(() => camera({
            id: 'c', name: 'n', lat: -6.2, lon: 106.8,
            stream: 'https://h/x.m3u8', precision: 'roughly'
        })) !== null);
}


section('Toll cameras: BPJT for position, Bina Marga for what still plays');
{
    const stops = STATION_NAMES.map(([id, name, lat, lon]) => ({id, name, lat, lon})),
        // The fixture's own line, so "near a route path" means something.
        shapes = [{id: 'M-north', coords: STATION_NAMES.flatMap(([, , lat, lon]) => [lon, lat])}],
        // On a shape vertex: the proximity check measures to vertices, and the
        // fixture line has six of them where a real shape has hundreds.
        onRoute = {lat: -6.27837, lon: 106.79734},
        // 6 km east of the line — a real camera on a road this map has no
        // network on.
        offRoute = {lat: -6.27837, lon: 106.86000};

    const bpjt = html => `<script>const allStreams = ${JSON.stringify(html)};</script>\n`;

    const cameras = [
            // Its own URL is live: no join needed.
            {camera_id: '1', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 01+000',
                lat: String(onRoute.lat), lon: String(onRoute.lon),
                streamhls: 'https://live.example/a/index.m3u8'},
            // Its own URL is dead; recovered by the (road, KM) join.
            {camera_id: '2', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 02+000',
                lat: String(onRoute.lat), lon: String(onRoute.lon),
                streamhls: 'https://dead.example/b/index.m3u8'},
            // Dead everywhere.
            {camera_id: '3', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 09+000',
                lat: String(onRoute.lat), lon: String(onRoute.lon),
                streamhls: 'https://dead.example/c/index.m3u8'},
            // Live, but nowhere near the network.
            {camera_id: '4', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 04+000',
                lat: String(offRoute.lat), lon: String(offRoute.lon),
                streamhls: 'https://live.example/d/index.m3u8'},
            // A stray comma in the latitude — the real table has 164 of these.
            {camera_id: '5', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 05+000',
                lat: '-6.27837,', lon: String(onRoute.lon),
                streamhls: 'https://live.example/e/index.m3u8'}
        ],
        page = `
            <div class="card-cctv"><p>KM 02+000</p>
              <source src="https://live.example/joined-2/index.m3u8"></div>
            <div class="card-cctv"><p>KM 09+000</p>
              <source src="https://dead.example/joined-3/index.m3u8"></div>
        `,
        liveness = [
            {url: 'https://live.example/a/index.m3u8', live: true},
            {url: 'https://dead.example/b/index.m3u8', live: false},
            {url: 'https://dead.example/c/index.m3u8', live: false},
            {url: 'https://live.example/d/index.m3u8', live: true},
            {url: 'https://live.example/e/index.m3u8', live: true},
            {url: 'https://live.example/joined-2/index.m3u8', live: true},
            {url: 'https://dead.example/joined-3/index.m3u8', live: false}
        ],
        {cameras: out, report} = normaliseCctvTol({
            bpjtHtml: bpjt({'1': cameras}),
            roads: [{id: 'tol-uji', road: 'Tol Uji'}],
            pages: {'tol-uji': page},
            liveness, shapes, stops
        });

    const byId = new Map(out.map(c => [c.id, c]));

    check('a camera whose own url is live needs no join', byId.has('tol-1'));
    check('a camera with a dead url is recovered by the (road, KM) join', byId.has('tol-2'));
    check('  and it uses the Bina Marga url, not the dead BPJT one',
        byId.get('tol-2')?.stream === 'https://live.example/joined-2/index.m3u8');
    check('a camera dead in both sources is dropped', !byId.has('tol-3'));
    check('a live camera off the network is dropped', !byId.has('tol-4'));
    check('a stray comma in the latitude is parsed, not discarded', byId.has('tol-5'));

    check('report counts direct and joined separately',
        report.direct === 2 && report.joined === 1, JSON.stringify(report));
    check('report counts what had no stream at all', report.noStream === 1);
    check('report counts what was off the network', report.offNetwork === 1);

    check('toll cameras are marked as such', out.every(c => c.kind === 'toll'));
    check('toll positions are published, not estimated',
        out.every(c => c.precision === 'exact'));
    check('the road and km are carried for the card',
        byId.get('tol-1')?.road === 'Tol Uji' && byId.get('tol-1')?.km === '1+000');

    // A Bina Marga url must not be handed to two different BPJT cameras: two
    // cameras at one kilometre are the two carriageways, and reusing the
    // stream would show the same picture twice under different names.
    const twins = [
            {camera_id: '10', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 02+000',
                lat: String(onRoute.lat), lon: String(onRoute.lon), streamhls: ''},
            {camera_id: '11', nama_ruas: 'Tol Uji', nama_km: 'UJI KM 02+000',
                lat: String(onRoute.lat), lon: String(onRoute.lon), streamhls: ''}
        ],
        twinOut = normaliseCctvTol({
            bpjtHtml: bpjt({'1': twins}),
            roads: [{id: 'tol-uji', road: 'Tol Uji'}],
            pages: {'tol-uji': page}, liveness, shapes, stops
        }).cameras;

    check('one Bina Marga stream is never given to two cameras',
        twinOut.length === 1, `got ${twinOut.length}`);

    // BPJT leaves nama_km empty on several roads. There is nothing to join on
    // there, and guessing by card order would shift every camera on the road.
    const noKm = [{camera_id: '20', nama_ruas: 'Tol Uji', nama_km: '',
            lat: String(onRoute.lat), lon: String(onRoute.lon), streamhls: 'https://dead.example/z/index.m3u8'}],
        noKmOut = normaliseCctvTol({
            bpjtHtml: bpjt({'1': noKm}),
            roads: [{id: 'tol-uji', road: 'Tol Uji'}],
            pages: {'tol-uji': page},
            liveness: [...liveness, {url: 'https://dead.example/z/index.m3u8', live: false}],
            shapes, stops
        });

    check('a camera with no KM is dropped rather than joined by order',
        noKmOut.cameras.length === 0 && noKmOut.report.noStream === 1);

    // And the gate has to accept them, judged on route proximity rather than
    // on the stop rule the street cameras use.
    const data = baseDataset();

    for (const item of out) {
        data.cameras.push(camera(item));
    }
    sortDataset(data);
    check('toll cameras pass the validation gate',
        !hasError(validate(data, {snapshots: []}), 'cameras'),
        JSON.stringify(validate(data, {snapshots: []}).errors.map(e => e.message)));

    // A toll camera far from any route path is an error even though it is
    // nowhere near a stop either — the gate must not let it through on the
    // street rule.
    const stray = baseDataset();

    stray.cameras.push(camera({
        id: 'tol-stray', name: 'Stray', lat: -6.27837, lon: 106.86,
        stream: 'https://live.example/x/index.m3u8', kind: 'toll', stop: null, distance: null
    }));
    sortDataset(stray);
    check('a toll camera far from every route path is an error',
        hasError(validate(stray, {snapshots: []}), 'cameras'));
}

section('Toll camera sources decay quietly, so the gate watches them (JAKAR-56)');
{
    const onRoute = {lat: -6.27837, lon: 106.79734},
        offRoute = {lat: -6.27837, lon: 106.86000},
        shapes = [{id: 'M-north', coords: STATION_NAMES.flatMap(([, , lat, lon]) => [lon, lat])}],
        stops = STATION_NAMES.map(([id, name, lat, lon]) => ({id, name, lat, lon})),
        bpjt = rows => `<script>const allStreams = ${JSON.stringify({'1': rows})};</script>`,
        NOW = Date.parse('2026-09-08T00:00:00Z'),
        // A road with five cameras, five KM labels and five live streams, so
        // every threshold below has enough material to trip on.
        row = (n, extra = {}) => ({
            camera_id: String(n), nama_ruas: 'Tol Uji', nama_km: `UJI KM 0${n}+000`,
            lat: String(onRoute.lat), lon: String(onRoute.lon),
            streamhls: `https://dead.example/own-${n}/index.m3u8`,
            updated_at: '2026-05-11 10:47:27', ...extra
        }),
        card = (km, url) => `<div class="card-cctv"><p>KM ${km}</p><source src="${url}"></div>`,
        five = [1, 2, 3, 4, 5].map(n => row(n)),
        page = [1, 2, 3, 4, 5].map(n => card(`0${n}+000`, `https://live.example/j-${n}/index.m3u8`)).join(''),
        liveness = [
            ...[1, 2, 3, 4, 5].map(n => ({url: `https://dead.example/own-${n}/index.m3u8`, live: false})),
            ...[1, 2, 3, 4, 5].map(n => ({url: `https://live.example/j-${n}/index.m3u8`, live: true}))
        ],
        run = (rows, {pages = {'tol-uji': page}, extraLive = []} = {}) => normaliseCctvTol({
            bpjtHtml: bpjt(rows),
            roads: [{id: 'tol-uji', road: 'Tol Uji'}],
            pages,
            liveness: [...liveness, ...extraLive],
            shapes, stops, now: NOW
        });

    // ---- what the table itself says --------------------------------------
    const base = run(five);

    check('BPJT\'s own write date is read from the rows, not from the fetch',
        base.report.tableWritten === '2026-05-11', base.report.tableWritten);
    check('  and turned into an age against an injected clock',
        base.report.tableAgeDays === 120, String(base.report.tableAgeDays));
    check('the newest row wins when the table has been partly rewritten',
        run([...five, row(6, {updated_at: '2026-08-01 00:00:00'})]).report.tableWritten === '2026-08-01');
    check('tgl_tarik stands in when updated_at is missing',
        run([row(1, {updated_at: undefined, tgl_tarik: '2026-07-04 03:20:38.008184'})])
            .report.tableWritten === '2026-07-04');

    const stale = validate(baseDataset(), {toll: base.report, snapshots: []}),
        fresh = validate(baseDataset(), {
            toll: {...base.report, tableWritten: '2026-09-01', tableAgeDays: 7}, snapshots: []
        });

    check('a table nobody has rewritten in a season is a warning',
        hasWarning(stale, 'toll-camera-sources'));
    check('  and not an error — the layer degrades to fewer cameras, not wrong ones',
        !hasError(stale, 'toll-camera-sources'));
    check('a table rewritten last week says nothing',
        !hasWarning(fresh, 'toll-camera-sources'));

    // ---- a match is a match even when we drop it afterwards ---------------
    // BORR: the join found every camera and the proximity filter then dropped
    // all five, 35 km from any route this map draws. Counting the shipped
    // number as the join rate reported a broken join that was working.
    const far = run([1, 2, 3, 4, 5].map(n => row(n, {
        lat: String(offRoute.lat), lon: String(offRoute.lon)
    })));

    check('a join that is later dropped for being off-network still counts as matched',
        far.report.matchedJoined === 5 && far.report.joined === 0,
        JSON.stringify({matched: far.report.matchedJoined, shipped: far.report.joined}));
    check('  so a road the fleet does not reach is not reported as a broken join',
        !validate(baseDataset(), {toll: far.report, snapshots: []}).warnings
            .some(w => /join matched none/.test(w.message)));

    // ---- the join actually breaking ---------------------------------------
    // Both sides have material and none of it matches: BPJT's KM labels, or
    // Bina Marga's, have changed shape. Detectable from one build alone, which
    // is what makes it the strongest of these checks.
    const renamed = run(five, {
        pages: {'tol-uji': [1, 2, 3, 4, 5]
            .map(n => card(`9${n}+000`, `https://live.example/j-${n}/index.m3u8`)).join('')}
    });

    check('when neither side\'s KM labels match, the join is reported broken',
        validate(baseDataset(), {toll: renamed.report, snapshots: []}).warnings
            .some(w => /join matched none/.test(w.message)),
        JSON.stringify(renamed.report.byRoad));
    check('  and every unmatched stream is counted as unclaimed',
        renamed.report.byRoad[0].pageUnused === 5);

    // ---- the split moving --------------------------------------------------
    // The predicted failure: Jasa Marga rotates its stream ids again, BPJT's
    // own urls all go dead, and only the join carries the layer.
    const rotated = validate(baseDataset(), {
        toll: base.report,
        previousToll: {...base.report, matchedDirect: 40, matchedJoined: 5, byRoad: []},
        snapshots: []
    });

    check('a resolution arm falling to zero is reported',
        rotated.warnings.some(w => /split moved/.test(w.message)));

    // ---- a single road going dark ------------------------------------------
    const dark = validate(baseDataset(), {
        toll: {...base.report, byRoad: [{
            road: 'Tol Uji', inRegion: 5, direct: 0, joined: 0,
            matchedDirect: 0, matchedJoined: 0, noStream: 5, offNetwork: 0,
            statesKm: 5, hasPage: true, pageStreams: 0, pageUnused: 0
        }]},
        previousToll: {...base.report, byRoad: [{road: 'Tol Uji', matchedDirect: 0, matchedJoined: 9}]},
        snapshots: []
    });

    check('a road that resolved cameras last build and none now is named',
        dark.warnings.some(w => /resolved cameras last build/.test(w.message)));

    // A road going dark must not need the totals to move: Jasa Marga is 61% of
    // the network and would mask every other operator at once.
    check('  even while the network total is unchanged',
        !dark.warnings.some(w => /split moved/.test(w.message)));

    // ---- one card per carriageway, one stream between them -----------------
    // Bina Marga repeats the card and can repeat the url with it. Counting
    // cards would claim the road publishes more than it does and leave a
    // camera looking unmatched when there was never a second picture for it.
    const twinned = run([row(1), row(2, {nama_km: 'UJI KM 01+000'})], {
        pages: {'tol-uji': card('01+000', 'https://live.example/j-1/index.m3u8') +
            card('01+000', 'https://live.example/j-1/index.m3u8')}
    });

    check('a stream listed twice for the two carriageways is counted once',
        twinned.report.byRoad[0].pageStreams === 1, JSON.stringify(twinned.report.byRoad[0]));
    check('  and is never handed to both cameras',
        twinned.report.matchedJoined === 1 && twinned.report.noStream === 1);

    // ---- nothing resolved at all -------------------------------------------
    // Not decay: a page format change. The only error in this check.
    const dead = run(five, {pages: {}});

    check('a snapshot with cameras and no resolvable stream anywhere is an error',
        hasError(validate(baseDataset(), {toll: dead.report, snapshots: []}), 'toll-camera-sources'),
        JSON.stringify(dead.report));

    check('no cctv-tol snapshot at all is simply passed over',
        !hasError(validate(baseDataset(), {toll: null, snapshots: []}), 'toll-camera-sources') &&
        !hasWarning(validate(baseDataset(), {toll: null, snapshots: []}), 'toll-camera-sources'));
}

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
