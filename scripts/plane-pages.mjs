/**
 * Writes the design documentation into Plane Pages.
 *
 * Idempotent by page name: re-running updates the existing page rather than
 * creating a second copy. Note pages update with PUT, not PATCH — PATCH
 * returns 405 on this endpoint, unlike work items.
 *
 * As with issue bodies, `description_html` must be a single unbroken line —
 * TipTap turns whitespace between block tags into empty paragraphs.
 */
import {plane} from './plane.mjs';

const SLUG = 'jakarta-publictrans-3d',
    PROJECT = '9a6895df-57a2-4b8c-a9f6-fe0b8e2f60e2',
    BASE = `/workspaces/${SLUG}/projects/${PROJECT}`;

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

    await sleep(200);
    if (!response.ok) {
        console.log(`  ! ${options?.method || 'GET'} ${path} -> ${response.status} ${JSON.stringify(response.data).slice(0, 250)}`);
    }
    return response;
}

const PAGES = [
    {
        name: 'Architecture Overview',
        html: h(
            p(`How the map is put together, and the constraints that shaped it. Repo: ${c('~/Dev/2026/transjakarta-3d-map')}.`),
            h2('The idea in one line'),
            p(`Do the expensive geometry once at build time, so that positioning a bus at runtime is a binary search and a lerp.`),
            h2('Two halves'),
            h3('Build time — scripts/build-data.mjs'),
            p(`Reads the raw GTFS feed and emits three files into ${c('public/data/')}:`),
            table(
                ['File', 'Size', 'Contents'],
                [
                    [c('network.json'), '1.6 MB', 'routes, stops, trips, stop offsets, headway windows, fares, transfers, accessibility'],
                    [c('shapes.bin'), '1.3 MB', '164k route vertices, delta-encoded int32'],
                    [c('routes.geojson'), '1.5 MB', 'simplified lines for display']
                ]
            ),
            p(`Shape vertices ship as a side-car binary rather than inside the JSON. Delta-encoded at 1e-6 degrees (about 11 cm), consecutive vertices differ by a handful of units and compress far better than raw floats.`),
            h3('Runtime — src/'),
            table(
                ['Module', 'Responsibility'],
                [
                    [c('clock.js'), 'Live and playback time, in seconds since Jakarta midnight'],
                    [c('network.js'), 'Decodes the bundle; resolves a distance along a shape to a position and heading'],
                    [c('fleet.js'), 'Expands headways into runs, tracks which are in service, positions them'],
                    [c('layers/bus-layer.js'), 'Draws the fleet as one instanced three.js mesh in a Mapbox custom layer'],
                    [c('ui/'), 'Clock, layer, search and detail panels'],
                    [c('main.js'), 'Wires it together: map layers, interaction, the frame loop']
                ]
            ),
            h2('Decisions worth knowing'),
            h3('The scene is built in metres, not Mercator'),
            p(`Mapbox hands a custom layer a matrix mapping Mercator coordinates in [0, 1] to clip space. A metre in Jakarta is about ${c('1.6e-8')} Mercator units — far below float32 precision, so building the scene in that space would quantise every bus to several metres. The scene is therefore built in metres around a fixed origin, and the origin transform is folded into the camera's projection matrix.`),
            h3('Movement between stops is kinematic, not linear'),
            p(`Each leg follows a trapezoidal speed profile — accelerate, hold, brake — so buses ease away from and into each stop. For a leg of distance ${c('d')} covered in time ${c('t')}, the accelerating fraction ${c('k')} satisfies ${c('k(1 - k) = d / (a·t²)')}. Legs too short to reach cruising speed have no real root and fall back to a triangular profile. Dwell times come from the gap between ${c('arrival_time')} and ${c('departure_time')}.`),
            h3('The detail card is built once per selection, not once per frame'),
            p(`A tracked bus reports a new position every frame. Rebuilding the card's markup at that rate replaces its buttons between a mousedown and the following mouseup, so the browser never produces a ${c('click')} and the buttons silently stop working. ${b('This actually shipped broken once')} — the follow button did nothing, and the bug was invisible to a test that called ${c('.click()')} directly, because that synthesises the event and skips the press/release pairing. Only the values that change are written now; the timetable is redrawn only when the bus reaches another stop.`),
            h3('Vehicle picking is done by projection, not by the GPU'),
            p(`The fleet lives in a custom WebGL layer, so Mapbox's feature query cannot see it. On click, the buses on screen are projected and the nearest is taken. That is cheap at click frequency and avoids a second picking render pass. Where a bus and a stop overlap — which happens constantly, since buses dwell at stops — whichever is nearer the click wins.`),
            h3('Stop styling follows the theme, not the hour'),
            p(`Stops are drawn as holes punched in the ground: filled with the ground colour, outlined in the ink colour, so the same geometry reads on a light or a dark map. ${b('Which way round is a property of the theme, not the light preset.')} The monochrome basemap keeps a pale ground at every preset and only dims its buildings, so its night view still needs dark ink, where the default theme genuinely inverts.`),
            h2('Performance'),
            p(`The simulation costs about ${b('0.22 ms per frame')} for the full peak fleet, so frame rate is bound by GPU rasterisation rather than by JavaScript. ${b('Caveat:')} this has only been measured under a software rasteriser (SwiftShader, in headless Chrome). The render path is untested on real GPU hardware — worth confirming before building anything heavier on top.`)
        )
    },
    {
        name: 'GTFS Data Pipeline & Feed Quirks',
        html: h(
            p(`What the Transjakarta feed actually contains, the three ways it fights back, and how the build handles each. Read this before touching ${c('scripts/build-data.mjs')}.`),
            h2('The feed'),
            table(
                ['', 'Count'],
                [
                    ['Routes', '240'],
                    ['Trip patterns', '700'],
                    ['Stops', '8,091 (7,488 drawn — platforms fold into stations)'],
                    ['Shapes', '700, 242k vertices raw'],
                    ['Daily vehicle runs', '69,761'],
                    ['Peak concurrent buses', '~6,600 at 17:30']
                ]
            ),
            p(`It is fully self-consistent: every trip has a shape, stop times and a frequency window, with zero dangling references. The difficulties are geometric, not referential.`),
            h2('The core transformation'),
            p(`Every stop of every trip is projected onto its route shape and stored as a ${b('distance along that shape')} — an "offset". At runtime a bus is positioned by interpolating between two offsets. Three things make that projection harder than it sounds.`),
            h3('1. Closed-loop shapes'),
            p(`Many shapes begin and end at the same coordinate. A terminus that both starts and ends a trip is therefore equidistant from offset 0 and offset ${c('L')}. Broken the wrong way, the first stop lands at the end of the line — and because offsets may never decrease, it drags every later stop with it.`),
            quote(`99 of the 700 trips collapsed this way before ties were resolved toward the earlier match.`),
            h3('2. Routes that double over themselves'),
            p(`A stop can match a later pass over the same street better than the correct earlier one. The search window is therefore bounded by how far a bus could plausibly travel in the scheduled time.`),
            quote(`Without that bound, one Mikrotrans trip appeared to cover 25 km in 13 seconds, pinning every subsequent stop to the same point.`),
            h3('3. Frequency-based service'),
            p(`${c('frequencies.txt')} gives headways, not departures, so a trip is a ${em('pattern')}. It expands at runtime into individual runs — 69,761 across a service day. Nothing in the feed says when a specific bus leaves; it has to be computed.`),
            h2('Validation after the fixes'),
            table(
                ['Check', 'Result'],
                [
                    ['Trips spanning their full shape', 'median 99.9%, minimum 86%'],
                    ['Non-monotonic offsets', '0'],
                    ['Worst stop-to-shape match', '183 m'],
                    ['Median segment speed', '13 km/h (right for Jakarta)'],
                    ['Segments implying &gt;80 km/h', '12 of 25,528 — inconsistencies in the published timings']
                ]
            ),
            h2('Things the feed records that are easy to miss'),
            h3('Stations are containers'),
            p(`${c('stop_times')} references ${b('platforms')}, which point back at their station through ${c('parent_station')} — but only stations are drawn. Anything asking "what serves this stop?" has to fold platforms into the station, or corridor stations come back empty. This shipped wrong once: Harmoni, Bundaran HI and Dukuh Atas all reported zero routes.`),
            h3('Fares are per-route and do not sum'),
            table(
                ['Fare', 'Price', 'Routes'],
                [
                    ['GR', 'Free', '101 (Mikrotrans, Rusun)'],
                    ['FP / FP2', 'Rp 3,500', '129'],
                    ['PP / PP2', 'Rp 20,000–25,000', '9 (Royaltrans)'],
                    ['PP3', 'Rp 35,000', '1']
                ]
            ),
            p(`Every fare carries a ${b('10,800-second (3 hour)')} integrated transfer window, so a second boarding inside the window is free.`),
            h3('The declared transfer list is not usable'),
            p(`${c('transfers.txt')} lists ${b('7')} interchange pairs. Measured against stop coordinates, ${b('15,221 stop pairs')} sit within 400 m of each other offering a different route. Any routing work must generate walk transfers itself.`),
            h3('Accessibility sits on platforms, not stations'),
            p(`${c('wheelchair_boarding')} marks 100 of 8,091 stops. The flag is on platforms, so the build propagates it up to the parent station; the 100 resolve to ${b('39 of the 7,488 drawn stops')}, every one a BRT corridor station. No Mikrotrans stop qualifies.`),
            h3('Service days'),
            p(`612 of 700 trips run daily, 50 are weekday-only, 32 Sunday-only. ${c('calendar_dates.txt')} is not shipped, so holiday exceptions are not modelled.`),
            h2('Rebuilding'),
            p(`${c('npm run build-data')}, or ${c('GTFS_DIR=/path/to/gtfs npm run build-data')}. Source feed: ${c('https://gtfs.transjakarta.co.id/files/file_gtfs.zip')}.`)
        )
    },
    {
        name: 'Journey Router — Design',
        html: h(
            p(`Design notes for ${b('JAKAR-8')} and its sub work items. Written before implementation; update it as reality intervenes.`),
            h2('Problem'),
            p(`Answer: leaving stop A at time T on service day D, what are the best ways to reach stop B? "Best" means some mix of fastest, fewest transfers, and cheapest — and cheapest is a real axis here, because 101 of 240 routes are free.`),
            h2('Why the network supports it'),
            ul([
                `${b('All 240 routes are mutually reachable')} by transfers. The graph is connected; there is nothing stranded.`,
                `${b('3,043 of 7,488 nodes (41%)')} are served by more than one route, so interchange opportunities are dense.`,
                `${b('15,221 stop pairs')} lie within 400 m of each other offering a different route, against ${b('7')} declared in ${c('transfers.txt')}.`
            ]),
            quote(`The single most important design consequence: walk transfers are not a refinement, they are the substrate. A router using only the feed's declared transfers would miss almost every real interchange in Jakarta.`),
            h2('Algorithm: RAPTOR'),
            p(`Round-based scanning of trip patterns, rather than Dijkstra over a time-expanded graph. Two reasons:`),
            ol([
                `Each round equals one additional ride, so the round index ${em('is')} the transfer count — a quantity riders care about and would otherwise need reconstructing.`,
                'No graph to materialise. The patterns and their stop sequences are already in memory.'
            ]),
            h3('Sketch'),
            ol([
                `Round 0: mark the origin (and everything within walking distance of it) with its arrival time.`,
                `Each round: for every pattern touching a stop improved in the previous round, board at the earliest reachable departure and relax arrival times at every later stop in the pattern.`,
                'Between rounds, apply the walk-transfer table.',
                'Stop after 4 rounds, or when no arrival time improves.'
            ]),
            p(`Keep parent pointers so an itinerary can be reconstructed, not just its arrival time.`),
            h2('Departures are computed'),
            p(`There is no departure row to look up. The next departure of a pattern at a stop is the next multiple of the headway inside an active ${c('frequencies.txt')} window, offset by the stop's position in the pattern. Handle patterns with several windows (18 have more than one), the midnight wrap, and ${c('calendar.txt')} service days.`),
            h2('Fares'),
            p(`Accumulate rather than sum. Charge the first boarding; charge a later boarding only if it falls outside the 3-hour window from the first. A journey entirely on free routes costs nothing, and a two-leg journey inside the window costs one fare. This is what makes a "cheapest" sort meaningful rather than decorative.`),
            h2('Budgets'),
            table(
                ['Concern', 'Target'],
                [
                    ['Query latency', '≲300 ms in the browser'],
                    ['Walk-transfer radius', '400 m at ~4.8 km/h'],
                    ['Max rounds', '4 (i.e. up to 3 transfers)'],
                    ['Where it runs', 'Client-side; Web Worker if it blocks the frame']
                ]
            ),
            h2('What this unlocks'),
            ul([
                `${b('JAKAR-9')} — the tap-A-tap-B planner.`,
                `${b('JAKAR-10')} — riding the planned journey in the simulation, the feature no other transit app can offer.`,
                `${b('JAKAR-11')} — reachability, which is the same search with the destination removed.`
            ]),
            h2('What was actually built'),
            table(
                ['Piece', 'Where'],
                [
                    ['Schedule queries over a headway feed', c('src/routing/timetable.js')],
                    ['RAPTOR search, reachability, access walking', c('src/routing/router.js')],
                    ['Fares with the 3-hour window', c('src/routing/fares.js')],
                    ['78 checks against the real feed', c('npm run test-routing')]
                ]
            ),
            p(`A query costs about ${b('2 ms')} against a 300 ms budget. Reachability from Dukuh Atas at 08:00, in 4 ms: 49 stops within 15 minutes, 1,960 within an hour.`),
            h3('Two access radii, deliberately different'),
            p(`${b('400 m')} between buses — a transfer you did not choose — and ${b('800 m')} to reach your first stop, a walk you did. Seeding every stop within the access radius means a journey can begin on foot: ${b('43% of itineraries now do')}, against none before, because walk relaxation previously only ever saw stops a ride had already improved.`),
            h3('Two artefacts the reconstruction has to clean up'),
            p('A round-based search can chain walks across rounds, and can alight and reboard the same vehicle. Both are correct journeys described badly, so adjacent walks and same-vehicle re-boardings are collapsed.'),
            h2('The open weakness'),
            quote(`Walking is straight-line at 4.8 km/h. Measured against real pedestrian routing: median ${b('1.36×')} too optimistic, worst ${b('2.6×')} — and the error concentrates where a major road intervenes, which is exactly where BRT transfers happen.`),
            p(`This is the weakest assumption in the router. ${b('JAKAR-24')} measures where it actually bites before anything is rebuilt.`),
            h2('Still open'),
            ul([
                'Is a transfer penalty beyond raw time worth modelling — waiting, uncertainty, the effort of finding the other stop? Currently a flat 60 s.',
                'Should the destination accept an arbitrary point, as the origin now does?'
            ])
        )
    },
    {
        name: 'Interaction & UI Design',
        html: h(
            p('The interface rules the map already follows. Worth reading before adding panels, so new surfaces stay consistent.'),
            h2('Layout'),
            table(
                ['Corner', 'Contents'],
                [
                    ['Top left', 'Search, with the clock directly beneath it'],
                    ['Bottom left', 'Layanan panel — service categories and layer toggles'],
                    ['Top right', 'Detail card — the selected bus or stop'],
                    ['Bottom right', 'Zoom, compass, geolocate']
                ]
            ),
            p(`Verified collision-free at 1440×900. The detail card is capped at ${c('calc(100vh - 172px)')} and scrolls internally so it never reaches the map controls below it.`),
            h2('Language'),
            p(`The interface is in Indonesian — "Cari rute atau halte", "Bus beroperasi", "Ikuti bus ini", "Berhenti mengikuti", "Hanya halte aksesibel". Times use a 24-hour clock, fares Indonesian digit grouping (${c('Rp 3.500')}).`),
            h2('Colour'),
            p(`Vehicles and route lines are coloured by ${b('service category')}, not by GTFS ${c('route_color')} — 94 routes share a single colour in the feed, so it carries almost no information.`),
            table(
                ['Category', 'Colour', 'Routes'],
                [
                    ['BRT Koridor', '#0d5eaf', '31'],
                    ['Angkutan Umum Integrasi', '#d4145a', '63'],
                    ['Mikrotrans', '#2fa84f', '98'],
                    ['Transjabodetabek', '#7b3fa0', '18'],
                    ['Royaltrans', '#e08b00', '10'],
                    ['Rusun', '#00a0a8', '17'],
                    ['Bus Wisata', '#e0559b', '3']
                ]
            ),
            p(`${b('Deliberate decision:')} the fleet is not coloured by fare, even though the free/paid split is the most rider-relevant fact in the dataset. Fare appears on the detail card instead, with free services called out in green. Category colour is the map's primary encoding and only one thing can be.`),
            h2('The basemap'),
            p(`A custom ${b('Monochrome')} style built on Mapbox Standard. Because it imports Standard under the id ${c('basemap')}, the app still drives ${c('lightPreset')} and ${c('show3dObjects')} through ${c('setConfigProperty')}, so time-of-day lighting and the 3D buildings toggle both work. Greying out the streets is what lets the coloured fleet carry the image.`),
            p(`${b('Note:')} the style is private to its Mapbox account and renders only for a token on that account.`),
            h2('Vehicle scale'),
            p(`Buses are drawn at true size (12 m) from zoom 16 up. Below that they scale up to 11× so the network stays legible — the same trade Mini Tokyo 3D makes. A tracked bus is drawn at 1.7× so it stays findable at street level.`),
            h2('The follow camera'),
            ul([
                `Centres a point ${b('ahead')} of the bus rather than the bus itself, so it sits about two thirds down the frame with the road ahead visible. The distance derives from current scale, so framing survives zooming.`,
                `Turns via ${b('exponential decay over elapsed time')}, not per frame. Route shapes are polylines: a heading can snap 86° between frames at a corner, and the camera absorbs that into under 6°/frame — identically at 60 fps or 15 fps.`,
                `Exits on a genuine user gesture only. ${c('dragstart')} and ${c('rotatestart')} also fire for the camera's own moves, so the handler checks ${c('e.originalEvent')} — without that, the entry animation cancels the follow it just started.`
            ]),
            h2('Rules learned the hard way'),
            ol([
                `${b('Never rebuild an interactive panel every frame.')} It destroys buttons between mousedown and mouseup, so clicks never fire. Build the shell once per selection and write only the values that change.`,
                `${b('Throttle on real time, not simulated time.')} The stop card once refreshed every 15 ${em('simulated')} seconds — which at 1200× playback is every frame, reintroducing the same broken-click problem.`,
                `${b('Test with native input.')} Calling ${c('.click()')} in a test synthesises the event and passes even when a real click is impossible. The follow button shipped dead because of exactly this.`,
                `${b('Adapt to the theme, not the hour.')} See Architecture Overview — a monochrome basemap stays pale at night.`
            ]),
            h2('Surfaces added since'),
            table(
                ['Surface', 'Where it lives', 'Why there'],
                [
                    ['Journey bar', 'left, under the clock', 'a pending origin must stay visible while you hunt for the destination'],
                    ['Itinerary card', 'top right, shared slot', 'mutually exclusive with the bus and stop inspectors'],
                    ['Ride-along HUD', 'bottom centre', 'the only free edge, and where a heads-up display belongs'],
                    ['Nearby card', 'top right, shared slot', 'answers a tap on open map'],
                    ['Service curve', 'behind the time scrubber', 'the slider was hiding the shape of the day']
                ]
            ),
            p(`${b('Known flow problem:')} search sits top left and its result opens top right, so finding a stop and starting a journey from it costs about 1,300 px of eye travel, twice. The panels are each fine; the path between them is the defect. See ${b('JAKAR-25')} — it needs a layout decision before any building.`),
            h2('Accessibility'),
            p(`"Hanya halte aksesibel" reduces the map from 7,488 drawn stops to ${b('39')} — all BRT corridor stations, no Mikrotrans. The emptiness is the point, and the feature exists to make it visible.`)
        )
    }
];

const existing = await call(`${BASE}/pages/`),
    byName = new Map((existing.data.results || []).map(p => [p.name, p]));

console.log('Design documentation pages:');
for (const page of PAGES) {
    const found = byName.get(page.name);
    const response = found ?
        await call(`${BASE}/pages/${found.id}/`, {
            method: 'PUT',
            body: {name: page.name, description_html: page.html}
        }) :
        await call(`${BASE}/pages/`, {
            method: 'POST',
            body: {name: page.name, description_html: page.html, access: 0}
        });

    console.log(response.ok ?
        `  ${found ? 'updated' : 'created'}  ${page.name}  (${page.html.length} chars)` :
        `  FAILED  ${page.name}`);
}
console.log('\nDone.');
