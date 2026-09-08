/**
 * CCTV snapshot -> canonical cameras.
 *
 * Two sets of cameras arrive by two different routes, and the difference
 * between them is carried all the way to the UI rather than smoothed over.
 *
 * **The geolocated set.** A coordinate table naming every camera DKI ever
 * published, reconciled against a liveness probe by stream name. Positions are
 * exact; roughly a third of the streams still answer.
 *
 * **The portal set.** The cameras on `dki-jkt.balitower.co.id` — Thamrin, Gatot
 * Subroto, S. Parman, Gerbang Pemuda, all on Transjakarta corridors and nearly
 * all live. Nothing geolocates them at all. What they do carry is the street,
 * in the stream id itself, so the position is recovered from the street:
 * `data/camera-places.json` names an OpenStreetMap feature per site and the
 * camera is placed on it.
 *
 * Those positions are **estimates and are marked `precision: 'estimated'`**, so
 * the card can say so. Half a street is a real error — which end of Gatot
 * Subroto camera C11 sits on is not knowable from its name — and the honest
 * move is to show the camera and admit the position rather than to withhold a
 * working camera or to imply a precision that is not there. Correcting one is a
 * one-line edit in `camera-places.json`.
 *
 * Cameras far from the network are dropped either way. This is a transit map,
 * and a camera watching a street with nothing to catch on it is noise on a
 * layer whose whole claim is that it shows you the network. The radius is the
 * same 400 m the walk table uses.
 */
const HOST = 'https://cctv-jsc.balitower.co.id:8011',
    PORTAL_HOST = 'https://dki-jkt.balitower.co.id:7028',

    MAX_STOP_DISTANCE_M = 400,

    // Jakarta's envelope. A handful of rows in the coordinate table have their
    // latitude and longitude the wrong way round, which puts them off the coast
    // of Somalia; they are dropped rather than corrected, because a row that is
    // wrong about which field is which may be wrong about more.
    LAT_RANGE = [-6.75, -5.85],
    LON_RANGE = [106.35, 107.30],

    M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function metres(latA, lonA, latB, lonB) {
    return Math.hypot((latA - latB) * M_PER_DEG_LAT, (lonA - lonB) * M_PER_DEG_LON);
}

/**
 * A stream name from the geolocated set, as a person would read it.
 *
 * `Bendungan-Hilir-003-700014_1` is a place, a camera number, a device id and a
 * channel. Only the first two mean anything to a viewer.
 */
function humanise(stream) {
    return stream
        .replace(/_\d+$/, '')          // channel
        .replace(/-\d{5,}$/, '')       // device id
        .replace(/-MP$/, '')           // device family, not part of the place
        .replace(/-/g, ' ')
        .trim();
}

// Tokens that are acronyms rather than words, and look wrong title-cased.
const ACRONYMS = new Set(['JL', 'JPO', 'KH', 'MH', 'RE', 'UOB', 'TNI', 'AL', 'DKI', 'RS']);

/**
 * A portal site token as a person would read it.
 *
 * `SIMPANG-JL.-LETJEN.-S.-PARMAN-C07` is shouted, hyphenated and abbreviated.
 * Title casing it wholesale produces "Jl. Mh. Thamrin", so the short all-caps
 * tokens that are genuinely acronyms are kept as they are.
 */
