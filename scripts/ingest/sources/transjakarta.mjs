/**
 * Transjakarta — the official GTFS feed.
 *
 * The only contracted, standards-conformant source the project has, and the
 * one the whole map was built on. It is also, as of 1 September 2026, served
 * behind an expired TLS certificate: the host is up and the zip downloads
 * fine, but every ordinary client refuses it, which reads like an outage and
 * is not one.
 *
 * So the origin is tried first and, if it fails on trust, the Mobility
 * Database mirror is used instead — properly certified, refreshed daily, and
 * carrying the same feed. Which one answered is recorded in the snapshot,
 * because "we silently used the mirror for six months" is its own bug.
 *
 * Verification is never disabled by default. `--insecure` exists for the case
 * where the mirror is also unavailable and the feed is genuinely needed, and
 * it is scoped to this one request.
 */
const ORIGIN = 'https://gtfs.transjakarta.co.id/files/file_gtfs.zip',
    MIRROR = 'https://storage.googleapis.com/storage/v1/b/mdb-latest/o/id-jakarta-raya-transjakarta-gtfs-1909.zip?alt=media',
    FILE = 'file_gtfs.zip';

export default {
    id: 'transjakarta',
    label: 'Transjakarta — official GTFS (gtfs.transjakarta.co.id)',
    interval: 500,

    async fetch(snap, log, options = {}) {
        const attempts = [];
        let served;

        if (!snap.has(FILE)) {
            for (const [origin, url, tls] of [
                ['origin', ORIGIN, true],
                ['mirror', MIRROR, true],
                ...(options.insecure ? [['origin (TLS verification disabled)', ORIGIN, false]] : [])
            ]) {
                try {
                    const buffer = await snap.getBuffer(url, {timeout: 180000, tls});

                    // A zip that is not a zip means we captured an error page.
                    if (buffer.slice(0, 2).toString() !== 'PK') {
                        throw new Error(`not a zip (starts "${buffer.slice(0, 16).toString('utf8').replace(/\s+/g, ' ')}")`);
                    }
                    await snap.write(FILE, buffer);
                    served = origin;
                    log(`fetched from ${origin}: ${(buffer.length / 1048576).toFixed(2)} MB`);
                    break;
                } catch (error) {
                    attempts.push(`${origin}: ${error.message.slice(0, 90)}`);
                    log(`  ! ${origin} — ${error.message.slice(0, 90)}`);
                }
            }

            if (!served) {
                throw new Error(`no source served the feed —\n    ${attempts.join('\n    ')}`);
            }
        } else {
            served = 'cache';
            log(`${FILE} already on disk`);
        }

        // Unpacked alongside the zip, which the zip remains the raw record of.
        // Decompression is not interpretation — no field is read or reshaped
        // here — and it keeps the transform pure JS with nothing to shell out
        // to. The .txt files are what everything downstream reads.
        const {execFileSync} = await import('node:child_process'),
            {existsSync, readdirSync, statSync} = await import('node:fs');

        if (!existsSync(snap.path('gtfs'))) {
            execFileSync('unzip', ['-oq', snap.path(FILE), '-d', snap.path('gtfs')]);
        }

        const tables = readdirSync(snap.path('gtfs')).filter(f => f.endsWith('.txt')).sort(),
            bytes = statSync(snap.path(FILE)).size;

        log(`unpacked ${tables.length} tables: ${tables.map(t => t.replace('.txt', '')).join(', ')}`);

        return {
            counts: {bytes, servedBy: served, tables: tables.length},
            sources: [ORIGIN, MIRROR],
            notes: [
                served === 'mirror'
                    ? 'Served by the Mobility Database mirror — the origin certificate is expired. See JAKAR-31.'
                    : `Served by ${served}.`,
                'Origin TLS certificate (*.transjakarta.co.id) expired 1 Sept 2026; the host itself is up.',
                'The mdb-latest bucket object can lag the origin — a May 2026 snapshot carried 12 routes since withdrawn. Prefer the origin once its certificate is renewed.',
                ...attempts.map(a => `attempt — ${a}`)
            ]
        };
    }
};
