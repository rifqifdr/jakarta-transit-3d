/**
 * Refines the Transjakarta 3D backlog in Plane.
 *
 * Rewrites every ticket body, wires real dependencies, breaks the router down
 * into sub work items, groups the backlog into modules, sets the project
 * overview, and writes the design documentation as Pages.
 *
 * Idempotent by name: re-running updates what exists rather than duplicating.
 *
 * IMPORTANT on formatting — Plane's editor parses `description_html` with
 * TipTap, which treats whitespace between block tags as text nodes. A newline
 * between </p> and <h3> becomes an empty paragraph, which is what made the
 * first pass render with gaps and blank bullets. Every block of HTML below is
 * therefore emitted as one unbroken line; `h()` enforces it.
 */
import {plane} from './plane.mjs';

const SLUG = 'jakarta-publictrans-3d',
    PROJECT = '9a6895df-57a2-4b8c-a9f6-fe0b8e2f60e2',
    BACKLOG = 'd25e2953-b56a-43f9-a4b5-4f9023444cb8',
    BASE = `/workspaces/${SLUG}/projects/${PROJECT}`;

// Joins fragments into a single line, collapsing any accidental whitespace
// between tags so the editor never sees a stray text node.
const h = (...parts) => parts.join('').replace(/>\s+</g, '><').trim();

const p = t => `<p>${t}</p>`,
    h3 = t => `<h3>${t}</h3>`,
    ul = items => `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`,
    ol = items => `<ol>${items.map(i => `<li>${i}</li>`).join('')}</ol>`,
    b = t => `<strong>${t}</strong>`,
    c = t => `<code>${t}</code>`,
    em = t => `<em>${t}</em>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Plane allows 60 requests a minute per key; this keeps a comfortable margin.
async function call(path, options) {
    const response = await plane(path, options);

    await sleep(180);
    if (!response.ok) {
        console.log(`  ! ${options?.method || 'GET'} ${path} -> ${response.status} ${JSON.stringify(response.data).slice(0, 200)}`);
    }
    return response;
}

// ---------------------------------------------------------------- ticket copy

const FOOTER = h(
    h3('Context'),
    p(`The map draws the whole Transjakarta network in 3D from the GTFS feed — about ${b('6,600 buses')} moving at the evening peak across 240 routes, 700 trip patterns and 8,091 stops — driven by a simulation clock that runs live or replays a day at up to 1200×.`),
    p(`Everything it does today is ${b('observation')}: watch, replay, filter, inspect. This backlog is about what people can ${em('do')} with it.`),
    p(`Repo ${c('~/Dev/2026/transjakarta-3d-map')} · architecture and data pipeline in ${c('README.md')} · design notes in this project's Pages.`)
);

