/**
 * Writes the data platform architecture (Sept 2026) into Plane: one design
 * page plus the tickets that implement it.
 *
 * Idempotent by name. Pages take PUT, work items PATCH.
 * description_html must be one unbroken line — TipTap turns whitespace between
 * block tags into empty paragraphs. <pre> content is exempt: newlines inside it
 * survive because the collapse only matches '>' followed by whitespace then '<'.
 */
import {plane} from './plane.mjs';

const SLUG = 'jakarta-publictrans-3d',
    PROJECT = '9a6895df-57a2-4b8c-a9f6-fe0b8e2f60e2',
    BASE = `/workspaces/${SLUG}/projects/${PROJECT}`;

const LABEL = {
    feature: 'd34811c0-e3f7-4a2a-b869-43b954ca9d36',
    foundation: 'd3b80dd4-2f71-4fed-85b0-f26d3b58ad16',
    concepts: '08614747-6f67-4b3e-af03-9c88d50f7167',
    quickWin: 'c6cad7f0-8619-4b39-b303-f567d48c62a7'
};

const STATE = {
    backlog: 'd25e2953-b56a-43f9-a4b5-4f9023444cb8',
    todo: '17e4fb66-e413-401a-af6a-a14c81a41d3d'
};

const h = (...parts) => parts.join('').replace(/>\s+</g, '><').trim(),
    p = t => `<p>${t}</p>`,
    h2 = t => `<h2>${t}</h2>`,
    h3 = t => `<h3>${t}</h3>`,
    ul = items => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`,
    ol = items => `<ol>${items.map(i => `<li>${i}</li>`).join('')}</ol>`,
    b = t => `<strong>${t}</strong>`,
    c = t => `<code>${t}</code>`,
    em = t => `<em>${t}</em>`,
    esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    pre = t => `<pre><code>${esc(t)}</code></pre>`,
    quote = t => `<blockquote><p>${t}</p></blockquote>`,
    table = (headers, rows) => `<table><thead><tr>${
        headers.map(x => `<th><p>${x}</p></th>`).join('')
    }</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(x => `<td><p>${x}</p></td>`).join('')}</tr>`).join('')
    }</tbody></table>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(path, options) {
    const response = await plane(path, options);

    await sleep(250);
    if (!response.ok) {
        console.log(`  ! ${options?.method || 'GET'} ${path} -> ${response.status} ${JSON.stringify(response.data).slice(0, 250)}`);
    }
    return response;
}

// ---------------------------------------------------------------- the page

const PAGE_NAME = 'Data Platform Architecture — Storage, Serving, Pipeline',
    PAGE_HTML = h(
        p(`${b('Design note, 5 September 2026.')} How data is stored, built, served and consumed as the map grows from one bus operator to every public transport mode in Greater Jakarta. Every number below was measured against the current build.`),

        h2('The answer in one line'),
        quote(`${b('Stay static-first.')} Do not add a database or an application server for the map. Restructure the artifacts — mode-sliced, binary, versioned, served from a CDN — and add a thin service only for realtime and telemetry, neither of which exists yet.`),
        p(`${b('The counter-intuitive result that drives this:')} encoding trips as binary rather than JSON makes the ${em('entire multi-modal network smaller than today\'s bus-only build')}. The scaling problem people expect here does not exist. The real problems are provenance, validation and load sequencing — and those are the ones five scraped sources actually create.`),

        h2('1. What this app is, architecturally'),
        p(`The ambition is "Google Maps for Jabodetabek public transport, in 3D". Useful as a product north star, ${b('actively misleading as an architecture')}, because the two systems have opposite data-access shapes.`),
        table(
            ['', 'Google Maps', 'This app'],
            [
                ['Renders', 'What is in the viewport', b('The entire network at once')],
                ['At peak', 'A few hundred visible features', b('~6,700 vehicles simultaneously')],
                ['Data access', 'Spatially tiled, fetched on pan/zoom', b('Whole schedule resident in memory')],
                ['Time', 'Now', b('Any time of day, replayed at up to 1200×')],
                ['Server role', 'Essential — tiles, routing, search at planetary scale', b('Optional — one metro area, one day of schedule')]
            ]
        ),
        quote(`${b('You cannot tile a simulation.')} A vehicle off-screen still has to be where it would be when it comes back on screen, and scrubbing to 18:00 needs every trip at once. The whole-network-in-memory model is not a limitation to outgrow — it is what the product requires.`),
        p(`This is why the static architecture is right, and why "we are like Google Maps now" should ${b('not')} be read as "we need Google's infrastructure". One metro area's schedule is small. The scale is in the ${em('animation')}, not the data.`),

        h2('2. Where we are — measured'),
        table(
            ['Artifact', 'Raw', 'Gzipped', 'Contents'],
            [
                [c('network.json'), '1.87 MB', '0.52 MB', '8,091 stops, 240 routes, 700 trips, walk table, fares, calendar'],
                [c('shapes.bin'), '1.25 MB', '0.48 MB', '164k vertices, delta-encoded Int32'],
                [c('routes.geojson'), '1.44 MB', '0.33 MB', 'Simplified lines for display'],
                [b('Total'), b('4.56 MB'), b('1.33 MB'), '']
            ]
        ),
        p(`All three are fetched in parallel at boot by ${c('src/network.js')} and held in memory. ${b('5,289 lines of client source, no backend, no database.')} The walk table is already a compact CSR structure — ${c('ids')} 7,488, ${c('offsets')} 7,489, ${c('targets')}/${c('seconds')} 28,737 each.`),
        p(`${b('This design is good.')} Build-time geometry, runtime binary search and lerp. The delta-encoded ${c('shapes.bin')} is the right instinct already applied once — the recommendation below is mostly ${em('apply it to the rest')}.`),

        h2('3. Where multi-modal takes us — measured'),
        table(
            ['Dimension', 'Today', 'With MRT + LRT + KRL', 'Growth'],
            [
                ['Trips', '700', '~2,632', '+276%'],
                ['Stop entries across trips', '26,427', '~55,948', '+112%'],
                ['Stops', '8,091', '~8,211', '+1.5%'],
                ['Shape vertices', '164k', '~186k', '+13%'],
                ['Walk edges', '28,737', '~30,467', b('+6%')],
                ['Vehicles at peak', '~6,600', '~6,700', b('+1.6%')]
            ]
        ),
        p(`${b('Cross-mode interchange, measured:')} of 136 rail stations in the Jabodetabek bbox, ${b('87 have at least one bus stop within 400 m')}, producing ${b('1,730 new bidirectional walk edges')} — a 6% increase on a table that already holds 28,737. Busiest interchanges: Tanah Abang (28 nearby bus stops), Tanjung Priuk (27), ASEAN HQ, Kebayoran and Bendungan Hilir (21 each).`),
        quote(`Rail is ${b('cheap to render and cheap to route')} — +1.6% fleet, +6% walk edges — while roughly doubling the perceived network. The cost is entirely in ${b('sourcing and pipeline')}, not runtime.`),

        h2('4. The finding: binary trips reverse the growth'),
        p(`Trips are stored as JSON carrying stop-id ${em('strings')} (${c('"G00402"')}). That is ${b('29.9 bytes per stop entry')}. Replacing the string with a ${c('Uint16')} index into the stops array — 8,091 stops fits comfortably — plus a ${c('Uint16')} time offset gives 4 bytes.`),
        table(
            ['Encoding', 'Raw', 'Gzipped'],
            [
                ['Trips today, JSON with string ids', '0.75 MB', '0.25 MB'],
                [`Trips today, binary ${c('Uint16')} index`, '52 KB', b('22 KB') + ' — 11× smaller'],
                ['All modes, binary index + time @ 4 bytes', b('0.21 MB'), '']
            ]
        ),
        table(
            ['Scenario', 'Gzipped payload'],
            [
                ['Today (bus only, JSON trips)', '1.33 MB'],
                ['Multi-modal, JSON trips', '~2.26 MB'],
                [b('Multi-modal, binary trips'), b('~1.2 MB') + ' — ' + em('smaller than today')]
            ]
        ),
        p(`${b('So the whole network of every mode ships in roughly what the buses cost now.')} This single change absorbs the entire multi-modal payload growth, and it extends a pattern the codebase already uses and documents.`),

        h2('5. Target architecture'),
        pre(`  SOURCES            INGEST              TRANSFORM          ARTIFACTS         SERVE        CLIENT
  ────────           ──────              ─────────          ─────────         ─────        ──────
  Transjakarta ─┐
  KCI API       │   adapters/       ┌─ canonical model      core.json
  MRT Strapi    ├──▶ fetch + ──────▶│  (mode first-class)   trips-<mode>.bin   CDN    ┌─▶ manifest
  LRT HTML      │   snapshot        │                       shapes-<mode>.bin  (imm-  │   core
  LRT form      │      │            ├─ OSM geometry join    walk.bin           utable)│   modes on
  OSM Overpass ─┘      ▼            │                       lines-<mode>.json    │    │   demand
                  snapshots/        └─ VALIDATION GATE      manifest.json ───────┴────┘      │
                  <src>/<date>/         (fails the build)                                    ▼
                  raw, dated, vendored                                              Worker + IndexedDB`),
        h3('Layer 1 — Ingest'),
        p(`One adapter per source under ${c('scripts/ingest/')}, all with the same contract: fetch, and write a ${b('raw, dated snapshot')}. ${b('No transformation during fetch')} — the snapshot is the truth we can re-derive from.`),
        ul([
            `${c('data/snapshots/<source>/<YYYY-MM-DD>/')} plus a ${c('meta.json')} recording fetch time, source URLs, record counts and a checksum.`,
            `${b('This is the answer to "every source is scraped, none contracted."')} A dead source degrades to stale, never to silently wrong — which is exactly how Comuline failed.`,
            `Rate-limit aware: Overpass allows ${b('2 concurrent slots')}; KCI needs ~150 ms between calls (~29 min for a full KRL harvest).`,
            `Idempotent and resumable — a full harvest must survive being interrupted.`
        ]),
        h3('Layer 2 — Transform to a canonical model'),
        p(`Normalise every source into one internal schema with ${b('mode as a first-class field')}, not derived from agency (JAKAR-27). KAI Commuter alone spans commuter rail, airport rail and Yogyakarta/Solo operations.`),
        ul([
            `Entities: ${c('agency')}, ${c('mode')}, ${c('route')}, ${c('pattern')}, ${c('trip')}, ${c('stop')}, ${c('station')}, ${c('shape')}, ${c('transfer')}, ${c('fare_rule')}.`,
            `Geometry joined from OSM via a ${b('checked-in alias table')} — proven at 98.8%, four aliases.`,
            `${b('Deterministic:')} identical snapshots must produce byte-identical artifacts, or content hashing and caching are worthless.`
        ]),
        h3('Layer 3 — Validation gate'),
        p(`${b('A build that fails validation must not publish.')} With one hand-checked GTFS feed this was optional; with five scraped sources it is the difference between stale data and wrong data. The checks this specific data needs:`),
        table(
            ['Check', 'Catches'],
            [
                ['Referential integrity', 'A trip referencing a stop or shape that does not exist'],
                ['Midnight unwrap', 'Trap 6 — a 23:10 → 00:37 trip read as 28 minutes long'],
                [b('Geographic monotonicity'), b('MRT short workings') + ' — times running backwards along the line at Blok M'],
                ['Branch assignment', 'LRT trips at Cawang assigned to the wrong terminus'],
                ['Stop-to-shape distance', 'A station joined to the wrong OSM node'],
                ['Volume drift vs previous build', 'A scrape that silently returned half the network'],
                ['Snapshot freshness', 'A source that stopped updating — the Comuline failure, detected'],
                ['Non-JSON response guard', 'Observed: 1 of 110 KCI stations returned a string']
            ]
        ),
        h3('Layer 4 — Artifacts'),
        p(`Content-hashed and immutable, so they can be cached forever and rolled back instantly:`),
        pre(`  data/
    manifest.json                  mutable, short TTL - the only file that changes
    core-<hash>.json               stops, stations, routes, modes, calendar, fares
    walk-<hash>.bin                CSR transfer table (ids/offsets/targets/seconds)
    shapes-<mode>-<hash>.bin       delta-encoded Int32 vertices
    trips-<mode>-<service>-<hash>.bin   Uint16 stop index + Uint16 time offset
    lines-<mode>-<hash>.geojson    simplified display geometry`),
        p(`${b('The manifest is the keystone.')} It carries schema version, build timestamp, the file list with hashes and sizes, and ${b('per-mode provenance')}: which source, which snapshot date, how old. Everything else is immutable and cacheable for a year.`),
        h3('Layer 5 — Serving'),
        table(
            ['Asset', 'Cache policy', 'Why'],
            [
                [`${c('manifest.json')}`, `${c('max-age=60, stale-while-revalidate')}`, 'The only mutable file; cheap to revalidate'],
                ['Everything else', `${c('max-age=31536000, immutable')}`, 'Content-hashed — the name changes when the bytes do'],
                ['Origin', b('Static CDN. No application server.'), 'There is nothing for a server to compute at request time']
            ]
        ),
        p(`Pre-compress with ${b('Brotli')} at build time; it beats gzip by roughly 15% on this kind of payload and costs nothing at request time.`),
        h3('Layer 6 — Client'),
        ol([
            `${b('Fetch manifest')} — tiny, tells the client what exists and how fresh it is.`,
            `${b('Fetch core')} — stops, routes, modes, calendar. ${b('Paint the map and stops now.')} This is first meaningful paint.`,
            `${b('Fetch enabled modes')} — shapes and trips per mode, in parallel, ${b('in a Web Worker')} so decode never blocks the render loop.`,
            `${b('Cache in IndexedDB keyed by content hash')} — repeat visits start instantly and work offline. A hash miss is the only thing that triggers a refetch.`
        ]),
        p(`${b('Mode toggles must gate loading, not just visibility.')} Someone who only wants MRT should not pay for 1,098 KRL trips. This is the main structural reason to slice artifacts per mode.`),

        h2('6. API surface — what is actually needed'),
        p(`Almost nothing. Stated explicitly so it is not built by reflex:`),
        table(
            ['Capability', 'Needs a server?', 'Why'],
            [
                ['Network data', b('No'), 'Static, content-hashed, CDN'],
                ['Journey planning (RAPTOR)', b('No'), 'Runs client-side today on the full network; rail adds 6% to the walk table'],
                ['Reachability / isochrones', b('No'), 'Same graph, same reasoning'],
                ['Search over stops', b('No'), '~8,200 stops indexes fine client-side'],
                ['Vehicle simulation', b('No'), 'Deterministic from schedule + clock. This is the whole design'],
                [b('GTFS-Realtime'), b('Yes — when it exists'), 'CORS, protobuf decode and polling all want a proxy. None found yet (JAKAR-31)'],
                [b('Telemetry / analytics'), b('Yes — thin'), 'To learn what people actually do with the map'],
                ['Saved journeys, accounts', b('Later, if ever'), 'Deep links already cover sharing without identity']
            ]
        ),
        p(`If and when a service appears, keep it to ${c('/api/rt/*')} and ${c('/api/telemetry')}. ${b('It must never sit in the path of loading the map')} — a realtime outage should degrade to the scheduled simulation, which is the product's normal state anyway.`),

        h2('7. Provenance as a product surface'),
        p(`Every rail source is scraped and none is contracted. That is a permanent condition, so it should be ${b('visible rather than hidden')}.`),
        ul([
            `The manifest already carries per-mode snapshot dates — surface them: ${em('"KRL schedule as of 5 Sept 2026"')}.`,
            `${b('Degrade loudly.')} A mode whose snapshot is older than a threshold should say so in the UI, not quietly serve stale trips.`,
            `${b('This is the Comuline lesson made structural.')} That API still answers today; it froze 17 months ago. A 200 is not freshness. The manifest turns freshness into data the UI can read.`
        ]),

        h2('8. Frontend integration and UX'),
        table(
            ['Concern', 'Approach'],
            [
                ['First paint', 'Manifest + core only. Map and stops appear before any trip data loads'],
                ['Progressive reveal', 'Modes stream in; each becomes interactive as it lands, rather than one long blocking spinner'],
                ['Main-thread budget', 'All decode and index building in a Worker. The render loop must keep its frame'],
                ['Repeat visits', 'IndexedDB by content hash — near-instant, and offline'],
                ['Mode filtering', 'Gates loading as well as drawing (see §5)'],
                ['Deep links', `${c('url-state.js')} must carry mode selection, or a shared link silently changes what the recipient sees`],
                ['Slow connections', 'Core is a fraction of the payload; the map is usable while rail streams'],
                ['Failure', 'A missing mode artifact disables that mode with a message — it must not break the map']
            ]
        ),
        p(`${b('One existing trap to respect:')} panels are built once per selection and only their values rewritten (trap 1 in CLAUDE.md). Progressive loading introduces a new way to violate that — do not rebuild a panel because a mode finished loading behind it.`),

        h2('9. What we are deliberately not building'),
        table(
            ['Not building', 'Why not'],
            [
                ['A database', 'Nothing queries at request time. The client holds the whole network by design'],
                ['Vector tiles for transit data', 'Tiling breaks the simulation — off-screen vehicles still need positions'],
                ['A server-side routing service', 'RAPTOR runs client-side on this network size and stays responsive'],
                ['A microservice split', '5,289 lines of client and one build script. Splitting adds failure modes, not capability'],
                ['Kubernetes / queues / a warehouse', 'The pipeline is a scheduled batch job producing ~1 MB of artifacts'],
                ['User accounts', 'Deep links already share state. Identity is a product decision, not an architectural need']
            ]
        ),
        quote(`Every one of these becomes right at some scale. ${b('None of them is right at one metro area and 1 MB of schedule.')} Revisit if the payload passes ~10 MB gzipped, or realtime arrives with per-user state.`),

        h2('10. Migration path'),
        p(`Each phase ships independently and none blocks the mode work in JAKAR-28/29.`),
        table(
            ['Phase', 'Ticket', 'Delivers'],
            [
                ['1', b('JAKAR-32'), 'Ingest layer — source adapters and the dated snapshot store'],
                ['2', b('JAKAR-33'), 'Canonical multi-modal model and the validation gate'],
                ['3', b('JAKAR-34'), 'Binary artifacts, content hashing and the manifest'],
                ['4', b('JAKAR-35'), 'Progressive client loading, Worker decode, IndexedDB cache'],
                ['5', 'JAKAR-31', 'Thin realtime proxy — only if a GTFS-RT feed is found']
            ]
        ),
        p(`${b('Order matters.')} Phase 3 (binary artifacts) is what absorbs the multi-modal payload growth, so it should land before or alongside the second mode. Phase 1 is what makes five scraped sources survivable, so it should land before the first.`),

        h2('11. Risks'),
        table(
            ['Risk', 'Severity', 'Mitigation'],
            [
                ['Binary formats are harder to debug than JSON', b('Medium'), `Ship a ${c('--json')} debug output from the same builder; never hand-write the decoder twice`],
                ['Content hashing without determinism breaks caching', b('Medium'), 'Make the transform deterministic and test it — same snapshots, same bytes'],
                ['Progressive loading introduces panel rebuild bugs', b('Medium'), 'Trap 1 in CLAUDE.md. Build shells once; write values only'],
                ['Worker adds serialisation cost', b('Low'), 'Transfer ArrayBuffers, do not structured-clone them'],
                ['IndexedDB unavailable (private mode)', b('Low'), 'Cache is an optimisation — always work without it'],
                ['Over-engineering ahead of need', b('Medium'), `§9 exists to prevent it. ${b('The payload is ~1 MB')}`]
            ]
        ),

        h2('Method'),
        ul([
            `Payload sizes measured with ${c('wc -c')} and ${c('gzip -c')} against the current ${c('public/data/')} build.`,
            `Per-entity costs derived from ${c('network.json')}: 700 trips, 26,427 stop entries, 29.9 bytes each.`,
            `Binary projection built by actually encoding the current trips to ${c('Uint16')} indices and gzipping the result — 52 KB raw, 22 KB gzipped, 0 unresolved stop ids.`,
            `Cross-mode interchange computed by haversine from 136 OSM rail stations against all 8,091 stops at the existing 400 m radius.`,
            `Rail trip and stop-time counts from the research page — measured, not estimated.`
        ])
    );

