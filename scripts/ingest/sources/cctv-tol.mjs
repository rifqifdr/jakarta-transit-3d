/**
 * Toll road cameras — BPJT for where they are, Bina Marga for what plays.
 *
 * Jakarta's daytime population lives outside Jakarta, and the commuter services
 * this map already carries — Royaltrans, Transjabodetabek — spend most of the
 * journey on a toll road. 64% of these cameras sit within 150 m of a route path
 * the fleet actually drives, against 41% within 400 m of a stop, which is why
 * the toll half is filtered on proximity to a *route* rather than to a stop.
 *
 * **Two sources, because neither works alone.**
 *
 * `bpjt.pu.go.id/cctv/` embeds an `allStreams` object in its page HTML with
 * coordinates, KM marker, road, operator and a stream URL for 1,530 cameras
 * nationwide. It is the only thing that geolocates any of them. But it was
 * written once on 2026-05-11 and has not moved since, and in that time **Jasa
 * Marga has rotated every stream id**: of its 239 Jabodetabek Jasa Marga URLs,
 * *none* appears on Bina Marga's live pages, and they play 0/10 where Bina
 * Marga's play 10/10. Jasa Marga is 61% of the usable cameras.
 *
 * `binamarga.pu.go.id/contents/cctv_tol/?id_ruas=…` renders one page per road
 * with current stream URLs, and no coordinates at all — only a KM label.
 *
 * So BPJT supplies position and Bina Marga supplies the stream, joined on
 * (road, KM). On Jakarta-Cikampek that join is 41 distinct markers and 100%
 * matched. The transform does the joining; this only fetches.
 *
 * **Liveness is measured on the body, never the status.** `jmlive.jasamarga.com`
 * answers HTTP 200 with **zero bytes** for a camera that is registered but not
 * publishing. A status-code pass scored 68%; checking for `#EXTM3U` gave a
 * different set entirely. This is the same shape as the `canPlayType` trap in
 * JAKAR-54 — a truthy answer that means nothing.
 */
const BPJT = 'https://bpjt.pu.go.id/cctv/',
    ROAD = 'https://binamarga.pu.go.id/contents/cctv_tol/?id_ruas=',
    INDEX = 'https://binamarga.pu.go.id/contents/cctv_tol',

    // Jabodetabek. Everything outside is a real camera on a real road that this
    // map has no network on, so it is not fetched rather than fetched and
    // dropped.
    BBOX = {lat: [-6.9, -5.9], lon: [106.3, 107.4]},

    CONCURRENCY = 12,
    PROBE_TIMEOUT_MS = 20000,
    USER_AGENT = 'jakarta-publictrans-3d/1.0 (open data map; contact via repo)';

