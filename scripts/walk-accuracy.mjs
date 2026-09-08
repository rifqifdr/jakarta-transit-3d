/**
 * Measures where the straight-line walking assumption breaks (JAKAR-24).
 *
 * The router treats a transfer as a straight line at 4.8 km/h. A twelve-pair
 * sample suggested that is optimistic by a median 1.36x, worst 2.6x, and — the
 * part that matters — that the error is *not uniform*: it concentrates where a
 * major road intervenes, which is exactly where BRT transfers happen.
 *
 * This samples several hundred pairs from the real walk table and routes each
 * with a genuine pedestrian engine, so the distribution can be seen rather than
 * guessed at.
 *
 * Two things it reports separately, on purpose:
 *
 *   - the **detour factor**, path over straight line
 *   - the **implied walking speed**, path length over real duration
 *
 * A ratio alone cannot tell you which is wrong. The early evidence says the
 * speed is very nearly right and the geometry is not, which points at a
 * different fix — correct the distance, leave 4.8 km/h alone.
 *
 *   node scripts/walk-accuracy.mjs --pairs=400
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'),

    // FOSSGIS's public Valhalla. Free, no key, and verified to do real
    // pedestrian routing — unlike the public OSRM demo, which serves the car
    // profile for every profile and would silently measure driving.
    ENDPOINT = 'https://valhalla1.openstreetmap.de/route',

    // Courtesy pacing for a community server.
    INTERVAL_MS = 1100,

    MODEL_SPEED_MS = 4.8 / 3.6;

const args = new Map(process.argv.slice(2).map(a => {
        const [k, v] = a.replace(/^--/, '').split('=');

        return [k, v ?? true];
    })),
    wanted = Number(args.get('pairs') ?? 400),
    sleep = ms => new Promise(r => setTimeout(r, ms));

const M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function straightMetres(a, b) {
    return Math.hypot((a.lat - b.lat) * M_PER_DEG_LAT, (a.lon - b.lon) * M_PER_DEG_LON);
}

async function pedestrianRoute(a, b) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            locations: [{lat: a.lat, lon: a.lon}, {lat: b.lat, lon: b.lon}],
            costing: 'pedestrian',
            directions_options: {units: 'kilometers'}
        }),
        signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const summary = (await response.json()).trip?.summary;

    if (!summary) {
        throw new Error('no trip in response');
    }
    return {metres: summary.length * 1000, seconds: summary.time};
}

// ---------------------------------------------------------------------------

const canonical = JSON.parse(readFileSync(join(ROOT, 'data/build/canonical.json'), 'utf8')),
    stops = canonical.stops,
    // Walk edges carry stop *ids*, not indices — see trap 7. They used to carry
    // indices, and this file's own distance stratification is what hid the
    // consequences: bucketing on straight-line distance selected exactly the
    // corrupted edges that happened to stay short, so the run came back
    // reassuring and was wrong.
    stopById = new Map(stops.map(stop => [stop.id, stop])),
    modeOfStop = new Map();

for (const pattern of canonical.patterns) {
    const mode = pattern.mode ??
        canonical.routes.find(r => r.id === pattern.route)?.mode;

    for (const id of pattern.stops) {
        if (!modeOfStop.has(id)) {
            modeOfStop.set(id, new Set());
        }
        modeOfStop.get(id).add(mode);
    }
}

const edges = canonical.transfers;

console.log(`walk table: ${edges.length.toLocaleString()} edges`);

// canonical.json is only written by `npm run transform -- --json`, so a plain
// build leaves a stale one behind. Say so, rather than sampling nothing and
// reporting statistics over an empty set.
if (!edges.length) {
    console.error('\nNo walk edges. Rebuild with: npm run transform -- --json --accept-drift');
    process.exit(1);
}

// Stratify by distance so short and long transfers are both represented, and
// keep cross-mode pairs identifiable — they are the ones the map newly depends
// on, and the ones a road is most likely to sit across.
const buckets = [[0, 100], [100, 200], [200, 300], [300, 400]],
    perBucket = Math.ceil(wanted / buckets.length),
    chosen = [];

let seed = 20260906;
const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};

for (const [low, high] of buckets) {
    const inRange = edges.filter(e => {
        const a = stopById.get(e.from),
            b = stopById.get(e.to);

        if (!a || !b) {
            return false;
        }

        const d = straightMetres(a, b);

        return d >= low && d < high;
    });

    for (let i = 0; i < perBucket && inRange.length; i++) {
        chosen.push(inRange[Math.floor(random() * inRange.length)]);
    }
}

console.log(`sampling ${chosen.length} pairs across ${buckets.length} distance bands\n`);

const results = [];
let failures = 0;

for (let i = 0; i < chosen.length; i++) {
    const edge = chosen[i],
        a = stopById.get(edge.from),
        b = stopById.get(edge.to),
        straight = straightMetres(a, b);

    try {
        const real = await pedestrianRoute(a, b),
            modelSeconds = straight / MODEL_SPEED_MS,
            aModes = [...(modeOfStop.get(a.id) ?? [])],
            bModes = [...(modeOfStop.get(b.id) ?? [])];

        results.push({
            from: a.name,
            to: b.name,
            straight,
            pathMetres: real.metres,
            realSeconds: real.seconds,
            modelSeconds,
            ratio: real.seconds / modelSeconds,
            detour: real.metres / straight,
            impliedSpeed: real.metres / real.seconds,
            crossMode: aModes.length && bModes.length &&
                aModes.some(m => !bModes.includes(m))
        });
    } catch (error) {
        failures++;
    }

    if ((i + 1) % 25 === 0) {
        console.log(`  ${i + 1}/${chosen.length}  (${failures} failed)`);
    }
    await sleep(INTERVAL_MS);
}

// ---------------------------------------------------------------------------

const quantile = (values, q) => {
    const sorted = [...values].sort((x, y) => x - y);

    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

const ratios = results.map(r => r.ratio),
    detours = results.map(r => r.detour),
    speeds = results.map(r => r.impliedSpeed);

console.log(`\nrouted ${results.length} pairs, ${failures} failed\n`);
console.log('                        p10     p50     p90     p99');
console.log(`  ratio real/model  ${[0.1, 0.5, 0.9, 0.99].map(q => quantile(ratios, q).toFixed(2).padStart(7)).join(' ')}`);
console.log(`  detour path/line  ${[0.1, 0.5, 0.9, 0.99].map(q => quantile(detours, q).toFixed(2).padStart(7)).join(' ')}`);
console.log(`  implied km/h      ${[0.1, 0.5, 0.9, 0.99].map(q => (quantile(speeds, q) * 3.6).toFixed(2).padStart(7)).join(' ')}`);

const cross = results.filter(r => r.crossMode),
    same = results.filter(r => !r.crossMode);

console.log(`\n  cross-mode pairs: ${cross.length}, median ratio ${cross.length ? quantile(cross.map(r => r.ratio), 0.5).toFixed(2) : '—'}`);
console.log(`  same-mode pairs : ${same.length}, median ratio ${same.length ? quantile(same.map(r => r.ratio), 0.5).toFixed(2) : '—'}`);

console.log('\nworst ten:');
[...results].sort((a, b) => b.ratio - a.ratio).slice(0, 10).forEach(r => {
    console.log(`  ${r.ratio.toFixed(2)}x  ${Math.round(r.straight)}m straight -> ${Math.round(r.pathMetres)}m on foot  ` +
        `${r.from.slice(0, 22)} -> ${r.to.slice(0, 22)}`);
});

writeFileSync(join(ROOT, 'data/build/walk-accuracy.json'), JSON.stringify({
    sampledAt: new Date().toISOString(),
    engine: ENDPOINT,
    modelSpeedKmh: 4.8,
    pairs: results.length,
    failures,
    summary: {
        ratio: {p10: quantile(ratios, 0.1), p50: quantile(ratios, 0.5), p90: quantile(ratios, 0.9), p99: quantile(ratios, 0.99)},
        detour: {p10: quantile(detours, 0.1), p50: quantile(detours, 0.5), p90: quantile(detours, 0.9), p99: quantile(detours, 0.99)},
        impliedSpeedKmh: {p50: quantile(speeds, 0.5) * 3.6}
    },
    results
}, null, 1));

console.log('\nwrote data/build/walk-accuracy.json');
