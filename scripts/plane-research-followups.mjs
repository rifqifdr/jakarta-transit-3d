/**
 * Folds the September 2026 data research back into the tickets it affects,
 * and refreshes the handover page.
 *
 * Comments rather than rewrites: JAKAR-24 and JAKAR-27 are still the right
 * tickets, they just now have answers to questions they were asking.
 */
import {plane} from './plane.mjs';

const SLUG = 'jakarta-publictrans-3d',
    PROJECT = '9a6895df-57a2-4b8c-a9f6-fe0b8e2f60e2',
    BASE = `/workspaces/${SLUG}/projects/${PROJECT}`,
    HANDOVER = '7c4d2257-b640-4e7a-9365-b66b34e321d9';

const h = (...parts) => parts.join('').replace(/>\s+</g, '><').trim(),
    p = t => `<p>${t}</p>`,
    h2 = t => `<h2>${t}</h2>`,
    h3 = t => `<h3>${t}</h3>`,
    ul = items => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`,
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

const COMMENTS = [
    {
        id: '98b1b11c-ba28-408c-ba89-d1cb19b1b4f2',
        ref: 'JAKAR-24',
        html: h(
            p(`${b('From the research session of 5 Sept 2026')} — full detail on the page ${b('"Multi-modal Data Sources — Research, Sept 2026"')}. Two things here change how this ticket should be run.`),
            h3('1. Do not use the public OSRM demo server'),
            p(`${c('router.project-osrm.org')} returns ${b('byte-identical results for the foot and driving profiles')} — 4,335 m in 362 s for the same pair, which is 43 km/h. It runs only the car profile. A walk study pointed at it would silently measure driving.`),
            h3('2. FOSSGIS Valhalla works, free, no key'),
            p(`${c('valhalla1.openstreetmap.de')} with ${c('costing=pedestrian')} returns real pedestrian routes. This gives the several-hundred-pair sample without spending Mapbox quota, and without standing up OSRM first.`),
            h3('3. The prior this ticket should test'),
            p(`One measured pair (Thamrin → Kuningan):`),
            table(
                ['Quantity', 'Value'],
                [
                    ['Straight-line distance', '2,610 m'],
                    ['Model at 4.8 km/h', '32.6 min'],
                    ['Real pedestrian route', '3,981 m, 50.5 min'],
                    [b('Ratio, real ÷ model'), b('1.55×')],
                    ['Detour factor, path ÷ straight', '1.53×'],
                    [b('Implied real walking speed'), b('4.73 km/h')]
                ]
            ),
            quote(`${b('The 4.8 km/h is very nearly right. It is the straight line that is wrong.')} Essentially the whole 1.55× error is the 1.53× detour.`),
            p(`If that holds over several hundred pairs, the fix is a ${b('geometric detour correction')}, not a speed change — and it fits this ticket's own observation that the error concentrates where a major road intervenes. ${b('Worth adding to the acceptance criteria:')} report the detour factor and the implied speed separately, so the two causes cannot hide in one ratio.`),
            p(`Supporting coverage: ${b('10,605 footway ways')} in the Jabodetabek core bbox, Overpass base timestamped the same day. Official portals ${c('satudata.jakarta.go.id')} and ${c('jakartasatu.jakarta.go.id')} are both reachable but their CKAN search API did not answer at the standard path — an official trotoar/JPO inventory remains ${b('unconfirmed')}.`)
        )
    },
    {
        id: '17603246-386e-4488-99b8-0fa5856f3fac',
        ref: 'JAKAR-27',
        html: h(
            p(`${b('From the research session of 5 Sept 2026')} — full detail and method on the page ${b('"Multi-modal Data Sources — Research, Sept 2026"')}.`),
            quote(`${b('This ticket can stop asking whether the data exists. It does, for all four modes.')} The design question narrows to the mode dimension itself.`),
            h3('Answers to "Where the data actually is"'),
            table(
                ['Mode', 'Was recorded as', 'Actually'],
                [
                    ['KRL', 'No official GTFS; Comuline a lead', `Official ${c('kci.id')} JSON API, no auth. ${b('Returns full ordered trip stop-sequences.')} 1,098 Jabodetabek trips/day, ~18,700 stop_times`],
                    ['MRT', 'No public GTFS found', `Still true — but a Strapi API serves the timetable. 13 stations, 3,012 departure times`],
                    ['LRT Jabodebek', 'No public GTFS found', 'Still true — whole timetable server-rendered into the page. 18 stations, 5,158 weekday departures'],
                    ['LRT Jakarta', 'No public GTFS found', 'Still true — 6 stations, times behind a form. The one genuine unknown left']
                ]
            ),
            h3('Comuline is dead — the dependency risk landed'),
            p(`Frozen at ${b('2025-03-30')} across every station checked; the repo's last commit is the same day. It still answers, which is what makes it a trap. ${b('It was also never necessary')} — it scraped ${c('kci.id')}, which we can read directly and which returns more. Tracked as ${b('JAKAR-30')}.`),
            h3('The real blocker was geometry, and it is solved'),
            p(`${b('No operator source carries a single coordinate.')} For a 3D map that, not the timetables, was the binding constraint. OSM closes it: ${b('41 route relations, 21,503 vertices, 38 carrying ordered stops')}, with official colours. Rail is 21.5k vertices against the buses' 164k — cheap to add.`),
            p(`The join was measured rather than assumed: ${b('82 of 83')} Jabodetabek stations match on normalised name with four aliases (${b('98.8%')}); the single miss is a bbox-edge artefact. MRT joins as cleanly — OSM carries the same sponsor names the operator uses.`),
            h3('Bearing on the five questions'),
            ul([
                `${b('Mode as a first-class field, not derived from agency.')} KAI Commuter alone spans commuter rail, airport rail and non-Jabodetabek regions; agency does not determine mode.`,
                `${b('Separate sources merged at build time.')} There is no combined feed to aim for and no prospect of one. Each mode has a different extraction shape — JSON API, Strapi, HTML scrape, form POST.`,
                `${b('Cross-mode transfers:')} the existing 400 m walk table should work, but see JAKAR-24 — interchanges are exactly where straight-line walking is worst.`,
                `${b('Rendering:')} a six-car train is not a bigger bus, and OSM supplies per-line official colours to key it from.`,
                `${b('Fares remain open.')} Rail prices by distance and JakLingko integration has its own rules. Not researched here.`
            ]),
            h3('One architectural recommendation'),
            p(`${b('Vendor dated snapshots rather than depending live.')} Every source is scraped, none is contracted. A snapshot with the date it was taken degrades to stale rather than silently wrong — which is precisely the failure Comuline just demonstrated.`),
            h3('Scope input for JAKAR-26'),
            p(`KRL reaches Rangkasbitung and Cikarang, LRT reaches Bekasi and Cibubur, KAI Bandara reaches the airport. ${b('The network is emphatically Jabodetabek, not Jakarta.')}`)
        )
    }
];

