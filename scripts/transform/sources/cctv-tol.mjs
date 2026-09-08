/**
 * Toll camera snapshot -> canonical cameras.
 *
 * BPJT says where every toll camera is; Bina Marga says which streams still
 * play. Resolving a camera is therefore two attempts in order:
 *
 * 1. **BPJT's own URL, if it is live.** True for 128 of 521 — every operator
 *    that has not rotated its stream ids since BPJT's table was written.
 * 2. **The (road, KM) join to a Bina Marga page.** Recovers a further 141,
 *    almost all of them Jasa Marga, which rotated every id and is 61% of the
 *    network. Without this step the biggest operator contributes nothing.
 *
 * What is left has no live stream anywhere and is dropped. Of the 269 that do
 * resolve, 143 survive the route-proximity filter below and ship.
 *
 * **The KM join only works where BPJT states a KM.** It leaves `nama_km` empty
 * on several roads — JORR S, Akses Tanjung Priok, Pondok Aren-Serpong — and
 * there the Bina Marga page's own KM labels have nothing to match against.
 * Those roads survive only through step 1. Joining them by card order instead
 * was considered and rejected: the two sources disagree on how many cameras a
 * road has, so an order join silently shifts every camera on the road to a
 * different kilometre, which is the failure this project has had twice.
 *
 * **Proximity is judged against route paths, not stops.** A motorway camera is
 * nowhere near a bus stop and that is not a fault in it — 64% lie within 150 m
 * of a path the fleet actually drives against 41% within 400 m of a stop, and
 * the services passing them are exactly the ones this is for: Royaltrans 112,
 * Transjabodetabek 109.
 *
 * **The report is the point of JAKAR-56.** This layer rests on a table that
 * stopped moving in May and a join that nothing was watching, so the counts it
 * returns are not decoration: `tableWritten` is when BPJT itself last wrote a
 * row, `byRoad` is the join rate road by road, and `validate.mjs` compares both
 * against the previous build. A source that answers with data that has stopped
 * changing is the one failure a snapshot date cannot see.
 */
const BBOX = {lat: [-6.9, -5.9], lon: [106.3, 107.4]},

    // How close a toll camera has to be to a path some vehicle actually runs
    // along. Generous compared with the walk table's 400 m because it is
    // answering a different question — not "can you walk there" but "does this
    // camera overlook a road our fleet uses".
    MAX_ROUTE_DISTANCE_M = 150,

    M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function metres(latA, lonA, latB, lonB) {
    return Math.hypot((latA - latB) * M_PER_DEG_LAT, (lonA - lonB) * M_PER_DEG_LON);
}

/** Tolerant of the stray commas and blanks the BPJT table actually contains. */
function num(value) {
    const parsed = Number(String(value ?? '').trim().replace(/,$/, ''));

    return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

/** `CIKAMPEK KM 04+500 | B` and `KM 04+500` alike, as a comparable key. */
function kmOf(text) {
    const match = /KM\s*(\d+)\s*\+\s*(\d+)/i.exec(text || '');

    return match ? `${Number(match[1])}+${match[2]}` : null;
}

/**
 * The day BPJT itself last wrote a row, from the rows rather than from the
 * fetch. Every record carries `updated_at`, and every one of the 1,530 says
 * 2026-05-11 — the page still answers daily, and nothing behind it has moved
 * since. `tgl_tarik` is the fallback because it is the other stamp the table
 * carries and they have never disagreed.
 */
function tableWritten(rows) {
    let newest = null;

    for (const row of rows) {
        const day = /^\d{4}-\d{2}-\d{2}/.exec(row.updated_at || row.tgl_tarik || '')?.[0];

        if (day && (newest === null || day > newest)) {
            newest = day;
        }
    }
    return newest;
}

function bpjtStreams(html) {
    const match = /const allStreams\s*=\s*(\{[\s\S]*?\});/.exec(html);

    if (!match) {
        throw new Error('BPJT page carries no allStreams object — its format has changed');
    }
    return Object.values(JSON.parse(match[1])).flat();
}

/**
 * A Bina Marga road page as (KM -> live stream URLs).
 *
 * One card is one camera: the KM label and the `<source>` live in the same
 * `card-cctv` block, and pairing them any other way — by document order across
 * the whole page, say — breaks as soon as a card has one and not the other, of
 * which there are 25 on Jakarta-Cikampek alone.
 */
function pageByKm(html, isLive) {
    const byKm = new Map(),
        cards = html.split('<div class="card-cctv">').slice(1);

    for (const card of cards) {
        const km = kmOf(card.replace(/<[^>]+>/g, ' ')),
            source = /<source\s+src="([^"]+)"/.exec(card);

        if (!km || !source) {
            continue;
        }

        const url = source[1].trim();

        if (!isLive(url)) {
            continue;
        }
        if (!byKm.has(km)) {
            byKm.set(km, []);
        }
        byKm.get(km).push(url);
    }
    return byKm;
}

