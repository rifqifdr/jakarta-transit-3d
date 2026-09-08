/**
 * One-off: seeds the Transjakarta 3D interaction backlog into Plane.
 *
 * Safe to re-read but not to re-run blindly — it creates issues every time.
 * Kept in the repo so the ticket copy is reviewable in version control.
 */
import {plane} from './plane.mjs';

const SLUG = 'jakarta-publictrans-3d',
    PROJECT = '9a6895df-57a2-4b8c-a9f6-fe0b8e2f60e2',
    BACKLOG = 'd25e2953-b56a-43f9-a4b5-4f9023444cb8';

const LABELS = [
    {name: 'feature', color: '#3f76ff'},
    {name: 'foundation', color: '#8b5cf6'},
    {name: 'quick win', color: '#22c55e'}
];

// Shared context every ticket can lean on, so each one stands alone for
// whoever picks it up.
const CONTEXT = `<h3>Context</h3>
<p>The map renders the whole Transjakarta network in 3D from the GTFS feed — around 6,600 buses moving at the evening peak across 240 routes, 700 trip patterns and 8,091 stops — driven by a simulation clock that runs live or replays a day at up to 1200×.</p>
<p>Everything it does today is <strong>observation</strong>: watch, replay, filter, inspect. This backlog is about what people can <em>do</em> with it.</p>
<p>Repo: <code>~/Dev/2026/transjakarta-3d-map</code>. See <code>README.md</code> for the data pipeline and runtime architecture.</p>`;