/** Tolerant of the stray commas and blanks the BPJT table actually contains. */
function num(value) {
    const parsed = Number(String(value ?? '').trim().replace(/,$/, ''));

    return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

/**
 * The `allStreams` object out of the BPJT page.
 *
 * Reading it here rather than in the transform, because which road pages to
 * fetch is decided by which roads have cameras in the region — the same reason
 * the MRT adapter reads its station list before fetching schedules. The page
 * itself is still snapshotted verbatim.
 */
function bpjtStreams(html) {
    const match = /const allStreams\s*=\s*(\{[\s\S]*?\});/.exec(html);

    if (!match) {
        throw new Error('BPJT page carries no allStreams object — its format has changed');
    }
    return Object.values(JSON.parse(match[1])).flat();
}

function inRegion(camera) {
    const lat = num(camera.lat),
        lon = num(camera.lon);

    return lat !== null && lon !== null &&
        lat > BBOX.lat[0] && lat < BBOX.lat[1] &&
        lon > BBOX.lon[0] && lon < BBOX.lon[1];
}

/** Every m3u8 URL a Bina Marga road page carries. */
function streamsOnPage(html) {
    return [...new Set(
        [...html.matchAll(/https?:\/\/[^\s"'<>\\)]+?\.m3u8[^\s"'<>\\)]*/g)].map(m => m[0].trim())
    )];
}

/**
 * One probe, judged on content.
 *
 * `#EXTM3U` alone is not enough either — a manifest with no variants and no
 * segments is a camera that is registered and silent, which is exactly what the
 * empty 200 looks like once it does answer.
 */
async function probe(url) {
    try {
        const response = await fetch(url, {
                headers: {'User-Agent': USER_AGENT},
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
            }),
            body = response.ok ? (await response.text()).slice(0, 800) : '';

        if (!body.includes('#EXTM3U')) {
            return {url, status: response.status, live: false, why: response.ok ? 'empty' : 'http'};
        }
        if (!/EXTINF|\.ts|\.m4s|EXT-X-STREAM-INF/.test(body)) {
            return {url, status: response.status, live: false, why: 'no-segments'};
        }
        return {url, status: response.status, live: true};
    } catch (error) {
        return {url, status: 0, live: false, why: String(error.name || error.message).slice(0, 40)};
    }
}

async function probeAll(urls) {
    const results = new Array(urls.length);
    let next = 0;

    await Promise.all(Array.from({length: Math.min(CONCURRENCY, urls.length)}, async () => {
        while (next < urls.length) {
            const index = next++;

            results[index] = await probe(urls[index]);
        }
    }));
    return results;
}

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export default {
    id: 'cctv-tol',
    label: 'Toll road cameras (BPJT + Bina Marga)',
    interval: 250,

    async fetch(snap, log) {
        if (!snap.has('bpjt.html')) {
            await snap.write('bpjt.html', await snap.get(BPJT, {timeout: 120000}));
        }

        const cameras = bpjtStreams(await snap.read('bpjt.html')),
            regional = cameras.filter(inRegion),
            roads = [...new Set(regional.map(camera => camera.nama_ruas).filter(Boolean))].sort();

        log(`BPJT: ${cameras.length} cameras nationwide, ${regional.length} in region, ${roads.length} roads`);

        // The index page is what maps a road name to the slug its own page is
        // served under; guessing the slug from the name is close but not exact
        // ("JORR S", "Cinere - jagorawi").
        if (!snap.has('roads-index.html')) {
            await snap.write('roads-index.html', await snap.get(INDEX, {timeout: 60000}));
        }

        const slugs = [...new Set(
                [...(await snap.read('roads-index.html')).matchAll(/id_ruas=([a-z0-9-]+)/g)].map(m => m[1])
            )],
            wanted = new Map();

        // Road name to page slug, resolved once here and *written to the
        // snapshot*, because prefix matching between the two is ambiguous and
        // the transform must not have to guess again: "Jakarta-Cikampek" and
        // "Jakarta-Cikampek II Selatan" are different roads whose names and
        // slugs both agree on their first sixteen characters, and picking the
        // wrong one silently joins a camera to a different motorway. Exact
        // slug first, longest partial second, and only when it is unambiguous.
        for (const road of roads) {
            const key = slug(road),
                exact = slugs.find(s => s === key),
                partial = slugs
                    .filter(s => s.startsWith(key) || key.startsWith(s))
                    .sort((a, b) => b.length - a.length),
                found = exact ?? (partial.length === 1 ? partial[0] : null);

            if (found) {
                wanted.set(found, road);
            } else if (partial.length > 1) {
                log(`  ! ambiguous page for road "${road}": ${partial.join(', ')} — skipped`);
            } else {
                log(`  ! no Bina Marga page for road "${road}"`);
            }
        }

        // The mapping is the join key downstream, so it is data, not a log line.
        await snap.writeJson('roads.json', [...wanted].map(([id, road]) => ({id, road})));

        log(`fetching ${wanted.size} road pages`);
        for (const [id, road] of wanted) {
            try {
                await snap.getInto(`roads/${id}.html`, ROAD + id, {retries: 2, timeout: 90000});
            } catch (error) {
                log(`  ! ${road}: ${error.message.slice(0, 60)}`);
            }
        }

        // Everything worth probing: the live pages' URLs, plus BPJT's own for
        // the operators that never rotated theirs.
        const fromPages = new Set();

        for (const id of wanted.keys()) {
            if (snap.has(`roads/${id}.html`)) {
                for (const url of streamsOnPage(await snap.read(`roads/${id}.html`))) {
                    fromPages.add(url);
                }
            }
        }

        const fromBpjt = regional
                .map(camera => (camera.streamhls || '').trim())
                .filter(url => url.startsWith('http') && url.endsWith('.m3u8')),
            urls = [...new Set([...fromPages, ...fromBpjt])];

        log(`probing ${urls.length} streams (${fromPages.size} from road pages, ${new Set(fromBpjt).size} from BPJT)`);

        if (!snap.has('liveness.json')) {
            await snap.writeJson('liveness.json', await probeAll(urls));
        }

        const liveness = await snap.readJson('liveness.json'),
            live = liveness.filter(row => row.live).length;

        log(`live ${live} of ${liveness.length}`);

        return {
            counts: {
                nationwide: cameras.length, inRegion: regional.length,
                roads: roads.length, pages: wanted.size,
                probed: liveness.length, live
            },
            sources: [BPJT, INDEX, ROAD],
            notes: [
                'BPJT embeds allStreams in its page HTML; there is no API (/api/cctv, /cctv/api, ' +
                    '/api/v1/cctv and /cctv/data are 301 or 404).',
                'BPJT carries coordinates, KM marker, road and operator — the only source that geolocates ' +
                    'any toll camera. But its table has not been rewritten since 2026-05-11.',
                'Jasa Marga has rotated every stream id since then: zero of its BPJT URLs appear on the ' +
                    'Bina Marga pages, and they play 0/10 where Bina Marga plays 10/10. Jasa Marga is 61% of ' +
                    'the usable cameras, so the road pages are not optional.',
                'Bina Marga road pages carry current stream URLs and a KM label, and no coordinates. The ' +
                    'transform joins them to BPJT on (road, KM) — 100% matched on Jakarta-Cikampek.',
                'LIVENESS IS JUDGED ON THE BODY. jmlive.jasamarga.com answers HTTP 200 with zero bytes for a ' +
                    'camera that is not publishing; a status-code pass scored 68% and was measuring nothing.',
                'Known dead hosts: stream.bsdtol.com, and pub2.hk-opt.com is mostly dead.',
                'No video is stored — only that a camera exists, where, and that it was publishing.'
            ]
        };
    }
};