const TICKETS = {
    8: {
        name: 'Journey router: time-dependent path search',
        html: h(
            p(`${b('Goal:')} answer "leaving stop A at time T, what is the fastest way to stop B?" over the existing timetable. Pure logic, no UI.`),
            h3('Why this comes first'),
            p('Three features sit on this one engine — the journey planner, the ride-along journey and the reachability map. Build it once and it pays for all three. It is the only ticket here that blocks anything else.'),
            h3('What the feed allows (measured, not assumed)'),
            ul([
                `${b('All 240 routes are mutually reachable')} by transfers — the route graph is fully connected, so there are no stranded islands to special-case.`,
                `${b('3,043 of 7,488')} network nodes (41%) are served by more than one route.`,
                `${c('transfers.txt')} declares only ${b('7')} interchange pairs, but ${b('15,221 stop pairs')} sit within 400 m of each other offering a different route.`,
                'Service spans 00:00–23:59, so there is no quiet window to ignore.'
            ]),
            p(`${b('The consequence that shapes the design:')} the feed's own transfer list is useless at this scale. The router has to generate walk transfers itself, or it will miss almost every real interchange.`),
            h3('Approach'),
            ul([
                `${b('RAPTOR')} (round-based) over the 700 trip patterns, rather than Dijkstra on a time-expanded graph. Simpler to get right, and each round maps directly onto "number of transfers", which riders actually care about.`,
                `${b('Precompute the walk-transfer table at build time')} — for every stop, all stops within 400 m, with walking time at roughly 4.8 km/h. Ship it in ${c('network.json')} beside the existing stop offsets. ${c('scripts/build-data.mjs')} already builds a spatial grid for exactly this analysis.`,
                `${b('Departures are computed, not looked up.')} The feed is headway-based: the next departure of a pattern at a stop is the next multiple of the headway inside an active ${c('frequencies.txt')} window, offset by the stop's position in the pattern. There is no departure row to read.`,
                `Honour ${c('calendar.txt')}: 612 of 700 trips run daily, 50 are weekday-only, 32 Sunday-only.`
            ]),
            h3('Output'),
            p(`For a query (origin, destination, departure time, service day), return ranked itineraries. Each is a list of legs — ${c('walk')} or ${c('ride')} — carrying boarding and alighting stop, route, board time and alight time, plus totals for duration, transfer count and fare.`),
            h3('Fares do not sum'),
            p(`Fares are per-route with a ${b('10,800-second (3 hour) integrated transfer window')}. A second boarding inside that window is free, so an itinerary's cost is ${em('not')} the sum of its legs. 101 of 240 routes are free outright, 129 cost Rp 3,500, 9 are premium. Getting this right is what makes a "cheapest" sort worth offering.`),
            h3('Acceptance'),
            ul([
                'Blok M → Kota returns Koridor 1 direct, not a three-transfer detour.',
                '"No service at this hour" and "unreachable" are reported clearly rather than returning an empty list.',
                'A typical query completes in roughly 300 ms or less in the browser.',
                'Tests cover hand-checked journeys including one requiring a walk transfer and one crossing midnight.'
            ]),
            h3('Notes'),
            p(`Runs client-side; the data is already loaded. The simulation costs only 0.22 ms/frame today, so if the search starts blocking the animation frame, move it to a Web Worker rather than slicing it.`),
            FOOTER
        )
    },
    9: {
        name: 'Journey planner: tap origin, tap destination',
        html: h(
            p(`${b('Goal:')} tap a stop and choose "Dari sini", tap another and choose "Ke sini", get ranked itineraries and see the chosen one drawn on the map.`),
            p('This is the interaction people expect from a transit map, and the main thing the app is missing.'),
            h3('Detail'),
            ul([
                `${b('Entry points:')} tapping a stop, tapping open map (JAKAR-12), or picking from the existing search box.`,
                `${b('Itinerary card:')} total duration, departure and arrival time, transfer count, total fare, then a leg-by-leg breakdown reusing the existing route badges and category colours.`,
                `${b('Sorting:')} fastest, fewest transfers, cheapest. Cheapest is often literally free — 101 routes cost nothing — so this is more than a cosmetic option.`,
                `${b('On the map:')} ride legs along the real shape geometry in the route's colour, walk legs dashed. The ${c('route-highlight')} layer in ${c('main.js')} is the pattern to follow.`,
                `${b('Departure time')} defaults to the simulation clock and can be edited. Planning at 07:00 and at 23:00 give very different answers, and that difference is worth making visible.`
            ]),
            h3('Acceptance'),
            ul([
                'Two taps produce a plan.',
                'The line drawn matches the itinerary legs exactly.',
                'Clearing the plan restores the previous map state.',
                'Works while the clock is in playback, not only live.'
            ]),
            FOOTER
        )
    },
    10: {
        name: 'Ride your planned journey in the simulation',
        html: h(
            p(`${b('Goal:')} after planning a journey, press play and watch it actually happen. The clock jumps to the departure time, the camera picks up the real bus serving the first leg, follows it, handles the walk transfer, then picks up the next bus.`),
            h3('Why this is the one that matters'),
            p(`Every transit app draws a blue line. None can show you the trip, because none of them simulate the fleet. We already do — roughly 6,600 buses running the real timetable. This turns a plan into something you watch, and it is the feature that makes this ours rather than a Mini Tokyo 3D port with Jakarta data.`),
            h3('Detail'),
            ul([
                `${b('Bind each ride leg to a run that already exists in the fleet')} — a trip pattern plus a departure time — never a vehicle invented for the animation. This is the whole point: if the bus is fake, the feature is just a cutscene.`,
                `Reuse the follow camera already in ${c('main.js')}: ${c('NAV_ZOOM')}, ${c('NAV_PITCH')}, the look-ahead framing and the time-based bearing smoothing.`,
                `${b('Walk legs:')} glide the camera along the walking line at walking pace, so a transfer reads as part of the journey rather than a cut.`,
                `${b('Progress UI:')} current leg, next stop, ETA, "3 stops to go".`,
                `${b('Controls:')} play/pause, speed up, skip to next leg, exit — restoring the previous camera on exit.`
            ]),
            h3('Acceptance'),
            ul([
                'The camera follows a bus that genuinely exists in the fleet at that moment.',
                'Leg handovers are continuous — no teleporting between vehicles.',
                'Works at playback speeds above 1×.',
                'Exiting part-way leaves the map usable.'
            ]),
            FOOTER
        )
    },
    11: {
        name: 'Reachability map from a stop (isochrone)',
        html: h(
            p(`${b('Goal:')} tap a stop, pick a time budget, and paint everything reachable within it — 15 / 30 / 45 / 60 minutes.`),
            h3('Nearly free once the router exists'),
            p('This is the same forward search as JAKAR-8 with the destination removed: run until the budget is exhausted and keep the earliest arrival at every stop reached. Most of the work is already done.'),
            h3('Detail'),
            ul([
                'Colour every reachable stop by arrival-time band; optionally shade the surrounding area for a filled isochrone rather than dots.',
                `${b('Recompute when the departure time changes.')} Reachability at 08:00 and 22:00 are very different, and the existing playback clock turns that into something you can explore by dragging the scrubber.`,
                `${b('Fare filter — the distinctive one.')} Restrict to free routes and answer: ${em('how far can you get in 45 minutes without paying anything?')} With 101 free routes across Mikrotrans and Rusun, that is a question only this dataset answers, and the resulting map is worth publishing on its own.`
            ]),
            h3('Acceptance'),
            ul([
                'The reachable set is correct for at least one hand-checked case.',
                'Recomputes within about a second when the time changes.',
                'Free-only mode produces a visibly smaller area than unrestricted.'
            ]),
            FOOTER
        )
    },
    12: {
        name: 'Click anywhere on the map for nearest stops and departures',
        html: h(
            p(`${b('Goal:')} tapping open map should answer "what can I catch from around here?"`),
            p('Today only stop dots and buses are clickable, but people tap where they are, not on a dot.'),
            h3('Detail'),
            ul([
                'Find the nearest few stops within roughly 800 m of the tapped point.',
                'Show walking distance and time, the routes each serves, and the next departures — the stop card already computes departures, so reuse it.',
                `${b('Feed the journey planner:')} "Dari sini" from an arbitrary point, not only from a stop. This is what makes JAKAR-9 usable for real trips.`,
                `Needs a spatial index over the 7,488 drawn nodes. A simple grid is plenty; ${c('scripts/build-data.mjs')} already builds one for the walk-transfer analysis.`
            ]),
            h3('Acceptance'),
            ul([
                'Tapping open map anywhere in Jakarta returns sensible nearby stops.',
                'Tapping well outside the network says so, rather than offering a stop 30 km away.',
                'Does not disturb existing bus and stop picking — the current handler resolves bus-versus-stop by whichever is nearer the click, so this becomes a third case.'
            ]),
            FOOTER
        )
    },
    13: {
        name: 'Shareable deep links for time, camera and selection',
        html: h(
            p(`${b('Goal:')} encode the current view in the URL, so any view can be bookmarked or sent to someone.`),
            p(c('?t=07:30&amp;z=15.4&amp;c=106.823,-6.188&amp;p=62&amp;b=-18&amp;route=1')),
            h3('State worth encoding'),
            ul([
                'Simulated time, and whether the clock is live or at a set speed',
                'Camera: centre, zoom, pitch, bearing',
                'Selection: bus run or stop, and whether follow mode is on',
                'Active service-category filters, accessibility mode, highlighted route',
                'Later: a planned journey (origin, destination, departure time)'
            ]),
            h3('Detail'),
            ul([
                `Update the URL with ${c('replaceState')}, throttled so dragging the map does not thrash history.`,
                'Parse on load and restore before first paint where possible.',
                'Keep parameters short and readable — these are meant to be pasted into a chat.'
            ]),
            h3('Why do this early'),
            p('It is an afternoon\'s work and it multiplies everything else in this backlog. "Look at Koridor 1 at 07:30" should be a link, not a set of instructions. Nothing here is shareable until it exists.'),
            h3('Acceptance'),
            ul([
                'Round-trip: copy the URL, open in a new tab, same view.',
                'A malformed or partial URL degrades to defaults instead of erroring.'
            ]),
            FOOTER
        )
    },
    14: {
        name: 'Service-level sparkline on the time scrubber',
        html: h(
            p(`${b('Goal:')} draw the day's service curve along the time slider, so the shape of the day is visible and you can drag straight to a peak.`),
            h3('The data, already measured'),
            p('Buses in service, sampled every half hour:'),
            ul([
                '04:30 — 682 (overnight floor)',
                '06:30 — 5,121 (morning ramp)',
                '17:30 — 6,138 (peak)',
                '22:30 — 4,094',
                '23:30 — 1,794'
            ]),
            h3('Detail'),
            ul([
                'Render the curve as a small SVG or canvas layer behind the slider track, with the current position marked.',
                `${b('Recompute when category filters change.')} Hiding Mikrotrans should visibly flatten the curve — it is over half the fleet — which makes the filter's effect legible instead of abstract.`,
                'Optional: stacked curves per service category.'
            ]),
            h3('Acceptance'),
            ul([
                'The curve matches actual active-bus counts.',
                'Dragging behaves exactly as it does now.',
                'Computed once at load, not per frame.'
            ]),
            FOOTER
        )
    },
    15: {
        name: 'First and last bus at a stop',
        html: h(
            p(`${b('Goal:')} show first and last departure on the stop card. "Last bus 22:47" is a real anxiety, and the feed answers it exactly — we simply are not showing it.`),
            h3('Detail'),
            ul([
                `Derive first and last departure per route from the ${c('frequencies.txt')} windows plus the stop's offset within the pattern. This is a computation, not a lookup — the feed is headway-based.`,
                `${b('Respect the service day.')} Weekday, Saturday and Sunday differ: 50 trips are weekday-only and 32 Sunday-only, so the last bus genuinely changes with the day you ask about.`,
                'Call out the case where the last bus has gone, or leaves within about 30 minutes — that is when this matters.'
            ]),
            h3('Acceptance'),
            ul([
                'Correct for a hand-checked stop verified against the raw GTFS.',
                'Correct on a Sunday, where some services do not run.'
            ]),
            FOOTER
        )
    },
    16: {
        name: 'Ride-along camera view (first person from the bus)',
        html: h(
            p(`${b('Goal:')} a first-person view from the bus — camera at roof height looking forward — as an alternative to the chase view from behind and above.`),
            h3('Detail'),
            ul([
                'Reuse the follow camera; drop to roughly 3.5 m and raise the pitch to about 80–85°.',
                'Toggle between "chase" and "ride along" while following.',
                `${b('Keep the time-based bearing smoothing.')} It matters more here, not less: route shapes are polylines, so a heading can snap by up to 86° between frames at a corner, and at eye level that is violent. The existing exponential decay already absorbs it to under 6°/frame.`,
                'Hide or shrink the tracked bus model, currently drawn at 1.7×, which would otherwise fill the frame.'
            ]),
            h3('Acceptance'),
            ul([
                'The view stays stable through corners rather than whipping around.',
                'Switching camera modes does not lose the tracked bus.'
            ]),
            h3('Why bother'),
            p('Pure delight, and close to free since the chase camera does the hard part. It is also the most shareable thing in the app once JAKAR-13 exists.'),
            FOOTER
        )
    },
    17: {
        name: 'Colour route lines by live headway instead of category',
        html: h(
            p(`${b('Goal:')} colour route lines by how long until the next bus, rather than by service category.`),
            h3('Why'),
            p(`Category colour is ${em('static')} — the map looks identical at 07:00 and 23:00, so playback changes the buses but not the picture. Headway colour makes the network breathe: you watch service thin out after 21:00 and see which corridors keep running. It also answers a real question — ${em('is this line useful right now?')}`),
            h3('Detail'),
            ul([
                `Compute the current headway per route from whichever ${c('frequencies.txt')} window is active at the simulated time.`,
                'Ramp along the lines of: under 5 min / 5–15 / 15–30 / over 30 min.',
                'A legend, plus a toggle between "by service" and "by frequency". Category stays the default.',
                `${b('Mind the range:')} headways run from 180 s to 52,700 s (over 14 hours), so the ramp needs a sensible top end or nearly everything lands in one bucket.`,
                'Recompute on a modest interval, not every frame.'
            ]),
            h3('Acceptance'),
            ul([
                'Colours change across the day and match the active windows.',
                'Toggling back to category colouring restores the current appearance exactly.'
            ]),
            FOOTER
        )
    }
};