/**
 * @param bpjtHtml  the BPJT index page
 * @param roads     [{id, road}] slug-to-name, resolved during ingest
 * @param pages     {slug: html} the Bina Marga road pages
 * @param liveness  [{url, live}] probed on body content, never status
 * @param shapes    canonical shapes, for the route-proximity filter
 * @param stops     canonical stops, so a card can still name the nearest one
 * @param now       the instant the table's age is measured against; injected so
 *                  a test can state a date instead of drifting with the clock
 */
export default function normaliseCctvTol({
    bpjtHtml, roads = [], pages = {}, liveness = [], shapes = [], stops = [],
    now = Date.now()
}) {
    const live = new Set(liveness.filter(row => row.live).map(row => row.url)),
        isLive = url => live.has(url),
        report = {
            nationwide: 0, inRegion: 0, direct: 0, joined: 0,
            noStream: 0, offNetwork: 0,
            // Resolution before the proximity filter. `direct`/`joined` count
            // what shipped, which moves when *our* route network changes;
            // these count whether the source still answers, which is the only
            // thing the freshness checks are entitled to judge it on. BORR
            // taught the difference: its join matched every camera and every
            // one was then dropped for being 35 km from any route we draw.
            matchedDirect: 0, matchedJoined: 0,
            tableWritten: null, tableAgeDays: null,
            // One row per road, so a road quietly falling to zero is visible.
            // A count over the whole network cannot show that: Jasa Marga is
            // 61% of it and would mask every other operator going dark.
            byRoad: []
        };

    // What happened to each camera, grouped by the road BPJT files it under.
    const roadStats = new Map(),
        statsFor = name => {
            const key = name || '(unnamed)';

            if (!roadStats.has(key)) {
                roadStats.set(key, {
                    road: key, inRegion: 0, direct: 0, joined: 0,
                    matchedDirect: 0, matchedJoined: 0,
                    noStream: 0, offNetwork: 0, statesKm: 0,
                    hasPage: false, pageStreams: 0, pageUnused: 0
                });
            }
            return roadStats.get(key);
        };

    // road name -> its page, keyed by KM
    const byRoad = new Map();

    for (const {id, road} of roads) {
        if (pages[id]) {
            byRoad.set(road, pageByKm(pages[id], isLive));
            statsFor(road).hasPage = true;
        }
    }

    // A coarse grid over every shape vertex. Cheaper than projecting onto
    // segments and precise enough for a 150 m question.
    const cell = 0.01,
        grid = new Map();

    for (const shape of shapes) {
        const coords = shape.coords;

        for (let i = 0; i < coords.length; i += 2) {
            const lon = coords[i],
                lat = coords[i + 1],
                key = `${Math.floor(lat / cell)},${Math.floor(lon / cell)}`;

            if (!grid.has(key)) {
                grid.set(key, []);
            }
            grid.get(key).push([lat, lon]);
        }
    }

    function distanceToNetwork(lat, lon) {
        const y = Math.floor(lat / cell),
            x = Math.floor(lon / cell);
        let best = Infinity;

        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                for (const [py, px] of grid.get(`${y + dy},${x + dx}`) ?? []) {
                    best = Math.min(best, metres(lat, lon, py, px));
                }
            }
        }
        return best;
    }

    function nearestStop(lat, lon) {
        let nearest = null,
            best = Infinity;

        for (const stop of stops) {
            const distance = metres(lat, lon, stop.lat, stop.lon);

            if (distance < best) {
                best = distance;
                nearest = stop;
            }
        }
        return {nearest, distance: best};
    }

    const all = bpjtStreams(bpjtHtml),
        cameras = [],
        taken = new Set();

    report.nationwide = all.length;
    report.tableWritten = tableWritten(all);
    report.tableAgeDays = report.tableWritten === null ? null :
        Math.floor((now - Date.parse(`${report.tableWritten}T00:00:00Z`)) / 86400000);

    for (const entry of all) {
        const lat = num(entry.lat),
            lon = num(entry.lon);

        if (lat === null || lon === null ||
            !(lat > BBOX.lat[0] && lat < BBOX.lat[1]) ||
            !(lon > BBOX.lon[0] && lon < BBOX.lon[1])) {
            continue;
        }
        report.inRegion++;

        const stats = statsFor(entry.nama_ruas);

        stats.inRegion++;
        if (kmOf(entry.nama_km)) {
            // Recorded because a road that joins nothing *and* states no KM is
            // a known limitation, while one that states a KM and still joins
            // nothing has had its label format change underneath the join.
            stats.statesKm++;
        }

        // ---- resolve a stream -------------------------------------------
        const own = (entry.streamhls || '').trim();
        let url = null,
            via = null;

        if (own.startsWith('https://') && isLive(own)) {
            url = own;
            via = 'direct';
        } else {
            const km = kmOf(entry.nama_km),
                candidates = km ? byRoad.get(entry.nama_ruas)?.get(km) ?? [] : [],
                // Two cameras at one kilometre are the two carriageways. Which
                // is which cannot be known from either source, so they are
                // handed out in order and never reused — better two cameras a
                // few metres apart than the same stream shown twice.
                free = candidates.find(candidate => !taken.has(candidate));

            if (free) {
                url = free;
                via = 'joined';
                taken.add(free);
            }
        }

        if (!url) {
            report.noStream++;
            stats.noStream++;
            continue;
        }

        const matched = via === 'direct' ? 'matchedDirect' : 'matchedJoined';

        report[matched]++;
        stats[matched]++;

        if (distanceToNetwork(lat, lon) > MAX_ROUTE_DISTANCE_M) {
            report.offNetwork++;
            stats.offNetwork++;
            continue;
        }

        report[via]++;
        stats[via]++;

        const {nearest, distance} = nearestStop(lat, lon),
            km = kmOf(entry.nama_km) ??
                kmOf([...(byRoad.get(entry.nama_ruas)?.entries() ?? [])]
                    .find(([, urls]) => urls.includes(url))?.[0] ?? ''),
            label = km ? `KM ${km}` : (entry.nama_segment || '').trim();

        cameras.push({
            id: `tol-${entry.camera_id || entry.id}`,
            name: [entry.nama_ruas, label].filter(Boolean).join(' '),
            lat,
            lon,
            stream: url,
            kind: 'toll',

            // BPJT publishes these coordinates; they are not inferred.
            precision: 'exact',
            road: entry.nama_ruas || null,
            km,

            // Recorded even when it is far: the card says what the camera is
            // near, and "2 km from anything" is a true and useful answer.
            stop: nearest?.id ?? null,
            distance: nearest ? Math.round(distance) : null
        });
    }

    // How much of Bina Marga's own material went unclaimed. This is the other
    // half of the diagnostic: a road where BPJT states a KM and Bina Marga is
    // publishing, and nothing matched, has had a label format change under the
    // join. A join rate alone cannot distinguish that from a road where Bina
    // Marga simply has nothing live to offer.
    //
    // Counted over *distinct* urls, because Bina Marga repeats one card per
    // carriageway and both cards can carry the same stream — BORR lists eight
    // cards over six streams. Counting cards would say a road publishes more
    // than it does, and would leave a camera looking unmatched when there was
    // never a second picture for it to match.
    for (const [road, byKm] of byRoad) {
        const stats = statsFor(road),
            urls = new Set();

        for (const list of byKm.values()) {
            for (const url of list) {
                urls.add(url);
            }
        }
        stats.pageStreams = urls.size;
        stats.pageUnused = [...urls].filter(url => !taken.has(url)).length;
    }

    report.byRoad = [...roadStats.values()]
        .sort((a, b) => (b.direct + b.joined) - (a.direct + a.joined) || a.road.localeCompare(b.road));

    return {cameras, report};
}
