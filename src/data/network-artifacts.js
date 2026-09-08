/**
 * Builds the bundle `Network` expects, out of the artifact set.
 *
 * Deliberately an adapter rather than a rewrite. `Network`'s constructor
 * already derives the things the simulation actually runs on — cumulative
 * distance along every shape, Mercator coordinates, acceleration fractions,
 * stop indexes — and all of that is tested by the 78 routing checks. Handing it
 * the same shape of input keeps that code in play instead of reimplementing it
 * against a deadline.
 *
 * So this reads manifest, core, patterns, walk, and every enabled mode's shapes
 * and trips, and returns exactly what `new Network(meta, shapeBuffer, lines)`
 * wants.
 */
import ArtifactLoader from './artifact-loader';

const COORD_SCALE = 1e6;

/**
 * @param base    where the artifacts are served from
 * @param modes   which modes to load; omitted means all of them
 */
export async function loadArtifactBundle(base = 'artifacts/', {modes = null, onProgress = () => {}} = {}) {
    const loader = new ArtifactLoader(base),
        core = await loader.loadCore(onProgress),
        manifest = loader.manifest,
        wanted = modes ?? Object.keys(manifest.modes);

    for (const mode of wanted) {
        await loader.loadMode(mode, onProgress);
    }

    onProgress('Menyiapkan geometri rute…');

    // ---- shapes: one global array, in the order core.patterns indexes them --
    const shapeCount = Object.values(manifest.modes)
            .reduce((total, mode) => Math.max(total, ...mode.shapeIds.map(id => id + 1)), 0),
        shapeCoords = new Array(shapeCount).fill(null);

    for (const mode of wanted) {
        const loaded = loader.modes.get(mode),
            {starts, coords} = loaded.shapes;

        loaded.shapeIds.forEach((globalIndex, i) => {
            shapeCoords[globalIndex] = coords.subarray(starts[i] * 2, starts[i + 1] * 2);
        });
    }

    // Re-encoded as deltas because that is the format Network decodes, and
    // reusing its decoder keeps one definition of what a shape is.
    let vertices = 0;

    for (const coords of shapeCoords) {
        vertices += coords ? coords.length / 2 : 0;
    }

    const deltas = new Int32Array(vertices * 2),
        shapes = [];
    let cursor = 0,
        previousLon = 0,
        previousLat = 0,
        start = 0;

    shapeCoords.forEach((coords, index) => {
        if (!coords) {
            shapes.push({id: `s${index}`, start, count: 0});
            return;
        }
        for (let i = 0; i < coords.length; i += 2) {
            const lon = Math.round(coords[i] * COORD_SCALE),
                lat = Math.round(coords[i + 1] * COORD_SCALE);

            deltas[cursor++] = lon - previousLon;
            deltas[cursor++] = lat - previousLat;
            previousLon = lon;
            previousLat = lat;
        }
        shapes.push({id: `s${index}`, start, count: coords.length / 2});
        start += coords.length / 2;
    });

    // ---- stops -------------------------------------------------------------
    const stopIds = core.stops.id,
        stops = stopIds.map((id, i) => ({
            i: id,
            n: core.stops.name[i],
            y: core.stops.lat[i] / COORD_SCALE,
            x: core.stops.lon[i] / COORD_SCALE,
            s: core.stops.station[i] === i ? 1 : 0,
            a: 0,
            p: core.stops.station[i] >= 0 && core.stops.station[i] !== i
                ? stopIds[core.stops.station[i]]
                : null
        }));

    // ---- patterns ----------------------------------------------------------
    const patterns = decodePatterns(loader.patternsBuffer, core.patterns.length);

    // ---- trips -------------------------------------------------------------
    const trips = [];

    for (const mode of wanted) {
        const loaded = loader.modes.get(mode);

        for (const [service, decoded] of Object.entries(loaded.services)) {
            const kind = manifest.modes[mode].services[service].kind;

            for (let i = 0; i < decoded.count; i++) {
                const patternIndex = decoded.patterns[i],
                    meta = core.patterns[patternIndex],
                    p = patterns[patternIndex];

                if (!p || p.stops.length < 2) {
                    continue;
                }

                const stopList = Array.from(p.stops, index => stopIds[index]),
                    // Offsets ship in metres; Network divides by 1000 itself.
                    offsets = Array.from(p.distances);

                let arrivals,
                    departures,
                    windows;

                if (kind === 'frequency') {
                    // Seconds from the pattern's own first call, identical for
                    // every trip that runs it.
                    arrivals = Array.from(p.times);
                    departures = arrivals;
                    windows = decoded.windows[i];
                } else {
                    // A scheduled trip is one run. Its shape is the same — an
                    // offset table plus a start — so it is expressed as a
                    // single-departure window rather than a second concept.
                    const times = decoded.times.subarray(decoded.offsets[i], decoded.offsets[i + 1]),
                        first = times[0];

                    arrivals = Array.from(times, t => t - first);
                    departures = arrivals;
                    windows = [[first, first + 1, 1]];
                }

                trips.push({
                    id: `${mode}-${service}-${i}`,
                    route: meta.route,
                    service,
                    shape: `s${meta.shape}`,
                    headsign: meta.headsign,
                    direction: meta.direction,
                    stops: stopList,
                    offsets,
                    arrivals,
                    departures,
                    windows
                });
            }
        }
    }

    // ---- walk table, as the CSR Network expects -----------------------------
    const walk = buildWalkCsr(loader.walkEdges, stopIds);

    // ---- display lines ------------------------------------------------------
    const lines = {
        type: 'FeatureCollection',
        features: shapeCoords.map((coords, index) => {
            if (!coords || coords.length < 4) {
                return null;
            }

            const route = core.patterns.find(p => p.shape === index)?.route,
                definition = core.routes.find(r => r.id === route);

            return {
                type: 'Feature',
                properties: {
                    route,
                    category: definition?.category ?? null,
                    mode: definition?.mode ?? null,
                    color: definition?.color ?? '#888888'
                },
                geometry: {
                    type: 'LineString',
                    coordinates: Array.from(
                        {length: coords.length / 2},
                        (_, i) => [coords[i * 2], coords[i * 2 + 1]]
                    )
                }
            };
        }).filter(Boolean)
    };

    const meta = {
        agency: core.agencies[0]?.name ?? 'Jakarta Transit',
        timezone: core.agencies[0]?.timezone ?? 'Asia/Jakarta',
        coordScale: COORD_SCALE,
        calendar: Object.fromEntries(Object.entries(core.calendar).map(([id, days]) => [id, {
            id,
            days: [days.sunday, days.monday, days.tuesday, days.wednesday,
                days.thursday, days.friday, days.saturday].map(Number)
        }])),
        categories: [...new Set(core.routes.map(r => r.category).filter(Boolean))].sort(),
        routes: core.routes,
        fares: core.fares,
        transfers: {},
        stops,
        walk,
        shapes,
        trips
    };

    return {meta, shapeBuffer: deltas.buffer, lines, manifest, loader};
}