console.log('Comments:');
for (const comment of COMMENTS) {
    const response = await call(`${BASE}/issues/${comment.id}/comments/`, {
        method: 'POST',
        body: {comment_html: comment.html}
    });

    console.log(response.ok ?
        `  added to ${comment.ref}  (${comment.html.length} chars)` :
        `  FAILED ${comment.ref}`);
}

// ------------------------------------------------------- handover refresh

const HANDOVER_HTML = h(
    p(`Read this first. Kept current at the end of each working session: where the project stands and what to pick up next.`),
    p(`Repo ${c('~/Dev/2026/transjakarta-3d-map')} — CLAUDE.md there has commands, conventions, and the traps this codebase has already fallen into.`),

    h2('Where this is going'),
    p(`My vision is to make people have visibility regarding public transportation in Jakarta or Greater Jakarta Area.`),
    p(`The map began as Transjakarta buses and is becoming a view of all public transport in Greater Jakarta — MRT, LRT and Commuter Line alongside the buses.`),
    p(`${b('As of 5 Sept 2026 that is no longer blocked on data.')} A research session established that every mode has a reachable source, and that OpenStreetMap supplies the geometry none of them carry. See the page ${b('"Multi-modal Data Sources — Research, Sept 2026"')}.`),

    h2('Where the project stands'),
    p(`Around 6,600 buses move at the evening peak, each a real scheduled run from the GTFS feed driven along its actual route geometry. All 16 original backlog tickets are Done.`),
    ul([
        `Live clock, or replay any time of day at up to 1200×, with basemap lighting following the hour.`,
        `Follow a bus — from behind, or on board.`,
        `Plan a journey between stops or from a tapped point; rank by time, transfers or cost.`,
        `Ride that journey inside the simulation, bound to the vehicles actually serving it.`,
        `Reachability from a stop, including free-routes-only.`,
        `First and last bus, live-frequency colouring, and shareable deep links.`
    ]),
    p(`Routing is covered by 78 automated checks — ${c('npm run test-routing')} — run against the real feed rather than fixtures.`),

    h2('Next session: start here'),
    p(`Six tickets are open. The two build tickets below are new and are the ones with momentum behind them.`),
    table(
        ['Ticket', 'What', 'Note'],
        [
            [b('JAKAR-28'), 'Build the KRL feed from the official KCI API', `${b('Ready to build.')} Source proven, join proven, scale measured`],
            [b('JAKAR-29'), 'Build the MRT and LRT feeds', `${b('Ready to build,')} except LRT Jakarta which needs one probe`],
            ['JAKAR-30', 'Retire Comuline from the docs', 'Small correction; it is 17 months stale'],
            ['JAKAR-26', 'Rename and rebrand away from Transjakarta', 'Needs a naming decision first'],
            ['JAKAR-24', 'Measure where straight-line walking is wrong', 'Analysis only. Now has a free routing engine and a strong prior'],
            ['JAKAR-25', 'Search → journey flow crosses the screen', 'Needs a layout decision first'],
            ['JAKAR-27', 'Design the mode dimension', 'Design spike. Data questions now answered']
        ]
    ),

    h3('What the research changed'),
    ul([
        `${b('KRL is the best-served mode, not the worst.')} ${c('kci.id')} exposes ${c('/api/krl/train-schedule?trainid=')}, which returns a full ordered stop sequence with times — a ${c('stop_times')} table in all but name. 1,098 Jabodetabek trips/day, ~18,700 rows, ~29 min to harvest.`,
        `${b('Comuline is dead.')} Frozen at 2025-03-30, repo included, but still answering — so it looks healthy. It was scraping ${c('kci.id')} anyway.`,
        `${b('The binding constraint was geometry, not timetables.')} No operator source carries a coordinate. OSM gives 41 rail relations, 21,503 vertices, 38 with ordered stops and official colours — and joins to operator station names at ${b('98.8%')}.`,
        `${b('Moovit is a benchmark, not a source.')} Proprietary, bot-protected. Useful only to check coverage.`,
        `${b('The walking error is geometric.')} A sampled pair gives ratio 1.55× but an implied walking speed of 4.73 km/h against the model's 4.8. The detour is the error, not the speed.`
    ]),

    h3('JAKAR-26 — the rename'),
    p(`Two questions to settle before touching code: what it is called, and whether the scope is Jakarta or Greater Jakarta. ${b('The research settles the second on the evidence:')} KRL reaches Rangkasbitung and Cikarang, LRT reaches Bekasi and Cibubur, KAI Bandara reaches the airport. The network is emphatically ${b('Jabodetabek')}. The name still needs a human decision.`),
    p(`Do it before the mode work: every day the old name stays it spreads further into code and copy.`),

    h3('JAKAR-25 — the flow problem'),
    p(`The search is on the left, and the preview and starting point are on the top right. You have to look at the top left and the top right to do one thing. Three options are on the ticket. Option B — one left-hand column — is the strongest but moves the clock, and the current layout was chosen deliberately in an earlier session. ${b('Ask before building.')}`),

    h2('Known weak points'),
    ul([
        `${b('Walking is straight-line.')} That is JAKAR-24, and it is the weakest assumption in the router. Now with a measured prior: correct the geometry, not the speed.`,
        `${b('GPU performance is unmeasured.')} Every frame-rate figure so far came from a software rasteriser. The simulation costs 0.22 ms/frame; the render path has never run on real hardware.`,
        `${b('One mode is baked into the code')} — one vehicle geometry, one speed profile, category filters that are Transjakarta's own product names. See JAKAR-27.`,
        `${b('Every rail source is scraped, none is contracted.')} Mitigation adopted in JAKAR-28/29: vendor dated snapshots so a dead source degrades to stale, not broken.`,
        `${b('MRT is served from a host named')} ${c('beweb-dev')}. Expect it to move.`,
        `A followed bus reaching its terminus just closes the card, with no handover to the next departure.`,
        `The Mapbox style is private and renders only for a token on its account.`
    ]),

    h2('How this project is run'),
    ul([
        `Tracked here in Plane. Not Linear — that is a different project of the user's.`,
        `Design documentation lives in this project's Pages, alongside README.md in the repo.`,
        `Plane token is in the repo .env as PLANE_API_TOKEN; ${c('scripts/plane.mjs')} is a small client. Pages update with PUT, work items with PATCH.`,
        `Do not re-run ${c('scripts/plane-seed-tickets.mjs')} — it creates rather than updates.`,
        `Working style: run a queued backlog through without checkpointing after every ticket; ask when a decision is genuinely the user's.`
    ])
);

const response = await call(`${BASE}/pages/${HANDOVER}/`, {
    method: 'PUT',
    body: {name: 'Next Session — Start Here', description_html: HANDOVER_HTML}
});

console.log(`\nHandover page: ${response.ok ? `updated (${HANDOVER_HTML.length} chars)` : 'FAILED'}`);
console.log('\nDone.');