// Sub work items under the router, so the foundation ticket is decomposable.
const ROUTER_SUBTASKS = [
    {
        name: 'Walk-transfer table in the build step',
        priority: 'high',
        html: h(
            p(`Precompute, for every stop, the stops within 400 m and the walking time between them, and ship the result in ${c('network.json')}.`),
            p(`${b('Why this is not optional:')} ${c('transfers.txt')} declares 7 interchange pairs. Measured against the feed, ${b('15,221 stop pairs')} sit within 400 m of each other offering a different route. Without this table the router misses almost every real interchange in Jakarta.`),
            h3('Notes'),
            ul([
                `${c('scripts/build-data.mjs')} already builds a spatial grid for this exact analysis — reuse it rather than writing a second one.`,
                'Walking speed ~4.8 km/h. Straight-line distance is acceptable at this radius.',
                'Fold station platforms into their parent station, as the stop panel already does, so a transfer within one station is not modelled as a walk.'
            ]),
            h3('Acceptance'),
            ul([
                'Table is emitted and its size is reported in the build log alongside the existing counts.',
                'Known interchanges (e.g. around Harmoni, Dukuh Atas) appear in it.'
            ])
        )
    },
    {
        name: 'Headway-based departure lookup',
        priority: 'high',
        html: h(
            p('Given a trip pattern, a stop and a time, return the next departure.'),
            p(`${b('This is a computation, not a lookup.')} The feed is frequency-based: the departure is the next multiple of the headway inside an active ${c('frequencies.txt')} window, offset by the stop's position in the pattern. There is no row to read.`),
            h3('Detail'),
            ul([
                'Handle patterns with several windows — 18 trips have more than one, and service genuinely thins after 21:00.',
                `Honour ${c('calendar.txt')} service days: 612 of 700 trips run daily, 50 weekday-only, 32 Sunday-only.`,
                'Handle the midnight wrap; the network runs 00:00–23:59.'
            ]),
            h3('Acceptance'),
            ul([
                'Matches the existing stop-card departure logic in main.js for the same inputs.',
                'Returns nothing, rather than a bogus time, outside service windows.'
            ])
        )
    },
    {
        name: 'RAPTOR core: rounds, labels, earliest arrival',
        priority: 'high',
        html: h(
            p('The search itself: round-based scanning of the 700 trip patterns, keeping the earliest arrival at each stop per round.'),
            h3('Detail'),
            ul([
                'One round equals one additional ride, so the round index is the transfer count — expose it, riders care.',
                'Apply the walk-transfer table between rounds.',
                'Cap rounds (4 is generous) to bound the work.',
                'Keep parent pointers so an itinerary can be reconstructed, not just its arrival time.'
            ]),
            h3('Acceptance'),
            ul([
                'Blok M → Kota resolves to Koridor 1 direct.',
                'A journey that genuinely needs a walk transfer is found.',
                'Typical query under ~300 ms in the browser.'
            ])
        )
    },
    {
        name: 'Fare accumulation with the 3-hour transfer window',
        priority: 'medium',
        html: h(
            p('Compute the true cost of an itinerary.'),
            p(`${b('Fares do not sum.')} Every fare carries a 10,800-second (3 hour) integrated transfer window, so a second boarding inside that window is free. 101 of 240 routes are free outright, 129 cost Rp 3,500, 9 are premium (Rp 20,000–35,000).`),
            h3('Acceptance'),
            ul([
                'A two-leg journey inside the window costs one fare, not two.',
                'A journey entirely on free routes costs zero.',
                'Enables a meaningful "cheapest" sort in JAKAR-9.'
            ])
        )
    },
    {
        name: 'Router test suite',
        priority: 'medium',
        html: h(
            p('Hand-checked journeys locking in the behaviour before any UI depends on it.'),
            h3('Cases to cover'),
            ul([
                'Direct corridor ride (Blok M → Kota on Koridor 1).',
                'A journey requiring one transfer at a shared stop.',
                'A journey requiring a walk transfer between nearby stops.',
                'A journey crossing midnight.',
                'A weekday-only service, queried on a Sunday, correctly excluded.',
                'An unreachable pair, reported rather than hanging.'
            ]),
            h3('Acceptance'),
            ul(['Runs in CI or via a single npm script, and fails loudly on regression.'])
        )
    }
];

