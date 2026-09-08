/**
 * Ingest runner: fetches raw, dated snapshots from every upstream source.
 *
 * The rule this whole layer exists to enforce is that fetching and
 * interpreting are separate jobs. Adapters here may not transform, filter or
 * normalise anything — they write what the source said, on the day it said
 * it. Everything downstream reads snapshots, never the network, so a build is
 * reproducible offline and a source going dark degrades to stale rather than
 * to silently wrong.
 *
 *   node scripts/ingest/index.mjs --list
 *   node scripts/ingest/index.mjs --status
 *   node scripts/ingest/index.mjs --source=osm
 *   node scripts/ingest/index.mjs --source=kci --force
 *   npm run ingest -- --source=all
 */
import {existsSync} from 'node:fs';
import {relative} from 'node:path';

import {Snapshot, latest, storeRoot, today} from './snapshot.mjs';
import cctv from './sources/cctv.mjs';
import cctvTol from './sources/cctv-tol.mjs';
import kci from './sources/kci.mjs';
import lrtJabodebek from './sources/lrt-jabodebek.mjs';
import lrtJakarta from './sources/lrt-jakarta.mjs';
import mrt from './sources/mrt.mjs';
import osm from './sources/osm.mjs';
import transjakarta from './sources/transjakarta.mjs';
import walk from './sources/walk.mjs';

// Ordered cheapest-first, so `--source=all` surfaces a broken source early
// rather than after the half-hour KRL harvest.
// `walk` is last and deliberately apart: it is the only adapter whose input is
// the project's own canonical dataset rather than an upstream source, so it
// cannot run before a transform has produced a walk table to route.
const ADAPTERS = [transjakarta, osm, mrt, lrtJabodebek, lrtJakarta, kci, cctv, cctvTol, walk],
    BY_ID = new Map(ADAPTERS.map(a => [a.id, a]));

const args = new Map(process.argv.slice(2).map(arg => {
        const [key, value] = arg.replace(/^--/, '').split('=');

        return [key, value ?? true];
    })),
    date = typeof args.get('date') === 'string' ? args.get('date') : today(),
    force = args.has('force');

function usage() {
    console.log('Sources:');
    for (const adapter of ADAPTERS) {
        console.log(`  ${adapter.id.padEnd(14)} ${adapter.label}`);
    }
    console.log('\n  --source=<id>|all   fetch one source, or every upstream source');
    console.log('                      (`all` excludes walk, which routes this project\'s own table)');
    console.log('  --status            show the newest snapshot of each source');
    console.log('  --force             refetch even if today is already complete');
    console.log('  --insecure          allow the Transjakarta origin despite its expired certificate');
    console.log(`  --date=YYYY-MM-DD   write into a specific dated directory (default ${today()})`);
}

async function status() {
    console.log(`Snapshot store: ${relative(process.cwd(), storeRoot)}\n`);
    for (const adapter of ADAPTERS) {
        const meta = await latest(adapter.id);

        if (!meta) {
            console.log(`  ${adapter.id.padEnd(14)} never fetched`);
            continue;
        }

        // Freshness is the signal that would have caught Comuline, so it is
        // the thing this command leads with.
        const age = meta.ageDays === 0 ? 'today' : `${meta.ageDays}d old`;

        console.log(`  ${adapter.id.padEnd(14)} ${meta.date}  ${age.padEnd(9)} ${String(meta.files).padStart(5)} files  ${(meta.bytes / 1048576).toFixed(2)} MB`);
        console.log(`  ${' '.repeat(14)} ${Object.entries(meta.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
}

async function run(adapter) {
    const snap = await (new Snapshot(adapter.id, date)).open(),
        label = `[${adapter.id}]`;

    if (adapter.interval) {
        snap.interval = adapter.interval;
    }

    // meta.json is written last, so its presence is what "complete" means.
    if (snap.has('meta.json') && !force) {
        console.log(`${label} ${date} already complete — skipping (use --force to refetch)`);
        return;
    }

    const log = message => console.log(`${label} ${message}`),
        started = Date.now();

    console.log(`${label} ${adapter.label}`);
    console.log(`${label} -> ${relative(process.cwd(), snap.dir)}`);

    const result = await adapter.fetch(snap, log, {insecure: args.has('insecure')}),
        meta = await snap.finish(result);

    console.log(`${label} done in ${((Date.now() - started) / 1000).toFixed(0)}s — ` +
        `${meta.requests.fetched} fetched, ${meta.requests.servedFromDisk} already on disk, ` +
        `${meta.files} files, ${(meta.bytes / 1048576).toFixed(2)} MB`);
    console.log(`${label} ${Object.entries(meta.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

if (args.has('status')) {
    await status();
} else if (args.has('list') || !args.has('source')) {
    usage();
} else {
    const wanted = args.get('source'),
        // `walk` routes the project's own walk table rather than fetching an
        // upstream source, so it needs a transform to have run first. On a
        // fresh checkout there is nothing to route and it would be the one
        // source that always fails, so `all` leaves it out and it is asked for
        // by name.
        selected = wanted === 'all'
            ? ADAPTERS.filter(adapter => !adapter.derived)
            : [BY_ID.get(wanted)].filter(Boolean);

    if (!selected.length) {
        console.error(`Unknown source "${wanted}".\n`);
        usage();
        process.exit(1);
    }

    for (const adapter of selected) {
        try {
            await run(adapter);
        } catch (error) {
            // One source failing must not abandon the others — a partial
            // snapshot is still resumable, and the rest are independent.
            console.error(`[${adapter.id}] FAILED: ${error.message}`);
            if (selected.length === 1) {
                process.exit(1);
            }
        }
    }
}

if (!existsSync(storeRoot)) {
    console.log('\nNothing fetched yet.');
}
