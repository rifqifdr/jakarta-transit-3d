/**
 * Loads the artifact set, manifest first and one mode at a time.
 *
 * The old loader fetched three files and blocked until every one had arrived
 * and been parsed. That is fine for one mode and 1.33 MB; it is wrong once a
 * viewer who only wants MRT would be paying for 1,097 KRL trips.
 *
 * The sequence:
 *
 *   1. manifest — tiny, and says what exists and how fresh each mode is
 *   2. core     — stops, routes, patterns, calendar. **Paint the map here.**
 *   3. modes    — shapes and trips, per enabled mode, decoded in a Worker
 *
 * Everything but the manifest is content-hashed, so a file's name is a promise
 * about its bytes. That is what makes the IndexedDB cache safe: a hit can be
 * trusted without revalidation, and a miss is the only thing that costs a
 * fetch.
 */

const DB_NAME = 'jakarta-transit-artifacts',
    DB_VERSION = 1,
    STORE = 'files',

    // Only the manifest may be stale, so only the manifest is revalidated.
    MANIFEST = 'manifest.json';

export default class ArtifactLoader {

    constructor(base = 'artifacts/', {cache = true} = {}) {
        const me = this;

        me.base = base.endsWith('/') ? base : `${base}/`;
        me.useCache = cache;
        me.manifest = null;
        me.core = null;
        me.modes = new Map();
        me._worker = null;
        me._pending = new Map();
        me._nextId = 1;
        me._db = null;

        // Counted rather than inferred, so a claim about cache behaviour can be
        // checked instead of believed.
        me.stats = {fetched: 0, fromCache: 0, bytes: 0, decodeMs: 0};
    }

    // ---- boot -------------------------------------------------------------

    /**
     * Manifest and core only. Enough to draw the map and every stop; no trip
     * data at all. This is first meaningful paint.
     */
    async loadCore(onProgress = () => {}) {
        const me = this;

        onProgress('Memuat manifes…');
        me.manifest = await (await fetch(me.base + MANIFEST, {cache: 'no-cache'})).json();

        onProgress('Memuat jaringan…');
        me.core = JSON.parse(new TextDecoder().decode(await me._file(me.manifest.core.file)));

        // Patterns are asked for by index during decode; hoist the stop counts
        // once rather than reaching through the pattern list per trip.
        // Patterns hold every trip's stop sequence, so nothing can be decoded
        // without them; the walk table is what makes interchange possible.
        // Both are mode-independent, which is why they load with core.
        me._patternStops = Uint16Array.from(me.core.patterns.map(p => p.stops));
        me.patternsBuffer = await me._file(me.manifest.patterns.file);

        if (me.manifest.walk) {
            me.walkEdges = (await me._decode('walk', me.manifest.walk.file)).edges;
        }
        return me.core;
    }

    /** Which modes exist, with their size and how stale their source is. */
    available() {
        const me = this;

        if (!me.manifest) {
            return [];
        }
        return Object.entries(me.manifest.modes).map(([id, mode]) => ({
            id,
            routes: mode.routes,
            trips: mode.trips,
            bytes: mode.shapes.bytes +
                Object.values(mode.services).reduce((total, s) => total + s.bytes, 0),
            loaded: me.modes.has(id)
        }));
    }

    /**
     * Freshness, per source, straight from the manifest.
     *
     * Every rail source is scraped and none is contracted, so a mode going
     * stale is a normal condition the interface should be able to state rather
     * than an exception.
     */
    provenance() {
        return this.manifest?.provenance ?? {};
    }

    // ---- modes ------------------------------------------------------------

    /**
     * Shapes and trips for one mode. Nothing is fetched for a mode that is
     * never asked for — the point of slicing the artifacts this way.
     */
    async loadMode(mode, onProgress = () => {}) {
        const me = this;

        if (me.modes.has(mode)) {
            return me.modes.get(mode);
        }
        if (!me.manifest?.modes[mode]) {
            throw new Error(`unknown mode "${mode}"`);
        }

        const entry = me.manifest.modes[mode];

        onProgress(`Memuat ${mode}…`);

        // Shapes and every service day in parallel; they are independent files.
        const [shapes, ...services] = await Promise.all([
            me._decode('shapes', entry.shapes.file),
            ...Object.entries(entry.services).map(async ([service, file]) => ({
                service,
                ...await me._decode(file.kind === 'frequency' ? 'frequency' : 'trips', file.file)
            }))
        ]);

        const loaded = {
            mode,
            shapeIds: entry.shapeIds,
            shapes,
            services: Object.fromEntries(services.map(s => [s.service, s]))
        };

        me.modes.set(mode, loaded);
        return loaded;
    }

