/**
 * Public CCTV cameras along the network — JakCCTV, served by Balitower.
 *
 * Jakarta publishes street cameras that a browser can play directly: the
 * portal is a thin wrapper over a Flussonic media server which answers
 * `access-control-allow-origin: *` with no auth token, so the map can embed a
 * stream from its own origin with no proxy and no key. That is unusual enough
 * to be worth stating — it is the reason this feature is possible at all.
 *
 * Three things are fetched, and the third is the awkward one:
 *
 * 1. **The portal page.** Only 50 cameras and no coordinates, but it is the
 *    authoritative statement of which hosts are currently in service.
 * 2. **A coordinate table.** The portal publishes no positions at all, and
 *    there is no official API — `/api/cctv`, `/api/camera` and `/publik/data`
 *    are all 404, and `api.jakarta.go.id` does not resolve. The only source
 *    tying a stream name to a position is a community mirror of the DKI open
 *    data release, which carries 2,288 of them.
 * 3. **Liveness.** That mirror is old and its host (`cctv.balitower.co.id:80`,
 *    plain http) is gone entirely. The stream *names* survived the move to
 *    the current host, but only some of the cameras did: measured over 80 at
 *    random, 31% still answer. So every stream is probed and the answer is
 *    recorded. Which cameras exist is exactly the kind of thing a snapshot is
 *    for — it is what the source said today.
 *
 * A dead camera is not an error and is not retried; the probe records the
 * status and moves on. The transform decides what to do with it.
 *
 * **This adapter stores no video.** A snapshot records that a camera exists,
 * where it is, and that it answered — never a frame of footage. The stream is
 * fetched by the viewer's browser, live, or not at all.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    PLACES = join(ROOT, 'data', 'camera-places.json'),

    PORTAL = 'https://jakcctv.jakarta.go.id/publik',

    // A community mirror of the DKI open data release. Pinned to a commit
    // would be better; the repository publishes no tags and the file has not
    // moved, so the branch is what there is.
    COORDS = 'https://raw.githubusercontent.com/lakuapik/cctv-jakarta/master/data.json',

    // The host serving the geolocated set.
    STREAM_HOST = 'https://cctv-jsc.balitower.co.id:8011',

    // The portal's *other* host, and the better cameras: Thamrin, Gatot
    // Subroto, S. Parman, Gerbang Pemuda — all on Transjakarta corridors, all
    // recent, and 57% of them live against 29% of the geolocated set.
    //
    // Nothing geolocates them. Their names do carry the street, though
    // (`501844_JKP_DISHUB_JL.-MH.-THAMRIN-C01_CCTV-01`), so the position is
    // recovered from the street rather than from a coordinate table:
    // `data/camera-places.json` maps each site to an OpenStreetMap feature and
    // this adapter fetches those features' geometry. The result is an estimate,
    // ships marked as one, and is corrected by editing that file.
    PORTAL_HOST = 'https://dki-jkt.balitower.co.id:7028',

    OVERPASS = 'https://overpass-api.de/api/interpreter',

    // DKI proper. Deliberately tighter than the app's own bounds, which reach
    // into Tangerang and Bekasi: there is a Jalan MH Thamrin in Tangerang and
    // an unconstrained name search finds it first.
    DKI_BBOX = '-6.38,106.68,-6.08,107.00',

    // Flussonic's multi-variant playlist: 170 bytes, and its presence is the
    // cheapest possible proof that a camera is publishing.
    PROBE = 'index.m3u8',

    // One file per 100 probes rather than per probe. Per-camera files would
    // make 2,288 of them for a resumability granularity nobody needs; per-run
    // would throw away a long harvest on one interruption.
    BATCH = 100,

    /**
     * The probe runs concurrently, which is the one place this adapter departs
     * from `snap.get`, and it is worth saying why.
     *
     * A camera that is live answers in about 55 ms. One that is gone takes
     * **ten seconds** — the media server stalls looking for a stream it has no
     * configuration for, then answers 404. Since roughly two thirds of the
     * list is gone, a sequential sweep is over four hours, essentially all of
     * it spent waiting on sockets.
     *
     * Cutting the timeout instead would be faster and worse: it would turn a
     * definite "the server says this camera is gone" into "we gave up asking",
     * and that difference is the whole value of the probe. So the wait is kept
     * and overlapped. Sixteen concurrent requests for a 170-byte playlist is
     * nothing to a server built to stream video to the public.
     */
    CONCURRENCY = 16,
    PROBE_TIMEOUT_MS = 15000,

    USER_AGENT = 'jakarta-publictrans-3d/1.0 (open data map; contact via repo)';

