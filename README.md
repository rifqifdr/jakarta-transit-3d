# Jakarta Transit 3D

*Angkutan umum Jabodetabek, dalam 3D.*

A 3D map of public transport in Greater Jakarta, in the spirit of
[Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d). Every vehicle is a
scheduled run, moved along its real route by a simulation clock: Transjakarta
buses, MRT, LRT and KRL Commuter Line — 249 routes, 8,236 stops, and over six
thousand vehicles at the evening peak.

> **Vision:** make people have visibility regarding public transportation in
> Jakarta or the Greater Jakarta Area.

It is a spatial visualisation, not a trip planner. A→B planning was removed on
2026-09-12, because Google Maps, Moovit and Waze already do it with live
traffic. What stays is spatial: the moving fleet, following a vehicle, line
tours, reachability and live cameras.

Open work is tracked in a private **Plane** project (`JAKAR`), whose
**"Next Session — Start Here"** page is where each working session begins.
`CLAUDE.md` holds the working conventions and the traps this codebase has
already fallen into.

## Running it

```bash
npm install
npm run dev              # the app, on :5173
npm run test-routing     # 91 checks: schedule maths, reachability, fares
npm run test-transform   # 120 checks: canonical model, encoders, validation gate
```

| URL | Loads |
| --- | --- |
| `http://localhost:5173/` | `public/artifacts/` — all four modes. The default |
| `http://localhost:5173/?data=legacy` | `public/data/` — buses only. The control the routing tests run against |

Both are checked in, so neither needs a data build. `.env` needs a public
Mapbox token — copy `.env.example`:

```
MAPBOX_ACCESS_TOKEN=pk.…
```

No `VITE_` prefix: `vite.config.js` injects it, and refuses to build with any
token that is not a public `pk.` one.

**Rebuilding the data** is only needed when a feed changes:

```bash
npm run ingest           # upstream -> dated snapshots in data/snapshots/
npm run transform        # snapshots -> canonical dataset -> public/artifacts/
npm run build-data       # the older path: GTFS -> public/data/
```

## What it does

- **Live or replayed.** Real Jakarta time, or any time of day at up to 128×.
  The basemap's lighting follows the sun's altitude, and a faint tint carries
  the hour between its presets.
- **Click a vehicle** for its line, headsign, fare and progress. **Follow it**
  in *Navigasi*, a navigation-style view, or *Dari dalam*, from the roof, with
  *Suara* for a cabin sound and a station announcer.
- **Fly a line** end to end with *Jelajahi jalur ini*, drawn the way navigation
  draws a route: grey behind, yellow to the next stop, the line's colour ahead.
- **Click a stop** for its routes, next departures, and first and last bus.
- **See how far you can get** in 15–60 minutes from any stop or point, released
  in arrival order, optionally on free routes only.
- **Click empty map** (press and hold on a touch screen) for the stops nearby
  and the reach from that exact point.
- **Watch the real street** through 798 public CCTV cameras on the network, in
  live mode only.
- **Filter and style** by mode and service category, colour lines by current
  frequency, draw speed trails, show accessible stops only, and switch the
  basemap between *Warna*, *Pudar* and *Mono*.
- **Share any view** as a link. `?tour=<route>` opens flying a line,
  `?cam=<id>` opens a camera.

## How the buses move

Transjakarta's feed lists no departures. All 700 of its trips are defined by
frequency: `frequencies.txt` gives a time window and an interval, and
`stop_times.txt` gives one sample run per trip. The app turns those into buses
in three steps, and builds each vehicle's speed from the result. Rail is
simpler — its sources publish real departures, so each train is a single run
and goes through the same code.

### 1. An interval becomes a list of departures

- When the network loads, `src/fleet.js` walks each window from its start,
  adding the interval until the window closes. Each departure is one run, which
  is one bus.