const MODULES = [
    {
        name: 'Journey Planning',
        description: 'Routing engine and everything built on it: the planner, the simulated ride-along, and reachability. JAKAR-8 blocks the rest.',
        issues: [8, 9, 10, 11]
    },
    {
        name: 'Map Interaction',
        description: 'Making the map answer questions directly — tapping open map, sharing a view, and the timetable facts riders actually ask for.',
        issues: [12, 13, 15]
    },
    {
        name: 'Visualisation & Camera',
        description: 'Changing what the map shows and how you look at it: service over time, live frequency, and the first-person view.',
        issues: [14, 16, 17]
    }
];

const PROJECT_OVERVIEW = h(
    p(`A real-time 3D map of Jakarta's Transjakarta network, in the spirit of Mini Tokyo 3D. Every bus on screen is a real scheduled run from the GTFS feed, moving along its actual route geometry under a simulation clock.`),
    h3('Where it is now'),
    ul([
        `${b('~6,600 buses')} moving at the evening peak, across 240 routes, 700 trip patterns and 8,091 stops.`,
        'Live clock or replay of any time of day at up to 1200×, with basemap lighting following the simulated hour.',
        'Click a bus for route, headsign, fare and a live timetable window; follow it with a turn-by-turn camera.',
        'Click a stop for routes, next departures and interchange walks.',
        'Filter by service category, search routes and stops, and isolate the 39 wheelchair-accessible stops.'
    ]),
    h3('What this backlog adds'),
    p(`Everything above is ${b('observation')}. The work here makes the map answer questions: plan a journey, watch it happen in the simulation, see how far you can get in 45 minutes, and share any view as a link.`),
    h3('Why journey planning is viable'),
    p('Checked against the actual feed before scoping:'),
    ul([
        `${b('All 240 routes are mutually reachable')} by transfers — the graph is fully connected.`,
        `${b('3,043 of 7,488')} network nodes (41%) are served by more than one route.`,
        `${c('transfers.txt')} lists ${b('7')} interchange pairs, but ${b('15,221 stop pairs')} sit within 400 m offering a different route — the router must generate walk transfers itself.`,
        `Fares are per-route with a 3-hour integrated transfer window; ${b('101 of 240 routes are free')}.`
    ]),
    h3('Shape of the work'),
    p(`One investment pays three times: ${b('JAKAR-8')} (the router) is the foundation for the planner, the ride-along and reachability. Everything in Map Interaction and Visualisation is independent and can be picked up in any order — most are an afternoon each.`),
    h3('Reference'),
    p(`Repo ${c('~/Dev/2026/transjakarta-3d-map')}. Architecture, the GTFS pipeline and the interaction rules are documented in this project's Pages.`)
);