    /** Drops a mode's decoded data. The files stay cached; only memory frees. */
    unloadMode(mode) {
        return this.modes.delete(mode);
    }

    // ---- fetching and caching ---------------------------------------------

    async _file(name) {
        const me = this,
            cached = me.useCache ? await me._fromCache(name) : null;

        if (cached) {
            me.stats.fromCache++;
            me.stats.bytes += cached.byteLength;
            return cached;
        }

        const response = await fetch(me.base + name);

        if (!response.ok) {
            throw new Error(`${name}: HTTP ${response.status}`);
        }

        const buffer = await response.arrayBuffer();

        me.stats.fetched++;
        me.stats.bytes += buffer.byteLength;

        if (me.useCache) {
            // Deliberately not awaited: a cache write must never sit between
            // the bytes arriving and the map using them.
            me._toCache(name, buffer).catch(() => {});
        }
        return buffer;
    }

    async _decode(kind, name) {
        const me = this,
            buffer = await me._file(name),
            started = performance.now(),

            // The worker takes ownership of the buffer, so anything that needs
            // to survive the call has to be copied first. Nothing here does.
            result = await me._ask({
                kind,
                buffer,
                patternStops: kind === 'trips' ? me._patternStops : null
            }, [buffer]);

        me.stats.decodeMs += performance.now() - started;
        return result;
    }

    _ask(message, transfer) {
        const me = this;

        if (!me._worker) {
            me._worker = new Worker(new URL('./decode.worker.js', import.meta.url), {type: 'module'});
            me._worker.onmessage = event => {
                const {id, ok, result, error} = event.data,
                    pending = me._pending.get(id);

                if (!pending) {
                    return;
                }
                me._pending.delete(id);
                if (ok) {
                    pending.resolve(result);
                } else {
                    pending.reject(new Error(error));
                }
            };
        }

        const id = me._nextId++;

        return new Promise((resolve, reject) => {
            me._pending.set(id, {resolve, reject});
            me._worker.postMessage({id, ...message}, transfer);
        });
    }

    // ---- IndexedDB --------------------------------------------------------
    //
    // Keyed by filename, and every filename carries a content hash, so a hit is
    // the right bytes by construction. Wrapped throughout: private browsing and
    // blocked site data both make this throw, and it is an optimisation — the
    // map has to work without it.

    async _open() {
        const me = this;

        if (me._db !== null) {
            return me._db;
        }
        me._db = await new Promise(resolve => {
            try {
                const request = indexedDB.open(DB_NAME, DB_VERSION);

                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(STORE)) {
                        request.result.createObjectStore(STORE);
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(false);
                request.onblocked = () => resolve(false);
            } catch {
                resolve(false);
            }
        });
        return me._db;
    }

    async _fromCache(name) {
        const db = await this._open();

        if (!db) {
            return null;
        }
        return new Promise(resolve => {
            try {
                const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(name);

                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    async _toCache(name, buffer) {
        const db = await this._open();

        if (!db) {
            return;
        }
        try {
            const store = db.transaction(STORE, 'readwrite').objectStore(STORE);

            store.put(buffer, name);

            // A rebuild renames every file it changed, so the old ones are
            // dead weight. Sweep anything the current manifest does not name.
            const live = this._live();

            if (live) {
                store.getAllKeys().onsuccess = event => {
                    for (const key of event.target.result) {
                        if (!live.has(key)) {
                            store.delete(key);
                        }
                    }
                };
            }
        } catch {
            // Storage full, or blocked. The map still works.
        }
    }

    _live() {
        const me = this;

        if (!me.manifest) {
            return null;
        }

        const names = new Set([me.manifest.core.file]);

        for (const mode of Object.values(me.manifest.modes)) {
            names.add(mode.shapes.file);
            for (const service of Object.values(mode.services)) {
                names.add(service.file);
            }
        }
        return names;
    }

    /** Forgets everything cached. Exposed for tests and for a hard reload. */
    async clearCache() {
        const db = await this._open();

        if (!db) {
            return false;
        }
        return new Promise(resolve => {
            try {
                const request = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch {
                resolve(false);
            }
        });
    }
}