// ------------------------------------------------------------- the tickets

const TICKETS = [
    {
        name: 'Data pipeline: source adapters and a dated snapshot store',
        priority: 'high',
        state: STATE.todo,
        labels: [LABEL.foundation],
        html: h(
            p(`Phase 1 of the page ${b('"Data Platform Architecture — Storage, Serving, Pipeline"')}. ${b('Should land before the second mode does.')}`),
            h2('The problem'),
            p(`${c('build-data.mjs')} reads one local GTFS directory. Multi-modal means ${b('five sources with five different shapes')} — a JSON API, a Strapi endpoint, a server-rendered HTML table, a form POST, and Overpass — and ${b('none of them is contracted')}. All are scraped.`),
            quote(`Comuline still answers today and froze 17 months ago. ${b('A 200 is not freshness.')} The pipeline has to make that detectable rather than invisible.`),
            h2('The shape'),
            p(`One adapter per source under ${c('scripts/ingest/')}, all with the same contract: ${b('fetch, and write a raw dated snapshot')}. No transformation during fetch — the snapshot is the truth everything else is re-derived from.`),
            pre(`  data/snapshots/<source>/<YYYY-MM-DD>/
      raw payloads, exactly as fetched
      meta.json  - fetch time, source URLs, record counts, checksum`),
            h2('Adapters needed'),
            table(
                ['Source', 'Shape', 'Notes'],
                [
                    [c('gtfs-transjakarta'), 'Zip download', `${b('TLS cert expired 1 Sept 2026')} — see JAKAR-31. Do not blanket-disable verification`],
                    [c('kci'), 'JSON API, 3 endpoints', '110 stations then ~1,098 trips. ~150 ms between calls, ~29 min total'],
                    [c('mrt'), 'Strapi JSON', `Plain curl works with ${c('--globoff')}. Host is named ${c('beweb-dev')} — pin it`],
                    [c('lrt-jabodebek'), 'HTML scrape', '3.8 MB page, 36 tables'],
                    [c('lrt-jakarta'), 'Form POST', 'Unresolved — probe first'],
                    [c('osm'), 'Overpass', `${b('2 concurrent slots')} — serialise queries`]
                ]
            ),
            h2('Requirements'),
            ul([
                `${b('Idempotent and resumable')} — a 29-minute harvest must survive interruption without restarting.`,
                `${b('Rate-limit aware')} per source, with the limits above encoded, not remembered.`,
                `${b('Guard every parse.')} Observed: 1 of 110 KCI stations returned a non-JSON string.`,
                `${b('Never fetch at build time from the transform step.')} Transform reads snapshots only, so builds are reproducible offline.`,
                `Snapshots are vendored — a dead source degrades to stale, never to missing.`
            ]),
            h2('Acceptance'),
            ul([
                `${c('npm run ingest -- --source=kci')} produces a dated snapshot with ${c('meta.json')}.`,
                `Running it twice on the same day is a no-op, not a duplicate.`,
                `An interrupted KRL harvest resumes without refetching what it already has.`,
                `Snapshot age is readable by the transform step, so staleness can be surfaced later.`
            ])
        )
    },
    {
        name: 'Canonical multi-modal data model and a validation gate that fails the build',
        priority: 'high',
        state: STATE.todo,
        labels: [LABEL.foundation],
        html: h(
            p(`Phase 2 of ${b('"Data Platform Architecture — Storage, Serving, Pipeline"')}. Depends on JAKAR-32; closely related to the design spike in JAKAR-27.`),
            h2('Canonical model'),
            p(`Normalise every snapshot into one schema with ${b('mode as a first-class field')} — not derived from agency. ${b('KAI Commuter alone')} spans Jabodetabek commuter rail, airport rail, and Yogyakarta/Solo operations, so agency cannot determine mode.`),
            p(`Entities: ${c('agency')}, ${c('mode')}, ${c('route')}, ${c('pattern')}, ${c('trip')}, ${c('stop')}, ${c('station')}, ${c('shape')}, ${c('transfer')}, ${c('fare_rule')}.`),
            ul([
                `Geometry and ordered stops joined from OSM via a ${b('checked-in alias table')} — proven at ${b('98.8%')} with four aliases (${c('SUDB')}, ${c('TPK')}, ${c('UI')}, ${c('UP')}).`,
                `${b('The transform must be deterministic')} — identical snapshots produce byte-identical output, or the content hashing in JAKAR-34 is worthless.`,
                `Layer filters must move from Transjakarta's product categories to ${b('mode above category')}.`
            ]),
            h2('The validation gate'),
            p(`${b('A build that fails validation must not publish.')} With one hand-checked feed this was optional. With five scraped sources it is the difference between stale data and wrong data.`),
            table(
                ['Check', 'Catches'],
                [
                    ['Referential integrity', 'A trip referencing a stop or shape that does not exist'],
                    ['Midnight unwrap', 'Trap 6 — a 23:10 → 00:37 trip read as 28 minutes long'],
                    [b('Geographic monotonicity'), `${b('MRT short workings')} — first departures run backwards at Blok M`],
                    ['Branch assignment', 'LRT trips at Cawang bound to the wrong terminus'],
                    ['Stop-to-shape distance', 'A station joined to the wrong OSM node'],
                    ['Volume drift vs previous build', 'A scrape that silently returned half the network'],
                    ['Snapshot freshness', 'A source that stopped updating — Comuline, detected'],
                    ['Parse guard', 'Non-JSON body from an API that normally returns JSON']
                ]
            ),
            h3('The monotonicity check has a trap of its own'),
            p(`Sorting departures by time and then testing that they increase is ${b('circular — it proves nothing')}. The check must compare against ${b('geographic')} station order taken from the OSM relation. That is exactly how the MRT short working at Blok M was found: five stations ascend from Lebak Bulus, then Blok M reads 05:00:00 and time goes backwards.`),
            h2('Acceptance'),
            ul([
                `A canonical model that holds all five modes with mode above category.`,
                `Validation runs as part of the build and ${b('fails it')} — no publishing invalid artifacts.`,
                `The MRT Blok M case is a regression test, not a comment.`,
                `Re-running the transform on unchanged snapshots produces identical bytes.`,
                `${c('npm run test-routing')} still passes.`
            ])
        )
    },
    {
        name: 'Binary artifacts, content hashing and a manifest with per-mode provenance',
        priority: 'high',
        state: STATE.todo,
        labels: [LABEL.foundation, LABEL.feature],
        html: h(
            p(`Phase 3 of ${b('"Data Platform Architecture — Storage, Serving, Pipeline"')}. ${b('This is the phase that absorbs the entire multi-modal payload growth')} — it should land before or alongside the second mode.`),
            h2('The measurement that justifies it'),
            p(`Trips are JSON carrying stop-id ${em('strings')} — ${b('29.9 bytes per stop entry')}. Replacing the string with a ${c('Uint16')} index into the stops array (8,091 stops fits) plus a ${c('Uint16')} time offset gives 4 bytes.`),
            table(
                ['Encoding', 'Raw', 'Gzipped'],
                [
                    ['Trips today, JSON', '0.75 MB', '0.25 MB'],
                    [`Trips today, binary ${c('Uint16')}`, '52 KB', b('22 KB — 11× smaller')],
                    ['All modes, binary index + time', b('0.21 MB'), '']
                ]
            ),
            table(
                ['Scenario', 'Gzipped total'],
                [
                    ['Today (bus only)', '1.33 MB'],
                    ['Multi-modal, JSON trips', '~2.26 MB'],
                    [b('Multi-modal, binary trips'), b('~1.2 MB — smaller than today')]
                ]
            ),
            p(`Verified by actually encoding the current trips: ${b('0 unresolved stop ids')}. This extends the delta-encoded ${c('shapes.bin')} pattern the codebase already uses and documents.`),
            h2('Artifact layout'),
            pre(`  data/
    manifest.json                  mutable, short TTL - the only file that changes
    core-<hash>.json               stops, stations, routes, modes, calendar, fares
    walk-<hash>.bin                CSR transfer table
    shapes-<mode>-<hash>.bin       delta-encoded Int32 vertices
    trips-<mode>-<service>-<hash>.bin   Uint16 stop index + Uint16 time offset
    lines-<mode>-<hash>.geojson    simplified display geometry`),
            h2('The manifest'),
            p(`The keystone. Carries schema version, build timestamp, the file list with hashes and sizes, and ${b('per-mode provenance')} — which source, which snapshot date, how stale.`),
            p(`${b('That provenance is a product surface, not just metadata.')} Every rail source is scraped; the UI should be able to say "KRL schedule as of 5 Sept 2026" and warn when a mode goes stale. It is the Comuline lesson made structural.`),
            h2('Serving'),
            table(
                ['Asset', 'Cache-Control'],
                [
                    [c('manifest.json'), c('max-age=60, stale-while-revalidate')],
                    ['Everything else', c('max-age=31536000, immutable')]
                ]
            ),
            p(`Pre-compress with ${b('Brotli')} at build time — roughly 15% better than gzip here, free at request time. ${b('Static CDN; no application server.')}`),
            h2('Acceptance'),
            ul([
                `Multi-modal payload ${b('at or below today\'s 1.33 MB gzipped')}.`,
                `Artifacts are content-hashed and immutable; the manifest is the only mutable file.`,
                `Manifest exposes per-mode source and snapshot date.`,
                `A ${c('--json')} debug output exists from the same builder, so binary artifacts stay inspectable.`,
                `Rebuilding unchanged snapshots produces identical hashes.`
            ])
        )
    },
    {
        name: 'Progressive loading: manifest-first boot, Worker decode, IndexedDB cache',
        priority: 'medium',
        state: STATE.todo,
        labels: [LABEL.feature, LABEL.foundation],
        html: h(
            p(`Phase 4 of ${b('"Data Platform Architecture — Storage, Serving, Pipeline"')}. Depends on JAKAR-34.`),
            h2('Today'),
            p(`${c('src/network.js')} fetches all three files in parallel and blocks until every one has arrived and been decoded. Fine for 1.33 MB and one mode; wrong once a user who wants only MRT pays for 1,098 KRL trips.`),
            h2('The boot sequence'),
            ol([
                `${b('Manifest')} — tiny. Tells the client what exists and how fresh each mode is.`,
                `${b('Core')} — stops, routes, modes, calendar, fares. ${b('Paint the map and stops here.')} This is first meaningful paint.`,
                `${b('Enabled modes')} — shapes and trips per mode, in parallel, ${b('decoded in a Web Worker')} so the render loop keeps its frame.`,
                `${b('IndexedDB, keyed by content hash')} — repeat visits start instantly and work offline. A hash miss is the only trigger to refetch.`
            ]),
            h2('Mode toggles must gate loading, not just drawing'),
            p(`This is the main structural reason artifacts are sliced per mode. Turning off KRL should mean ${b('not fetching')} it, not fetching and hiding it.`),
            h2('UX requirements'),
            table(
                ['Concern', 'Requirement'],
                [
                    ['Progressive reveal', 'Each mode becomes interactive as it lands — not one long blocking spinner'],
                    ['Slow connections', 'Map is usable while rail streams in'],
                    ['Failure', 'A missing mode artifact disables that mode with a message; it must not break the map'],
                    ['Staleness', 'Surface per-mode snapshot dates from the manifest; warn when a mode is stale'],
                    ['Deep links', `${c('url-state.js')} must carry mode selection, or a shared link shows the recipient something different`]
                ]
            ),
            h2('Traps'),
            ul([
                `${b('Trap 1 in CLAUDE.md.')} Progressive loading creates a new way to rebuild an interactive panel mid-interaction — do not rebuild a panel because a mode finished loading behind it.`,
                `${b('Transfer ArrayBuffers to the Worker, do not structured-clone them')}, or the copy costs more than the decode saved.`,
                `${b('IndexedDB can be unavailable')} (private browsing). The cache is an optimisation — always work without it.`
            ]),
            h2('Acceptance'),
            ul([
                `Map and stops are visible before any trip data has loaded.`,
                `Disabling a mode prevents its artifacts being fetched at all.`,
                `Decode happens off the main thread; no dropped frames at boot.`,
                `Second visit loads from IndexedDB with no network fetch beyond the manifest.`,
                `Panels are still built once per selection — verified with native input events, not ${c('.click()')}.`
            ])
        )
    }
];