const TICKETS = [
    {
        name: 'Journey router: time-dependent path search',
        priority: 'high',
        labels: ['feature', 'foundation'],
        html: `<h3>What this is</h3>
<p>A routing engine that answers: <em>leaving stop A at time T, what is the fastest way to stop B?</em> Pure logic, no UI. This is the foundation that the journey planner, the ride-along journey and the reachability map all sit on — build it once, it pays for three features.</p>

<h3>Why this is viable (checked against the feed)</h3>
<ul>
<li><strong>All 240 routes are mutually reachable</strong> by transfers — the route graph is fully connected, so there are no stranded islands to special-case.</li>
<li><strong>3,043 of 7,488 network nodes (41%)</strong> are served by more than one route.</li>
<li><code>transfers.txt</code> declares only <strong>7</strong> interchange pairs, but <strong>15,221 stop pairs sit within 400 m of each other offering a different route</strong>. The feed's own transfer list is nowhere near enough — <strong>the router must generate walk transfers itself</strong>. This is the single most important design consequence.</li>
<li>Service spans <strong>00:00–23:59</strong>.</li>
</ul>

<h3>Suggested approach</h3>
<ul>
<li><strong>RAPTOR</strong> (round-based) over the 700 trip patterns, rather than Dijkstra on a time-expanded graph. Simpler to get right, and each round maps directly onto "number of transfers", which is something riders care about.</li>
<li><strong>Precompute a walk-transfer table at build time</strong> — for every stop, all stops within 400 m with a walking time at roughly 4.8 km/h. Ship it in <code>network.json</code> next to the existing stop offsets. <code>scripts/build-data.mjs</code> already builds a spatial grid for exactly this analysis; reuse it.</li>
<li><strong>Departures are headway-based, not fixed.</strong> The feed is frequency-based: the next departure of a pattern at a stop is the next multiple of the headway inside an active window from <code>frequencies.txt</code>, offset by the stop's position in the pattern. There is no departure row to look up.</li>
<li>Honour <code>calendar.txt</code> service days — 612 of 700 trips run daily, but 50 are weekday-only and 32 Sunday-only.</li>
</ul>

<h3>Output shape</h3>
<p>For a query (origin, destination, departure time, service day), return ranked itineraries. Each is a list of legs — <code>walk</code> or <code>ride</code> — with boarding and alighting stop, route, board time, alight time, plus totals for duration, transfer count and fare.</p>

<h3>Fare rule (do not sum the legs)</h3>
<p>Fares are per-route with a <strong>10,800-second (3 hour) integrated transfer window</strong>. A second boarding inside that window is free, so an itinerary's cost is <em>not</em> the sum of its legs. 101 of 240 routes are free outright, 129 cost Rp 3,500, 9 are premium. Getting this right is what makes a "cheapest" sort meaningful.</p>

<h3>Acceptance</h3>
<ul>
<li>Returns a correct itinerary for known pairs — Blok M → Kota should come back as Koridor 1 direct, not a three-transfer detour.</li>
<li>Handles "no service at this hour" and "unreachable" gracefully rather than hanging or returning empty without explanation.</li>
<li>A typical query completes in roughly 300 ms or less in the browser.</li>
<li>Unit tests cover a handful of hand-checked journeys, including one that requires a walk transfer and one that crosses midnight.</li>
</ul>

<h3>Notes</h3>
<p>Runs entirely client-side; all the data is already loaded. If it blocks the animation frame, move it to a Web Worker — the simulation currently costs only 0.22 ms/frame and should stay smooth.</p>` + CONTEXT
    },
    {
        name: 'Journey planner: tap origin, tap destination',
        priority: 'high',
        labels: ['feature'],
        blockedBy: 0,
        html: `<h3>What this is</h3>
<p>The interaction on top of the router. Tap a stop and choose "Dari sini"; tap another and choose "Ke sini". Get ranked itineraries in the detail card and the chosen one drawn on the map.</p>
<p>This is the interaction people expect from a transit map and the main thing the app is missing.</p>

<h3>Detail</h3>
<ul>
<li><strong>Entry points:</strong> tapping a stop, tapping open map (see the "click anywhere" ticket), or picking from the existing search box.</li>
<li><strong>Result card per itinerary:</strong> total duration, departure and arrival time, transfer count, total fare, then a leg-by-leg breakdown using the existing route badges and category colours.</li>
<li><strong>Sorting:</strong> fastest, fewest transfers, cheapest. Cheapest is frequently <em>free</em> — 101 routes cost nothing — which makes this more than a cosmetic sort.</li>
<li><strong>On the map:</strong> ride legs drawn along the real shape geometry in the route's colour; walk legs dashed. Reuse the <code>route-highlight</code> layer pattern already in <code>main.js</code>.</li>
<li><strong>Departure time</strong> defaults to the simulation clock and can be edited. Planning at 07:00 and at 23:00 give very different answers, and that difference is worth surfacing.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>Two taps produce a plan.</li>
<li>The line drawn on the map matches the itinerary's legs exactly.</li>
<li>Clearing the plan restores the map to its previous state.</li>
<li>Works while the clock is in playback mode, not just live.</li>
</ul>` + CONTEXT
    },
    {
        name: 'Ride your planned journey in the simulation',
        priority: 'medium',
        labels: ['feature'],
        blockedBy: 1,
        html: `<h3>What this is</h3>
<p>After planning a journey, press play and <strong>watch it actually happen</strong> in the 3D simulation. The clock jumps to the departure time, the camera picks up the real bus serving the first leg, follows it, handles the walk transfer, then picks up the next bus.</p>

<h3>Why this one matters most</h3>
<p>Every transit app can draw a blue line on a map. None of them can show you the trip, because none of them simulate the fleet. We already do — around 6,600 buses moving on the real timetable. This is what turns a plan into something you can watch, and it is the feature that makes this ours rather than a Mini Tokyo 3D port for Jakarta.</p>

<h3>Detail</h3>
<ul>
<li><strong>Bind each ride leg to an actual run in the fleet</strong> — a trip pattern plus a departure time that already exists in the simulation — not a synthetic vehicle invented for the animation. This is the whole point; if the bus is fake, the feature is just a cutscene.</li>
<li>Reuse the existing follow camera: <code>NAV_ZOOM</code>, <code>NAV_PITCH</code>, the look-ahead framing, and the time-based bearing smoothing already in <code>main.js</code>.</li>
<li><strong>Walk legs:</strong> glide the camera along the walking line at walking pace, so transfers read as part of the journey rather than a cut.</li>
<li><strong>Progress UI:</strong> current leg, next stop, ETA, "3 stops to go".</li>
<li><strong>Controls:</strong> play/pause, speed up, skip to next leg, exit. Restore the previous camera on exit.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>The camera follows a bus that genuinely exists in the fleet at that time.</li>
<li>Leg handovers are visually continuous — no teleporting between buses.</li>
<li>Works at playback speeds above 1×.</li>
<li>Exiting part-way through leaves the map in a usable state.</li>
</ul>` + CONTEXT
    },
    {
        name: 'Reachability map from a stop (isochrone)',
        priority: 'medium',
        labels: ['feature'],
        blockedBy: 0,
        html: `<h3>What this is</h3>
<p>Tap a stop, choose a time budget, and paint everything reachable within it — 15 / 30 / 45 / 60 minutes.</p>

<h3>Why it is nearly free once the router exists</h3>
<p>This is the same forward search as the journey router with the destination removed: run it until the time budget is exhausted and keep the earliest arrival time at every stop reached. Most of the work is already done by the router ticket.</p>

<h3>Detail</h3>
<ul>
<li>Colour every reachable stop by arrival-time band.</li>
<li>Optionally shade the areas around reachable stops for a filled isochrone rather than dots.</li>
<li><strong>Recompute when the departure time changes.</strong> Reachability at 08:00 and at 22:00 are very different, and the existing playback clock makes that difference explorable — drag the scrubber and watch the reachable area shrink after 21:00.</li>
<li><strong>Fare filter — the distinctive one.</strong> Restrict to free routes and answer: <em>how far can you get in 45 minutes without paying anything?</em> With 101 free routes across Mikrotrans and Rusun, that is a question only this dataset answers, and the resulting map is worth publishing on its own.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>The reachable set is correct for at least one hand-checked case.</li>
<li>Recomputes within about a second when the time changes.</li>
<li>Free-only mode produces a visibly smaller reachable area than the unrestricted one.</li>
</ul>` + CONTEXT
    },
    {
        name: 'Click anywhere on the map for nearest stops and departures',
        priority: 'medium',
        labels: ['feature', 'quick win'],
        html: `<h3>What this is</h3>
<p>Today only stop dots and buses are clickable. But people tap <em>where they are</em>, not on a dot. Tapping open map should answer "what can I catch from around here?"</p>

<h3>Detail</h3>
<ul>
<li>Find the nearest few stops within roughly 800 m of the tapped point.</li>
<li>Show walking distance and time, the routes each serves, and the next departures — the stop card already computes departures, so reuse it.</li>
<li><strong>Feed the journey planner:</strong> "Dari sini" from an arbitrary point, not just from a stop. This is what makes the planner usable for real trips.</li>
<li>Needs a spatial index over the 7,488 drawn nodes. A simple grid is plenty — <code>scripts/build-data.mjs</code> already builds one for the walk-transfer analysis and the same approach works at runtime.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>Tapping open map anywhere in Jakarta returns sensible nearby stops.</li>
<li>Tapping well outside the network says so, rather than returning a stop 30 km away.</li>
<li>Does not interfere with existing bus and stop picking — the current handler already resolves bus-vs-stop by which is nearer to the click, so this becomes a third case.</li>
</ul>` + CONTEXT
    },
    {
        name: 'Shareable deep links for time, camera and selection',
        priority: 'medium',
        labels: ['feature', 'quick win'],
        html: `<h3>What this is</h3>
<p>Encode the current view in the URL, so any view can be bookmarked or sent to someone.</p>
<p>Example: <code>?t=07:30&amp;z=15.4&amp;c=106.823,-6.188&amp;p=62&amp;b=-18&amp;route=1</code></p>

<h3>State worth encoding</h3>
<ul>
<li>Simulated time, and whether the clock is live or at a set speed</li>
<li>Camera: centre, zoom, pitch, bearing</li>
<li>Selection: bus run or stop, and whether follow mode is on</li>
<li>Active service-category filters, accessibility mode, highlighted route</li>
<li>Later: a planned journey (origin, destination, departure time)</li>
</ul>

<h3>Detail</h3>
<ul>
<li>Update the URL with <code>replaceState</code> as things change, throttled so dragging the map does not thrash history.</li>
<li>Parse on load and restore before first paint where possible.</li>
<li>Keep the parameters short and human-readable — these are meant to be pasted into a chat.</li>
</ul>

<h3>Why this is worth doing early</h3>
<p>It is an afternoon's work and it multiplies the value of everything else in this backlog. "Look at Koridor 1 at 07:30" should be a link, not a set of instructions. Nothing else here is shareable until this exists.</p>

<h3>Acceptance</h3>
<ul>
<li>Round-trip: copy the URL, open it in a new tab, get the same view.</li>
<li>A malformed or partial URL degrades to sensible defaults instead of erroring.</li>
</ul>` + CONTEXT
    },
    {
        name: 'Service-level sparkline on the time scrubber',
        priority: 'low',
        labels: ['feature', 'quick win'],
        html: `<h3>What this is</h3>
<p>The time slider is a plain track today, so the shape of the service day is invisible. Draw the day's service curve along it — you can then see where the peaks are and drag straight to them.</p>

<h3>The data (already measured)</h3>
<p>Buses in service, sampled at each half hour:</p>
<ul>
<li>04:30 — 682 (overnight floor)</li>
<li>06:30 — 5,121 (morning ramp)</li>
<li>17:30 — 6,138 (peak)</li>
<li>22:30 — 4,094</li>
<li>23:30 — 1,794</li>
</ul>

<h3>Detail</h3>
<ul>
<li>Render the curve as a small SVG or canvas layer behind the slider track.</li>
<li>Mark the current position on the curve.</li>
<li><strong>Recompute when category filters change.</strong> Hiding Mikrotrans should visibly flatten the curve — it is over half the fleet — which makes the filter's effect legible rather than abstract.</li>
<li>Optional: separate stacked curves per service category.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>The curve matches the actual active-bus counts.</li>
<li>Dragging behaves exactly as it does now.</li>
<li>The curve is computed once at load, not per frame.</li>
</ul>` + CONTEXT
    },
    {
        name: 'First and last bus at a stop',
        priority: 'medium',
        labels: ['feature', 'quick win'],
        html: `<h3>What this is</h3>
<p>Add first and last departure times to the stop card. "Last bus 22:47" is a real anxiety for riders, and the feed answers it exactly — we just are not showing it.</p>

<h3>Detail</h3>
<ul>
<li>For each route serving the stop, derive the first and last departure from the <code>frequencies.txt</code> windows plus the stop's offset within the trip pattern. Note this is a computation, not a lookup — the feed is headway-based.</li>
<li><strong>Respect the service day.</strong> Weekday, Saturday and Sunday differ: 50 trips are weekday-only and 32 are Sunday-only, so the last bus genuinely changes depending on when you ask.</li>
<li>Highlight the case where the last bus has already gone, or leaves within about 30 minutes — that is when this information actually matters.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>Correct for a hand-checked stop verified against the raw GTFS.</li>
<li>Correct on a Sunday, where some services do not run at all.</li>
</ul>` + CONTEXT
    },
    {
        name: 'Ride-along camera view (first person from the bus)',
        priority: 'low',
        labels: ['feature', 'quick win'],
        html: `<h3>What this is</h3>
<p>A first-person view from the bus itself — camera at roof height looking forward along the route — as an alternative to the current chase view from behind and above.</p>

<h3>Detail</h3>
<ul>
<li>Reuse the existing follow camera; drop the height to roughly 3.5 m and raise the pitch to about 80–85°.</li>
<li>Toggle between "chase" and "ride along" while following.</li>
<li><strong>Keep the time-based bearing smoothing.</strong> It matters more here, not less: route shapes are polylines, so a bus's heading can snap by up to 86° between frames at a corner, and at eye level that is very visible. The existing exponential decay already absorbs this into under 6°/frame.</li>
<li>Hide or shrink the tracked bus model, which is currently drawn at 1.7× and would fill the frame from this position.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>The view stays stable through corners rather than whipping around.</li>
<li>Switching between camera modes does not lose the tracked bus.</li>
</ul>

<h3>Why bother</h3>
<p>Pure delight, and close to free — the chase camera already does the hard part. It is also the most shareable thing in the app once deep links exist.</p>` + CONTEXT
    },
    {
        name: 'Colour route lines by live headway instead of category',
        priority: 'low',
        labels: ['feature'],
        html: `<h3>What this is</h3>
<p>Colour the route lines by how long until the next bus, rather than by service category.</p>

<h3>Why</h3>
<p>Category colour is <em>static</em> — the map looks identical at 07:00 and at 23:00, so playback changes the buses but not the picture. Headway colour makes the network breathe: you watch service thin out after 21:00 and see exactly which corridors keep running. It also answers a question a rider actually has: <em>is this line useful right now?</em></p>

<h3>Detail</h3>
<ul>
<li>Compute the current headway per route from whichever <code>frequencies.txt</code> window is active at the simulated time.</li>
<li>Colour ramp along the lines of: under 5 min / 5–15 / 15–30 / over 30 min.</li>
<li>A legend, plus a toggle between "by service" and "by frequency" — the category view stays the default.</li>
<li><strong>Mind the range:</strong> headways in this feed run from 180 s to 52,700 s (over 14 hours), so the ramp needs a sensible top end or almost everything lands in one bucket.</li>
<li>Recompute on a modest interval, not every frame.</li>
</ul>

<h3>Acceptance</h3>
<ul>
<li>Colours change across the day and match the active frequency windows.</li>
<li>Toggling back to category colouring restores the current appearance exactly.</li>
</ul>` + CONTEXT
    }
];

