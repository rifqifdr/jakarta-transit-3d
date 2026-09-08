/**
 * The snapshot store, shared by every ingest adapter.
 *
 * A snapshot is the raw bytes a source returned on a given day, with nothing
 * interpreted. That separation is the point: none of these sources is
 * contracted, so the only defence against one going dark is to keep what it
 * last said. Comuline is the cautionary tale — its API still answers, but the
 * data behind it froze in March 2025, and nothing downstream could tell.
 *
 * Resumability falls out of writing one file per unit of work: a file that is
 * already on disk is not fetched again, so an interrupted 29-minute KRL
 * harvest picks up where it stopped.
 */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url)),
    ROOT = join(__dirname, '..', '..'),
    STORE = join(ROOT, 'data', 'snapshots'),

    // Kept deliberately mild. These sources are public courtesy, not products
    // we pay for, and a harvest that gets us blocked helps nobody.
    DEFAULT_INTERVAL_MS = 150,
    DEFAULT_TIMEOUT_MS = 45000,
    DEFAULT_RETRIES = 4,

    // Ceiling on the adaptive slowdown, and how long to wait out a 429 that
    // arrives without a Retry-After header.
    MAX_INTERVAL_MS = 4000,
    RATE_LIMIT_BACKOFF_MS = 8000,

    USER_AGENT = 'jakarta-publictrans-3d/1.0 (open data map; contact via repo)';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function today() {
    // Jakarta time, because a snapshot is named for the service day it covers.
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export const storeRoot = STORE;

export class Snapshot {

    constructor(source, date) {
        const me = this;

        me.source = source;
        me.date = date;
        me.dir = join(STORE, source, date);
        me.startedAt = Date.now();
        me.fetched = 0;
        me.skipped = 0;
        me.urls = new Set();
        me._lastRequest = 0;
        me.interval = DEFAULT_INTERVAL_MS;
        me.throttled = 0;
    }

    async open() {
        await mkdir(this.dir, {recursive: true});
        return this;
    }

    path(name) {
        return join(this.dir, name);
    }

    has(name) {
        return existsSync(this.path(name));
    }

    async write(name, data) {
        const file = this.path(name);

        await mkdir(dirname(file), {recursive: true});
        await writeFile(file, data);
        return file;
    }

    async writeJson(name, value) {
        return this.write(name, JSON.stringify(value));
    }

    async read(name) {
        return readFile(this.path(name), 'utf8');
    }

    async readJson(name) {
        return JSON.parse(await this.read(name));
    }

    // One request, rate-limited and retried. Returns the body as text so the
    // caller decides how to interpret it — a snapshot stores bytes, not meaning.
    async get(url, {timeout = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, headers = {}, method = 'GET', body} = {}) {
        const me = this,
            wait = me.interval - (Date.now() - me._lastRequest);

        if (wait > 0) {
            await sleep(wait);
        }

        let lastError;

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url, {
                    method,
                    body,
                    headers: {'User-Agent': USER_AGENT, ...headers},
                    signal: AbortSignal.timeout(timeout)
                });

                me._lastRequest = Date.now();

                if (response.status === 429) {
                    const retryAfter = Number(response.headers.get('retry-after'));

                    // Being told to slow down is information, not noise. A
                    // long harvest that keeps its original pace after a 429
                    // just collects more of them, so the interval is raised
                    // for the rest of the run rather than only for this
                    // request. Measured against kci.id: 150 ms survives a
                    // hundred requests and fails well before a thousand.
                    me.interval = Math.min(Math.round(me.interval * 1.5), MAX_INTERVAL_MS);
                    me.throttled++;
                    throw new Error(`HTTP 429 rate limited (interval now ${me.interval} ms)`, {
                        cause: {backoff: retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_BACKOFF_MS * attempt}
                    });
                }
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                me.fetched++;
                me.urls.add(url.split('?')[0]);
                return await response.text();
            } catch (error) {
                lastError = error;
                me._lastRequest = Date.now();

                // Back off before trying again; a source that is rate-limiting
                // us wants more space, not the same request sooner.
                if (attempt < retries) {
                    await sleep(error.cause?.backoff ?? 500 * attempt * attempt);
                }
            }
        }
        // Reason first, URL last: adapter logs truncate, and the status code
        // is the part worth keeping.
        throw new Error(`${lastError.message} after ${retries} attempts — ${url}`);
    }

    // Same request, kept as bytes. Text decoding would quietly corrupt a zip,
    // so anything that is not character data has to come through here.
    async getBuffer(url, {timeout = DEFAULT_TIMEOUT_MS, headers = {}, tls = true} = {}) {
        const me = this,
            wait = me.interval - (Date.now() - me._lastRequest);

        if (wait > 0) {
            await sleep(wait);
        }

        // Node reads this at socket-creation time, so it has to be set around
        // the call rather than passed in. Scoped to one request and restored
        // immediately — see the Transjakarta adapter for why it exists at all.
        const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

        if (!tls) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        }

        try {
            const response = await fetch(url, {
                headers: {'User-Agent': USER_AGENT, ...headers},
                signal: AbortSignal.timeout(timeout)
            });

            me._lastRequest = Date.now();

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            me.fetched++;
            me.urls.add(url.split('?')[0]);
            return Buffer.from(await response.arrayBuffer());
        } finally {
            if (!tls) {
                if (previous === undefined) {
                    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                } else {
                    process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
                }
            }
        }
    }

    // JSON with the guard that this data has already needed once: one KCI
    // station in 110 answered with a bare string instead of an object.
    async getJson(url, options) {
        const text = await this.get(url, options);

        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`${url} returned non-JSON (${text.length} bytes, starts "${text.slice(0, 60).replace(/\s+/g, ' ')}")`);
        }
    }

    // Fetch into a file unless it is already there. This is what makes a long
    // harvest resumable, so it is the method adapters should reach for.
    async getInto(name, url, options) {
        if (this.has(name)) {
            this.skipped++;
            return {cached: true};
        }
        await this.write(name, await this.get(url, options));
        return {cached: false};
    }

    // Written last, so its presence means the snapshot completed. A partial
    // run leaves the files but no meta, and the next run resumes it.
    async finish({counts = {}, sources = [], notes = []} = {}) {
        const me = this,
            files = await hashTree(me.dir),
            meta = {
                source: me.source,
                date: me.date,
                fetchedAt: new Date().toISOString(),
                durationMs: Date.now() - me.startedAt,
                requests: {
                    fetched: me.fetched,
                    servedFromDisk: me.skipped,
                    rateLimited: me.throttled,
                    finalIntervalMs: me.interval
                },
                sources: sources.length ? sources : [...me.urls].sort(),
                counts,
                notes,
                files: files.length,
                bytes: files.reduce((total, f) => total + f.bytes, 0),
                checksum: createHash('sha256')
                    .update(files.map(f => `${f.name}:${f.sha256}`).join('\n'))
                    .digest('hex')
            };

        await me.writeJson('meta.json', meta);
        return meta;
    }
}

// Every file in the snapshot except the meta itself, so the checksum describes
// the payload rather than describing itself.
async function hashTree(dir, prefix = '') {
    const entries = await readdir(dir, {withFileTypes: true}),
        files = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            files.push(...await hashTree(join(dir, entry.name), name));
        } else if (name !== 'meta.json') {
            const data = await readFile(join(dir, entry.name));

            files.push({
                name,
                bytes: data.length,
                sha256: createHash('sha256').update(data).digest('hex')
            });
        }
    }
    return files;
}

// What the transform step reads to decide whether a source is fresh enough to
// build from. Returns the newest completed snapshot for a source.
export async function latest(source) {
    const dir = join(STORE, source);

    if (!existsSync(dir)) {
        return null;
    }

    const dates = (await readdir(dir)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();

    for (const date of dates) {
        const metaFile = join(dir, date, 'meta.json');

        if (existsSync(metaFile)) {
            const meta = JSON.parse(await readFile(metaFile, 'utf8'));

            return {
                ...meta,
                dir: join(dir, date),
                ageDays: Math.floor((Date.now() - Date.parse(meta.fetchedAt)) / 86400000)
            };
        }
    }
    return null;
}