// ------------------------------------------------------------------- run

console.log('Loading issues…');
const issuesResponse = await call(`${BASE}/issues/?per_page=100`),
    all = issuesResponse.data.results || [],
    bySeq = new Map(all.map(i => [i.sequence_id, i]));

// 1. Rewrite ticket bodies
console.log('\nRewriting descriptions (single-line HTML):');
for (const [seq, ticket] of Object.entries(TICKETS)) {
    const issue = bySeq.get(+seq);

    if (!issue) {
        console.log(`  ! JAKAR-${seq} not found`);
        continue;
    }

    const response = await call(`${BASE}/issues/${issue.id}/`, {
        method: 'PATCH',
        body: {name: ticket.name, description_html: ticket.html}
    });

    if (response.ok) {
        console.log(`  JAKAR-${seq}  ${ticket.html.length} chars`);
    }
}

// 2. Sub work items under the router
console.log('\nSub work items under JAKAR-8:');
const router = bySeq.get(8),
    existingChildren = new Map(
        all.filter(i => i.parent === router.id).map(i => [i.name, i])
    );

for (const task of ROUTER_SUBTASKS) {
    const found = existingChildren.get(task.name);
    const response = found ?
        await call(`${BASE}/issues/${found.id}/`, {
            method: 'PATCH',
            body: {description_html: task.html, parent: router.id}
        }) :
        await call(`${BASE}/issues/`, {
            method: 'POST',
            body: {
                name: task.name,
                description_html: task.html,
                priority: task.priority,
                state: BACKLOG,
                parent: router.id
            }
        });

    if (response.ok) {
        console.log(`  JAKAR-${response.data.sequence_id}  ${task.name}`);
    }
}