async function ensureLabels() {
    const existing = await plane(`/workspaces/${SLUG}/projects/${PROJECT}/labels/`),
        byName = new Map(
            (existing.data.results || existing.data || []).map(l => [l.name.toLowerCase(), l.id])
        );

    for (const label of LABELS) {
        if (byName.has(label.name.toLowerCase())) {
            continue;
        }

        const created = await plane(`/workspaces/${SLUG}/projects/${PROJECT}/labels/`, {
            method: 'POST',
            body: {name: label.name, color: label.color}
        });

        if (created.ok) {
            byName.set(label.name.toLowerCase(), created.data.id);
            console.log(`  label created: ${label.name}`);
        } else {
            console.log(`  label failed: ${label.name} -> ${created.status} ${JSON.stringify(created.data).slice(0, 120)}`);
        }
    }
    return byName;
}

const labelIds = await ensureLabels(),
    created = [];

for (const ticket of TICKETS) {
    // Dependencies are expressed in the body, because the sequence numbers of
    // the blocking issues only exist once they have been created.
    let html = ticket.html;

    if (ticket.blockedBy !== undefined) {
        const blocker = created[ticket.blockedBy];

        html = `<p>🔗 <strong>Blocked by ${blocker.key}</strong> — ${blocker.name}</p>` + html;
    }

    const response = await plane(`/workspaces/${SLUG}/projects/${PROJECT}/issues/`, {
        method: 'POST',
        body: {
            name: ticket.name,
            description_html: html,
            priority: ticket.priority,
            state: BACKLOG,
            labels: ticket.labels.map(n => labelIds.get(n)).filter(Boolean)
        }
    });

    if (!response.ok) {
        console.log(`FAILED: ${ticket.name} -> ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`);
        break;
    }

    const key = `JAKAR-${response.data.sequence_id}`;

    created.push({key, name: ticket.name, id: response.data.id});
    console.log(`  ${key.padEnd(10)} ${ticket.name}`);
}

console.log(`\nCreated ${created.length} of ${TICKETS.length}.`);