- Example: `10A-L02` runs every 2,180 s from 05:00 to 22:00, so it gets 29 runs —
  05:00:00, 05:36:20, 06:12:40 … 21:57:20.
- Across the whole feed that is **69,761 runs** in a service day, before the
  weekday calendar is applied.
- Intervals run from 180 s to 52,700 s, median 900 s, and never change by time
  of day. 752 of 753 windows are `exact_times=0`: "about every N minutes", not
  fixed clock times.
- The feed gives no starting point for the rhythm, so the first bus of every
  window leaves exactly at the window's start. That is an assumption.
- Each run stores its trip, its start, and its end (start plus the trip's
  duration).

### 2. Stop times are one template, shared

- The sample run is kept as seconds from the first stop — for `10A-L02`, 0, 181,
  288 … Every run of a pattern uses the same list, so a bus leaving at 05:36:20
  passes the second stop at 05:39:21.
- Each stop also carries a distance along the route's shape, projected once at
  build time and in order along the shape, so a loop route never matches a stop
  to its later pass. Placing a bus at runtime is then a lookup between two
  known distances.
- Travel times are the same at 07:30 as at 03:00. The feed has one set for the
  whole day.
- The feed gives a 10-second halt at nearly every stop (26,375 of 26,427 rows).
  The default boot path currently keeps departure times only, so buses brake
  into a halte and pull away without standing; the legacy path keeps the halt.
  See *Known limits*.

### 3. Each frame, every active bus is placed

- **Who is out.** A run is active while the clock is between its start and end
  and its service runs that weekday (`calendar.txt`). A run that left before
  midnight carries on past it. The set is rebuilt once per simulated second,
  not every frame.
- **Where it is.** Time since the run's start finds the leg between two stops.
  The share of the leg's time that has passed becomes distance through a speed
  profile — accelerate, cruise, brake — at each mode's own rate (bus 1.0 m/s²,
  KRL 0.7, MRT 1.1). Legs too short to reach cruising speed only accelerate and
  brake. The distance becomes a point and a heading on the shape.
- **When it stands.** Between a stop's arrival and departure, and at its
  terminus until the run ends.
- **How fast it goes.** The leg's length over its scheduled time, which is what
  the speed trails draw.
- **What it costs.** Four draw calls for the whole fleet, one instanced mesh per
  mode. The simulation itself is about 1 ms a frame for six thousand vehicles on
  an Apple M4; the basemap is the expensive part.

### 4. How speed is built

- **One number per leg:** the leg's length divided by the time the timetable
  gives it, in metres per second (`src/fleet.js:272`). It is 0 while the
  vehicle stands.
- **Length** is the difference between the two stops' distances along the
  shape. **Time** is the arrival at the next stop minus the departure from this
  one.
- **Example:** the first leg of `10A-L02` is 612 m. The legacy path gives it
  171 s, so 3.6 m/s, about 12.9 km/h. The default path gives it 181 s, because
  the halt it drops is added to the leg (see *Known limits*), so 12.2 km/h.
- **Where the time comes from:** for buses, the feed's sample run; for KRL,
  each train's published times; for MRT and LRT, the track distance, because
  their departure boards cannot give travel times.
- **It is the leg's average.** The vehicle itself accelerates, cruises and
  brakes, so its top speed is the average ÷ (1 − the share of the leg spent
  accelerating). On that first leg a bus reaches cruising speed in about 3.7 s
  and tops out at 13.2 km/h.
- **What uses it:** the speed trails. A trail is 8 seconds of speed, held
  between 8 and 200 m, and scaled up with the vehicles when zoomed out
  (`src/layers/vehicle-layer.js:36`). The average is used on purpose: a trail
  following the speed moment by moment would shrink to nothing at every stop
  and flicker.
- **It is scheduled speed.** There is no traffic in it, and a leg has the same
  speed at 07:30 as at 03:00.

## How each feature works

### The clock and the light