// 3. Real dependencies
console.log('\nDependencies:');
for (const [fromSeq, blocks] of [[8, [9, 11]], [9, [10]]]) {
    const from = bySeq.get(fromSeq),
        targets = blocks.map(s => bySeq.get(s).id),
        response = await call(`${BASE}/issues/${from.id}/relations/`, {
            method: 'POST',
            body: {relation_type: 'blocking', issues: targets}
        });

    if (response.ok) {
        console.log(`  JAKAR-${fromSeq} blocks ${blocks.map(s => `JAKAR-${s}`).join(', ')}`);
    }
}

// 4. Modules
console.log('\nModules:');
const moduleList = await call(`${BASE}/modules/`),
    modulesByName = new Map((moduleList.data.results || []).map(m => [m.name, m]));

for (const module of MODULES) {
    const found = modulesByName.get(module.name);
    const response = found ?
        await call(`${BASE}/modules/${found.id}/`, {
            method: 'PATCH',
            body: {description: module.description}
        }) :
        await call(`${BASE}/modules/`, {
            method: 'POST',
            body: {name: module.name, description: module.description, status: 'backlog'}
        });

    if (!response.ok) {
        continue;
    }

    const moduleId = response.data.id,
        issueIds = module.issues.map(s => bySeq.get(s)?.id).filter(Boolean),
        link = await call(`${BASE}/modules/${moduleId}/module-issues/`, {
            method: 'POST',
            body: {issues: issueIds}
        });

    console.log(`  ${module.name}: ${issueIds.length} items ${link.ok ? 'linked' : 'LINK FAILED'}`);
}

// 5. Project overview
console.log('\nProject overview:');
const overview = await call(`/workspaces/${SLUG}/projects/${PROJECT}/`, {
    method: 'PATCH',
    body: {description_html: PROJECT_OVERVIEW}
});

console.log(overview.ok ? '  updated' : '  failed');
console.log('\nDone.');