// ------------------------------------------------------------------- write

const pages = await call(`${BASE}/pages/`),
    byName = new Map((pages.data.results || []).map(x => [x.name, x])),
    found = byName.get(PAGE_NAME);

const pageResponse = found ?
    await call(`${BASE}/pages/${found.id}/`, {
        method: 'PUT',
        body: {name: PAGE_NAME, description_html: PAGE_HTML}
    }) :
    await call(`${BASE}/pages/`, {
        method: 'POST',
        body: {name: PAGE_NAME, description_html: PAGE_HTML, access: 0}
    });

console.log(pageResponse.ok ?
    `page ${found ? 'updated' : 'created'}: ${PAGE_NAME} (${PAGE_HTML.length} chars)` :
    `page FAILED: ${PAGE_NAME}`);

const issues = await call(`${BASE}/issues/?per_page=100`),
    byTitle = new Map((issues.data.results || []).map(x => [x.name, x]));

console.log('\nTickets:');
for (const ticket of TICKETS) {
    const existing = byTitle.get(ticket.name),
        body = {
            name: ticket.name,
            description_html: ticket.html,
            priority: ticket.priority,
            state: ticket.state,
            labels: ticket.labels
        },
        response = existing ?
            await call(`${BASE}/issues/${existing.id}/`, {method: 'PATCH', body}) :
            await call(`${BASE}/issues/`, {method: 'POST', body});

    console.log(response.ok ?
        `  ${existing ? 'updated' : 'created'}  JAKAR-${response.data.sequence_id}  ${ticket.name}` :
        `  FAILED  ${ticket.name}`);
}
console.log('\nDone.');
