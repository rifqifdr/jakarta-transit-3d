/**
 * Second research pass (5 Sept 2026): folds source verification, the fare
 * model and the scale analysis into the handover page, and answers the one
 * JAKAR-27 question the first pass left open.
 */
import {plane} from './plane.mjs';

const SLUG = 'jakarta-publictrans-3d',
    PROJECT = '9a6895df-57a2-4b8c-a9f6-fe0b8e2f60e2',
    BASE = `/workspaces/${SLUG}/projects/${PROJECT}`,
    HANDOVER = '7c4d2257-b640-4e7a-9365-b66b34e321d9',
    JAKAR27 = '17603246-386e-4488-99b8-0fa5856f3fac';

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
        console.log(`  ! ${options?.method || 'GET'} ${path} -> ${response.status} ${JSON.stringify(response.data).slice(0, 200)}`);
    }
    return response;
}

const FARES_COMMENT = h(
    p(`${b('Follow-up, same session — question 5 (fares) is now answerable.')} Full detail in §5 of the research page.`),
    quote(`${b('JakLingko caps a multi-modal journey at Rp 10,000 within 3 hours')}, across TransJakarta, MRT, LRT, KRL and Mikrotrans, on one card.`),
    p(`Confirmed from JakLingko's own EIPTJ site (${c('devweb.jaklingko.co.id/eiptj')}) and independently corroborated by an external document citing Indonesian policy literature. EIPTJ is the body holding the government mandate for integrated payment, data and tariff across modes.`),
    p(`${b('Why this is easier than feared:')} ${c('fares.js')} already models a 3-hour integrated transfer window for buses. The cross-mode rule is ${em('the same window plus a cap')} — an extension of existing logic, not a new fare engine. The error to avoid is per-agency or distance-based summing, which ${b('overestimates')} multi-modal cost.`),
    h3('Also settled since the first comment'),
    ul([
        `${b('Question 4 (rendering) has a cost answer.')} Rail adds ~100 vehicles at evening peak against 6,600 buses — about ${b('1.6%')} more fleet. KRL ~68 (measured, Little's Law), LRT Jabodebek ~21, MRT ~12. ${b('The render path is not the constraint; the data pipeline is.')}`,
        `${b('Question 1 (mode as a field) is reinforced.')} KAI Commuter alone spans Jabodetabek commuter rail, airport rail and Yogyakarta/Solo operations. Agency does not determine mode.`,
        `${b('A new constraint for question 2.')} Only KRL supplies trip identity. MRT and LRT give station departure boards only, so trips must be reconstructed — and MRT runs ${b('short workings from Blok M')} that naive chaining silently corrupts. See §3 of the research page; it changes the effort estimate for JAKAR-29.`
    ])
);

console.log('Comment on JAKAR-27:');
const commentResponse = await call(`${BASE}/issues/${JAKAR27}/comments/`, {
    method: 'POST',
    body: {comment_html: FARES_COMMENT}
});
console.log(commentResponse.ok ? `  added (${FARES_COMMENT.length} chars)` : '  FAILED');