- Live mode follows Jakarta time. Replay picks any time of day and runs it at
  1× to 128×.
- The day-and-night look follows the sun's altitude over Jakarta, not the hour,
  so dawn and dusk land when the sky actually changes. Mapbox Standard has four
  light presets; a faint tint over the map (`src/sky.js`) fills in between them.

### Stop departures

- The bus feed lists no departures, so the stop card works them out: for each
  pattern calling at the stop, the next run start after now, plus that stop's
  offset in the template. The card and the moving fleet use the same arithmetic
  (`src/routing/timetable.js`), so they always agree.
- First and last bus are the earliest and latest runs of the day at that stop.
- Train departures are the published ones.

### Following a vehicle

- **Navigasi** is a navigation-style view: the camera sits behind and above the
  vehicle at a 78° pitch, with the vehicle low in the frame. The route ahead is
  drawn as a ribbon that shortens as the vehicle moves, and labels, other routes
  and other stops are pulled back. Everything it changes is put back when you
  stop.
- **Dari dalam** rides on the roof: closer, at an 82° pitch, with the vehicle
  itself hidden.
- While following, the card shows only progress and the stops around the
  vehicle.
- **Suara** adds sound: a looped cabin recording on trains (a CC0 recording of
  an electric train), and the device's own Indonesian voice announcing each stop
  as it is reached.

### Flying a line

- *Jelajahi jalur ini* flies a trip from its first stop to its last. From a
  vehicle's card it is that vehicle's own trip; from a line's card it is the
  line's longest journey, measured from first stop to last.
- The camera moves at a constant ground speed of about 620 m of line per second,
  held between 14 and 95 seconds, so a short feeder and a 50 km rail line both
  read well.
- The line is drawn as navigation draws a route: grey behind, yellow to the next
  stop, the line's own colour ahead. Other lines dim, the fleet and other stops
  step aside, and all of it comes back when the flight ends or you touch the map.

### Reachability

- Pick a stop, or a point on the map, and a budget of 15, 30, 45 or 60 minutes.
  A forward search over the timetable (`src/routing/router.js`, RAPTOR) finds
  every stop reachable from now, riding and walking between stops.
- From a point, the search starts at the nearest stops within 800 m, walked at
  4.8 km/h.
- Results are released in order of arrival over six seconds, so the edge of
  what is reachable visibly moves along the corridors and jumps down the rail
  lines.
- *Free routes only* restricts the search to the 101 routes that cost nothing.

### Frequency colours

- Colours each route by how often it runs right now: under 5 minutes, 5–15,
  15–30, or over 30. It changes as the clock moves.
- A route with several patterns takes its shortest active interval.

### Vehicle sizes on screen

- Each mode has its real size: a bus is 12 m, an LRT set 80 m, an MRT set 120 m,
  a KRL set 160 m, each with its own body shape.
- Below zoom 16, vehicles are enlarged so the network stays readable. They are
  enlarged towards a common on-screen length, so a train is not drawn
  kilometres long.

### Where train trips come from

- **KRL** publishes each train with its stops and times, which are used
  directly.
- **MRT and LRT** publish departures per station, not trains.
  `scripts/transform/reconstruct.mjs` rebuilds the trains: it estimates each
  leg's travel time from track distance, then walks the line claiming
  departures that fit. A departure nobody claims is a train starting at that
  station, which is how short workings show up.
- Rail geometry comes from OpenStreetMap route relations, stitched into one
  continuous path per line.

### Walking between stops

- `transfers.txt` declares only 7 interchange pairs, so the walk table is
  derived: every pair of stops within 400 m, 40,466 edges in all.
- Each edge is routed through Transitland's hosted Valhalla for a real walking
  time. A straight line had been off by more than three minutes on 12.4% of
  edges, wherever a railway, river or toll road sits between two stops.

### Live cameras

