/**
 * Canonical dataset -> the files the browser actually downloads.
 *
 * Three ideas, in order of how much they matter:
 *
 * 1. **Binary where it pays.** Trips are the bulk of the payload and were the
 *    worst-encoded part of it: JSON carrying stop-id *strings* costs about
 *    30 bytes per stop entry. A Uint16 index into the stop table plus a Uint16
 *    time offset costs 4. That single change absorbs the whole multi-modal
 *    growth — measured on the bus network alone it took trips from 0.25 MB
 *    gzipped to 22 KB.
 *
 * 2. **Content hashing.** Every file but the manifest carries a hash of its own
 *    bytes in its name, so it can be cached for a year and rolled back by
 *    pointing the manifest somewhere else. This only works if the build is
 *    deterministic, which is why the canonical dataset is sorted and serialised
 *    stably before it gets here.
 *
 * 3. **Provenance in the manifest.** Every rail source is scraped and none is
 *    contracted, so how old each mode's data is has to be a fact the client can
 *    read — not something buried in a build log. It is the Comuline lesson made
 *    structural: that API still answers, and its data froze seventeen months
 *    ago.
 */
import {createHash} from 'node:crypto';
import {brotliCompressSync, constants, gzipSync} from 'node:zlib';
import {mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {projectSequential, simplify} from './geometry.mjs';
import {SCHEMA_VERSION, stableStringify} from './model.mjs';

// Coordinates ship as integers scaled by 1e6 (~11 cm) and delta-encoded, the
// same trick shapes.bin has always used.
const COORD_SCALE = 1e6,

    // Eight hex characters is 4 billion values; collisions are not the risk
    // here, long filenames are.
    HASH_LENGTH = 8,

    // Seconds from a trip's first call. A Uint16 covers 18 hours, which is
    // longer than any single run in this network — the longest KRL trip is
    // about 100 minutes.
    MAX_OFFSET = 65535;

function hash(buffer) {
    return createHash('sha256').update(buffer).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Trips for one mode and service day.
 *
 * Layout, little-endian:
 *   uint32  trip count
 *   per trip:
 *     uint16  pattern index
 *     uint32  first call, seconds from midnight (may exceed 86400 — a train
 *             leaving at 23:10 and arriving 00:37 belongs to today)
 *     uint16 × (stops - 1)  seconds since the previous call
 *
 * Stop identity is not stored per trip at all: it lives once on the pattern,
 * which is the whole reason this is small.
 */
export function encodeTrips(trips, patternIndex) {
    let bytes = 4;

    for (const trip of trips) {
        bytes += 2 + 4 + Math.max(0, trip.times.length - 1) * 2;
    }

    const buffer = Buffer.allocUnsafe(bytes);
    let offset = 0;

    buffer.writeUInt32LE(trips.length, offset);
    offset += 4;

    for (const trip of trips) {
        buffer.writeUInt16LE(patternIndex.get(trip.pattern), offset);
        offset += 2;
        buffer.writeUInt32LE(trip.times[0], offset);
        offset += 4;

        for (let i = 1; i < trip.times.length; i++) {
            const delta = trip.times[i] - trip.times[i - 1];

            if (delta < 0 || delta > MAX_OFFSET) {
                throw new Error(`trip ${trip.id}: leg ${i} is ${delta}s, outside a uint16 — ` +
                    'times were probably not unwrapped past midnight');
            }
            buffer.writeUInt16LE(delta, offset);
            offset += 2;
        }
    }
    return buffer;
}

/**
 * Frequency-based trips: the Transjakarta feed has no departure rows at all.
 *
 * A trip is a pattern plus headway windows, and the pattern already carries the
 * per-stop offsets, so a trip costs almost nothing:
 *
 *   uint32  trip count
 *   per trip:
 *     uint16  pattern index
 *     uint8   window count
 *     per window: uint32 start, uint32 end, uint16 headway
 */
export function encodeFrequencyTrips(trips, patternIndex) {
    let bytes = 4;

    for (const trip of trips) {
        bytes += 2 + 1 + trip.frequency.windows.length * 10;
    }

    const buffer = Buffer.allocUnsafe(bytes);
    let offset = 0;

    buffer.writeUInt32LE(trips.length, offset);
    offset += 4;

    for (const trip of trips) {
        buffer.writeUInt16LE(patternIndex.get(trip.pattern), offset);
        offset += 2;
        buffer.writeUInt8(trip.frequency.windows.length, offset);
        offset += 1;

        for (const window of trip.frequency.windows) {
            buffer.writeUInt32LE(window.start, offset);
            offset += 4;
            buffer.writeUInt32LE(window.end, offset);
            offset += 4;
            buffer.writeUInt16LE(Math.min(65535, window.headway), offset);
            offset += 2;
        }
    }
    return buffer;
}

/**
 * Pattern stop sequences, with each stop's place along its shape.
 *
 *   uint32 pattern count
 *   per pattern:
 *     uint16 stop count
 *     stop count × uint16  stop index
 *     stop count × uint16  seconds from the pattern's first call
 *     stop count × uint32  metres along the shape
 *
 * That last column is the one that matters at runtime, and the reason this is
 * a build-time job at all. Positioning a vehicle is then a binary search over
 * cumulative distance and a lerp — the whole design of the simulation — rather
 * than a projection per frame. It costs a projection per pattern stop here,
 * once, instead of sixty times a second forever.
 */
export function encodePatterns(patterns, stopIndex, stops, shapesById) {
    const collapsed = [];
    let entries = 0;

    for (const p of patterns) {
        entries += p.stops.length;
    }

    const buffer = Buffer.allocUnsafe(4 + patterns.length * 2 + entries * 8);
    let offset = 0,
        projected = 0,
        unshaped = 0;

    buffer.writeUInt32LE(patterns.length, offset);
    offset += 4;

    for (const p of patterns) {
        buffer.writeUInt16LE(p.stops.length, offset);
        offset += 2;
        for (const id of p.stops) {
            buffer.writeUInt16LE(stopIndex.get(id) ?? 0, offset);
            offset += 2;
        }
        for (let i = 0; i < p.stops.length; i++) {
            buffer.writeUInt16LE(Math.min(65535, Math.max(0, p.offsets?.[i] ?? 0)), offset);
            offset += 2;
        }

        const coords = shapesById.get(p.shape)?.coords,
            placed = coords
                ? projectSequential(
                    p.stops.map(id => stops[stopIndex.get(id)]),
                    coords,
                    // The pattern's own time offsets, which is what bounds how
                    // far ahead a stop may be matched.
                    p.offsets
                ).offsets
                : null;

        if (placed && p.stops.length > 2) {
            let zeros = 0;

            for (let i = 1; i < placed.length; i++) {
                if (Math.round(placed[i]) === Math.round(placed[i - 1])) {
                    zeros++;
                }
            }
            if (zeros / (placed.length - 1) > 0.5) {
                collapsed.push(`${p.route} "${p.headsign}"`);
            }
        }

        for (let i = 0; i < p.stops.length; i++) {
            if (placed) {
                projected++;
            } else {
                unshaped++;
            }
            buffer.writeUInt32LE(placed ? Math.max(0, Math.round(placed[i])) : 0, offset);
            offset += 4;
        }
    }

    // A collapsed pattern is one where a stop was flung far along the shape and
    // every stop after it piled against the same offset. The vehicle then
    // teleports once and stands still for the rest of its run — which is what
    // it looks like on the map, and how this was found. 158 of 806 patterns
    // were in that state before the projection bounded its search; there is no
    // legitimate reason for one to be, so the build stops rather than shipping
    // geometry that is visibly wrong.
    if (collapsed.length) {
        throw new Error(
            `${collapsed.length} pattern(s) collapsed onto a single offset: ` +
            `${collapsed.slice(0, 5).join(', ')}${collapsed.length > 5 ? ', …' : ''}`
        );
    }

    encodePatterns.lastRun = {projected, unshaped};
    return buffer;
}

/**
 * The walk table: every pair of stops within 400 m, either way.
 *
 *   uint32 edge count
 *   per edge: uint16 from, uint16 to, uint16 seconds
 *
 * Stored as pairs rather than the CSR the runtime wants, because building the
 * adjacency is a decode-side concern and the pair form is what stays stable
 * when a stop is added.
 */
export function encodeWalk(transfers, stopIndex) {
    const buffer = Buffer.allocUnsafe(4 + transfers.length * 6);
    let offset = 0;

    buffer.writeUInt32LE(transfers.length, offset);
    offset += 4;

    // Sorted in index space so the binary's order does not depend on how the
    // canonical dataset happens to be sorted. Today the two agree — stops and
    // transfers are both id-sorted, so this is a no-op and the hash is
    // unchanged by it — which is precisely why it is cheap to guarantee.
    //
    // This file compresses worse than it used to (brotli 158 KB against 131 KB)
    // and that is the cost of the fix, not a regression to chase: the old
    // ordering came from the spatial grid that built the edges, so neighbouring
    // rows held neighbouring indices. Those indices were the ones pointing at
    // the wrong stops.
    const rows = transfers.map(edge => {
        const from = stopIndex.get(edge.from),
            to = stopIndex.get(edge.to);

        // An id the stop table does not contain would otherwise write as
        // undefined and land somewhere plausible-looking. Say so instead.
        if (from === undefined || to === undefined) {
            throw new Error(`walk edge references unknown stop: ${edge.from} -> ${edge.to}`);
        }
        return [from, to, Math.min(65535, edge.seconds)];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    for (const [from, to, seconds] of rows) {
        buffer.writeUInt16LE(from, offset);
        offset += 2;
        buffer.writeUInt16LE(to, offset);
        offset += 2;
        buffer.writeUInt16LE(seconds, offset);
        offset += 2;
    }
    return buffer;
}

/**
 * All shapes for a mode, delta-encoded int32 pairs.
 *
 * Consecutive vertices differ by a handful of units at 1e-6 degrees, so the
 * deltas compress far better than raw coordinates would.
 */
export function encodeShapes(rawShapes, {tolerance = 1e-5} = {}) {
    // Simplified here rather than in the model: how finely a line is drawn is a
    // rendering decision, and the canonical dataset should keep what the source
    // said. Halves the vertex count for no visible change.
    const shapes = rawShapes.map(shape => ({
        id: shape.id,
        coords: simplify(shape.coords, tolerance)
    }));

    let vertices = 0;

    for (const shape of shapes) {
        vertices += shape.coords.length / 2;
    }

    const header = Buffer.allocUnsafe(4 + shapes.length * 4),
        coords = new Int32Array(vertices * 2);

    header.writeUInt32LE(shapes.length, 0);

    let cursor = 0,
        previousLon = 0,
        previousLat = 0;

    shapes.forEach((shape, index) => {
        header.writeUInt32LE(shape.coords.length / 2, 4 + index * 4);
        for (let i = 0; i < shape.coords.length; i += 2) {
            const lon = Math.round(shape.coords[i] * COORD_SCALE),
                lat = Math.round(shape.coords[i + 1] * COORD_SCALE);

            coords[cursor++] = lon - previousLon;
            coords[cursor++] = lat - previousLat;
            previousLon = lon;
            previousLat = lat;
        }
    });

    return Buffer.concat([header, Buffer.from(coords.buffer)]);
}

/**
 * Writes the artifact set and returns the manifest.
 *
 * Sliced per mode so the client can decline to download what the viewer has
 * switched off — someone who only wants MRT should not pay for 1,097 KRL trips.
 */
export async function writeArtifacts(dataset, outDir, {previousManifest = null} = {}) {
    await mkdir(outDir, {recursive: true});

    const files = [],
        stopIndex = new Map(dataset.stops.map((stop, i) => [stop.id, i])),
        shapeIndex = new Map(dataset.shapes.map((shape, i) => [shape.id, i])),
        patternIndex = new Map(dataset.patterns.map((pattern, i) => [pattern.id, i])),
        modeOf = new Map(dataset.routes.map(route => [route.id, route.mode]));

    async function emit(name, extension, buffer) {
        const digest = hash(buffer),
            filename = `${name}-${digest}.${extension}`;

        await writeFile(join(outDir, filename), buffer);

        // Pre-compressed at build time so the CDN never spends CPU on it, and
        // brotli beats gzip by roughly 15% on this kind of payload.
        const brotli = brotliCompressSync(buffer, {
            params: {[constants.BROTLI_PARAM_QUALITY]: 11}
        });

        await writeFile(join(outDir, `${filename}.br`), brotli);

        const entry = {
            file: filename,
            sha256: digest,
            bytes: buffer.length,
            gzip: gzipSync(buffer, {level: 9}).length,
            brotli: brotli.length
        };

        files.push(entry);
        return entry;
    }

    // ---- core: everything the map needs before it can draw anything --------
    const core = {
        schemaVersion: SCHEMA_VERSION,
        modes: dataset.modes,
        agencies: dataset.agencies,
        routes: dataset.routes,
        calendar: dataset.calendar,
        fares: dataset.fares,

        // Stops as parallel arrays rather than an array of objects: the key
        // names are otherwise repeated once per stop, which is most of the file.
        stops: {
            id: dataset.stops.map(s => s.id),
            name: dataset.stops.map(s => s.name),
            lat: dataset.stops.map(s => Math.round(s.lat * COORD_SCALE)),
            lon: dataset.stops.map(s => Math.round(s.lon * COORD_SCALE)),
            station: dataset.stops.map(s => stopIndex.get(s.station) ?? -1)
        },

        // Pattern metadata only — the stop sequences and offsets are the bulk
        // and live in patterns.bin, indexed identically.
        patterns: dataset.patterns.map(pattern => ({
            id: pattern.id,
            route: pattern.route,
            mode: pattern.mode ?? modeOf.get(pattern.route) ?? null,
            stops: pattern.stops.length,
            shape: shapeIndex.has(pattern.shape) ? shapeIndex.get(pattern.shape) : -1,
            headsign: pattern.headsign,
            direction: pattern.direction,
            inferred: pattern.inferred
        }))
    };

    const coreEntry = await emit('core', 'json', Buffer.from(stableStringify(core))),
        patternsEntry = await emit('patterns', 'bin', encodePatterns(
            dataset.patterns,
            stopIndex,
            dataset.stops,
            new Map(dataset.shapes.map(shape => [shape.id, shape]))
        )),
        walkEntry = dataset.transfers.length
            ? await emit('walk', 'bin', encodeWalk(dataset.transfers, stopIndex))
            : null,

        // Cameras are their own file for the same reason modes are: a viewer
        // who never opens the layer should not pay for it. Parallel arrays and
        // a hoisted host, because the host is identical for every row and the
        // key names would otherwise be most of the payload.
        camerasEntry = dataset.cameras?.length
            ? await emit('cameras', 'json', Buffer.from(stableStringify({
                id: dataset.cameras.map(c => c.id),
                name: dataset.cameras.map(c => c.name),
                lat: dataset.cameras.map(c => Math.round(c.lat * COORD_SCALE)),
                lon: dataset.cameras.map(c => Math.round(c.lon * COORD_SCALE)),

                // Full URLs rather than a host and a path. The toll cameras
                // come from thirty-odd operators on as many hosts, so there is
                // no host to hoist, and the repetition costs almost nothing
                // once brotli has seen it.
                stream: dataset.cameras.map(c => c.stream),
                preview: dataset.cameras.map(c => c.preview ?? ''),

                kind: dataset.cameras.map(c => c.kind === 'toll' ? 1 : 0),
                precision: dataset.cameras.map(c => c.precision === 'estimated' ? 1 : 0),
                channel: dataset.cameras.map(c => c.channel ?? 0),
                road: dataset.cameras.map(c => c.road ?? ''),

                // The stop **id**, not an index into the stop array. An index
                // here would be trap 7 rebuilt from scratch: the client
                // assembles its own stop list, and any reordering would
                // silently repoint every camera at a different place. Ids
                // survive that; the few extra bytes are the cheapest
                // insurance in this file.
                stop: dataset.cameras.map(c => c.stop ?? ''),
                distance: dataset.cameras.map(c => c.distance ?? -1)
            })))
            : null;

    // ---- shapes and trips, sliced per mode --------------------------------
    const modes = [...new Set(dataset.routes.map(r => r.mode))].sort(),
        byMode = {};

    for (const mode of modes) {
        const patterns = dataset.patterns.filter(p =>
                (p.mode ?? modeOf.get(p.route)) === mode),
            shapeIds = [...new Set(patterns.map(p => p.shape).filter(Boolean))].sort(),
            shapes = shapeIds.map(id => dataset.shapes.find(s => s.id === id)).filter(Boolean),
            trips = dataset.trips.filter(t => modeOf.get(t.route) === mode),
            services = [...new Set(trips.map(t => t.service))].sort();

        byMode[mode] = {
            routes: dataset.routes.filter(r => r.mode === mode).length,
            patterns: patterns.length,
            trips: trips.length,
            shapes: await emit(`shapes-${mode}`, 'bin', encodeShapes(shapes)),
            // Which global shape index each of this mode's shapes is, so the
            // client can resolve a pattern without loading every mode.
            shapeIds: shapes.map(s => shapeIndex.get(s.id)),
            services: {}
        };

        for (const service of services) {
            const forService = trips.filter(t => t.service === service);

            // Scheduled and frequency-based trips are different shapes and are
            // encoded differently; the manifest says which.
            const scheduled = forService.every(t => t.times);

            byMode[mode].services[service] = await emit(
                `trips-${mode}-${service}`, 'bin',
                scheduled
                    ? encodeTrips(forService, patternIndex)
                    : encodeFrequencyTrips(forService, patternIndex)
            );
            byMode[mode].services[service].kind = scheduled ? 'scheduled' : 'frequency';
            byMode[mode].services[service].trips = forService.length;
        }
    }

    // ---- manifest ---------------------------------------------------------
    const totals = files.reduce((acc, f) => ({
        bytes: acc.bytes + f.bytes,
        gzip: acc.gzip + f.gzip,
        brotli: acc.brotli + f.brotli
    }), {bytes: 0, gzip: 0, brotli: 0});

    const manifest = {
        schemaVersion: SCHEMA_VERSION,
        projection: encodePatterns.lastRun ?? null,
        builtAt: new Date().toISOString(),
        core: coreEntry,
        patterns: patternsEntry,
        walk: walkEntry,
        cameras: camerasEntry && {...camerasEntry, count: dataset.cameras.length},
        modes: byMode,

        // Per-mode freshness, readable by the UI. A mode whose snapshot has
        // gone stale should say so rather than quietly serving old trips.
        provenance: dataset.provenance,
        totals
    };

    await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Old hashed files would otherwise accumulate forever. Anything not in this
    // manifest is from a previous build and safe to drop.
    const keep = new Set(files.flatMap(f => [f.file, `${f.file}.br`]).concat(['manifest.json'])),
        removed = [];

    for (const name of await readdir(outDir)) {
        if (!keep.has(name)) {
            await rm(join(outDir, name));
            removed.push(name);
        }
    }

    return {manifest, files, removed, unchanged: previousManifest
        ? files.filter(f => JSON.stringify(previousManifest).includes(f.sha256)).length
        : null};
}