function humanisePortal(place) {
    return place.split('-').map(word => {
        const bare = word.replace(/\.$/, '');

        if (ACRONYMS.has(bare) || /^C?\d+$/.test(bare) || bare.length === 1) {
            return word;
        }
        return word.charAt(0) + word.slice(1).toLowerCase();
    }).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Every vertex of the OSM features carrying one name, ordered along the street.
 *
 * Ordering is by whichever axis the feature spans furthest, which is enough to
 * spread points along a road without stitching its ways into a path. Stitching
 * would be the wrong tool here: a major Jakarta road is mapped as two
 * carriageways plus service roads, and concatenating those produces the
 * out-and-back that cost this project a day on the rail relations. Sorting by
 * position cannot produce that failure — the worst it does is interleave the
 * two carriageways, which for an estimate is no error at all.
 */
function pointsAlong(elements, name) {
    const points = [];

    for (const element of elements) {
        if (element.tags?.name !== name) {
            continue;
        }
        // Three shapes, because Overpass answers in three: a way with
        // `out geom` carries its vertices, a way or relation with `out center`
        // carries a centre, and a plain node carries its own coordinates. Taman
        // Literasi is a node, and handling only the first two silently lost it.
        for (const point of element.geometry ?? []) {
            points.push([point.lat, point.lon]);
        }
        if (!element.geometry) {
            if (element.center) {
                points.push([element.center.lat, element.center.lon]);
            } else if (element.lat !== undefined && element.lon !== undefined) {
                points.push([element.lat, element.lon]);
            }
        }
    }

    if (points.length < 2) {
        return points;
    }

    const lats = points.map(p => p[0]),
        lons = points.map(p => p[1]),
        spanLat = Math.max(...lats) - Math.min(...lats),
        spanLon = Math.max(...lons) - Math.min(...lons),
        axis = spanLat >= spanLon ? 0 : 1;

    return points.sort((a, b) => a[axis] - b[axis]);
}

/** `501844_JKP_DISHUB_JL.-MH.-THAMRIN-C01_CCTV-01` into its parts. */
function parsePortalStream(stream) {
    const match = /^(\d+)_(JK[PSBTU])_([A-Z-]+)_(.+)_CCTV-(\d+)$/.exec(stream);

    return match && {
        device: match[1],
        kota: match[2],
        agency: match[3],
        place: match[4],
        channel: match[5]
    };
}

function nearestStop(lat, lon, stops) {
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

/**
 * @param coordinates    raw text of the coordinate mirror
 * @param liveness       [{stream, status}] for the geolocated set
 * @param portalHtml     the portal page, or null when it did not answer
 * @param portalLiveness [{stream, status}] for the portal set
 * @param streets        the Overpass response placing the portal cameras
 * @param places         data/camera-places.json
 * @param stops          canonical stops, for the proximity filter
 */
export default function normaliseCctv({
    coordinates, liveness, portalHtml = null, portalLiveness = [],
    streets = null, places = {}, stops
}) {
    const cameras = [],
        report = {
            listed: 0, live: 0, offNetwork: 0, badCoords: 0,
            portalLive: 0, portalPlaced: 0, portalUnmapped: [], portalOffNetwork: 0
        };

    // ---- the geolocated set ------------------------------------------------
    const live = new Set(liveness.filter(row => row.status === 200).map(row => row.stream)),
        seen = new Set();

    for (const match of coordinates.matchAll(/"url":"(.*?)".*?"latitude":(-?[\d.]+),"longitude":(-?[\d.]+)/g)) {
        const url = match[1].replace(/\\\//g, '/'),
            stream = /\/\/[^/]+\/([^/]+)\/embed/.exec(url)?.[1],
            lat = Number(match[2]),
            lon = Number(match[3]);

        if (!stream || seen.has(stream)) {
            continue;
        }
        seen.add(stream);
        report.listed++;

        if (!live.has(stream)) {
            continue;
        }
        report.live++;

        if (!(lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1]) ||
            !(lon >= LON_RANGE[0] && lon <= LON_RANGE[1])) {
            report.badCoords++;
            continue;
        }

        const {nearest, distance} = nearestStop(lat, lon, stops);

        if (!nearest || distance > MAX_STOP_DISTANCE_M) {
            report.offNetwork++;
            continue;
        }

        cameras.push({
            id: `cctv-${stream}`,
            name: humanise(stream),
            lat,
            lon,
            stream: `${HOST}/${stream}/index.m3u8`,
            preview: `${HOST}/${stream}/preview.jpg`,
            kind: 'street',
            precision: 'exact',
            stop: nearest.id,
            distance: Math.round(distance)
        });
    }

    // ---- the portal set ----------------------------------------------------
    if (portalHtml) {
        const portalLive = new Set(
                portalLiveness.filter(row => row.status === 200).map(row => row.stream)
            ),
            portalStreams = [...new Set(
                [...portalHtml.matchAll(/dki-jkt\.balitower\.co\.id:7028\/([^"'/\s]+)/g)].map(m => m[1])
            )].sort(),
            elements = streets?.elements ?? [],

            // Group by site first: the channels of one device are cameras on
            // one pole and genuinely share a position, so they must not be
            // spread apart from each other.
            bySite = new Map();

        for (const stream of portalStreams) {
            const parsed = parsePortalStream(stream);

            if (!parsed || !portalLive.has(stream)) {
                continue;
            }
            report.portalLive++;
            if (!bySite.has(parsed.place)) {
                bySite.set(parsed.place, {...parsed, streams: []});
            }
            bySite.get(parsed.place).streams.push(stream);
        }

        // Sites sharing a street are spread evenly along it, in site order, so
        // three cameras on Gatot Subroto land at three different places on
        // Gatot Subroto rather than in one heap at its midpoint.
        const byStreet = new Map();

        for (const [place, site] of [...bySite].sort((a, b) => a[0].localeCompare(b[0]))) {
            const entry = places[place];

            if (!entry) {
                report.portalUnmapped.push(place);
                continue;
            }
            site.entry = entry;
            if (entry.street) {
                if (!byStreet.has(entry.street)) {
                    byStreet.set(entry.street, []);
                }
                byStreet.get(entry.street).push(site);
            }
        }

        for (const site of bySite.values()) {
            const entry = site.entry;

            if (!entry) {
                continue;
            }

            let lat = entry.lat,
                lon = entry.lon;

            if (lat === undefined || lon === undefined) {
                const points = pointsAlong(elements, entry.street);

                if (!points.length) {
                    report.portalUnmapped.push(`${site.place} (no OSM geometry for "${entry.street}")`);
                    continue;
                }

                const peers = byStreet.get(entry.street) ?? [site],
                    index = peers.indexOf(site),
                    // `along` overrides the automatic spread for a site that
                    // has been checked by hand.
                    fraction = entry.along ?? (index + 1) / (peers.length + 1),
                    chosen = points[Math.min(points.length - 1,
                        Math.floor(fraction * points.length))];

                [lat, lon] = chosen;
            }

            const {nearest, distance} = nearestStop(lat, lon, stops);

            if (!nearest || distance > MAX_STOP_DISTANCE_M) {
                report.portalOffNetwork++;
                continue;
            }

            for (const stream of site.streams) {
                const {channel} = parsePortalStream(stream);

                cameras.push({
                    id: `cctv-${stream}`,
                    name: humanisePortal(site.place),
                    lat,
                    lon,
                    stream: `${PORTAL_HOST}/${stream}/index.m3u8`,
                    preview: `${PORTAL_HOST}/${stream}/preview.jpg`,
                    kind: 'street',

                    // The whole reason this field exists. These positions come
                    // from a street name, not from a survey.
                    precision: 'estimated',
                    stop: nearest.id,
                    distance: Math.round(distance),

                    // Several cameras genuinely share this pole, so the card can
                    // offer them rather than stacking three pins on one point.
                    channel: Number(channel)
                });
                report.portalPlaced++;
            }
        }
    }

    return {cameras, report};
}
