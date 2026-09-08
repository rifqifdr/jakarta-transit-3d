/**
 * Writes the multi-modal data-source research (Sept 2026) into Plane, as one
 * page plus the tickets that follow from it.
 *
 * Idempotent by name: re-running updates rather than duplicating. Pages take
 * PUT, work items PATCH — the asymmetry is Plane's, not ours.
 *
 * As elsewhere, description_html must be a single unbroken line: TipTap turns
 * whitespace between block tags into empty paragraphs.
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

const PAGE_NAME = 'Multi-modal Data Sources — Research, Sept 2026',
    PAGE_HTML = h(
        p(`${b('Research, 5 September 2026.')} No code written. Question: is there viable data for MRT, LRT and KRL, and for the roads and footways underneath them? Everything below was fetched and measured. Where a number is estimated rather than measured, it says so.`),

        h2('Executive summary'),
        quote(`${b('All four rail modes can be built.')} The blocker was never timetables — it is that no operator source carries a coordinate. OpenStreetMap supplies the geometry and joins to operator station names at ${b('98.8%')}.`),
        ul([
            `${b('Cost to the render path is negligible.')} Rail adds roughly ${b('100 vehicles at evening peak')} against 6,600 buses — about ${b('1.6%')} more fleet, for something closer to double the perceived network. ${b('All the work is in the data pipeline, none in rendering.')}`,
            `${b('The app stays a simulation.')} No GTFS-Realtime feed was found for any Jakarta operator. Live vehicle positions are not available today.`,
            `${b('Fares are now answerable.')} JakLingko caps a multi-modal journey at ${b('Rp 10,000 within 3 hours')} across TransJakarta, MRT, LRT, KRL and Mikrotrans.`,
            `${b('The real difficulty axis is trip identity')}, not mode or network size — see §3. It decides how hard each mode is, and it is not what you would guess.`,
            `${b('Two external research documents were checked')} against live sources. One contains a fabricated API endpoint presented as copy-pasteable config — see §9.`
        ]),

        h2('1. Verdict by source'),
        table(
            ['Source', 'Use it?', 'Why'],
            [
                [`KRL — ${c('kci.id')} API`, b('Yes — build on it'), 'Unauthenticated. Returns full ordered trip stop-sequences. The richest source found'],
                [`MRT — Strapi API`, b('Yes'), '13 stations, 3,012 departure times. Reachable by plain curl'],
                ['LRT Jabodebek — HTML', b('Yes'), '18 stations, 5,158 weekday departures, server-rendered'],
                ['LRT Jakarta — form', b('Probably'), '6 stations; times behind a POST. One probe away'],
                ['OSM route relations', b('Yes — essential'), 'The only source of geometry and coordinates for any rail mode'],
                ['Transjakarta GTFS', b('Already in use'), 'Official. Feed is current. But see the TLS problem in §8'],
                ['Comuline', b('No'), 'Frozen since 2025-03-30. Whole GitHub org dormant'],
                ['Moovit', b('Benchmark only'), 'Proprietary, bot-protected. Confirms coverage is achievable, supplies no data'],
                ['ArcGIS TransJakarta layers', b('No'), 'GTFS fields republished. 6,904 stops vs 8,092 in the feed — a staler subset'],
                ['Community GTFS repos', b('No'), `${c('akherlan/transjakartagtfs')} last pushed 2021; ${c('soluvas/gtfs-indonesia')} 2015`],
                [`Unofficial MRT GTFS repo`, b('No — it is empty'), 'See §9. Contains no data despite claiming to']
            ]
        ),

        h2('2. What was measured'),
        table(
            ['Mode', 'Stations', 'Service/day', 'Geometry', 'Confidence'],
            [
                ['KRL (Jabodetabek)', '83 served', `${b('1,098 trips')}, ~18,700 stop_times`, '21.5k vertices, 26 relations', b('Measured') + ' — 110 stations harvested, 0 failures'],
                ['MRT North-South', '13', '142 weekday deps/direction', '210 vertices, 13 ordered stops', b('Measured')],
                ['LRT Jabodebek', '18', '5,158 weekday deps', '421 + 398 vertices', b('Measured')],
                ['LRT Jakarta', '6', 'unknown — behind a form', '100 vertices, only 4 of 6 stops', b('Partial')],
                ['Transjakarta (existing)', '~7,500 drawn', '~6,600 vehicles at peak', '164k vertices', 'Already built']
            ]
        ),
        p(`${b('Scale on screen, at evening peak.')} KRL from Little's Law (L = λ × W) over measured trip spans; MRT and LRT from measured peak departure rates and published run times. Rounded, and a lower bound for KRL because station boards do not report every train at every station.`),
        table(
            ['Mode', 'Peak departures', 'Run time', 'Concurrent vehicles'],
            [
                ['KRL', 'λ measured per line', 'W = 13–88 min median', b('~68')],
                ['LRT Jabodebek', '15/h per direction', '~42 min avg', '~21'],
                ['MRT', '12/h per direction (5-min headway)', '~30 min', '~12'],
                ['LRT Jakarta', 'assumed ~6/h', '~13 min', '~3 ' + em('(estimate)')],
                [b('Rail total'), '', '', b('~100')],
                ['Buses today', '', '', '~6,600'],
                [b('Increase in fleet'), '', '', b('~1.6%')]
            ]
        ),

        h2('3. The finding that should drive the plan: trip identity'),
        p(`The intuitive difficulty ranking — by network size, or linear-versus-branching — is ${b('wrong')}. The axis that actually decides effort is whether the source ${b('tells you which vehicle a departure belongs to')}.`),
        table(
            ['Mode', 'Gives a trip ID?', 'Reconstruction', 'Risk'],
            [
                ['KRL', `${b('Yes')} — ${c('train_id')}, plus an endpoint returning the whole sequence`, 'None needed. Read it off', b('Low')],
                ['MRT', b('No') + ' — station boards only', 'Chain departures along the line', b('Medium')],
                ['LRT Jabodebek', b('No'), 'Chain, then assign a branch at Cawang', b('Medium-High')],
                ['LRT Jakarta', b('No') + ' — and no times yet', 'Unknown until probed', b('Unknown')]
            ]
        ),
        h3('Why MRT is harder than "13 stations, one straight line" suggests'),
        p(`Taking the first northbound weekday departure at each MRT station and reading them in ${b('geographic')} order, the times do not increase monotonically:`),
        table(
            ['Station (south → north)', 'First departure →HI'],
            [
                ['Lebak Bulus', '05:00:00'],
                ['Fatmawati', '05:03:10'],
                ['Cipete Raya', '05:06:10'],
                ['Haji Nawi', '05:08:20'],
                ['Blok A', '05:10:40'],
                [b('Blok M'), b('05:00:00') + ' ← time goes backwards'],
                ['ASEAN', '05:02:30'],
                ['Senayan', '05:05:00'],
                ['Istora', '05:07:00'],
                ['Bendungan Hilir', '05:09:30'],
                ['Setiabudi', '05:11:30'],
                ['Dukuh Atas', '05:13:40']
            ]
        ),
        p(`Two different trains leave at 05:00 — one from Lebak Bulus, one from ${b('Blok M')}. MRT runs ${b('short workings')}. A naive chain from the terminus would splice them into one impossible train.`),
        quote(`${b('Station-level departure boards cannot distinguish a full run from a short working.')} This is the same ambiguity class as LRT's branch at Cawang, arriving by a different route — and it is invisible unless you check against geographic order rather than sorted time.`),
        p(`${b('Consequence for the plan:')} KRL is genuinely easy and should go first — it validates the whole pipeline with zero inference. MRT and LRT both need a reconstruction step with explicit validation, and MRT should not be assumed trivial because the line is straight.`),

        h2('4. Fitness for the product, feature by feature'),
        p(`What each mode can actually support once built, given the data that exists:`),
        table(
            ['Product capability', 'Bus', 'KRL', 'MRT', 'LRT'],
            [
                ['Vehicles moving on real geometry', '✅', '✅', '✅', '✅'],
                ['Follow a vehicle / on-board camera', '✅', '✅', '✅', '✅'],
                ['Journey planning through the mode', '✅', '✅', '✅', '✅'],
                ['Reachability / isochrones', '✅', '✅', '✅', '✅'],
                ['First & last departure', '✅', '✅', '✅', '✅'],
                ['Frequency colouring', '✅', '✅', '✅', '✅'],
                ['Correct per-vehicle trip identity', '✅', '✅', `⚠️ ${em('inferred')}`, `⚠️ ${em('inferred')}`],
                ['Live vehicle positions', '❌', '❌', '❌', '❌'],
                ['Delays / disruption', '❌', '❌', '❌', '❌'],
                ['Integrated fare across modes', '—', `✅ ${em('rules known, see §5')}`, '✅', '✅']
            ]
        ),
        p(`${b('The honest limit:')} everything the product does today extends to rail. Nothing that needs realtime becomes possible. If live positions ever matter, that is a separate sourcing problem — see the GTFS-RT ticket.`),

        h2('5. Fares — the JakLingko model'),
        p(`This closes question 5 of JAKAR-27. Confirmed from JakLingko's own EIPTJ site (${c('devweb.jaklingko.co.id/eiptj')}) and independently corroborated by an external research document citing Indonesian policy literature.`),
        ul([
            `${b('One card across TransJakarta, MRT, LRT, KRL and Mikrotrans.')}`,
            `${b('Rp 10,000 maximum')} for a multi-modal journey completed ${b('within 3 hours')}.`,
            `EIPTJ = ${em('Elektronifikasi Integrasi Pembayaran Transportasi Jakarta')}, the body with the government mandate for integrated payment, data and tariff across modes.`
        ]),
        p(`${b('Why this is good news:')} the codebase already models a 3-hour integrated transfer window for buses in ${c('fares.js')}. The cross-mode rule is the ${em('same window plus a cap')} — an extension of existing logic, not a new fare engine. Per-agency or distance-based summing would ${b('overestimate')} multi-modal trip cost, which is the specific error to avoid.`),

        h2('6. Geometry — the piece that unlocks everything'),
        p(`No operator source carries a single coordinate. OSM closes it: ${b('41 route relations, 21,503 vertices, 38 with ordered stops')}, carrying official line colours.`),
        table(
            ['Line', 'Ordered stops', 'Vertices', 'Colour'],
            [
                ['MRT North-South (both directions)', '13', '210 / 212', c('#CE0037')],
                ['LRT Jabodebek — Cibubur', '12', '421 / 413', c('#20409A')],
                ['LRT Jabodebek — Bekasi', '14', '398 / 386', c('#0E6938')],
                ['KRL Lin Bogor', '22', '805 / 775', c('#ec2329')],
                ['KRL Lin Lingkar Cikarang (full)', '35 / 36', '1,541 / 1,533', 'blue'],
                ['KRL Lin Rangkasbitung', '17', '1,281 / 1,116', 'green'],
                ['KRL Lin Tangerang', '9', '190 / 187', 'brown'],
                ['LRT Jakarta — Lin Selatan', `4 ${em('(should be 6)')}`, '100', c('#f16227')],
                ['KAI Bandara — Soekarno-Hatta', '5', '572 / 555', c('#2e2f70')]
            ]
        ),
        p(`Rail is ${b('21.5k vertices against the buses\' 164k')} — cheap to add to ${c('shapes.bin')}. MRT East-West has geometry but ${b('zero ordered stops')} because it is under construction; excluding relations with no stops handles it without a special case.`),
        h3('The join, measured'),
        ul([
            `${b('82 of 83')} Jabodetabek KRL stations match on normalised name with four aliases — ${c('SUDB')}→BNI City, ${c('TPK')}→Tanjung Priuk, ${c('UI')}→Universitas Indonesia, ${c('UP')}→Universitas Pancasila. ${b('98.8%')}. The one miss, Rangkasbitung, is a bbox-edge artefact.`,
            `MRT joins as cleanly — OSM carries the sponsor names the operator uses (${c('Cipete Raya TUKU')}, ${c('Blok M BCA')}), so only the ${c('Stasiun MRT ')} prefix needs stripping.`,
            `OSM returns several nodes per station (platform and stop) — ${b('the same containers problem')} as GTFS ${c('parent_station')}, already solved in this codebase.`
        ]),

        h2('7. Walking — and a result that reframes JAKAR-24'),
        table(
            ['Quantity', 'Value'],
            [
                ['Straight-line distance (test pair)', '2,610 m'],
                ['Model at 4.8 km/h', '32.6 min'],
                ['Real pedestrian route', '3,981 m, 50.5 min'],
                [b('Ratio, real ÷ model'), b('1.55×')],
                ['Detour factor, path ÷ straight', '1.53×'],
                [b('Implied real walking speed'), b('4.73 km/h')]
            ]
        ),
        quote(`${b('The 4.8 km/h is very nearly right. It is the straight line that is wrong.')} Essentially the whole 1.55× error is the 1.53× detour.`),
        ul([
            `${b('Do not use the public OSRM demo.')} ${c('router.project-osrm.org')} returns byte-identical results for the foot and driving profiles (4,335 m in 362 s = 43 km/h). It runs only the car profile; a walk study pointed at it would silently measure driving.`,
            `${b('FOSSGIS Valhalla works, free, no key.')} ${c('valhalla1.openstreetmap.de')} with ${c('costing=pedestrian')} returns real routes.`,
            `${b('10,605 footway ways')} in the Jabodetabek core bbox; Overpass base timestamped the same day.`,
            `An external document independently identifies ${b('Dukuh Atas, Manggarai and Jatinegara')} and JPO tagging (${c('bridge=yes')}, ${c('layer=1')}) as the failure points — the same conclusion JAKAR-24 reached from measurement.`
        ]),

        h2('8. Risk register'),
        table(
            ['Risk', 'Severity', 'Status', 'Mitigation'],
            [
                [`${c('gtfs.transjakarta.co.id')} TLS certificate expired 1 Sept 2026`, b('High'), b('Live now'), 'Host is up and serves the zip; ordinary clients fail. Use the MDB mirror, or pin trust. Ticketed'],
                ['No source is contracted — all are scraped', b('High'), 'Structural', 'Vendor dated snapshots so a dead source degrades to stale, not silently wrong'],
                ['MRT short workings corrupt naive chaining', b('Medium-High'), 'Confirmed §3', 'Validate reconstructed trips against geographic order; detect backwards time'],
                ['LRT branch assignment at Cawang', b('Medium-High'), 'Confirmed', 'Constrain with OSM station order; validate against first/last times'],
                [`MRT served from a host named ${c('beweb-dev')}`, b('Medium'), 'Live', 'Pin hostname in config; expect it to move'],
                ['No GTFS-RT anywhere in Jakarta', b('Medium'), 'Confirmed', 'Product stays a simulation. Separate ticket to chase Transjakarta'],
                ['OSM has 4 of 6 LRT Jakarta stations', b('Low'), 'Confirmed', 'Fix upstream in OSM, or hand-correct two'],
                ['KCI returns non-JSON occasionally (1 of 110)', b('Low'), 'Observed', 'Guard the parse'],
                ['Overpass allows only 2 concurrent slots', b('Low'), 'Measured', 'Serialise build-time queries'],
                ['Comuline looks alive but is 17 months stale', b('Low'), 'Neutralised', 'Removed from docs — JAKAR-30']
            ]
        ),

        h2('9. Verification of external research documents'),
        p(`Two documents were checked claim-by-claim against live sources. Both are useful; both contain assertions that do not survive checking. Recording this because ${b('the failure mode is consistent')} — confident prose, real-looking citations, and data that is not there.`),
        h3('Document A — "Jakarta / Jabodetabek Public Transportation Data & API Sources"'),
        table(
            ['Claim', 'Checked'],
            [
                [`${c('sbenua/gtfs-jakarta-mrt')} "provides GTFS static: stations, routes, trips, schedules, shapes"`, `${b('False.')} Repo holds a LICENSE and a README only. 3 releases, ${b('0 assets each')}; zipball is 6.8 KB. Its own validator link 404s`],
                ['ArcGIS TransJakarta datasets, ⭐⭐⭐', `${b('Redundant.')} Literally GTFS fields republished. 6,904 stops vs 8,092 in the feed — a staler subset`],
                ['KRL "publicly documented APIs less straightforward"', `${b('Understated.')} ${c('kci.id')} has three unauthenticated endpoints, one returning whole trip sequences`],
                ['GTFS-RT presented as a stack component', `${b('No evidence.')} Conventional paths 404. Not proof of absence, but nothing found`],
                ['Transjakarta GTFS link', `${b('Broken in practice')} — expired TLS cert. Host is up`]
            ]
        ),
        h3('Document B — "Technical Architecture and Data Sourcing Framework" (Moovit-focused)'),
        p(`Substantially stronger. Its OTP2 / OSM / GTFS / MapLibre architecture is sound; ${c('frequencies.txt')} for Mikrotrans matches what this codebase already does; its pedestrian and JakLingko sections are correct and corroborated. But:`),
        table(
            ['Claim', 'Checked'],
            [
                [`GTFS-RT updaters pointed at ${c('api.transport.jakarta.go.id')}`, `${b('FABRICATED.')} The domain returns ${b('NXDOMAIN')} — it does not exist. It appears inside copy-pasteable ${c('router-config.json')}`],
                ['MRT: "high availability via Jakarta Smart City open portals"', `${b('False.')} Portals are SPAs with no GTFS. Mobility Database holds ${b('3')} Indonesian feeds, none rail`],
                ['LRT: "available via global transit directories"', `${b('False.')} Transitland atlas: ${b('790 feed files, 1 Indonesian')} (Transjakarta)`],
                ['KRL: "available via third-party indices"', `${b('Only Comuline')} — dead since March 2025`],
                ['Community repos to fill feeder gaps', `Real but stale: ${c('akherlan/transjakartagtfs')} 2021, ${c('soluvas/gtfs-indonesia')} 2015`],
                ['JakLingko Rp 10,000 / 3 hours', `${b('Confirmed')} independently — see §5`]
            ]
        ),
        quote(`${b('Rule to carry forward:')} a live endpoint is not a fresh one, a confident README is not data, and a citation count is not evidence. Every number in this page was fetched.`),

        h2('10. Reference and validation sources'),
        table(
            ['Source', 'Value'],
            [
                ['Transport for Jakarta (FDTJ)', `${b('Best validation reference found.')} Community cartography, ${b('June 2026')} integrated network map, plus Depok, Bekasi and locality sheets. Use to sanity-check a reconstructed network`],
                ['Mobility Database mdb-1909', 'Transjakarta feed quality: no errors, 5 warnings, 2 notices. Report 28 Jul 2026. Fetches daily at 00:00 UTC'],
                ['Geofabrik Indonesia', `${c('indonesia-260904.osm.pbf')}, 1.65 GB, rebuilt daily. For a self-hosted foot router`],
                ['Overpass API', 'Live. 2 concurrent slots — serialise build-time queries'],
                [`${c('transjakarta.co.id/routes')}`, '~120 route codes in plain HTML. Redundant vs GTFS; fine as a name cross-check'],
                ['Moovit Jakarta index', 'Confirms MRT, LRT Jakarta, LRT Jabodebek, KCI and Transjakarta are all mappable. Also surfaces DAMRI, KAI Bandara, KCIC (Whoosh), Trans Kota Tangerang as scope questions'],
                ['RPubs — Public Transportation Routes in Jakarta', `Sept 2024 R/${c('osmdata')} teaching exercise. No new data; cites Nominatim relation ${c('6362934')} as the Jakarta boundary`]
            ]
        ),

        h2('11. Recommended sequence'),
        ol([
            `${b('JAKAR-28 — KRL first.')} Largest mode, richest source, ${b('zero inference required')}. It proves the whole multi-modal pipeline (OSM geometry + operator times + name join) against the easiest possible case. If it does not work here, it will not work anywhere.`,
            `${b('JAKAR-29 — MRT next, then LRT Jabodebek.')} Both need trip reconstruction with validation. MRT is smaller and its ambiguity (short workings) is easier to detect than LRT's (branch assignment).`,
            `${b('LRT Jakarta last.')} Smallest network, one unresolved probe, and an OSM gap to fix.`,
            `${b('Fares after the modes land.')} The rule is known and small; it is an extension of ${c('fares.js')}, not new machinery.`,
            `${b('GTFS-RT is a separate question')} and should not block any of the above.`
        ]),
        p(`${b('Architecture, unchanged from §1–6:')} geometry and ordered stops from OSM at build time; times from the operator source; join on normalised station name with a small checked-in alias table; emit the existing intermediate format, because RAPTOR is already mode-agnostic. ${b('Vendor dated snapshots rather than fetching live.')}`),

        h2('Method, so the numbers can be audited'),
        ul([
            `KRL: all 110 enabled stations harvested from ${c('/api/krl/schedules')} (451 s, 0 failures); trips counted by distinct ${c('train_id')}; stop counts from a stratified sample of 20 trips across 5 lines (20/20 complete). Concurrency by Little's Law over trip spans reconstructed from station boards — ${b('a lower bound')}, since not every station reports every train.`,
            `MRT: all 13 stations from the Strapi ${c('datum')} endpoint; headways computed from the raw ${c('weekdaysEnd')} list; the short-working finding comes from ordering first departures ${b('geographically')} rather than by time.`,
            `LRT: 36 tables parsed from the rendered page; peak counted in the 17:00–18:00 window; trunk stations carry both directions (430 ≈ 2 × 215), termini one (214).`,
            `OSM: Overpass, Jabodetabek bbox, ${c('route=subway|light_rail|train')}, ${c('out geom')}.`,
            `Join: normalised case and punctuation, four hand aliases, restricted to stations actually served by a Jabodetabek line.`,
            `External claims: DNS resolution, HTTP status, GitHub API for repo contents and release assets.`,
            em('Raw samples kept in the session scratchpad, not committed.')
        ])
    );

// ------------------------------------------------------------- the tickets

const TICKETS = [
    {
        name: 'Build the KRL Commuter Line feed from the official KCI API',
        priority: 'high',
        state: STATE.todo,
        labels: [LABEL.feature, LABEL.foundation],
        html: h(
            p(`${b('Now unblocked.')} Evidence on the page ${b('"Multi-modal Data Sources — Research, Sept 2026"')}.`),
            h2('Why this one first'),
            p(`KRL is the largest missing mode and ${b('the only one whose source hands over trip identity')}. Every other mode needs trips inferred from station boards; this one does not. It proves the whole pipeline — OSM geometry, operator times, name join — against the easiest possible case.`),
            h2('The source'),
            p(`${c('kci.id')}, no auth, no key, plain ${c('curl')} works:`),
            ul([
                `${c('/api/krl/stations')} — 113 stations`,
                `${c('/api/krl/schedules?stationid=&timefrom=00:00&timeto=23:59')} — every departure at a station; enumerates ${c('train_id')}s`,
                `${c('/api/krl/train-schedule?trainid=')} — ${b('the full ordered stop sequence with times')}`
            ]),
            h2('Measured'),
            ul([
                `110 stations harvested, ${b('0 failures')}, 451 s.`,
                `${b('1,098 Jabodetabek trips/day')} — Cikarang 361, Bogor 359, Rangkasbitung 192, Tangerang 122, Tanjung Priuk 64.`,
                `70 further trips are Yogyakarta/Solo/Merak/Walahar/Jatiluhur — ${b('filter them out')}.`,
                `Stratified sample of 20 trips: ${b('20/20')} complete sequences.`,
                `~${b('18,700 stop_times rows/day')}, ~${b('29 min')} to harvest at 150 ms between calls.`,
                `${b('~68 trains on screen at evening peak')} (Little's Law; lower bound).`
            ]),
            h2('Geometry comes from OSM, not KCI'),
            p(`${b('KCI returns no coordinates.')} Take geometry and ordered stops from OSM relations (Lin Bogor 22 stops / 805 vertices, Lingkar Cikarang 35 / 1,541, Rangkasbitung 17 / 1,281, Tangerang 9 / 190) and join on normalised station name.`),
            p(`Join proven: ${b('82 of 83')} with four aliases — ${c('SUDB')}→BNI City, ${c('TPK')}→Tanjung Priuk, ${c('UI')}→Universitas Indonesia, ${c('UP')}→Universitas Pancasila.`),
            h2('Traps'),
            ul([
                `${b('Times wrap past midnight.')} Train 1469 runs 23:10 → 00:37 — trap 6 in CLAUDE.md in a second feed. Reuse the un-wrapping in ${c('timetable.js')}.`,
                `${b('One station in 110 returned a non-JSON body.')} Guard the parse.`,
                `${b('Several OSM nodes per station')} (platform and stop) — same containers problem as ${c('parent_station')}.`,
                `${b('Overpass allows 2 concurrent slots.')} Serialise.`,
                `${b('Do not use Comuline.')} Frozen at 2025-03-30, still answering.`
            ]),
            h2('Acceptance'),
            ul([
                `Build-time harvester producing the existing intermediate format for KRL.`,
                `Data vendored with the date taken.`,
                `Non-Jabodetabek lines excluded.`,
                `Trips render along real OSM geometry.`,
                `${c('npm run test-routing')} still passes.`
            ])
        )
    },
    {
        name: 'Build the MRT and LRT feeds (MRT Jakarta, LRT Jabodebek, LRT Jakarta)',
        priority: 'high',
        state: STATE.todo,
        labels: [LABEL.feature, LABEL.foundation],
        html: h(
            p(`Companion to JAKAR-28. Same architecture, three smaller networks — but ${b('none of them gives trip identity')}, so each needs a reconstruction step with validation. Evidence on the page ${b('"Multi-modal Data Sources — Research, Sept 2026"')}.`),
            h2('Do not assume MRT is trivial because the line is straight'),
            p(`Reading the first northbound departure at each station in ${b('geographic')} order, time goes ${b('backwards')} at Blok M:`),
            p(`Lebak Bulus 05:00 → Fatmawati 05:03:10 → Cipete 05:06:10 → Haji Nawi 05:08:20 → Blok A 05:10:40 → ${b('Blok M 05:00:00')} → ASEAN 05:02:30 → Senayan 05:05 → … → Dukuh Atas 05:13:40.`),
            p(`${b('MRT runs short workings from Blok M.')} Two different trains leave at 05:00. Naive chaining from the terminus splices them into one impossible train. ${b('Validation must compare against geographic order, not sorted time')} — sorting by time and checking monotonicity proves nothing.`),
            h2('MRT — Strapi API'),
            ul([
                `${c('beweb-dev.jakartamrt.co.id/middleware/api/datum')} with ${c('filters[field][slug]=stasiun')}.`,
                `${b('Reachable by plain curl')} — pass ${c('--globoff')} so ${c('[]')} in the query string is not treated as a glob. No headless browser needed.`,
                `${b('13 stations')}, ${b('3,012 departure times')}, 142 weekday departures/direction, 5-min peak headway, span 05:00–23:27.`,
                `Times in ${c('object.schedule')} as semicolon-separated lists: ${c('weekdaysEnd')}, ${c('weekendsEnd')}, ${c('weekdaysStart')}, ${c('weekendsStart')}.`,
                `Termini carry one direction only — correct, not missing.`,
                `${b('Caution:')} production served from a host named ${c('beweb-dev')}. Pin it. Unknown content types return ${c('500')}, so discover endpoints from the app.`
            ]),
            h2('LRT Jabodebek — server-rendered HTML'),
            ul([
                `${c('lrtjabodebek.kai.id/jadwal-keberangkatan')}, 3.8 MB, whole timetable inline. No API.`,
                `${b('18 stations')} × 2 day types = 36 tables, 8,400 times. Weekday 5,158, holiday 3,242.`,
                `Trunk stations carry both directions (430 ≈ 2 × 215); termini one (214). Peak 15/h per direction from Dukuh Atas. ${b('~21 trains on screen at peak.')}`,
                `${b('The hard part:')} branch assignment at ${b('Cawang')} — a departure may be bound for Harjamukti or Jati Mulya. Constrain with OSM station order and validate against first/last times.`
            ]),
            h2('LRT Jakarta — one probe away'),
            ul([
                `${c('lrtjakarta.co.id/jadwal.html')} lists ${b('6 stations')}; times appear only after a form submission. Probe with a ${c('POST')}.`,
                `${b('OSM has only 4 of the 6 stations')} — the single place OSM under-covers. Fix upstream or hand-correct.`
            ]),
            h2('Geometry'),
            p(`MRT North-South 13 stops / 210 vertices / ${c('#CE0037')}; LRT Jabodebek Cibubur 12 / 421 / ${c('#20409A')} and Bekasi 14 / 398 / ${c('#0E6938')}; LRT Jakarta Lin Selatan 4 / 100 / ${c('#f16227')}.`),
            p(`${b('MRT East-West has geometry but zero ordered stops')} — under construction. Excluding relations with no stops handles it without a special case.`),
            p(`MRT names join easily: OSM carries the sponsor names the operator uses (${c('Cipete Raya TUKU')}, ${c('Blok M BCA')}); strip the ${c('Stasiun MRT ')} prefix.`),
            h2('Acceptance'),
            ul([
                `MRT and LRT Jabodebek build and render on real geometry.`,
                `${b('Reconstructed trips validated against geographic order')}, with short workings and branch splits detected rather than smoothed over.`,
                `A written answer on LRT Jakarta: extractable, or hand-built from published times.`,
                `Snapshots vendored with their date.`
            ])
        )
    },
    {
        name: 'Retire Comuline as a KRL source — it has been frozen since March 2025',
        priority: 'medium',
        state: STATE.todo,
        labels: [LABEL.concepts, LABEL.quickWin],
        html: h(
            p(`${b('A correction to the record.')} JAKAR-27 and CLAUDE.md describe Comuline as a third-party API that "scrapes KAI's schedules daily — a real lead, and a dependency risk". Measured 5 September 2026, that is no longer true.`),
            h2('Evidence'),
            ul([
                `${c('api.comuline.com/v1/station')} returns 113 stations, last ${c('updated_at')} ${b('2025-03-30')}.`,
                `Schedules checked at seven stations — MRI, BKS, THB, DP, JAKK, POC, BOO. ${b('All')} report a maximum ${c('updated_at')} of 2025-03-30.`,
                `${b('The whole GitHub org is dormant:')} ${c('api')} 2025-03-30, ${c('web')} 2025-04-03, ${c('android')} 2025-08-22, ${c('ios')} 2024-09-02. Nothing in 2026.`,
                `${b('17 months stale.')} The API still answers — which is what makes it a trap.`
            ]),
            h2('Why it stopped mattering'),
            p(`Comuline was scraping ${c('kci.id')}, which is directly readable with no auth ${b('and returns more')} — ${c('/api/krl/train-schedule')} gives full ordered stop sequences. ${b('The dependency was never necessary.')}`),
            h2('The work'),
            ul([
                `Correct the KRL row in the CLAUDE.md data table and in JAKAR-27.`,
                `Record the lesson: ${b('a live endpoint is not a fresh one')} — freshness must be asserted from the data, not from a 200.`,
                `Note the mitigation now adopted: vendor dated snapshots.`
            ]),
            h2('Acceptance'),
            ul([
                `No document in the repo or Plane still describes Comuline as a daily-updating source.`,
                `The KCI API is named as the KRL source in its place.`
            ])
        )
    },
    {
        name: 'Transjakarta GTFS feed: expired TLS certificate, and the open question of GTFS-Realtime',
        priority: 'high',
        state: STATE.todo,
        labels: [LABEL.foundation, LABEL.quickWin],
        html: h(
            p(`Two things about the project's own feed host, found while verifying external research on 5 September 2026.`),
            h2('1. The certificate expired on 1 September 2026'),
            p(`${c('gtfs.transjakarta.co.id')} is ${b('up')} and still serves the feed, but its TLS certificate (wildcard ${c('*.transjakarta.co.id')}) expired four days ago:`),
            ul([
                `${c('notBefore=Sep 1 00:00:00 2025 GMT')}, ${c('notAfter=Sep 1 23:59:59 2026 GMT')}.`,
                `Any ordinary client fails with ${c('SSL certificate problem: certificate has expired')} — ${c('curl')} returns exit 60 and no HTTP status at all.`,
                `With verification bypassed the zip downloads normally (2,497,332 bytes).`,
                `${b('This looks like the site being down.')} It is not.`
            ]),
            h3('What to do'),
            ul([
                `${b('Nothing is broken today')} — the vendored feed is current, and identical to what the origin serves.`,
                `If the feed must be refetched before the cert is renewed, use the ${b('Mobility Database mirror')}: ${c('mdb-1909')}, refreshed daily at 00:00 UTC, quality report 28 Jul 2026 with no errors.`,
                `${b('Do not blanket-disable TLS verification')} in any build script. If a bypass is needed, pin it to this one host with a comment and a date.`,
                `Worth reporting to Transjakarta — they may not know.`
            ]),
            h3('Feed freshness, checked'),
            p(`The origin feed is ${b('byte-identical in shape')} to the project's local copy — 240 routes, 8,092 stops, 701 trips. ${b('The local feed is current.')} The MDB ${c('mdb-latest')} bucket object is a ${b('May 2026 snapshot')} with 252 routes; those 12 extra routes (JJF1–JJF7, 10C, 10D, 1N, 21ST, JAK.42A) have since been withdrawn. ${b('Do not re-add them.')}`),
            h2('2. Is there a GTFS-Realtime feed at all?'),
            p(`${b('The open question, and the highest-value one left.')} It is the difference between a simulation and live vehicle positions.`),
            ul([
                `${b('Nothing found.')} Conventional paths on the GTFS host — ${c('vehiclepositions.pb')}, ${c('tripupdates.pb')}, ${c('alerts.pb')}, ${c('gtfs-rt.pb')} — all return 404. The index page lists no realtime feed.`,
                `An external research document supplied OTP updater config pointing at ${c('api.transport.jakarta.go.id')}. ${b('That domain does not exist')} — it returns ${b('NXDOMAIN')}. The endpoints were fabricated; do not build against them.`,
                `${b('But absence of evidence is not evidence of absence.')} Transjakarta's own Tije app shows live arrivals, so ${b('something')} serves vehicle positions. The same document claims a Transjakarta–Moovit telemetry partnership.`
            ]),
            h3('The work'),
            ul([
                `Inspect what the Tije mobile app or ${c('transjakarta.co.id')} calls for live arrivals.`,
                `Ask Transjakarta directly whether a GTFS-RT endpoint exists or is planned — the feed is official, so there is someone to ask.`,
                `If one exists, assess it separately: this project is a scheduled simulation by design, and realtime is an addition, not a correction.`
            ]),
            h2('Acceptance'),
            ul([
                `A written answer on whether Jakarta GTFS-RT exists, with evidence either way.`,
                `The certificate situation recorded in CLAUDE.md so it is not rediscovered as an outage.`,
                `No build script silently disabling TLS verification.`
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
