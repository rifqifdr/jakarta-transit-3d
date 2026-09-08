/**
 * Decodes artifact binaries off the main thread.
 *
 * The render loop has a frame to hold, and decoding thirty thousand stop times
 * on the main thread is exactly the kind of work that drops one. Buffers arrive
 * and leave as transfers rather than copies — a structured clone of the whole
 * payload would cost more than the decode it was meant to save.
 */

const COORD_SCALE = 1e6;

self.onmessage = event => {
    const {id, kind, buffer, patternStops} = event.data;

    try {
        const decoders = {
                trips: () => decodeTrips(buffer, patternStops),
                frequency: () => decodeFrequency(buffer),
                shapes: () => decodeShapes(buffer),
                walk: () => decodeWalk(buffer)
            },
            result = decoders[kind]();

        self.postMessage({id, ok: true, result}, result.transfer);
    } catch (error) {
        self.postMessage({id, ok: false, error: error.message});
    }
};

/**
 * uint32 count, then per trip: uint16 pattern, uint32 first call, uint16 delta
 * per remaining stop.
 *
 * Times come back as one flat Int32Array with an offset table rather than an
 * array of arrays: thousands of small arrays is what makes a decode slow, and
 * the simulation wants a flat buffer anyway.
 */
function decodeTrips(buffer, patternStops) {
    const view = new DataView(buffer),
        count = view.getUint32(0, true),
        patterns = new Uint16Array(count),
        offsets = new Uint32Array(count + 1);

    let cursor = 4,
        total = 0;

    // First pass: how many stop times, so the flat array is allocated once.
    for (let i = 0; i < count; i++) {
        const pattern = view.getUint16(cursor, true),
            stops = patternStops[pattern];

        patterns[i] = pattern;
        offsets[i] = total;
        total += stops;
        cursor += 2 + 4 + Math.max(0, stops - 1) * 2;
    }
    offsets[count] = total;

    const times = new Int32Array(total);

    cursor = 4;
    for (let i = 0; i < count; i++) {
        const stops = patternStops[view.getUint16(cursor, true)];

        cursor += 2;

        let time = view.getUint32(cursor, true);

        cursor += 4;
        times[offsets[i]] = time;
        for (let k = 1; k < stops; k++) {
            time += view.getUint16(cursor, true);
            cursor += 2;
            times[offsets[i] + k] = time;
        }
    }

    return {count, patterns, offsets, times, transfer: [patterns.buffer, offsets.buffer, times.buffer]};
}

/**
 * Frequency trips: uint32 count, then per trip uint16 pattern, uint8 window
 * count, and per window uint32 start, uint32 end, uint16 headway.
 *
 * Windows stay as plain arrays — there are a few hundred of them, and the
 * fleet reads them once when it builds runs rather than per frame.
 */
function decodeFrequency(buffer) {
    const view = new DataView(buffer),
        count = view.getUint32(0, true),
        patterns = new Uint16Array(count),
        windows = new Array(count);

    let cursor = 4;

    for (let i = 0; i < count; i++) {
        patterns[i] = view.getUint16(cursor, true);
        cursor += 2;

        const n = view.getUint8(cursor);

        cursor += 1;
        windows[i] = [];
        for (let k = 0; k < n; k++) {
            const start = view.getUint32(cursor, true),
                end = view.getUint32(cursor + 4, true),
                headway = view.getUint16(cursor + 8, true);

            cursor += 10;
            windows[i].push([start, end, headway]);
        }
    }
    return {count, patterns, windows, transfer: [patterns.buffer]};
}

/** uint32 count, then per edge uint16 from, uint16 to, uint16 seconds. */
function decodeWalk(buffer) {
    const view = new DataView(buffer),
        count = view.getUint32(0, true),
        edges = new Array(count);

    let cursor = 4;

    for (let i = 0; i < count; i++) {
        edges[i] = [
            view.getUint16(cursor, true),
            view.getUint16(cursor + 2, true),
            view.getUint16(cursor + 4, true)
        ];
        cursor += 6;
    }
    return {count, edges, transfer: []};
}

/**
 * uint32 shape count, uint32 vertex count each, then delta-encoded int32 pairs
 * scaled by 1e6. Undone into plain degrees in one pass.
 */
function decodeShapes(buffer) {
    const view = new DataView(buffer),
        count = view.getUint32(0, true),
        lengths = new Uint32Array(count),
        starts = new Uint32Array(count + 1);

    let vertices = 0;

    for (let i = 0; i < count; i++) {
        lengths[i] = view.getUint32(4 + i * 4, true);
        starts[i] = vertices;
        vertices += lengths[i];
    }
    starts[count] = vertices;

    const deltas = new Int32Array(buffer, 4 + count * 4, vertices * 2),
        coords = new Float64Array(vertices * 2);

    let lon = 0,
        lat = 0;

    for (let i = 0; i < deltas.length; i += 2) {
        lon += deltas[i];
        lat += deltas[i + 1];
        coords[i] = lon / COORD_SCALE;
        coords[i + 1] = lat / COORD_SCALE;
    }

    return {count, starts, coords, transfer: [starts.buffer, coords.buffer]};
}
