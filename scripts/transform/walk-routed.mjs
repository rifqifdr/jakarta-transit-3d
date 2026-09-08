import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Real pedestrian times for the walk table, out of the `walk` snapshot.
 *
 * The straight-line model is right about walking *speed* — measured 4.92 km/h
 * against its 4.8 — and wrong about the *route* wherever something is in the
 * way. Sentul and Simpang Sentul are 62 m apart and 2,579 m on foot; the model
 * offered that as a 46-second transfer. This replaces the estimate with what a
 * pedestrian router actually returns.
 *
 * The snapshot holds one file per matrix block: two id arrays and an
 * index-ordered result grid. Only pairs the walk table contains are read out.
 */
const STORE = 'data/snapshots/walk';

/** The newest completed snapshot, or null if there is none. */
function newest() {
    if (!existsSync(STORE)) {
        return null;
    }

    const dates = readdirSync(STORE)
        .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort()
        .reverse();

    // `meta.json` is written last, so its presence is what "complete" means.
    for (const date of dates) {
        if (existsSync(join(STORE, date, 'meta.json'))) {
            return join(STORE, date);
        }
    }
    return null;
}

/**
 * @returns {{lookup: Map<string, number>, date: string, stats: object}|null}
 *   `lookup` is keyed `from|to` with both directions present.
 */
export function loadRoutedWalk() {
    const dir = newest();

    if (!dir) {
        return null;
    }

    const lookup = new Map(),
        files = readdirSync(dir).filter(name => name.startsWith('block-'));

    let cells = 0,
        unroutable = 0;

    for (const file of files) {
        const {sources, targets, response} = JSON.parse(readFileSync(join(dir, file), 'utf8')),
            grid = response?.sources_to_targets ?? [];

        for (let i = 0; i < grid.length; i++) {
            for (let j = 0; j < grid[i].length; j++) {
                const cell = grid[i][j],
                    from = sources[i],
                    to = targets[j];

                if (from === to) {
                    continue;
                }
                cells++;

                // Valhalla reports an unreachable pair as a null time, and a
                // zero-distance one for coordinates that snapped to the same
                // edge. Neither is a measurement, so neither is recorded and
                // the pair keeps its straight-line estimate.
                if (cell.time === null || cell.time === undefined || cell.distance === null) {
                    unroutable++;
                    continue;
                }
                lookup.set(`${from}|${to}`, {seconds: cell.time, metres: Math.round(cell.distance * 1000)});
            }
        }
    }

    return {
        lookup,
        date: dir.slice(-10),
        stats: {blocks: files.length, cells, unroutable}
    };
}

/**
 * Applies routed times to the canonical walk table, in place.
 *
 * **Directions are averaged.** Valhalla answers each way separately and they
 * differ — Sentul to Simpang Sentul is 2,028 s against 1,916 s coming back,
 * because the crossings are not symmetric. The canonical table is undirected
 * and the router builds a symmetric adjacency from it, so one number has to
 * stand for both. The mean is the unbiased choice; taking the larger would be
 * safe but would inflate every edge in the network to guard against a few.
 */
export function applyRoutedWalk(dataset, routed) {
    let matched = 0,
        missing = 0,
        worsened = 0,
        improved = 0,
        totalDelta = 0;

    // The mean hides this entirely: most edges barely move and a few move by
    // half an hour. The percentiles are the finding.
    const deltas = [];

    for (const edge of dataset.transfers) {
        if (edge.kind !== 'walk') {
            continue;
        }

        const forward = routed.lookup.get(`${edge.from}|${edge.to}`),
            backward = routed.lookup.get(`${edge.to}|${edge.from}`),
            found = [forward, backward].filter(Boolean);

        if (!found.length) {
            missing++;
            edge.estimated = true;
            continue;
        }

        const seconds = Math.round(found.reduce((sum, r) => sum + r.seconds, 0) / found.length),
            metres = Math.round(found.reduce((sum, r) => sum + r.metres, 0) / found.length),
            delta = seconds - edge.seconds;

        matched++;
        totalDelta += delta;
        deltas.push(delta);
        if (delta > 0) {
            worsened++;
        } else if (delta < 0) {
            improved++;
        }
        edge.seconds = seconds;
        edge.metres = metres;
    }

    deltas.sort((a, b) => a - b);

    const at = q => deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] : 0;

    return {
        matched,
        missing,
        worsened,
        improved,
        meanDelta: matched ? totalDelta / matched : 0,
        p50: at(0.5),
        p90: at(0.9),
        p99: at(0.99),
        max: deltas.length ? deltas[deltas.length - 1] : 0,
        over3min: deltas.filter(d => d > 180).length
    };
}
