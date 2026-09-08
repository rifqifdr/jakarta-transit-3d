# Jakarta Transit 3D

*Angkutan umum Jabodetabek, dalam 3D.*

A real-time 3D map of public transport in Greater Jakarta, in the spirit of
[Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d). Every vehicle you see
is a real scheduled run, driven along its actual route geometry by a simulation
clock.

> **Vision:** make people have visibility regarding public transportation in
> Jakarta or the Greater Jakarta Area.

It started with Transjakarta's buses — the first mode to have a working feed —
and now carries **all four modes**: bus, MRT, LRT and Commuter Line (KRL). Only
the bus feed is an official GTFS; the three rail feeds are built from scraped
timetables and OpenStreetMap geometry.

At the evening peak that is around **6,600 vehicles moving at once**, across 261
routes, 806 trip patterns, 8,281 stops and a 40,817-edge walking table.

## Status

Everything in the original backlog is built. Open work, current weak points and
what to pick up next are tracked in **Plane** (workspace `jakarta-publictrans-3d`,
project `JAKAR`) — start from its **"Next Session — Start Here"** page.
`CLAUDE.md` carries the working conventions and the traps this codebase has
already fallen into.

## Running it

```bash
npm install
npm run dev            # the app, on :5173
npm run test-routing   # 91 checks over the routing layer, against the real feed
npm run test-transform # 114 checks over the canonical model and validation gate
```

**Two boot paths.** `http://localhost:5173/` loads `public/artifacts/` — all
four modes, and the default. `http://localhost:5173/?data=legacy` loads the
older `public/data/` bundle, which is buses only. Both are checked in, so
neither needs a data build to run.

`.env` must contain a Mapbox token — copy `.env.example` and fill it in:

```
MAPBOX_ACCESS_TOKEN=pk.…
```