- 798 public CCTV cameras: 658 on streets and 140 on toll roads.
- Most street cameras have published coordinates. 46 are placed from the street
  named in their stream id, so their position is an estimate, and the card says
  so.
- Toll cameras join two government sources: BPJT gives positions, Bina Marga
  gives the streams that still play.
- Cameras play in live mode only, and load only when the layer is switched on.
  The fleet is a schedule and the camera is the real street, so the two will
  disagree.

### Links

- The URL carries the time, the camera view, the selection, reachability and
  filters, so any view can be shared.
- `?tour=<routeId>` flies a line on arrival. `?cam=<id>` opens a camera and
  switches the clock to live.

## How it works

| Stage | What it does |
| --- | --- |
| `npm run ingest` | Fetches each upstream into `data/snapshots/<source>/<date>/` and **never transforms**, so a build is reproducible offline and a source going dark degrades to stale rather than wrong |
| `npm run transform` | Snapshots → one canonical dataset → content-hashed binaries in `public/artifacts/`. **Nothing publishes if the validation gate errors** |
| The browser | `manifest.json`, then core, then only the modes switched on. Decoded in a worker, cached in IndexedDB |

All four modes come to about **640 KB brotli / 1.0 MB gzip**. Trips are binary:
a pattern index, a first call and a small delta per stop, with stop identity
stored once on the pattern rather than once per trip.

Each check in the validation gate exists because its failure has happened here:
times not unwrapped past midnight, two vehicles spliced into one, a station
joined to the wrong coordinates, a walk table joining stops 74 km apart, a
source that answers daily with data that stopped moving months ago.
`npm run test-transform` proves the gate catches each one.

| Module | Job |
| --- | --- |
| `src/clock.js` | Live and playback time, in seconds since Jakarta midnight |
| `src/network.js` | Decodes the data; turns a distance along a shape into a position and heading |
| `src/fleet.js` | Expands intervals into runs, picks the active ones, places them |
| `src/layers/vehicle-layer.js` | Draws the fleet, one instanced three.js mesh per mode |
| `src/routing/` | Schedule maths (`timetable.js`), the reachability search (`router.js`), fares (`fares.js`) |
| `src/ui/` | Panels: clock, Layanan, Lapisan peta, search, detail, reach, follow, credits |

## Data, by mode

| Mode | Source |
| --- | --- |
| Transjakarta (bus) | Official GTFS from `gtfs.transjakarta.co.id` — the only Indonesian feed on Transitland |
| KRL Commuter Line | Three unauthenticated JSON endpoints on `kci.id`, one returning whole trip stop sequences |
| MRT Jakarta | The timetable from MRT Jakarta's own API |
| LRT Jakarta | Its timetable page, which answers a form request |
| LRT Jabodebek | Its timetable page, which renders the timetable into the page itself |

Rail geometry and station positions come from OpenStreetMap. MRT and both LRTs
publish departure boards rather than trains, so their trips are rebuilt from
the boards. **No Jakarta operator publishes GTFS-Realtime.**

Facts about the bus feed worth knowing:

- `transfers.txt` declares 7 interchange pairs. The walk table derives 40,466
  edges within 400 m, each routed for real walking time through Transitland's
  hosted Valhalla.
- Stations are containers: `stop_times` points at platforms, which point at
  their station.
- Fares do not add up per ride. A 3-hour window covers later boardings, and 101
  of 240 routes are free.
- 100 stops carry `wheelchair_boarding`, which resolves to 39 drawn stations,
  all on BRT corridors.

The basemap is stock **Mapbox Standard**, so the app runs on any Mapbox token.

## Deploying

A static build. Both data folders are checked in, so the host needs Node and a
token and nothing else.

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | 22 |
| Environment variable | `MAPBOX_ACCESS_TOKEN` |

| Host | Reads |
| --- | --- |
| Cloudflare Workers | `wrangler.jsonc`, plus `worker/index.js` so the artifacts are served brotli |
| Netlify | `netlify.toml` |

