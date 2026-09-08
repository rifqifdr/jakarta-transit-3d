/**
 * The canonical multi-modal model.
 *
 * Everything the pipeline produces is expressed in these shapes, whatever the
 * source said. Six upstreams disagree about almost everything — one gives
 * trip identity, three give departure boards, one gives a zip of CSVs, and
 * none gives a coordinate — so the value here is in what they are forced to
 * agree on.
 *
 * The load-bearing decision is that `mode` is a field on a route, not
 * something derived from its operator. KAI Commuter alone runs Jabodetabek
 * commuter rail, the airport line, and services around Yogyakarta and Solo;
 * agency cannot tell you what kind of vehicle turns up. The layer filters in
 * the UI are Transjakarta's own product categories (BRT, Mikrotrans,
 * Royaltrans), which is a level *below* this — category stays, mode sits
 * above it.
 */

export const SCHEMA_VERSION = 1;

// Mode is a closed set on purpose. A new one should be a deliberate edit
// here, not something a normaliser invents by writing a novel string.
export const MODES = {
    bus: {id: 'bus', label: 'Bus', labelId: 'Bus', gtfsRouteType: 3},
    metro: {id: 'metro', label: 'MRT', labelId: 'MRT', gtfsRouteType: 1},
    lightRail: {id: 'light_rail', label: 'LRT', labelId: 'LRT', gtfsRouteType: 0},
    commuterRail: {id: 'commuter_rail', label: 'Commuter Line', labelId: 'Commuter Line', gtfsRouteType: 2},
    airportRail: {id: 'airport_rail', label: 'Airport Rail', labelId: 'Kereta Bandara', gtfsRouteType: 2}
};

export const MODE_IDS = new Set(Object.values(MODES).map(m => m.id));

// Service days, kept as the feed's own ids so nothing is lost in translation.
export const DAY_TYPES = ['weekday', 'saturday', 'sunday', 'holiday'];

/**
 * A dataset is a plain object rather than a class: it has to be serialisable,
 * comparable and hashable, and every stage either adds to it or reads it.
 */
export function emptyDataset() {
    return {
        schemaVersion: SCHEMA_VERSION,
        modes: Object.values(MODES),
        agencies: [],
        routes: [],
        stations: [],
        stops: [],
        patterns: [],
        trips: [],
        shapes: [],
        transfers: [],
        cameras: [],
        calendar: {},
        fares: {attributes: {}, byRoute: {}},

        // Which snapshot each part came from, and how old it was. This is the
        // check that Comuline would have failed: its API still answered, but
        // the data behind it had not moved in seventeen months.
        provenance: {}
    };
}

// ---------------------------------------------------------------------------
// Entity constructors
//
// These exist to make a missing field a loud failure at the point it is
// omitted, rather than an undefined that surfaces three stages later as a
// vehicle at latitude null.
// ---------------------------------------------------------------------------

function require_(value, field, where) {
    if (value === undefined || value === null || value === '') {
        throw new Error(`${where}: missing required field "${field}"`);
    }
    return value;
}

export function agency({id, name, url = null, timezone = 'Asia/Jakarta'}) {
    return {
        id: require_(id, 'id', 'agency'),
        name: require_(name, 'name', 'agency'),
        url,
        timezone
    };
}

export function route({id, mode, agency: agencyId, shortName = '', longName = '', category = null, color = null, textColor = null}) {
    if (!MODE_IDS.has(mode)) {
        throw new Error(`route ${id}: unknown mode "${mode}" (expected one of ${[...MODE_IDS].join(', ')})`);
    }
    return {
        id: require_(id, 'id', 'route'),
        mode,
        agency: require_(agencyId, 'agency', `route ${id}`),
        shortName,
        longName,

        // Operator product name — "BRT", "Mikrotrans", "Commuter Line Bogor".
        // Below mode, never a substitute for it.
        category,
        color,
        textColor
    };
}

export function station({id, name, lat, lon, modes = []}) {
    return {
        id: require_(id, 'id', 'station'),
        name: require_(name, 'name', `station ${id}`),
        lat: coordinate(lat, 'lat', `station ${id}`),
        lon: coordinate(lon, 'lon', `station ${id}`),
        modes: [...new Set(modes)].sort()
    };
}

export function stop({id, name, lat, lon, station: stationId = null, modes = [], accessible = false, platform = null}) {
    return {
        id: require_(id, 'id', 'stop'),
        name: require_(name, 'name', `stop ${id}`),
        lat: coordinate(lat, 'lat', `stop ${id}`),
        lon: coordinate(lon, 'lon', `stop ${id}`),

        // Stations are containers: stop_times reference platforms, which point
        // at the station. Anything asking "what serves this stop?" has to fold
        // platforms in — true of the GTFS feed and of OSM alike, which returns
        // separate stop and platform nodes for the same station.
        station: stationId,
        modes: [...new Set(modes)].sort(),
        accessible,
        platform
    };
}

export function pattern({id, route: routeId, mode, stops, shape = null, headsign = null, direction = 0, inferred = false}) {
    if (!Array.isArray(stops) || stops.length < 2) {
        throw new Error(`pattern ${id}: needs at least two stops, got ${stops?.length ?? 0}`);
    }
    return {
        id: require_(id, 'id', 'pattern'),
        route: require_(routeId, 'route', `pattern ${id}`),
        mode,
        stops,
        shape,
        headsign,
        direction,

        // Whether the trips on this pattern were reconstructed from station
        // departure boards rather than read from the source. KRL gives trip
        // identity outright; MRT and LRT do not, and only inferred patterns can
        // be wrong about which branch or short working a vehicle is on.
        inferred
    };
}