/** One probe. Never throws: a dead camera is an answer, not a failure. */
async function probe(stream, host = STREAM_HOST) {
    try {
        const response = await fetch(`${host}/${stream}/${PROBE}`, {
            headers: {'User-Agent': USER_AGENT},
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        });

        return {stream, status: response.status};
    } catch (error) {
        // Status 0 means we never got an answer, which is different from the
        // server telling us the camera is gone. Kept distinct so a future run
        // can tell a decommissioned camera from a bad afternoon.
        return {stream, status: 0, error: String(error.name || error.message).slice(0, 60)};
    }
}

/** Bounded pool, preserving input order so a batch file reads sensibly. */
async function probeAll(streams, host) {
    const results = new Array(streams.length);
    let next = 0;

    await Promise.all(Array.from({length: Math.min(CONCURRENCY, streams.length)}, async () => {
        while (next < streams.length) {
            const index = next++;

            results[index] = await probe(streams[index], host);
        }
    }));
    return results;
}

/**
 * The OpenStreetMap features `data/camera-places.json` names, in one request.
 *
 * Ways come back with full geometry because sites sharing a street are spread
 * along it; the named buildings and parks come back as a centre point, which
 * is all a single-point feature can offer. One query rather than one per name —
 * Overpass is a courtesy service and this is twelve names.
 */