/**
 * patterns.bin: uint32 count, then per pattern uint16 stop count, stop indices,
 * time offsets in seconds, and distances along the shape in metres.
 */
function decodePatterns(buffer, expected) {
    const view = new DataView(buffer),
        patterns = [],
        count = view.getUint32(0, true);

    let offset = 4;

    for (let i = 0; i < count; i++) {
        const stops = view.getUint16(offset, true);

        offset += 2;

        const stopIndices = new Uint16Array(stops),
            times = new Uint16Array(stops),
            distances = new Uint32Array(stops);

        for (let k = 0; k < stops; k++) {
            stopIndices[k] = view.getUint16(offset, true);
            offset += 2;
        }
        for (let k = 0; k < stops; k++) {
            times[k] = view.getUint16(offset, true);
            offset += 2;
        }
        for (let k = 0; k < stops; k++) {
            distances[k] = view.getUint32(offset, true);
            offset += 4;
        }
        patterns.push({stops: stopIndices, times, distances});
    }

    if (patterns.length !== expected) {
        throw new Error(`patterns.bin holds ${patterns.length} patterns, core.json expects ${expected}`);
    }
    return patterns;
}

/**
 * The walk table ships as symmetric pairs; the router wants an adjacency list.
 * Building it here rather than at build time keeps the artifact stable when a
 * stop is added.
 */
function buildWalkCsr(edges, stopIds) {
    const degree = new Uint32Array(stopIds.length);

    for (const [from, to] of edges) {
        degree[from]++;
        degree[to]++;
    }

    const offsets = new Uint32Array(stopIds.length + 1);

    for (let i = 0; i < stopIds.length; i++) {
        offsets[i + 1] = offsets[i] + degree[i];
    }

    const targets = new Int32Array(offsets[stopIds.length]),
        seconds = new Int32Array(offsets[stopIds.length]),
        cursor = Uint32Array.from(offsets.subarray(0, stopIds.length));

    for (const [from, to, time] of edges) {
        targets[cursor[from]] = to;
        seconds[cursor[from]++] = time;
        targets[cursor[to]] = from;
        seconds[cursor[to]++] = time;
    }

    return {
        radius: 400,
        ids: stopIds,
        offsets: Array.from(offsets),
        targets: Array.from(targets),
        seconds: Array.from(seconds)
    };
}