/**
 * A trip is either scheduled (explicit seconds at each stop) or frequency
 * based (a headway window). The bus feed has no departure rows at all — they
 * are computed from frequencies.txt — while KRL hands over exact times, so
 * the model has to carry both without pretending one is the other.
 */
export function trip({id, route: routeId, pattern: patternId, service, times = null, frequency = null}) {
    if (!times && !frequency) {
        throw new Error(`trip ${id}: needs either times or frequency`);
    }
    if (times && frequency) {
        throw new Error(`trip ${id}: has both times and frequency — pick one`);
    }
    return {
        id: require_(id, 'id', 'trip'),
        route: require_(routeId, 'route', `trip ${id}`),
        pattern: require_(patternId, 'pattern', `trip ${id}`),
        service: require_(service, 'service', `trip ${id}`),

        // Seconds from midnight of the service day, and deliberately allowed
        // past 86400: a last train at 24:44 is 00:44 tomorrow and belongs to
        // today's service. Wrapping it silently once made a 24-hour route
        // look 28 minutes long.
        times,
        frequency
    };
}

/**
 * A public CCTV camera, as a point on the network.
 *
 * Cameras are not part of the timetable and nothing routes through them — this
 * is the one entity here that describes the real world rather than the
 * schedule. It carries the stream path rather than a full URL because the host
 * is the same for all of them and belongs in one place.
 */
/**
 * A public camera, as a point on the network.
 *
 * Cameras are not part of the timetable and nothing routes through them — this
 * is the one entity here that describes the real world rather than the
 * schedule.
 *
 * `stream` is a full URL rather than a path under a shared host, because the
 * toll cameras come from thirty-odd operators on as many hosts and there is no
 * host to share. The street cameras' URLs are assembled where they are
 * normalised instead, which keeps one definition of what a camera's stream is.
 */
export function camera({
    id, name, lat, lon, stream, preview = null, kind = 'street', precision = 'exact',
    stop: stopId = null, distance = null, channel = null, road = null, km = null
}) {
    if (kind !== 'street' && kind !== 'toll') {
        throw new Error(`camera ${id}: kind must be "street" or "toll", got "${kind}"`);
    }
    if (precision !== 'exact' && precision !== 'estimated') {
        throw new Error(`camera ${id}: precision must be "exact" or "estimated", got "${precision}"`);
    }
    if (!/^https:\/\/[^\s"'<>]+$/.test(String(stream ?? ''))) {
        throw new Error(`camera ${id}: stream must be an https URL, got "${stream}"`);
    }
    return {
        id: require_(id, 'id', 'camera'),
        name: require_(name, 'name', `camera ${id}`),
        lat: coordinate(lat, 'lat', `camera ${id}`),
        lon: coordinate(lon, 'lon', `camera ${id}`),
        stream,

        // A still to show before the stream starts. Flussonic serves one per
        // camera; the toll operators do not, so this is often null.
        preview,

        // Street cameras are validated against the stop they sit by; toll
        // cameras against the route path they overlook, because a motorway
        // camera is nowhere near a stop and that is not a fault in it.
        kind,

        // Whether the position was published or inferred from a street name.
        precision,

        // Which camera on a shared pole. Several channels legitimately sit at
        // one position, and the card offers them rather than stacking pins.
        channel,

        // Toll only: the road and kilometre marker, which is how a driver and
        // both upstream sources refer to the place.
        road,
        km,

        // Nearest stop and how far, so a card can say what the camera watches
        // rather than only where it stands.
        stop: stopId,
        distance
    };
}

export function shape({id, coords}) {
    if (!Array.isArray(coords) || coords.length < 4 || coords.length % 2) {
        throw new Error(`shape ${id}: expected a flat [lon, lat, …] array of at least two points`);
    }
    return {id: require_(id, 'id', 'shape'), coords};
}

export function transfer({from, to, seconds, kind = 'walk'}) {
    return {
        from: require_(from, 'from', 'transfer'),
        to: require_(to, 'to', 'transfer'),
        seconds: require_(seconds, 'seconds', `transfer ${from}->${to}`),
        kind
    };
}

// Jakarta sits at roughly -6.1 to -6.6, 106.3 to 107.1. A coordinate outside
// the region is far more likely to be a parsing slip than a real place, and
// null island is the classic one.
function coordinate(value, field, where) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        throw new Error(`${where}: ${field} is not a number (${value})`);
    }
    if (number === 0) {
        throw new Error(`${where}: ${field} is exactly 0 — almost certainly a missing value, not a location`);
    }
    return number;
}

// ---------------------------------------------------------------------------
// Determinism
//
// Artifacts are content-hashed downstream, so identical snapshots must produce
// identical bytes. Anything derived from a Map or a Set has an insertion order
// that depends on the order the source happened to be read in, which is not
// stable enough to hash.
// ---------------------------------------------------------------------------

export function sortDataset(dataset) {
    const byId = (a, b) => String(a.id).localeCompare(String(b.id));

    dataset.agencies.sort(byId);
    dataset.routes.sort(byId);
    dataset.stations.sort(byId);
    dataset.stops.sort(byId);
    dataset.patterns.sort(byId);
    dataset.trips.sort(byId);
    dataset.shapes.sort(byId);
    dataset.cameras.sort(byId);
    dataset.transfers.sort((a, b) =>
        String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)));
    return dataset;
}

// Stable JSON: object keys in sorted order at every level, so the hash
// describes the content and not the order the keys were assigned.
export function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}