function overpassQuery(names) {
    const escaped = names
        .map(name => name.replace(/[\\"]/g, '\\$&').replace(/[.*+?^${}()|[\]]/g, '\\$&'))
        .join('|');

    return `[out:json][timeout:180];
(
  way["highway"]["name"~"^(${escaped})$"](${DKI_BBOX});
);
out geom;
(
  nwr["name"~"^(${escaped})$"](${DKI_BBOX});
);
out center;`;
}

/**
 * Stream names out of the coordinate mirror.
 *
 * The file is JavaScript (`var datacctv = [...]`) rather than JSON, and one of
 * its rows breaks a strict parse, so it is read with a regular expression.
 * Nothing is interpreted here beyond "which streams should be probed" — the
 * bytes are written to the snapshot verbatim either way.
 */
function streamsIn(text) {
    const seen = new Set(),
        streams = [];

    for (const match of text.matchAll(/"url":"(.*?)"/g)) {
        const url = match[1].replace(/\\\//g, '/'),
            name = /\/\/[^/]+\/([^/]+)\/embed/.exec(url)?.[1];

        if (name && !seen.has(name)) {
            seen.add(name);
            streams.push(name);
        }
    }
    return streams;
}

export default {
    id: 'cctv',
    label: 'Public CCTV cameras (JakCCTV / Balitower)',

    // Governs only the two document fetches — the portal page and the
    // coordinate table. The liveness probe does not go through `snap.get`; see
    // CONCURRENCY above for why.
    interval: 150,

    async fetch(snap, log) {
        // The portal is fetched for the record rather than for the camera
        // list: it is what says which hosts are in service, and a future build
        // that finds this page changed should be able to see how.
        //
        // Best-effort on purpose. It went unreachable partway through the
        // session this adapter was written in — answering, then timing out at
        // the TCP level while the media host stayed up throughout. Nothing
        // downstream needs it, so letting it fail the whole harvest would
        // trade the part that works for the part that does not.
        let portal = 'ok';

        try {
            await snap.getInto('portal.html', PORTAL, {retries: 2, timeout: 20000});
        } catch (error) {
            portal = 'unreachable';
            log(`  ! portal unreachable, continuing: ${error.message.slice(0, 60)}`);
        }

        if (!snap.has('coordinates.json')) {
            await snap.write('coordinates.json', await snap.get(COORDS));
        }

        const streams = streamsIn(await snap.read('coordinates.json'));

        if (!streams.length) {
            throw new Error('coordinate mirror parsed to zero streams — its format has changed');
        }

        log(`streams to probe: ${streams.length}`);

        let live = 0,
            dead = 0,
            errors = 0;

        for (let start = 0; start < streams.length; start += BATCH) {
            const batch = streams.slice(start, start + BATCH),
                name = `liveness/${String(start / BATCH).padStart(3, '0')}.json`;

            if (snap.has(name)) {
                // Counted from disk so the summary is right on a resumed run
                // rather than reporting only what this process happened to do.
                for (const row of await snap.readJson(name)) {
                    if (row.status === 200) {
                        live++;
                    } else if (row.status === 404) {
                        dead++;
                    } else {
                        errors++;
                    }
                }
                continue;
            }

            const results = await probeAll(batch);

            for (const row of results) {
                if (row.status === 200) {
                    live++;
                } else if (row.status === 404) {
                    dead++;
                } else {
                    errors++;
                }
            }

            await snap.writeJson(name, results);
            log(`  ${Math.min(start + BATCH, streams.length)}/${streams.length} probed — ${live} live`);
        }

        log(`live ${live}, decommissioned ${dead}, unreachable ${errors}`);

        // ---- the portal's own cameras, and the streets that place them ----
        //
        // Skipped rather than failed when the portal did not answer: its HTML
        // is the only list of these streams, and the geolocated set above is a
        // complete result on its own.
        let portalLive = 0,
            portalTotal = 0,
            streets = 0;

        if (snap.has('portal.html')) {
            const html = await snap.read('portal.html'),
                portalStreams = [...new Set(
                    [...html.matchAll(/dki-jkt\.balitower\.co\.id:7028\/([^"'/\s]+)/g)].map(m => m[1])
                )].sort();

            portalTotal = portalStreams.length;

            if (!snap.has('portal-liveness.json')) {
                log(`portal streams to probe: ${portalTotal}`);
                await snap.writeJson('portal-liveness.json',
                    await probeAll(portalStreams, PORTAL_HOST));
            }
            portalLive = (await snap.readJson('portal-liveness.json'))
                .filter(row => row.status === 200).length;
            log(`portal cameras: ${portalLive}/${portalTotal} live`);

            if (!snap.has('streets.json')) {
                const places = JSON.parse(readFileSync(PLACES, 'utf8')),
                    names = [...new Set(Object.values(places)
                        .map(place => place?.street)
                        .filter(Boolean))].sort();

                log(`fetching ${names.length} OSM features for camera placement`);
                await snap.write('streets.json', await snap.get(OVERPASS, {
                    method: 'POST',
                    headers: {'Content-Type': 'text/plain'},
                    body: overpassQuery(names),
                    timeout: 180000
                }));
            }
            streets = (await snap.readJson('streets.json')).elements?.length ?? 0;
            log(`street geometry: ${streets} OSM elements`);
        } else {
            log('  ! no portal.html — skipping the portal cameras entirely');
        }

        return {
            counts: {
                streams: streams.length, live, dead, errors, portal,
                portalStreams: portalTotal, portalLive, streetElements: streets
            },
            sources: [PORTAL, COORDS, STREAM_HOST, PORTAL_HOST, OVERPASS],
            notes: [
                portal === 'ok'
                    ? 'Portal page captured.'
                    : 'Portal page was UNREACHABLE on this run (TCP timeout) — the media host answered ' +
                        'normally throughout, so this is the portal alone, not the cameras.',
                'Flussonic media server: /<stream>/index.m3u8 is HLS, /<stream>/preview.jpg a still, ' +
                    '/<stream>/preview.mp4 a short clip. All send access-control-allow-origin: * with no token.',
                'No official coordinate API exists — /api/cctv, /api/camera and /publik/data are 404 and ' +
                    'api.jakarta.go.id does not resolve. Positions come from a community mirror of the DKI ' +
                    'open data release.',
                'The mirror is stale: its own host cctv.balitower.co.id:80 is gone, and only about a third ' +
                    'of its streams still answer on the current host. Hence the probe.',
                'Dead streams stay in the snapshot with their status. A camera that comes back should not ' +
                    'need the coordinate table re-derived.',
                'The portal cameras on dki-jkt.balitower.co.id:7028 are the better ones — Thamrin, Gatot ' +
                    'Subroto, S. Parman, Gerbang Pemuda, all on Transjakarta corridors, and 57% live against ' +
                    '29% of the geolocated set. Nothing geolocates them, so their position is recovered from ' +
                    'the street name in the stream id via data/camera-places.json and OSM geometry. Those ' +
                    'positions are ESTIMATES and are marked as such downstream.',
                'streets.json is one Overpass query for every OSM feature that file names — ways with full ' +
                    'geometry (sites on one street are spread along it), buildings and parks as a centre point.',
                'No video is stored. The snapshot records that a camera exists and answered, nothing more.'
            ]
        };
    }
};