The bare name (no `VITE_` prefix) is deliberate — `vite.config.js` reads it
explicitly and injects it. A default public token from
[account.mapbox.com](https://account.mapbox.com) is enough; nothing else in
`.env` is needed to run the app, only to rebuild the data.

The token is compiled into the browser bundle. That is how Mapbox GL works and
cannot be avoided, so a **deployed** site should use a separate public token
with a URL restriction set to its own domain, never the development one.

### Rebuilding the data

Only needed when a feed changes; the built output is checked in.

```bash
npm run ingest         # fetch dated snapshots from upstream -> data/snapshots/
npm run transform      # snapshots -> canonical dataset -> public/artifacts/
npm run build-data     # the older path: GTFS -> public/data/
```

`npm run build-data` reads the feed from `GTFS_DIR`, defaulting to the newest
Transjakarta snapshot in `data/snapshots/` so a fresh clone can rebuild it
(`GTFS_DIR=/path/to/gtfs npm run build-data` to point elsewhere). That snapshot
came from the Mobility Database mirror and carries 252 routes against the
origin's 240, so rebuilding changes the network the routing checks run over.

## What it does

- **Live or replayed.** The clock follows real Jakarta time, or you can scrub to
  any time of day and run it at up to 1200×. The basemap's lighting follows the
  simulated hour, so replaying a day takes the city from dawn through to night.
- **Click a bus** for its route, headsign, fare, progress along the trip, and a
  live window of its timetable.
- **Follow a bus** and the view drops to street level, rotates so the bus's
  direction of travel is up, and rides along behind it — a turn-by-turn camera.
  Pan or rotate by hand to take the wheel back.
- **Click a stop** for the routes calling there, the next departures, and any
  official interchange walks.
- **Plan a journey.** Open any stop and pick "Dari sini" / "Ke sini". Results
  rank by fastest, fewest transfers or cheapest, with a leg-by-leg breakdown,
  and the chosen one is drawn along the roads the buses actually take while the
  rest of the network fades behind it.
- **Ride from on board or from behind.** While following anything, switch
  between the chase view and a first-person view from the bus roof.
- **Ride the journey you planned.** Press "Jalankan perjalanan" and the clock
  winds to your departure, the camera picks up the *actual bus* serving the
  first leg, follows it, walks the transfer, and boards the next one. Not an
  animation laid over the map — the vehicle is a real run in the simulation.
- **See how far you can get.** Pick a stop, choose a budget, and the map paints
  everything reachable in 15/30/45/60 minutes. Restrict it to the 101 free
  routes and it answers a question few networks can: how far can you travel
  without paying anything?
- **Share any view.** The URL carries the time, camera, selection, journey,
  reachability and filters, so "look at Koridor 1 at 07:30" is a link rather
  than a set of instructions.
- **Tap anywhere**, not just a dot. Open map answers with the stops within
  walking distance, their next departures, and an option to start a journey
  from that exact point.
- **First and last bus** on every stop card, with a warning when the last one
  is close or already gone.
- **See the shape of the day** on the time scrubber, and **colour the network by
  live frequency** instead of by service type.
- **Watch the real street.** Switch on *Kamera langsung* and 801 public CCTV
  cameras appear on the network — 658 city cameras beside stops, and 143 on the
  toll roads the Royaltrans and Transjabodetabek services actually drive. Click one and it
  plays live; click the picture and it fills the map. The map beside it is a *schedule*, not a position feed, so the two
  will disagree — the card says so rather than implying the bus on screen is the
  bus in the camera. Live mode only, for the same reason.
- **Search** routes by number or name, and stops by name.
- **Filter** by service category: BRT corridors, Angkutan Umum Integrasi,
  Mikrotrans, Transjabodetabek, Royaltrans, Rusun, Bus Wisata.
- **Accessible stops only** empties the map down to 39 of 7,488 drawn stops —
  every one a BRT corridor station. See below.

## How it works

### The data pipeline (`scripts/build-data.mjs`)

The expensive geometry work happens once, at build time. For every trip, each
stop is projected onto the trip's route shape and stored as a distance along
that shape. At runtime, positioning a bus is then a binary search and a lerp
rather than a nearest-point-on-line search.

Three things in this feed make that projection harder than it looks, and each is
handled explicitly:

1. **Closed-loop shapes.** Many shapes begin and end at the same coordinate, so
   a terminus that both starts and ends the trip is equidistant from offset 0
   and offset *L*. Broken the wrong way, the first stop lands at the end of the
   line and — because offsets may never decrease — drags every later stop with
   it. 99 of the 700 trips collapsed this way before ties were resolved toward
   the earlier match.
2. **Routes that double over themselves.** A stop can match a later pass over
   the same street better than the correct earlier one. The search window is
   therefore bounded by how far a bus could plausibly travel in the scheduled
   time. Without it, one Mikrotrans trip appeared to cover 25 km in 13 seconds.
3. **Frequency-based service.** `frequencies.txt` gives headways, not
   departures, so a trip is a *pattern*. It expands at runtime into individual
   runs — 69,761 of them across a service day.

After these corrections every trip spans its full shape (median 99.9%), the
median segment speed is 13 km/h, which is about right for Jakarta, and the worst
stop-to-shape match is 183 m.

Output lands in `public/data/`:

| File | Size | Contents |
| --- | --- | --- |
| `network.json` | 2.0 MB | routes, stops, trips, stop offsets, headway windows, fares, transfers, walk transfers |
| `shapes.bin` | 1.3 MB | 164k route vertices, delta-encoded as int32 |
| `routes.geojson` | 1.5 MB | simplified lines for display |

Shape vertices ship in a side-car binary rather than in the JSON: as
delta-encoded integers scaled by 1e6 (about 11 cm), consecutive vertices differ
by a handful of units and compress far better than raw floats.

### The artifact pipeline (`scripts/ingest/`, `scripts/transform/`)

The path that feeds the default boot, and the one all four modes come through.
It is three stages that never blur into each other:

| Stage | What it does |
| --- | --- |
| `npm run ingest` | Fetches each upstream into `data/snapshots/<source>/<date>/`, and **never transforms**. A build is therefore reproducible offline, and a source going dark degrades to stale rather than to silently wrong. |
| `npm run transform` | Snapshots → one canonical dataset → content-hashed binaries in `public/artifacts/`. Nothing publishes if the validation gate errors. |
| the browser | `manifest.json` first, then core, then only the modes asked for. Decoded in a worker, cached in IndexedDB. |

All four modes come to **628 KB brotli / 1005 KB gzipped**, against 1.33 MB
gzipped for the buses alone on the older path. Trips are binary because JSON was
the wrong shape for them: a trip is a pattern index, a uint32 first call and a
uint16 delta per stop, with stop identity living once on the pattern rather than
once per trip — 5.3x smaller gzipped than the same trips as JSON.

**The validation gate fails the build.** Each of its checks exists because the
failure it looks for has actually happened here: times never unwrapped past
midnight, a reconstruction splicing two vehicles into one, a station joined to
the wrong coordinates, a walk table joining stops 74 km apart, a source that
answers every day with data that stopped moving in May. `npm run test-transform`
proves the gate catches each one.

### Journey routing (`src/routing/`)

| Module | Responsibility |
| --- | --- |
| `timetable.js` | Schedule queries over a headway-based feed — next departure, ranges, first/last bus, service days |
| `router.js` | RAPTOR search: journey planning and reachability |
| `fares.js` | What a journey costs, given the 3-hour integrated transfer window |

**The feed publishes headways, not departures.** There is no departure row to
look up: the next departure of a pattern at a stop is the next multiple of the
headway inside an active `frequencies.txt` window, offset by the stop's position
in the pattern. All of that lives in `timetable.js`, and the departure boards in
the UI use it too, so the app has one implementation of schedule arithmetic
rather than two that drift.

**The search is RAPTOR, not Dijkstra.** Rounds rather than a time-expanded
graph, because a round is exactly one additional ride — so the round index *is*
the transfer count, which is what riders care about. It searches over *nodes*
(a station standing for its platforms), and relaxes the derived walk-transfer
table between rounds.

**Fares do not sum.** A free route never opens a paid period, the first paid
boarding is charged in full, later boardings inside the 3-hour window are
covered, and a dearer service charges the difference. The order matters: riding
free-then-paid still costs the paid fare, which a naive "charge the first
boarding" rule would report as free.

Verified end to end by `npm run test-routing` — 91 checks against the real
network, including a property test that the closed-form headway arithmetic
agrees with brute-force enumeration over 5,000 random queries.

```
Blok M → Harmoni        ride 1                              52 min, 0 transfers, Rp 3.500
Blok M → Pulo Gadung    ride 1 → 4K → walk                  98 min, 1 transfer,  Rp 3.500 (one tap)
                        ride 1 → 1T → 2                     95 min, 2 transfers, Rp 20.000
```

A query costs about **2 ms**, against a 300 ms budget.

Reachability is the same search with the destination removed and a ceiling put
on instead, which is why it cost almost nothing to add. From Dukuh Atas at
08:00, in **4 ms**: 49 stops within 15 minutes, 335 within 30, 900 within 45,
1,960 within an hour.

The free-routes filter is the part worth having. From a Mikrotrans stop, 728 of
881 stops reachable in 45 minutes cost nothing at all. From a BRT interchange
like Dukuh Atas the answer is 1 — no free route serves it, only paid corridors —
which the panel says outright rather than showing an empty map.

### Riding a planned journey

A plan is not drawn on top of the simulation; it is a *selection of vehicles
already in it*. Each ride leg names a trip pattern and a departure time, and
`fleet.findRun()` resolves that pair to the run actually serving it, so the
camera follows a bus that is genuinely out there among the other 6,000.

`ui/ride.js` gives every leg a window on the clock. Ride legs carry their own
times; a walk gets the gap between the ride before and the ride after — usually
longer than the walk itself, and showing the wait honestly is part of the point.
A journey from Blok M reads:

```
8:06 ride (1) → 8:09 walk → 8:10 waiting → 8:13 ride (13B) → 8:34 ride (9) → 8:53 ride (7)
```

Two states that look alike are kept apart deliberately: a bus that has not set
out yet (normal during the lead-in when boarding at a pattern's first stop, and
the camera waits at the stop) versus a run the timetable promises that the fleet
is not running. Conflating them reads as a fault when it usually is not.

### Walking, and where a journey starts

Two radii, deliberately different: **400 m** between buses (a transfer you did
not choose) and **800 m** to reach your first stop (a walk you did). The search
seeds every stop within the access radius, so a journey may begin on foot —
**43% of itineraries now do**, against none before, because walk relaxation
previously only ever saw stops a ride had already improved.

An origin can be a stop or a tapped coordinate; from a point the router seeds
the nearest handful of stops with their walking times. Reconstruction collapses
adjacent walk legs and re-boardings of the same vehicle, which are artefacts of
a round-based search rather than things a rider would do.

### Frequency, not category

Colouring route lines by service type is static — replaying a day changes the
buses but not the picture. Colouring by **current headway** makes the network
breathe: **223 routes are running at 08:00, and 15 at 22:30.** The ramp needs a
sensible top band, since the feed's headways run from 180 s to 52,700 s.

The scrubber carries the same story as a curve behind the slider, counted with
a difference array over all 69,761 runs rather than by simulating each bucket.
Hiding Mikrotrans visibly flattens it — peak 6,445 down to 2,905.

### Deep links (`src/url-state.js`)

```
?c=106.8230,-6.1880&z=15.40&p=62&b=-18&t=07:30&from=H00014P&to=H00095P&hide=Mikrotrans
```

View, clock, selection, journey, reachability, a previewed line, a selected CCTV
camera (`cam=`), category filters and accessibility mode all round-trip. Writes
are throttled and use `replaceState`, so panning the map does not fill the back
button with history.

Three rules the round-trip depends on:

- **An explicit view wins.** Restoring a journey would normally reframe the map
  to fit it, which throws away the very view the link was sent to show. A
  restored CCTV camera follows the same rule and does not fly.
- **A CCTV camera and a replay time cannot both hold.** The camera layer exists
  only in live mode, so a link carrying both is asking for two incompatible
  things. The camera wins, the clock is forced live, and the card says the time
  was dropped — moving the clock silently is the one answer ruled out.
- **Malformed input degrades, never throws.** `?t=99:99&z=abc&c=nonsense` opens
  a normal live map rather than a blank screen, and `?cam=` naming a camera that
  is no longer in the build changes nothing at all.

A bus is identified by its pattern and departure (`bus=1-R01@27000`) rather than
by a run index, because run indices are an internal detail that changes whenever
the data is rebuilt.

### The runtime

| Module | Responsibility |
| --- | --- |
| `src/clock.js` | Live and playback time, in seconds since Jakarta midnight |
| `src/network.js` | Decodes the bundle; resolves a distance along a shape to a position and heading |
| `src/fleet.js` | Expands headways into runs, tracks which are in service, positions them |
| `src/layers/vehicle-layer.js` | Draws the fleet as one instanced three.js mesh per mode, in a Mapbox custom layer |
| `src/layers/vehicle-geometry.js` | The Kapsul vehicle body: one geometry per mode, all built inside the same base box |
| `src/ui/` | Clock, layer, search and detail panels |

Two details worth knowing:

**Movement between stops is kinematic, not linear.** Each leg follows a
trapezoidal speed profile — accelerate, hold, brake — so buses ease away from
and into each stop. The accelerating fraction *k* of a leg of distance *d* and
duration *t* satisfies `k(1 - k) = d / (a·t²)`; legs too short to reach cruising
speed have no real root and fall back to a triangular profile. Dwell times come
from the gap between `arrival_time` and `departure_time` in the feed.

**Two viewpoints, one camera.** "Dari dalam" drops from the chase view (zoom 17,
pitch 65) to riding on board (zoom 18.4, pitch 82 — Mapbox caps pitch at 85),
with a much larger look-ahead so the vehicle falls below the frame, and the
tracked bus scaled to nothing because from on board you are inside it. Switching
mid-follow re-settles the camera by treating it as a new vehicle.

**The follow camera centres ahead of the bus, not on it.** Centring the bus
itself spends most of the screen on road already travelled. Centring a point in
front of it — a distance derived from the current scale, so the framing holds as
you zoom — sits the bus about two thirds down the frame. Route shapes are
polylines, so the bus's own heading can snap by 90 degrees between one frame and
the next; the camera follows it through an exponential decay over elapsed time,
which absorbs an 86°/frame corner into under 6°/frame and behaves the same at
any frame rate.

**The detail card is built once per selection, not once per frame.** A tracked
bus reports a new position every frame, but rebuilding the card's markup at that
rate replaces its buttons between a mousedown and the following mouseup, so the
browser never produces a click and the buttons silently stop working. Only the
values that change are written afterwards; the timetable is redrawn only when
the bus reaches another stop.

**Stop styling follows the theme, not just the hour.** Stops are drawn as holes
punched in the ground — filled with the ground colour, outlined in the ink
colour — so the same geometry reads on a light or a dark map. Which way round is
a property of the *theme*: the monochrome theme keeps a pale ground at every
light preset and only dims its buildings, so its night view still needs dark
ink, where the default theme genuinely inverts.

**The scene is built in metres, not Mercator.** Mapbox hands a custom layer a
matrix mapping Mercator coordinates in [0, 1] to clip space, but a metre in
Jakarta is about 1.6e-8 Mercator units — far below float32 precision. The scene
is therefore built in metres around a fixed origin, with the origin transform
folded into the camera's projection matrix.

The simulation costs about **0.22 ms per frame** for the full peak fleet, so
frame rate is bound by GPU rasterisation rather than by the JavaScript.

## Live cameras

Jakarta publishes street CCTV that a browser can play directly: the JakCCTV
portal is a wrapper over a Flussonic media server which sends
`access-control-allow-origin: *` with no auth token, so there is no proxy and no
key anywhere in this feature.

Positions are the hard part. The portal lists 50 cameras and no coordinates, and
there is no API — `/api/cctv`, `/api/camera` and `/publik/data` are all 404, and
`api.jakarta.go.id` does not resolve. The coordinates come from a community
mirror of the DKI open data release, which is stale: of its 2,288 streams only
**662 still answer**. `npm run ingest -- --source=cctv` probes every one and
records the result, and the transform keeps the 612 that are also within 400 m of
a stop.

46 of the cameras come from the portal's own host instead — Thamrin, Gatot
Subroto, S. Parman, Gerbang Pemuda, the ones actually pointed at Transjakarta
corridors, and all of them live. Nothing geolocates those at all. What they do
carry is the street, in the stream id itself, so their position is recovered
from the street via `data/camera-places.json` and OpenStreetMap geometry. Half a
street is a real error, so they ship marked `estimated` and the card says
*perkiraan lokasi* rather than implying a precision that is not there —
correcting one is a one-line edit in that file. (Commercial geocoding was no
help: Mapbox returns the same district centroid for MH Thamrin, Gerbang Pemuda
and Gatot Subroto alike.)

**801 cameras** ship in total — 612 geolocated street, 46 placed from street
names, 143 on the toll roads. Their artifact is **14.6 KB brotli** and is
fetched only when the layer is switched on; `hls.js` is a dynamic import and
code-splits accordingly, so a viewer who never opens a camera downloads neither.

The layer is available **only in live mode**. A camera shows the street now, and
the clock can be replaying a Tuesday in March at 1200x; there is no honest way to
show both at once. Mini Tokyo 3D's camera plugin makes the same call, declaring
`clockModes: ['realtime']`.

And the caveat the card carries rather than hides: there is no GTFS-Realtime for
any Jakarta operator, so every vehicle on this map is where the *timetable* says
it should be. The camera is the only thing on screen showing reality. They will
disagree, and that is the honest state of the data rather than a bug.

### Toll roads

Jakarta's daytime population lives outside Jakarta, and the commuter services
this map carries spend most of the journey on a toll road. Those cameras need
two sources: BPJT publishes coordinates for 1,530 cameras nationwide but its
table has not been rewritten since May, and Jasa Marga — 61% of the network —
has rotated every stream id since. Bina Marga's per-road pages carry the current
streams and no coordinates. They join on (road, KM).

They are also filtered differently. A motorway camera is nowhere near a bus
stop, so the toll half is kept on proximity to a **route path** instead: 64% lie
within 150 m of one the fleet drives, against 41% within 400 m of a stop.

Both sources are watched, because both will decay quietly. BPJT's own rows carry
an `updated_at` and every one of the 1,530 says 2026-05-11, so a fetch that
succeeds proves nothing about whether the data behind it has moved — the gate
reads the rows rather than the snapshot date. The join is measured road by road
and the split recorded, so an arm collapsing or a single road going dark is
reported rather than left as a number in a log. Measured from the feed side the
join is **100% wherever it can run**: 135 of the 173 kilometre markers Bina
Marga publishes live, with every miss on a road where BPJT states no KM at all.

## Walk transfers

`transfers.txt` declares **7** interchange pairs for the whole network. That is
not a usable transfer graph, so the build derives one from stop coordinates:
every pair of stops within 400 m where the walk reaches a route the origin does
not already serve.

**28,737 edges across 7,488 nodes**, 65% of nodes with at least one, median walk
3m34s. The effect on connectivity is the point:

| Interchange available | Route pairs |
| --- | --- |
| At a shared stop | 1,970 |
| Additionally, by a walk of ≤400 m | 1,904 |

Walking very nearly doubles the network's interchange options. Any routing work
that used only the declared transfers would miss half the city.

The radius is a deliberate choice — edges grow with its square while
connectivity does not:

| Radius | Edges | New route pairs |
| --- | --- | --- |
| 300 m | 16,014 | 1,775 |
| **400 m** | **28,929** | **1,905** |
| 500 m | 45,866 | 2,052 |
| 800 m | 128,420 | 2,653 |

Going to 800 m costs 4.4× the data for 1.39× the options, and asks for a
ten-minute walk between buses. Note this is the *transfer* radius; walking to
the first stop or from the last is a separate question, handled at runtime.

## Accessibility

`wheelchair_boarding` marks **100 of the Transjakarta feed's 8,091 stops** as
boardable by a wheelchair user — the bus feed is the only one of the four that
publishes the flag at all. It sits on platforms rather than on their parent
station, so the build propagates it upward; the 100 resolve to **39 of the 7,488
bus stops the map draws**, and every one is a BRT corridor station. No Mikrotrans stop qualifies.
Toggling "Hanya halte aksesibel" makes that visible at a glance.

## Fares

`fare_attributes.txt` and `fare_rules.txt` price the network by route, and the
split is worth knowing:

| Fare | Price | Routes |
| --- | --- | --- |
| GR | Free | 101 (Mikrotrans, Rusun) |
| FP / FP2 | Rp 3,500 | 129 |
| PP / PP2 | Rp 20,000–25,000 | 9 (Royaltrans) |
| PP3 | Rp 35,000 | 1 |

Every fare carries a 10,800-second (3 hour) transfer window, which the bus card
shows alongside the price.

## Data and basemap

GTFS feed published by Transjakarta (`agency_id: Tije`), from
`https://gtfs.transjakarta.co.id/files/file_gtfs.zip`.

The basemap is stock **Mapbox Standard** (`configs.style`), so the app runs on
any Mapbox token rather than only one on a particular account. `lightPreset`
and `show3dObjects` are Standard's own `basemap` import config, which is how
the time-of-day lighting and the *Gedung 3D* toggle are driven.

This replaced a private Monochrome style built on the same base. What was lost
with it is a grey city for the fleet to stand out against: Standard is full
colour and the vehicles compete with it. If they stop reading, Standard's
`monochrome` theme is one `setConfigProperty('basemap', 'theme', 'monochrome')`
away. Swapping the style is a one-line change in `src/configs.js`; a classic
style (`dark-v11` and friends) would work too, but would need the 3D buildings
rebuilt as a `fill-extrusion` layer and would lose the lighting presets.

Route geometry and station positions are derived from **OpenStreetMap**, so the
map credits it under ODbL alongside the operators — see `LICENSE`.

## Deploying

The app is a static build. `npm run build` writes `dist/`, and both
`public/artifacts/` (what the browser downloads) and `public/data/` (the legacy
bundle) are checked in, so the host needs no data step — just Node and a
Mapbox token.

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 22 |
| Environment variable | `MAPBOX_ACCESS_TOKEN` |

Three hosts are configured, and **Cloudflare has two products that are not
the same thing**:

| Host | What it reads | Deploy command |
| --- | --- | --- |
| Cloudflare **Workers** | `wrangler.jsonc` | `npx wrangler deploy` |
| Cloudflare **Pages** | its own dashboard | — |
| Netlify | `netlify.toml` | — |

A `*.workers.dev` URL means Workers, and Workers Builds runs the build and
then `npx wrangler deploy`, which needs `wrangler.jsonc` to know what to
upload. Without it the build succeeds, the deploy fails, and whatever was
deployed before — the Hello World template, on a new project — stays live at
the URL. From outside that reads as "latest build failed" with no clue why.

Three ways a first Cloudflare build fails, none of which is a broken repo:

- **No `wrangler.jsonc`, on Workers.** Fixed in this repo; the deploy command
  in the dashboard still has to be `npx wrangler deploy`.
- **The token has to be a *build* variable.** Cloudflare separates build
  variables from runtime ones on two different screens, and only the build ones
  reach `vite build`.
- **Connecting the repository fires a deployment immediately**, before there is
  anywhere to have put the token. Save the variable, then retry that first
  deployment. `public/_headers` is honoured by both, and is where the caching
lives: everything under `/artifacts/` and `/assets/` is content-hashed and
cached for a year, except `manifest.json`, which is the one mutable file and
must revalidate — a stale manifest pins a visitor to an old dataset.

Two things worth knowing before the first deploy:

- **Use a separate Mapbox token, restricted by URL.** It ends up in the
  bundle, where anyone can read it. A restricted public token that only works
  on the deployed domain costs nothing and cannot be spent elsewhere.
- **It must be a public (`pk.`) token, and the build enforces that.** A token
  becomes secret the moment any secret scope is ticked at creation
  (`tokens:write`, `uploads:write`, `styles:write`, `downloads:read`); keep the
  public defaults. A secret token here is a published secret rather than a
  misconfiguration, so it would need revoking, not just replacing.
- **A visit is about 1.7 MB.** 665 KB of bundle plus ~1 MB of artifacts for the
  modes actually shown, and `hls.js` (179 KB gzipped) only if someone opens a
  camera. Mapbox's own tiles and its free tier's 50,000 monthly map loads are
  the limit that binds first, not the host's bandwidth.

No redirect rules are needed, and `not_found_handling` is deliberately left at
`none`. Deep links are query strings on one page (`?stop=`, `?cam=`, `?t=`),
not paths, so an SPA rewrite has nothing to do — and it would do harm: it
answers every unknown path with `index.html` and a 200, so a mistyped or swept
artifact hash would hand the loader a page of HTML to parse as JSON instead of
an honest 404.

## Known limits

- The feed is a **schedule**, not a live vehicle feed. Buses run exactly on
  time, and Jakarta traffic does not. Wiring in GTFS-Realtime would mean
  replacing the run's departure time with a reported position and re-deriving
  the offset — the rest of the pipeline would carry over unchanged.
- 12 of 25,528 timetable segments imply speeds above 80 km/h. These are
  inconsistencies in the published timings, and buses simply move fast there.
- Service exceptions (`calendar_dates.txt`) are not applied; the feed does not
  ship the file, so only the weekly `calendar.txt` pattern is honoured.
- When a followed bus reaches its terminus the card simply closes, with no
  handover to the next departure on that route.
- ~~Walking is straight-line distance~~ — **fixed.** All 40,817 edges are routed
  through Valhalla and carry real pedestrian times. The straight line had been
  out by more than three minutes on **12.4% of edges**, worst 38 minutes: Sekolah
  Fatimiyah Perdana to SMA Angkasa 1 is 293 m apart and 3,356 m on foot. The
  clusters were Halim and Roxy, where a toll road or a railway sits between two
  stops a street apart.
- Cross-mode walking is still unmeasured. The routed table covers every edge,
  but only 7 of the 400 sampled pairs were bus-to-rail — and those interchanges
  are both what a multi-modal map most depends on and the most likely to sit
  across a barrier.
- Frame rate has only ever been measured under a software rasteriser. The
  simulation costs 0.22 ms/frame, but the render path is untested on a real GPU
  — and the per-mode vehicle bodies took the fleet from 12 triangles a vehicle to
  360, roughly 2M at the evening peak against 72k.
- 46 camera positions are estimates, inferred from street names because no
  source geolocates them, and a further 47 live toll streams cannot be placed at
  all because BPJT names no kilometre for their road.

## Licence

Code is MIT — see `LICENSE`. The data is not the author's to license and stays
under its own terms: route geometry and station positions are
© OpenStreetMap contributors under **ODbL**, timetables belong to Transjakarta,
KAI Commuter, MRT Jakarta and the two LRT operators, and the camera streams to
JakCCTV / Dishub DKI, BPJT and Bina Marga. The dated captures under
`data/snapshots/` are unmodified copies of those sources, kept so a build is
reproducible offline.

**This is a scheduled simulation, not a live vehicle feed.** No Jakarta
operator publishes GTFS-Realtime; every vehicle drawn is where its timetable
says it should be. The map says so in its own attribution, and the only thing
on screen showing the street as it is now is a CCTV camera.