- **Use a separate public token, restricted to the site's URL.** It is
  compiled into the bundle, where anyone can read it.
  `npm run check-token -- https://your-site/` says whether a token is valid,
  revoked or restricted — three failures that look identical in the browser.
- **On Cloudflare the token is a *build* variable**, set on a different screen
  from runtime ones, and the first deploy fires before there is anywhere to put
  it. Save the variable, then retry.
- **After a deploy**, `node scratchpad/verify-artifacts.mjs https://your-site/`
  checks the artifacts really arrive compressed. Give a Workers deploy a couple
  of minutes first.

The reasoning behind each of these is in `CLAUDE.md`, under "Shipping it".

## Known limits

- **A schedule, not positions.** Buses run exactly on time, perfectly spaced,
  with the same travel times all day. Real corridors bunch and crawl.
- **Bus stops have no halt on the default path.** The feed's 10-second halt is
  dropped by the transform, which keeps departure times only. A fix is planned.
- **The first bus of every window is assumed** to leave at the window's start.
- **Service exceptions are not applied**: the feed ships no
  `calendar_dates.txt`.
- **Four Cikarang patterns cannot be drawn** — 6 trips of 3,216 — because their
  OpenStreetMap relation stops one station short.
- **46 camera positions are estimates** from street names, and 47 live toll
  streams cannot be placed at all.
- **Performance is measured on an Apple M4 and a Galaxy S25 only.** On the S25
  the line tour and *Navigasi* drop over a third of their frames; a mid-range
  Android is still unmeasured.
- **Walking between bus and rail has not been checked as a group**, though
  those are the transfers most likely to cross a barrier.

## Licence

Code is MIT — see `LICENSE`. Bundled third-party components carry their own
notices in `THIRD-PARTY-NOTICES.md`. The data is not the author's to license
and stays under its own terms.

The running map credits these in **Sumber data**, a panel opened from the end
of the credit line in its bottom-right corner, beside Mapbox's own.

### Data sources and their terms

| Source | What it gives | Terms |
| --- | --- | --- |
| Transjakarta | Official GTFS | Published openly; no licence stated by the operator or by Transitland |
| KAI Commuter, MRT Jakarta, LRT Jakarta, LRT Jabodebek | Timetables | Published openly; read from unauthenticated public endpoints, no licence stated |
| OpenStreetMap | Route geometry, station positions | **ODbL 1.0** — © OpenStreetMap contributors |
| Transitland (Interline) | Pedestrian routing for the walk table | [transit.land/terms](https://www.transit.land/terms) — attribution required, and given |
| Freesound — Yoyodaman234 | The EMU cabin sound under *Suara* | **CC0 1.0** — no credit required, given anyway; see `public/sounds/SOURCES.md` |
| ITDP Indonesia & TfJ-FDTJ | Line codification and colours | Lampiran to Kepgub DKI Jakarta 31/2022 |
| JakCCTV / Dishub DKI, BPJT, Bina Marga | Camera positions and streams | Public government sources; streams are embedded live, never recorded or restreamed |
| Plus Jakarta Sans | The typeface | **SIL OFL 1.1** — `public/fonts/OFL.txt` |

**The OSM-derived artifacts are offered under ODbL.** `public/artifacts/`
contains route geometry and station positions derived from OpenStreetMap, which
makes it a Derivative Database; ODbL's share-alike applies to it, and it is
published here under those terms rather than under the repository's MIT licence.
The MIT licence covers the code.

The dated captures under `data/snapshots/` are unmodified copies of those
sources, kept so a build is reproducible offline, and each records which host
answered on the day.

**This is a scheduled simulation, not a live vehicle feed.** No Jakarta
operator publishes GTFS-Realtime; every vehicle drawn is where its timetable
says it should be. The map says so in its own attribution, and the only thing
on screen showing the street as it is now is a CCTV camera.
