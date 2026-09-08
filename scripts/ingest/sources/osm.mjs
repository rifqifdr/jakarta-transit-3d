/**
 * OpenStreetMap, via Overpass.
 *
 * This is the only source of geometry the project has. Not one operator —
 * not KCI, not MRT, not LRT — returns a single coordinate, so every rail line
 * on the map is drawn from an OSM route relation and joined to the operator's
 * timetable by station name. That join measured 98.8% on the KRL network.
 *
 * Overpass grants two concurrent slots per client, so the queries run one at
 * a time with a wide gap. They are also slow by nature: minutes, not seconds.
 */

// Jabodetabek, stretched west far enough to include Rangkasbitung (106.25),
// which sits outside the commuter belt proper but is a Commuter Line terminus.
const BBOX = '-6.75,106.10,-5.95,107.30',
    ENDPOINT = 'https://overpass-api.de/api/interpreter',

    // Overpass is doing real work for us; give it room and do not hammer it.
    TIMEOUT_MS = 300000,
    INTERVAL_MS = 3000;

const QUERIES = [
    {
        name: 'rail-routes.json',
        what: 'route relations with geometry (subway, light rail, commuter rail)',
        // `out geom` inlines the vertices, which is what makes these usable as
        // shapes without a second pass to resolve way members.
        //
        // The operator filter on heavy rail matters more than it looks. A
        // relation is returned if it merely *intersects* the bbox, and `out
        // geom` then returns the whole thing — so matching bare "KAI" drags in
        // intercity services whose geometry runs the length of Java. Measured:
        // adding it took the snapshot from 3 MB to 33 MB, 88 of the extra
        // relations being trains to Malang, Jember and Ketapang. "KAI
        // Commuter" and "PT KCJ" cover the commuter network, and subway and
        // light rail are matched on route type regardless of operator.
        ql: `[out:json][timeout:280];
(
  relation["type"="route"]["route"="subway"](${BBOX});
  relation["type"="route"]["route"="light_rail"](${BBOX});
  relation["type"="route"]["route"="train"]["operator"~"Commuter|KCJ",i](${BBOX});
);
out geom;`
    },
    {
        name: 'rail-stations.json',
        what: 'railway station and halt nodes',
        ql: `[out:json][timeout:280];
(
  node["railway"="station"](${BBOX});
  node["railway"="halt"](${BBOX});
);
out body;`
    },
    {
        name: 'metro-stations.json',
        what: 'subway and light rail station nodes',
        // MRT stations carry their sponsor names here ("Blok M BCA"), which is
        // exactly the form the operator's own API uses — so the name join works
        // with nothing more than a prefix strip.
        ql: `[out:json][timeout:280];
(
  node["railway"="station"]["station"="subway"](${BBOX});
  node["railway"="station"]["station"="light_rail"](${BBOX});
  node["railway"="stop"]["subway"="yes"](${BBOX});
  node["public_transport"="stop_position"]["light_rail"="yes"](${BBOX});
);
out body;`
    }
];

export default {
    id: 'osm',
    label: 'OpenStreetMap — Overpass (rail geometry and stations)',
    interval: INTERVAL_MS,

    async fetch(snap, log) {
        const counts = {};

        for (const query of QUERIES) {
            if (snap.has(query.name)) {
                log(`  cached  ${query.name}`);
            } else {
                log(`  querying ${query.what}…`);
                await snap.write(query.name, await snap.get(ENDPOINT, {
                    method: 'POST',
                    body: query.ql,
                    timeout: TIMEOUT_MS,
                    headers: {'Content-Type': 'text/plain'}
                }));
            }

            const payload = await snap.readJson(query.name),
                elements = payload.elements || [];

            counts[query.name.replace('.json', '')] = elements.length;

            // Overpass stamps the age of the data it built the answer from,
            // which is a better freshness signal than when we asked.
            if (payload.osm3s?.timestamp_osm_base) {
                counts[`${query.name.replace('.json', '')}OsmBase`] = payload.osm3s.timestamp_osm_base;
            }
            log(`  ${query.name}: ${elements.length} elements`);
        }

        return {
            counts,
            sources: [ENDPOINT],
            notes: [
                `bbox ${BBOX} (Jabodetabek, widened west for Rangkasbitung)`,
                'Data © OpenStreetMap contributors, ODbL 1.0 — attribution required wherever it is drawn.',
                'Relations with geometry but no ordered stops are lines under construction (MRT East-West); exclude at transform time.',
                'LRT Jakarta (Lin Selatan) has 4 of its 6 stations mapped — a known upstream gap.'
            ]
        };
    }
};