const HANDOVER_HTML = h(
    p(`Read this first. Kept current at the end of each working session: where the project stands and what to pick up next.`),
    p(`Repo ${c('~/Dev/2026/transjakarta-3d-map')} — CLAUDE.md there has commands, conventions, and the traps this codebase has already fallen into.`),

    h2('Where this is going'),
    p(`My vision is to make people have visibility regarding public transportation in Jakarta or Greater Jakarta Area.`),
    p(`The map began as Transjakarta buses and is becoming a view of all public transport in Greater Jakarta — MRT, LRT and Commuter Line alongside the buses.`),
    p(`${b('As of 5 Sept 2026 this is no longer blocked on data.')} Two research passes established that every rail mode has a reachable source, that OpenStreetMap supplies the geometry none of them carry, and what the integrated fare rule is. See the page ${b('"Multi-modal Data Sources — Research, Sept 2026"')}.`),

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
    p(`Seven tickets are open. The build tickets are ready; two older ones still need a decision from you.`),
    table(
        ['Ticket', 'What', 'Status'],
        [
            [b('JAKAR-28'), 'Build the KRL feed from the official KCI API', `${b('Ready.')} Source, join and scale all measured. Do this first — zero inference needed`],
            [b('JAKAR-29'), 'Build the MRT and LRT feeds', `${b('Ready,')} but harder than it looks — see the short-workings finding`],
            [b('JAKAR-31'), 'Transjakarta TLS cert + the GTFS-RT question', `${b('Has a clock on it.')} Cert expired 1 Sept 2026`],
            ['JAKAR-30', 'Retire Comuline from the docs', 'Small correction'],
            ['JAKAR-26', 'Rename and rebrand away from Transjakarta', `${b('Needs your naming decision.')} Scope question now settled by evidence`],
            ['JAKAR-24', 'Measure where straight-line walking is wrong', 'Analysis only. Now has a free routing engine and a strong prior'],
            ['JAKAR-25', 'Search → journey flow crosses the screen', `${b('Needs your layout decision')}`],
            ['JAKAR-27', 'Design the mode dimension', 'Design spike. All five data questions now answered']
        ]
    ),

    h3('What the research established'),
    ul([
        `${b('Rail is cheap to render, expensive to source.')} ~100 rail vehicles at peak against 6,600 buses — ${b('1.6%')} more fleet for roughly double the perceived network. All the work is in the pipeline.`,
        `${b('KRL is the best-served mode, not the worst.')} ${c('kci.id')} exposes ${c('/api/krl/train-schedule?trainid=')}, returning a full ordered stop sequence — a ${c('stop_times')} table in all but name. 1,098 Jabodetabek trips/day, ~18,700 rows, ~29 min to harvest, ~68 trains on screen at peak.`,
        `${b('The difficulty axis is trip identity, not network size.')} Only KRL says which vehicle a departure belongs to. MRT and LRT need reconstruction — and ${b('MRT runs short workings from Blok M')} that naive chaining splices into impossible trains. Validate against ${b('geographic')} order, never sorted time.`,
        `${b('Geometry was the real blocker, and OSM solves it.')} No operator source carries a coordinate. 41 relations, 21,503 vertices, 38 with ordered stops, official colours — joining to operator station names at ${b('98.8%')}.`,
        `${b('Fares are settled.')} JakLingko caps multi-modal at ${b('Rp 10,000 within 3 hours')}. An extension of ${c('fares.js')}, not a new engine.`,
        `${b('There is no realtime.')} No GTFS-RT found for any Jakarta operator. The app stays a scheduled simulation — by design, not by accident.`,
        `${b('The walking error is geometric.')} Ratio 1.55× but implied speed 4.73 km/h against the model's 4.8. Correct the geometry, not the speed.`
    ]),

    h3('A working rule this session earned'),
    quote(`${b('A live endpoint is not a fresh one, a confident README is not data, and a citation count is not evidence.')} Comuline still answers but froze 17 months ago. An "unofficial MRT GTFS" repo has three releases and zero assets. An external document supplied OTP config pointing at a domain that returns NXDOMAIN. ${b('Every number in the research page was fetched, not cited.')}`),

    h3('JAKAR-26 — the rename'),
    p(`Two questions: what it is called, and whether the scope is Jakarta or Greater Jakarta. ${b('The research settles the second on evidence:')} KRL reaches Rangkasbitung and Cikarang, LRT reaches Bekasi and Cibubur, KAI Bandara reaches the airport. The network is emphatically ${b('Jabodetabek')}. The name still needs a human decision. Do it before the mode work — every day it stays, it spreads.`),

    h3('JAKAR-25 — the flow problem'),
    p(`Search is on the left; the preview and starting point are top right. You look at two corners to do one thing. Three options are on the ticket; B (one left-hand column) is strongest but moves the clock, and the current layout was chosen deliberately. ${b('Ask before building.')}`),

    h2('Known weak points'),
    ul([
        `${b('Walking is straight-line.')} JAKAR-24, the weakest assumption in the router. Now with a measured prior: correct the geometry, not the speed.`,
        `${b('GPU performance is unmeasured.')} Every frame-rate figure came from a software rasteriser. Simulation costs 0.22 ms/frame; the render path has never run on real hardware. Rail adds only ~1.6% more vehicles, so this stays the open question.`,
        `${b('One mode is baked into the code')} — one vehicle geometry, one speed profile, category filters that are Transjakarta's product names. See JAKAR-27.`,
        `${b('Every rail source is scraped, none contracted.')} Mitigation in JAKAR-28/29: vendor dated snapshots so a dead source degrades to stale, not silently wrong.`,
        `${b('The Transjakarta GTFS cert expired 1 Sept 2026.')} Host is up, feed still serves, ordinary clients fail. JAKAR-31.`,
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
