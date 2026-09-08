import {readFileSync, existsSync} from 'node:fs';

/**
 * Real pedestrian distances for the walk table, from Valhalla.
 *
 * The router models a transfer as a straight line at 4.8 km/h. Measured against
 * real pedestrian routing (JAKAR-45) the *speed* is right — implied 4.92 km/h —
 * but 11% of edges are underestimated by more than three minutes, worst +27,
 * because the straight line ignores whatever is in the way. PLN Senayan to Pulo
 * Kamboja is 142 m apart and 2,213 m on foot. A railway, a river or a
 * limited-access road intervenes and the crossing is somewhere else entirely.
 *
 * Those cannot be picked out by a heuristic — the earlier attempt blamed
 * same-name platform pairs and was wrong, they are 23% of the tail and behave
 * *better* than average. The only way to know is to route them.
 *
 * **Why Valhalla over an OSM extract.** Routing locally would mean the 855 MB
 * Geofabrik Java extract plus a PBF reader. Routing over Overpass would mean
 * ~300 MB of tiles from a server that asks people not to bulk-extract, and a
 * buffer small enough to be affordable is small enough to truncate exactly the
 * long detours this exists to find — a 500 m buffer still needs 666 km² and
 * would clip a 2.2 km path. Transitland's hosted Valhalla is authenticated,
 * intended for this, and answers 2,500 pairs in about five seconds.
 *
 * **Why a matrix.** One request per edge is 40,817 requests. `sources_to_targets`
 * answers a block at a time, so the harvest is a few hundred requests instead.
 * Only the pairs the walk table actually contains are kept; the rest of each
 * block is the price of asking in blocks.
 */
/**
 * `.env`, read here rather than imported from the Plane client — that module
 * throws at load without a Plane token, and ingest has no business depending
 * on the issue tracker.
 */
function apiKey() {
    if (!existsSync('.env')) {
        return null;
    }

    const env = {};

    for (const line of readFileSync('.env', 'utf8').split('\n')) {
        const trimmed = line.trim(),
            eq = trimmed.indexOf('=');

        if (!trimmed || trimmed.startsWith('#') || eq < 0) {
            continue;
        }
        env[trimmed.slice(0, eq).trim()] =
            trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env.TRANSITLAND_ROUTING_API || env.TRANSITLAND_API_TOKEN || null;
}

const ENDPOINT = 'https://transit.land/api/v2/routing/valhalla/sources_to_targets',

    // Valhalla caps a matrix at 2,500 cells — sources x targets, not the
    // location count, which is what "Exceeded max locations" sounds like but is
    // not. 50 x 50 sits exactly on it and returns in ~4.5 s at ~460 KB; 49 x 59
    // is 2,891 and is refused. Kept a little under.
    MAX_CELLS = 2400,
    MAX_TARGETS = 60,

    // The canonical dataset is the input. Ingest normally touches nothing
    // downstream, and this is the one adapter that cannot: which pairs to
    // route *is* the walk table, and that only exists after a transform.
    CANONICAL = 'data/build/canonical.json';

/** Stops grouped so a block's sources and targets overlap as much as possible. */
function planBlocks(stops, edges) {
    const neighbours = new Map();

    for (const edge of edges) {
        if (edge.kind !== 'walk') {
            continue;
        }
        for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]]) {
            if (!neighbours.has(a)) {
                neighbours.set(a, new Set());
            }
            neighbours.get(a).add(b);
        }
    }

    // Sorted by cell then by longitude, so consecutive sources share targets
    // and a block stays geographically tight.
    const cell = 0.006, // ~660 m
        ordered = [...neighbours.keys()]
            .map(id => stops.get(id))
            .filter(Boolean)
            .sort((a, b) =>
                Math.floor(a.lat / cell) - Math.floor(b.lat / cell) ||
                Math.floor(a.lon / cell) - Math.floor(b.lon / cell) ||
                a.lon - b.lon);

    const blocks = [];
    let sources = [],
        targets = new Set();

    const flush = () => {
        if (sources.length) {
            blocks.push({sources: sources.map(s => s.id), targets: [...targets]});
        }
        sources = [];
        targets = new Set();
    };

    for (const stop of ordered) {
        const wanted = new Set(targets);

        for (const id of neighbours.get(stop.id)) {
            wanted.add(id);
        }
        if (wanted.size > MAX_TARGETS || (sources.length + 1) * wanted.size > MAX_CELLS) {
            flush();
        }
        sources.push(stop);
        for (const id of neighbours.get(stop.id)) {
            targets.add(id);
        }
    }
    flush();
    return blocks;
}

export default {
    id: 'walk',
    label: 'Pedestrian distances (Transitland Valhalla)',
    // Derived from this project's own canonical dataset rather than fetched
    // from upstream, so `--source=all` skips it: on a fresh checkout there is
    // no walk table to route and it would be the one source that always fails.
    derived: true,
    // Someone else's routing engine, on the user's own key. Unhurried.
    interval: 1200,

    async fetch(snap, log) {
        const key = apiKey();

        if (!key) {
            throw new Error('No TRANSITLAND_ROUTING_API in .env — cannot route the walk table');
        }
        if (!existsSync(CANONICAL)) {
            throw new Error(
                `${CANONICAL} not found. This adapter routes the pairs in the walk table, ` +
                'so run `npm run transform -- --json` first.'
            );
        }

        const canonical = JSON.parse(readFileSync(CANONICAL, 'utf8')),
            stops = new Map(canonical.stops.map(s => [s.id, s])),
            blocks = planBlocks(stops, canonical.transfers),
            wanted = canonical.transfers.filter(e => e.kind === 'walk').length;

        log(`  walk: ${wanted.toLocaleString()} edges, ${blocks.length} matrix blocks`);

        for (let i = 0; i < blocks.length; i++) {
            const name = `block-${String(i).padStart(4, '0')}.json`;

            if (snap.has(name)) {
                continue;
            }

            const block = blocks[i],
                body = JSON.stringify({
                    sources: block.sources.map(id => ({lat: stops.get(id).lat, lon: stops.get(id).lon})),
                    targets: block.targets.map(id => ({lat: stops.get(id).lat, lon: stops.get(id).lon})),
                    costing: 'pedestrian',
                    units: 'kilometers'
                }),
                // The key goes in a header, never the query string. As a
                // parameter it ends up in the URL that `snap.get` prints on a
                // failure, which put it in a log file the first time this ran.
                text = await snap.get(ENDPOINT, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json', apikey: key},
                    body,
                    timeout: 180000
                });

            // The ids are written alongside the response because the matrix
            // answers in index order and nothing in it says which stop an
            // index was. A snapshot that cannot be read without re-deriving
            // the request is not a snapshot.
            await snap.writeJson(name, {
                sources: block.sources,
                targets: block.targets,
                response: JSON.parse(text)
            });

            if ((i + 1) % 25 === 0) {
                log(`    ${i + 1}/${blocks.length} blocks`);
            }
        }

        await snap.finish({
            counts: {blocks: blocks.length, edges: wanted},
            sources: [ENDPOINT],
            notes: [
                'Pedestrian matrix from Transitland-hosted Valhalla, on the user\'s API key.',
                'Blocks hold the stop ids for each axis; the matrix itself is index-ordered.',
                `Costing: pedestrian, default walking speed. Blocks capped at ${MAX_CELLS} matrix cells.`
            ]
        });
    }
};
