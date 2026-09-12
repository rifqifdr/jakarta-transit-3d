# Jakarta Transit 3D — working notes

A real-time 3D map of public transport in Greater Jakarta. Every vehicle is a
real scheduled run, driven along its actual route geometry by a simulation
clock. Around 6,600 vehicles move at the evening peak, across all four modes.

> **Vision:** make people have visibility regarding public transportation in
> Jakarta or the Greater Jakarta Area.

**Where this is going: a thematic map of Greater Jakarta, with one entry.**
Four themes — **Angkutan Umum** (the opening, and the foundation the other
three borrow), **Warga dan Kota**, **Air dan Tanah**, **Udara dan Cuaca**.
Phase 1 is the layers; phase 2 is a small set of *authored* analyses that
combine them. Not a mapping SaaS: the opening view is an opinion, and the
analyses are written rather than assembled. JAKAR-68 onward, and the theme
shell blocks the rest.

Three decisions carry all of it:

- **Layers store values, not appearances** — `{geometry, value, unit}`,
  coloured at render. Density already baked to red cannot be multiplied by a
  reachability result, and that is the whole bet of the two-phase split.
- **The channel budget**: at most one ground fill, one point layer, one line
  layer, plus the dimmed network. Two choropleths never co-exist, not even
  inside one theme. **The legibility limit and the GPU limit are the same
  limit** — the basemap is ~95% of a street-level frame and the whole fleet is
  0.2-2.6 ms, so what hurts is several heavy layers at once, which is exactly
  what the budget forbids. One rule enforces both.
- **Precompute rather than warn.** Five of six planned analyses are build-time
  jobs shipped as artifacts; at runtime they are lookups — the same trade
  `patterns.bin` already makes. For anything that must run live, build a
  *bound* (max time, max points, a stop button), because "this is expensive"
  is a warning nobody can act on.

**The transit-only shape is tagged `v1.0-transit`** and archived outside the
repo. It is recoverable exactly: `git checkout v1.0-transit`.

**The direction changed on 2026-09-12: this is a spatial visualisation, not a
trip planner.** A→B journey planning is gone — Google Maps, Moovit and Waze all
do it and do it with live traffic, and competing with them was spending the
one thing this map has (six thousand scheduled vehicles moving over a real 3D
city) on the one job it was worst at. What stays is everything spatial: the
animated fleet, **ikuti kendaraan**, line preview, reachability, the stop card,
and the live cameras. What gets built next is more *data about Greater
Jakarta*, not more routing.

It began with Transjakarta's buses and now carries **MRT, LRT and Commuter Line
(KRL)** as well. Two consequences to hold in mind while working:

- **The name is `Jakarta Transit 3D`** (JAKAR-26, done 2026-09-06), with the
  subtitle *"Angkutan umum Jabodetabek, dalam 3D"*. Do not add user-visible copy
  that names Transjakarta as though it were the whole system — but references to
  Transjakarta as the *operator of those particular routes* are correct and
  should stay.
- **The mode dimension is in** (JAKAR-27, done): mode sits above service
  category, and each mode now has its own size, acceleration and body geometry.
  What is still shaped by the bus feed is the *category* axis — `configs.categories`
  lists the rail lines beside Transjakarta's product names because that is the
  axis the layer panel filters on. Prefer mode-neutral naming in anything new.

**Read `README.md` for architecture.** This file is for working *in* the repo.

## Commands

```bash
npm run dev            # vite dev server on :5173
npm run build          # production build
npm run preview        # serve the build on :4173
npm run build-data     # GTFS -> public/data/  (only when the feed changes)
npm run test-routing   # 91 checks over the routing layer, against the real feed
npm run test-transform # 114 checks over the canonical model and validation gate
npm run ingest         # fetch raw dated snapshots from upstream sources
npm run transform      # snapshots -> canonical dataset, through the validation gate
```

**Two boot paths. Artifacts is now the default.** `npm run dev` then:

| URL | Loads |
| --- | --- |
| `http://localhost:5173/` | `public/artifacts/` — **all four modes**. The default. |
| `http://localhost:5173/?data=legacy` | `public/data/` from `build-data.mjs` — 240 routes, buses only |

The flag flipped once the artifact path had been lived with; booting a
multi-modal map into a bus-only network was the wrong first impression.

**Do not delete `build-data.mjs`.** `npm run test-routing` runs against
`public/data/`, so the old path is the regression test for the new one — it is
what proved the walk table bug (trap 7) was newly introduced rather than
long-standing, and it is still the only thing that can catch a mistake in the
artifact pipeline.

`GTFS_DIR=/path/to/gtfs npm run build-data` to point at a different feed.

```bash
npm run check-token                     # is the Mapbox token valid, revoked or restricted?
npm run check-token -- https://site/    # ...and is it allowed from that origin?
```

**Three Mapbox failures look identical from the browser** — the map never
paints and the console says 401 — and each has a different fix: the token is
secret, the token is revoked, or the token is URL-restricted and the origin is
not on the list. Only `api.mapbox.com/tokens/v2` tells them apart, which is
what `check-token` asks. All three have now cost a deploy cycle here.

```bash
npm run ingest -- --status              # newest snapshot per source, and its age
npm run ingest -- --source=osm          # one source
npm run ingest -- --source=all          # all of them, cheapest first
npm run ingest -- --source=kci --force  # refetch a source already done today
npm run ingest -- --source=walk        # route the walk table (needs a transform first)
npm run ingest -- --source=cctv         # probe the public CCTV cameras (~25 min)
npm run ingest -- --source=cctv-tol     # toll road cameras: BPJT index + Bina Marga streams
```

**`walk` is not like the others.** Every other adapter fetches from upstream;
this one routes the pairs in the project's own walk table, so it needs
`data/build/canonical.json` to exist. `--source=all` skips it (`derived: true`)
because on a fresh checkout there is nothing to route. Re-run it by name when
the stop set changes materially — the transform reports how many edges fell back
to straight-line estimates.

**Ingest never transforms.** Adapters write what the source said, on the day it
said it, into `data/snapshots/<source>/<date>/`. Everything downstream reads
snapshots rather than the network, so a build is reproducible offline and a
source going dark degrades to stale rather than to silently wrong.

A long harvest is resumable — one file per unit of work, and a file already on
disk is not refetched. `meta.json` is written last, so its presence is what
"complete" means, which is also why a half-finished snapshot is never built from.

**The validation gate fails the build.** `npm run transform` publishes nothing
if a check errors. The checks exist because each failure has actually happened
here: times never unwrapped past midnight, a reconstruction that splices two
vehicles into one, a station joined to the wrong coordinates, a source that
stopped updating. `npm run test-transform` proves the gate catches each one.

**Not every decay deserves an error.** `toll-camera-sources` (JAKAR-56) is all
warnings but one, because that layer degrades to *fewer* cameras rather than to
wrong ones, and failing a four-mode build over a camera source would be out of
proportion. Its single error is "in region, and not one camera resolved" — a
page format change rather than decay. Warnings are still reported after it, so
the error says why it collapsed rather than only that it did.

**Validate temporal order against geographic stop order, never sorted time.**
Sorting departures by time and then asserting they ascend is circular and
proves nothing — it is how the MRT short working at Blok M stayed hidden.

## Where things live

| Path | What |
| --- | --- |
| `scripts/build-data.mjs` | GTFS → `public/data/`. All expensive geometry happens here. |
| `scripts/ingest/` | Source adapters → `data/snapshots/`. Fetch only, never transform. |
| `scripts/ingest/sources/cctv.mjs` | Public CCTV: coordinate table, liveness probe, and the OSM features that place the portal cameras |
| `scripts/ingest/sources/cctv-tol.mjs` | Toll cameras: BPJT for position, Bina Marga for the streams that still play |
| `data/camera-places.json` | Where each portal camera site is. Estimates — correcting one is a one-line edit. |
| `data/snapshots/` | Raw dated captures of every upstream source, with provenance. |
| `scripts/transform/` | `model.mjs` (canonical entities), `join.mjs` (OSM ↔ operator), `validate.mjs` (the gate) |
| `data/aliases.json` | Station-name aliases for the OSM join. Three rows. Keep it that way. |
| `scripts/transform/artifacts.mjs` | Canonical dataset → content-hashed binaries + `manifest.json` |
| `scripts/transform/geometry.mjs` | Track projection, run times from distance, simplification, walk table |
| `public/artifacts/` | What the browser downloads. Generated; rebuildable from snapshots. |
| `src/routing/` | `timetable.js` (schedule maths), `router.js` (RAPTOR, now only for reachability), `fares.js` |
| `src/fleet.js` | Expands headways into runs, positions them each frame |
| `src/layers/vehicle-layer.js` | The fleet, as one instanced three.js mesh per mode |
| `src/layers/vehicle-geometry.js` | The Kapsul body, built per mode inside one base box |
| `src/kodefikasi.js` | Line codes, line colours and the mode glyph sprite (JAKAR-50) |
| `src/cameras.js` | Live CCTV: artifact loading, the map pin, and the HLS player |
| `src/ui/` | Panels: clock, layers, search, detail, reach, follow, credits |
| `#left-rail` | Search and detail card in one column (JAKAR-25) |
| `src/data/artifact-loader.js` | Manifest-first loading, mode gating, IndexedDB cache |
| `src/data/decode.worker.js` | Binary decode, off the main thread |
| `src/url-state.js` | Deep links, including `?cam=` for a live camera |
| `src/bench.js` | `?bench` — the on-device render benchmark. Dynamically imported, so it costs a normal visitor nothing |
| `worker/index.js` | Cloudflare only: re-declares the `Content-Encoding` its asset server strips (JAKAR-61) |
| `scratchpad/probe.mjs` | Real Chrome over CDP, native clicks. Finds interaction bugs; its timings are meaningless |
| `scratchpad/gpu-bench.mjs` | The same idea inverted: real GPU, vsync off, A/B arms. Timings only |
| `scratchpad/mobile-bench.mjs` | A phone's viewport and pixel density on the real GPU: fill rate, and what each lever costs |
| `scratchpad/verify-artifacts.mjs` | Asks an origin whether it really serves the artifacts compressed. Exits non-zero, so it can gate a deploy |
| `scratchpad/device-bench/` | `?bench` output from real phones, one file per run. A number without its device is not a measurement |
| `scripts/plane*.mjs` | Plane issue tracker sync (see below) |

## Project management

Tracked in **Plane**, not Linear (Linear is the user's other project).

- Workspace `jakarta-publictrans-3d`, project **Jakarta-publictrans-3d** (`JAKAR`)
- API token in `.env` as `PLANE_API_TOKEN`; `scripts/plane.mjs` is a small client
- Design docs live as Plane **Pages**, not only in this repo
- Pages update with `PUT`, not `PATCH` (work items use `PATCH`)
- **Never re-run `scripts/plane-seed-tickets.mjs`** — it creates, it does not update

## Conventions that matter here

**Code style.** Comma-first `const` declaration lists, `const me = this` in
classes, comments that explain *why* rather than what. Match the surrounding
file.

**Comments earn their place.** Prefer explaining a non-obvious decision or a
trap over narrating the code.

## The interface, and why it looks like Jakarta

The panels were rebuilt once it was pointed out that they read as generated.
The diagnosis was not taste, it was arithmetic: **fifteen distinct font sizes**
between 10 and 30px, padding on every integer from 2 to 14, and 35 of 69 type
declarations at 11.5px or under. Nothing had been decided; every value had been
chosen on its own. Reference points are Google Maps and Moovit, which are large,
confident and legible at arm's length in daylight.

**The typeface is Plus Jakarta Sans**, commissioned as the city of Jakarta's own
and therefore the one choice here that is not a default. Self-hosted at
`public/fonts/` — 27 KB for the whole 200-800 variable axis, against a DNS
lookup and a connection to a third party on first paint. `font-display: swap`,
because a transit map that shows nothing while a font loads has its priorities
backwards.

**The accent is Transjakarta's, not a stock blue.** `#0d5eaf` is the enamel of
the corridor signage, and like the signs it is a *fill* colour with white type
on it — far too dark to be text on a dark panel, which is why `--brand-lift`
exists separately for text and edges. The map had been carrying the real
operator colours in `configs.categories` the whole time while the UI painted
itself `#35a7ff` on top of them.

- **The card carries its line's identity in the badge, and nowhere else.** A
  coloured 3px stripe down the card's leading edge was tried and removed: on the
  route preview it fought the stop list it sat beside, and because `#detail` is
  one element reused for every kind of card, a treatment there is a treatment on
  all of them at once. The badge already says which line this is, in the same
  colour, without a second element competing for the same job.
- **Hazard yellow (`--here`) means one thing: you are here, now.** The tick on
  the current stop and the current leg of a ride. It is the yellow every rider
  in this city has stood behind on a platform edge, and it stops meaning that
  the moment it is used for anything else.
- **The type scale is 15px stepped at ~1.2** — seven tokens where there were
  fifteen ad-hoc sizes. 11px survives only for tracked capitals, which read a
  size larger than they measure. Hierarchy comes from size *and* weight *and*
  ink level (four of them, `--text` through `--text-4`); size alone is what made
  it flat.
- **Space is on a 4px grid** (`--s1`..`--s6`), and control heights are named:
  `--ctl-sm` 36, `--ctl` 40, `--ctl-lg` 48. Primary actions are 48px because
  that is what Google Maps gives them, and 44 is the floor WCAG asks for.
- **A 36px control keeps its size and extends its hit area**, via
  `.btn-sm::after { inset: -4px -2px }`. Growing them instead would push the
  segmented rows off a 390px screen. The rows that use them set a gap wide
  enough that two hit areas meet but never overlap.
- **One filled action per card.** Everything was an outline before, so no card
  had a focal point; then everything became filled, which is the same problem
  in reverse — the stop card had three primary buttons at once. Someone who taps
  a stop is nearly always starting a journey from it, so that one is filled and
  the other two are outlines.

**One button, two intents.** There were six pill buttons — `.track-btn`,
`.end-btn`, `.sorts button`, `.ride-controls button`, `.fh-btn`, `.cam-ch` —
each with its own hover and its own idea of what selected looks like. Now `.btn`
rests neutral (a toggle, a secondary action) and `.btn-accent` is filled brand
(the action a card exists for), with `.btn-sm` / `.btn-lg`, `.btn-danger` and
`.btn-block`.

- **Intent and size live on the class; layout lives on the container.** A shared
  class that also carried `flex: 1` or a margin is how five of these drifted
  apart. `.sorts`, `.journey-ends` and `.fh-controls` each say how their own
  buttons sit.
- **`.sorts` is a segmented control, not three loose buttons** — one inset track
  with the choice filled inside it. As separate outlines the three read as three
  unrelated actions.
- **An input is inset, not raised.** `.field` sinks (`--sink`) and fills its
  48px, because the origin and destination boxes are the first thing a thumb
  goes for and a borderless 13.5px label does not read as somewhere you can
  type.
- **A button does not inherit the page font.** `.cam-ch` was drawn in the UA's
  own for want of a `font-family` line, which is the kind of drift one
  definition prevents.
- **Query with a `js-` hook, never with the style class.** `.track-btn` and
  `.cam-ch` were both, so restyling them would have broken the handlers; they
  are `js-track` and `js-cam-ch` now.
- **A size change is a layout change on a phone.** Moving the ride HUD's
  controls up one size step took 14 px from `.ride-step` and wrapped
  "Tahap 1 / 4" onto two lines at 390 px. Measured, not noticed:
  `PROBE_WIDTH=390 PROBE_HEIGHT=844 node scratchpad/probe.mjs` is the arm that
  sees it, and the 1440 px arm shows nothing at all. That row now wraps
  deliberately on a phone — label above, four 44px buttons below — which is what
  both reference apps do with a bottom sheet.
**The basemap theme is the rider's to choose** — Warna / Pudar / Mono in
Layanan, mapping to Mapbox Standard's `default` / `faded` / `monochrome`. It is
what the README has meant since the basemap stopped being a private style: the
fleet competes with a full-colour city, and monochrome takes the colour out so
six thousand vehicles have it to themselves.

- **Changing the theme must re-run `applyStopTheme`.** It branches on the theme
  rather than the hour (trap 4) — monochrome keeps a pale ground at every light
  preset, so its night view still needs dark ink. Verified: the switch flips
  `stop-labels` ink from `#ffffff` to `#2b3644`. Setting one without the other
  leaves the stops inked for the previous map.
- **Set it before the layers, not after.** The frame loop runs `applyStopTheme`
  on its first pass to establish the light preset, so a theme restored after
  that point paints stops for the default map until the hour changes — trap 12
  again, in a new place. `main.js` sets the config property immediately after
  `style.load`.
- **It is a preference, not a view, so it lives in `localStorage`** rather than
  the URL. A shared link is about where and when; someone else's taste in map
  colour is not part of it. The read is wrapped, because private browsing and
  blocked site data both make `localStorage` throw.
- **The light preset stays automatic.** It is driven by the simulated clock so
  playback reads as a day passing over the city, which is a better use of the
  four presets than a fourth control.
- **`custom` is in Standard's schema and is not offered.** It needs a
  `theme-data` payload, which is style authoring rather than something to put in
  front of a rider.

- **Motion is named properties only, never `transition: all`.** `all` animates
  layout and drops frames on the phone this is built for. 140ms on
  `cubic-bezier(0.23, 1, 0.32, 1)`, `scale(0.97)` on press, and the whole lot
  drops to colour-only under `prefers-reduced-motion`.

## Drawing four modes, one instanced mesh each

A six-car train is not a bigger bus, and since JAKAR-49 it is not a scaled one
either: each mode has its own **Kapsul** body — rounded shell, tapered nose,
window band — built by `src/layers/vehicle-geometry.js` and drawn by its own
`InstancedMesh`. Four draw calls for six thousand vehicles. `configs.modes`
still holds each mode's real size and a service acceleration; a KRL set is
160 m and pulls away at 0.7 m/s², an MRT set 120 m at 1.1.

- **Size lives in `configs`, shape lives in the geometry, and the two must not
  meet.** Every mode's body is built inside the same base box
  (`vehicleWidth × vehicleLength × vehicleHeight`), which is what the zoom
  inflation divides by. A geometry that outgrew the box would draw a train
  1.8 km long the moment it was inflated.
- **The window band is vertex colour, not a second mesh.** Three multiplies a
  geometry's `color` attribute into `instanceColor`, so a darker band can be
  baked into the geometry and still come out tinted by whatever category colour
  the instance wears. A second object would multiply draw calls by the fleet
  size, which is the constraint the whole layer exists to respect. The multiply
  is in linear space and can only darken — glass is the body colour with the
  light taken out of it.
- **On rail, the couplings carry the read, not the windows.** A band confined to
  the sides of a 160 m train is under a pixel high at any zoom the whole
  formation fits in, and the train draws as a painted bar. The map is pitched,
  so what a train actually shows is roof: darkening the whole ring at every
  coupling — `cars` is 8 for KRL, 6 for MRT, 4 for LRT — segments it from the
  same distance. The bus has one car and no couplings.
- **Check the taper against face winding, not against the bounding box.** The
  first build mapped the nose profile to the wrong end, so both tips flared
  outward into an hourglass — and the bounding box was still exactly the base
  box, because the widest ring had merely moved. What caught it was that a third
  of the faces wound inward.
- **Resolve mode per instance on the fleet's generation, never per frame.**
  Looking up route-then-mode for six thousand vehicles every frame is six
  thousand map lookups a frame. `_modeOf` is a `Uint8Array` rebuilt on the same
  gate the colour buffer uses.
- **Zoom inflation has to be per mode too.** Below `trueScaleZoom` a 12 m bus is
  drawn up to 11× so the network stays legible; the same multiplier on a 160 m
  train draws it **1.8 km long**. Inflate towards a common on-screen length
  instead — `max(1, scale × busLength / modeLength)` — which leaves the big ones
  at true size, where they are already visible.
- **The selection ring is built at bus length** and has to grow with what it
  rings, or it is a dot in the middle of a train.
- **Mode is absent on the legacy path**, so everything falls back to `bus` and
  the layer panel drops modes with no routes rather than showing four empty
  rail headings. On that path the three rail meshes hold zero instances and are
  never drawn.
- **Each mesh is allocated for the whole fleet**, not for its mode's share —
  ~3 MB of instance buffers that mostly go unused, against a per-mode cap that
  would write past the end of a buffer the first time it was wrong. Only the
  prefix written each frame is uploaded (`addUpdateRange`), so the waste is
  memory, not bandwidth.

## Kodefikasi: the city's own line codes

JAKAR-50. Jakarta has an official alphabet for its lines — `C` for the Bogor
line, `B` for Cikarang, `M` for the MRT — and until now the app ignored it and
printed whatever the feed happened to call a route. `src/kodefikasi.js` is the
one place that knows the mapping.

The source is the **Pedoman Sistem Informasi Penunjuk Arah (Wayfinding) DKI
Jakarta**, pages 29-30 — the Lampiran to **Kepgub No. 31 Tahun 2022**, written
by ITDP Indonesia and TfJ-FDTJ for Pemprov DKI. It is what the platform signage
and the integration map use, so a rider who has stood at Manggarai already
knows this alphabet.

- **The licence question that blocked this is settled, and the answer is
  credit.** A codification scheme is a *system*, which UU 28/2014 Pasal 41
  huruf b puts outside copyright; a letter in a coloured disc is below the
  threshold of originality, and Wikimedia Commons already publishes the same
  Jakarta roundels as `{{PD-text}}`. What does carry copyright is the
  guideline's own pictogram artwork — so **the glyphs here are redrawn, not
  extracted from its PDF**. ITDP has published no licence of any kind: no terms
  page, no copyright policy, and nothing in 127 pages of the book. The credit
  is in the map's attribution line.
- **The guideline outranks the feed on colour.** KAI Commuter publishes its own
  liveries (Bogor `#E30A16`, Cikarang `#0084D8`); these are the *operator's*.
  The pedoman's are the city's integrated set, and one network gets one
  alphabet. Five KRL lines had been sharing a single red because colour came
  from the *category*; they now carry their own.
- **The mark is one object, with its own gap.** `routeMark` returns a
  `.route-mark` wrapper holding the glyph and the badge. They were two siblings
  borrowing whatever gap the row set, cancelled back with a negative margin per
  container — and inside the ride HUD's `.js-badge` there is no row and no gap,
  so the margin had nothing to cancel and pulled the glyph into the badge. **A
  component that only spaces correctly inside the five containers somebody
  remembered to list is not a component.**
- **A coded line wears its ring everywhere it appears**, including the
  itinerary leg chips. Rail as a disc in the summary and a ring in the card is
  two alphabets for one network.
- **`routeColor()` is the one function the whole map agrees through** — badges,
  route lines and the instanced fleet. It replaced `CATEGORY_COLOR.get(route.category)`
  copied at nine call sites, and `routeMark()` replaced eight copies of
  `<span class="badge" style="background:…">`. Same lesson as the six pill
  buttons that became one `.btn`: a shape repeated at every call site drifts.
- **Keyed by route id, not by shortName.** The feed's own label is exactly what
  this table exists to replace, and an id survives a rebuild.
- **A coded line wears a ring, everything else a filled plate.** Page 30 draws
  every rail line as a thick collar of the line's colour around a clear centre;
  page 29 draws the bus corridors filled. The first build had rail filled too,
  which read as "one more bus corridor, in a different colour".
- **An inline `background` beats any class rule**, so emitting one on a ring
  badge filled every rail roundel solid and swallowed its letter —
  `.badge-line { background: none }` never had a chance. `routeMark` now emits
  `background` only on a plate, and the colour always as `--mark`, which is
  what lets the collar and the letter come from one value.
- **The letter is the line's colour, and six of nine fail contrast.** Measured
  on paper: Cikarang `#26baed` is 2.25:1 and Rangkasbitung `#99ca3e` is
  1.93:1, against WCAG's 4.5:1 for 13px bold. The pedoman sets the letter in
  near-black inside the collar — 17.6:1 — which is why it does that. Kept as
  the line's colour by decision; `color: var(--text)` on `.badge-line` is the
  whole change if that is revisited.
- **The fleet's colour buffer is keyed by route now**, which also makes the
  per-instance lookup one map hit instead of two in a loop that runs six
  thousand times per regeneration.
- **No pantograph on any glyph.** The first draft gave one to LRT, which has it
  backwards — both Jakarta LRTs take 750 V from a third rail, and it is KRL and
  MRT that run under wire. At 15px it would have been a 1px dash saying
  something untrue.
- **BRT corridors 1-13 have their own colours on the same page** and are not
  adopted yet. That would take 31 bus routes from one blue to thirteen colours,
  and `#0d5eaf` — the app's whole accent — is corridor blue, so it is a
  deliberate decision rather than a continuation of this one.

## What the render path actually costs

JAKAR-58. Measured on an **Apple M4** (ANGLE Metal, WebGL2, 120 Hz, canvas
2880x1602 at dpr 2), against the production build at the evening peak — 17:30,
~6,110 vehicles. `scratchpad/gpu-bench.mjs` is the harness; it is the opposite
trade to `probe.mjs`, which runs SwiftShader on purpose and whose timings
therefore mean nothing.

As shipped, with the presentation clock left on — this is what a person sees:

| View | frame p50 | mean fps | the fleet's share |
| --- | --- | --- | --- |
| city-wide, z10.5 | 8.8 ms | 94 | +0.5 ms |
| default, z12.4 | 9.8 ms | 83 | +1.4 ms |
| street, z16.8 | 16.5 ms | 65 | +0.2 ms |

**Vsync has to come off before a frame interval is a measurement.** With it on,
every frame that fits in the budget reports the budget, and the arms are
indistinguishable. `--disable-gpu-vsync --disable-frame-rate-limit` makes the
interval the frame's own cost — at the price that rAF is no longer tied to
presentation, so the CPU can run ahead of a GPU that is behind. Both arms are
kept for that reason: vsync off attributes, vsync on says what is seen.

Attribution, vsync off, each arm patched into the live layer so the fleet, the
clock and the tiles are identical across them:

| View | basemap alone | + 12-triangle box | + Kapsul, as shipped |
| --- | --- | --- | --- |
| city-wide | 7.4 ms | 8.2 ms | 9.8 ms |
| default | 8.8 ms | 9.9 ms | 11.4 ms |
| street | 14.0 ms | 14.7 ms | 14.8 ms |

- **JAKAR-49's trade was affordable.** Thirty times the triangles cost
  **1.5-1.6 ms a frame** at city zooms and **0.1 ms** at street level, where a
  handful of vehicles are on screen at true size. Neither of the fallbacks that
  ticket named — a coarser cross-section, or an LOD swap below `trueScaleZoom`
  — is worth building. The fleet is not what limits this map.
- **The per-instance loop is free; the draw is the cost.** Running the matrix
  loop with the GL draw suppressed lands within 0.1 ms of not running the layer
  at all (7.5 vs 7.4, 8.8 vs 8.8, 14.2 vs 14.0). Six thousand `compose` calls a
  frame are nothing next to six thousand instances of geometry.
- **`addUpdateRange` is real but small.** Suppressing it makes three re-send
  the whole 12,000-instance buffer instead of the ~6,110 written prefix — 375 KB
  more a frame — and costs **0.4-0.6 ms** at city zooms, nothing at street
  level, and nothing measurable at all with vsync on. Keep it; it is free. It
  is not what anything is waiting on.
- **The simulation is ~1.0 ms a frame, not 0.22.** `fleet.update` measures
  0.9-1.1 ms p50 in every arm and every view at 6,110 vehicles. Where 0.22 ms
  came from is not recorded; it is wrong by about 4.5x. Still not the
  bottleneck — about 12% of a 120 Hz frame — but it is the second largest thing
  this app does per frame, after the basemap.

**Do not trust `EXT_disjoint_timer_query_webgl2` here.** The extension is
present, returns 0.00 ms when no draw is issued, and is reproducible to two
decimal places across five runs — every sign of a working instrument. It also
reports **15-21 ms of "GPU time" for the fleet inside an 8.8 ms frame**, and
reports *less* time (2.7 ms) for the arm that does strictly more work. It is
timing queue wait along with execution. Same shape as traps 10 and 11: an
answer that is confident, stable, and not about what it appears to be about.
The only attribution that held up is the A/B against a disabled layer.

**Measured on a real phone at last (JAKAR-60).** A Samsung S25 — Chrome 152,
Android, Xclipse 940, dpr 3, a 1080x2025 canvas, scheduled against a 60 fps
ceiling — at the evening peak, ~6,100 vehicles, via `?bench`:

| View | as shipped | Gedung 3D off |
| --- | --- | --- |
| street (z16.8) | 54 fps, p90 25.0 ms, p99 33.4 | **59 fps, p90 16.9 ms** |
| default (z12.4) | 58 fps, p90 16.8 ms | 60 fps, p90 16.7 ms |
| city-wide (z10.5) | 56 fps, p90 16.8 ms | 58 fps, p90 16.8 ms |

- **The median frame hits the budget in every view, including street level.**
  `p50` is 16.7 ms across all twelve arms of two runs. Nothing here is
  anywhere near the 17 fps that a 4x-throttled desktop predicted — **4x CPU
  throttle over-predicts badly for a phone with a real GPU**, and that arm
  should be read as a floor for a slow device, never as a phone.
- **What it costs is tail frames, exactly as JAKAR-58 said.** Street level as
  shipped loses about one frame in ten (54 against a 60 ceiling) and its p90
  is a frame and a half. Turning off Gedung 3D recovers nearly all of it and
  pulls p90 back to the budget — the same lever the emulated sweep found, now
  confirmed where it matters.
- **Two runs four minutes apart differed, and the later one was worse across
  every arm** (street shipped 54 fps then 50, p90 25 ms then 33). They were
  served by different hosts, which is a coincidence and not a cause — the
  bytes are identical and already loaded before the bench runs. It is the
  phone getting warm. Sustained use costs more than the view does.
- **An S25 is not the target device.** It is a current flagship, so this is
  the good case, and the audience the ticket is about — mid-range Android —
  is still unmeasured. A flagship dropping a tenth of its frames at street
  level is the reason the lever is worth having, not a reason to relax.
- **`observedCeilingHz` is not the panel.** It reported 60 on a 120 Hz
  display, because Chrome was scheduling the page at 60. The intervals still
  quantise to 8.33 ms (16.7, 25.0, 33.4), which is the panel showing through.

**On a slow CPU the basemap is the entire problem.** At 4x CPU throttle the
street view runs **17 fps — and 18 fps with the fleet removed altogether**:
51.9 ms of a 58.7 ms frame is Mapbox Standard. City zooms hold 49-62 fps and
the geometry stops mattering at all (16.6 ms box against 16.6 ms Kapsul).
Turning off Standard's 3D buildings — the app's own *Gedung 3D* switch — barely
moves the median at street level but lifts the mean from 65 to 78 fps, so what
they cost is tail frames rather than every frame.

## Icons, and the rows they sit in

One sprite in `src/kodefikasi.js` holds every symbol the interface draws —
four mode glyphs and seven interface icons — because there is one
`installSprite()`, one place to look, and **a `<use>` pointing at a symbol that
is not in the document renders nothing at all, silently**. Two sprites would be
two chances to forget one.

- **A layer row is icon and label on the left, switch on the right.** The
  native checkbox sat between the icon and the words, so every row began with
  the same 18px square and there was nothing to aim at; at the trailing edge
  the states line up in one column and the row reads as a thing and then
  whether it is on. The input is **visually hidden, not replaced** — the label,
  the keyboard and the accessibility tree still run through it, and it is still
  what the handler binds to.
- **Rows are named the way a rider would say them.** *Kamera langsung* became
  *CCTV*, *Hanya halte aksesibel* became *Halte aksesibel*.
- **The finder shows what a stop is, not a letter for it.** `H` and `ST` on a
  grey plate were two letters of jargon in the space a picture costs, and
  telling a roadside halte from a station you walk into is most of what
  Navigasi's list is for.
- **The route count in Layanan is set like a number.** At 11px grey mono it
  read as leftover debug output; it is the one figure in that panel — how much
  of the network a filter is holding — so it is tabular, 13px, one ink level
  up, and in its own well so the column lines up.
- **An itinerary step is two rows, not three columns.** The mark and the
  departure take the top line with the full width between them; boarding and
  alighting sit under it. Side by side, the mark, three lines of prose and the
  time fought over a 344px rail and the time lost — it was 11px grey mono, the
  one number on the step anybody is reading. The headsign and stop count went
  with the change: four legs of them read as a paragraph rather than a journey.
- **A scheduled time has no seconds.** `formatClock` is `05:09`; `formatOffset`
  keeps `05:09:00` for the clock readout, which is the one thing genuinely
  ticking. No departure board quotes seconds, and `05:03:00 – 06:06:00` was
  what wrapped the itinerary header onto two lines.

## Paper, not night

The panels were dark because the first basemap was a private dark style and the
fleet was the only colour on it. Neither is true any more — the basemap is stock
Standard in full colour — and the case to design for is a rider reading a halte
card in Jakarta daylight. Both reference apps are light for that reason.

- **It is one palette, at the token level.** The repaint is the `:root` block
  plus about twenty values that had assumed a dark ground; nothing downstream
  knows. A dark theme would be a second token block, not a second stylesheet.
- **The substitution the whole thing turns on is white-at-low-alpha becoming
  ink-at-low-alpha.** Those were seven hard-coded `rgba(255,255,255,…)` troughs
  — a progress bar, a ride segment, a scrollbar — each of which had to be found
  by hand. They are `--track`, `--track-done` and `--press` now.
- **Grep for `rgba(0,0,0,…)` too.** One rule set the focused field to black at
  30%, which on paper drew a grey slab where the input should be. It was the
  only one, and the sweep that missed it looked only for white.
- **Focus clears the well rather than deepening it.** On a dark panel an input
  sinks further on focus; on paper the way to say "active" is to take the tint
  away, so `.field:focus-within` goes to `--panel-solid`.
- **`--brand-lift` moved in the opposite direction.** It is the readable tint,
  which on a dark panel meant lifting the enamel blue towards white; on paper
  the enamel blue *is* the readable one and lifting it is what would make it
  vanish. Same token, inverted job.
- **`--live`, `--here` and `--danger` are darkened, hues held.** `#2fd07a` on
  white is about 1.7:1. `--here` splits in two: `--here-fill` keeps the real
  platform-edge yellow for the tick itself, and `--here` is the ink-dark collar
  that stops it dissolving into the paper.
- **The loader is paper too**, or the app flashes black and then turns white on
  every first paint.
- **A camera card stays dark on purpose.** `#000` behind a stream and a dark
  scrim on the fullscreen overlay are not dark-mode relics — video wants a dark
  surround at any theme.
- **The basemap still follows the clock**, by decision. Between dusk and dawn
  that means light cards over a dark map, which is what Google Maps does with
  its own chrome, and it keeps playback reading as a day passing over the city.
  Pinning the preset light was considered and rejected.

## What went, and what stayed

The router did not go with the journey planner. **Reachability still needs
it** — "everywhere you can get to in 45 minutes" is the same forward search
with the destination removed and a ceiling put on instead, and it is the most
spatial thing in the app. `router.js`, `timetable.js` and `fares.js` all stay.

Removed: `src/ui/journey.js`, `src/ui/ride.js`, the `journey-*` map layers, the
`from`/`to`/`fromll` URL parameters, the stop card's *Dari sini* / *Ke sini*,
and the frame loop's journey branch.

- **A tap on empty map now offers reachability rather than an origin.** The
  "sekitar sini" card's one action used to be *plan from here*; it sets a reach
  origin instead, which is the spatial question a tap on nothing is actually
  asking. That is also most of JAKAR-66 answered by subtraction.
- **The stop card has one filled action again** — *Lihat jangkauan*. It had
  three primary buttons when two of them were journey ends.
- **`#ride` is gone and `#follow-hud` keeps the slot.** They shared it and were
  never open together; the frame loop's guard collapses from
  `(app.trackedRun < 0 || app.ride.active)` to `app.trackedRun < 0`.

## The two rails, and the finder

**Left is what you do, right is what you read.** `buildRails()` puts the finder
and the detail card in a left column, the clock and Layanan in a right one.

**Below 700px there is one column, not two** (JAKAR-62): the same order, stacked
— read at the top, act at the bottom. Both panels in the header start folded, so
it stays short and the map remains the largest thing on screen; Layanan folds to
its title bar rather than being hidden, because `display: none` there had quietly
removed the mode filters, the cameras, the accessibility filter and Gedung 3D
from every phone at once. See trap 13 for what the first attempt did instead.
Layanan moved right because it is a filter you set once, not a step in finding
or planning anything.

**The finder is one field over everything.** It was two tabs, because a mixed
list made every query ambiguous — typing "Bogor" returned a corridor and eleven
stations with no way to say which you meant. That ambiguity was never really
about the list: it was about what happened *next*. A stop was an origin to plan
from, a line was a thing to look at, and nothing in the row said which.

With planning gone there is one next step — show me this — so one list is
unambiguous by construction, and the kind is carried by the mark: a halte or
stasiun glyph in a plate against a line's ring or corridor badge. The picture
says which without a tab having to be chosen first.

- **Duplicate stop names are more visible in one list.** Three rows reading
  "Akses Bawah Flyover Raya" are three real stops with one name, which the two
  tabs used to hide behind a mode choice. Worth a disambiguating line one day.
- **Jalur previews a line**: the card is the route and its stops, and the map
  frames it. Contrast comes from dimming the other 700 lines, not from
  brightening this one — a brighter needle is still in the same haystack. Same
  reason `drawJourney` dims. The highlight takes the line's category colour so
  the preview and the legend agree.
- **Stops no route serves are not listed.** 43 of 8,281 never appear in a
  pattern, including a dead Transjakarta "Manggarai" that sat next to the real
  KRL station reading "0 rute" and could not be planned to.

**Following a vehicle has its own controls**, in the ride HUD's slot at the
bottom — the two are never open together, and both are the same kind of view:
the camera is locked to something moving, so the controls belong under it rather
than out at the side. It carries only what applies to following — camera (`Dari
dalam` / `Dari luar`), speed, and `Berhenti` — because there is no leg to skip
and no itinerary to leave.

- **Speed offers `configs.speeds`, not the ride HUD's four.** Two controls for
  one value that disagree about what values exist is worse than either, so the
  HUD and the clock panel share the list and `clockControl.syncSpeed()` keeps
  the sliders agreeing.
- **Never write a slider's `value` while it is being dragged** — assigning it
  mid-gesture snaps the handle out from under the pointer. Both sliders check
  `document.activeElement` first.
- **`hide()` is idempotent** because the frame loop calls it, and it restores the
  chase camera: stopping while on board would otherwise leave the vehicle
  scaled away and invisible.

Absolutely positioned panels cannot stack, so they are **re-parented** into
flex columns at boot. Two things that matters for:

- **Re-parent, do not re-mount.** Each panel still builds itself exactly as
  before, so trap 1 — a panel's shell is built once per selection and only its
  values rewritten — is untouched. Moving a node does not rebuild it.
- **Call it after the panels exist.** It ran too early the first time and
  silently produced an empty rail with every panel still in its old corner.
  `document.getElementById` returning null is not an error, just a no-op.

**The frame loop reasserts the detail card every frame**, through an
`if / else if` chain over what is selected. Anything that opens the card outside
that chain is overwritten on the next frame — the line preview appeared and
vanished instantly until it got its own branch, ahead of the journey. Give a new
card a branch; do not just call `show*` and hope.

`#left-rail` is `pointer-events: none` with `auto` on its panels, so the gaps
between cards do not swallow clicks meant for the map.

## Shipping it

The build is static and the host runs `npm run build` into `dist/`, with
`MAPBOX_ACCESS_TOKEN` in its environment and nothing else. `public/_headers`
is read by all three of the hosts below.

**Cloudflare Workers and Cloudflare Pages are different products, and a
`*.workers.dev` URL means Workers.** Pages takes its build command and output
directory from a dashboard and needs nothing in the repo; Workers Builds runs
the build and then `npx wrangler deploy`, which reads `wrangler.jsonc`. With no
such file the build *succeeds*, the deploy fails, and whatever was deployed
before stays live — on a new project that is the Hello World template, so the
URL answers `Hello world` on every path while the dashboard says the latest
build failed. Nothing in the build log says any of this. `netlify.toml` is the
equivalent for Netlify.

- **Two generated directories are checked in on purpose**, against the usual
  rule. `public/artifacts/` is what the browser downloads, so committing it
  means the bytes that go live are the bytes verified locally and the host's
  build step stays one command. `public/data/` is what `npm run test-routing`
  runs against, and that suite is the control for every data bug found so far —
  a clone that cannot run it is not a clone of this project. `data/build/`
  stays ignored: it is intermediate and nothing ships from it.
- **No host agrees that the first matching rule wins**, so `_headers` must not
  depend on it. `manifest.json` was kept out of an immutable `/artifacts/*`
  wildcard by being listed first: Netlify let the wildcard win outright, and
  Cloudflare concatenated the two into `max-age=31536000, immutable,
  max-age=0, must-revalidate`. Every rule is now written to match only what it
  means to match. What actually guarantees the manifest is the loader fetching
  it with `cache: 'no-cache'`, which it has always done — a header nobody can
  test before deploying is not something to rely on alone.
- **The Mapbox token is compiled into the bundle** and always will be — that is
  how Mapbox GL works. The deployed site therefore wants its *own* public token
  with a URL restriction, not the one in `.env`. What binds first is Mapbox's
  50,000 monthly map loads, not the host's bandwidth.
- **A secret token in that bundle is a published secret, and the build now
  refuses one.** An `sk.` token shipped to both live hosts once: Mapbox GL
  rejects it at runtime with a clear message, but by then 2.4 MB of
  world-readable JavaScript on a CDN was carrying it, so the console error is
  the *second* thing that has gone wrong. A token turns secret the moment any
  secret scope is ticked at creation (`tokens:write`, `uploads:write`,
  `styles:write`, `downloads:read`) — the public defaults are all this needs.
  `vite.config.js` fails the build on anything not starting with `pk.`, which
  is the last place it can still be caught. Replacing such a token is not
  enough; it has to be revoked.
- **A build host has no `.env`, and Cloudflare has two kinds of variable.**
  The first Pages build failed on `MAPBOX_ACCESS_TOKEN is missing from .env`,
  which is true and useless — there is no `.env` on a build host and there is
  not supposed to be. Two things are behind it: Cloudflare separates *build*
  variables from *runtime* ones on different screens and only the build ones
  reach `vite build`, and connecting a repository fires a deployment
  immediately, before there is anywhere to have put the token. `vite.config.js`
  now says all of that in the error itself, because a build log is the only
  place anyone will read it.
- **`build-data.mjs` no longer points at a folder on one laptop.** It defaults
  to the newest Transjakarta snapshot in the repo, so the control suite runs on
  a fresh clone. It is the origin's own 240 routes again as of 2026-09-10 —
  while the certificate was expired the newest snapshot was the mirror's 252,
  and a rebuild then moved the network under the routing checks. Expected
  either way, not a regression: `public/data/` is a fixed control and is only
  regenerated deliberately.
- **The credits are a panel, not a line** (`src/ui/credits.js`). Five sources
  crammed into Mapbox's badge was technically a credit and read as boilerplate;
  the operators whose timetables this map *is* arrived as a run-on sentence
  behind an `(i)`. `Sumber data` opens a panel that says what each source
  actually gave, and only data sources are in it — the typeface and the
  bundled libraries have their obligations met in `THIRD-PARTY-NOTICES.md`, and
  putting them in front of a rider looking for who runs the Bogor line would
  bury the answer.
  - **`customAttribution` cannot host a trigger. Mapbox sanitises it hard** — a
    `<button>` came through as bare text and an `<a class="js-credits">` lost
    its class, both of which look operable and are not. Only `<a href="http…">`
    survives intact. So the trigger is a control of our own.
  - **It is in `bottom-left`, not `bottom-right`**, where a credits link would
    more naturally sit: an unfolded Layanan reaches the bottom of a 900px
    window, so the right-hand control stack is *underneath* the rail at desktop
    heights. Measured rather than guessed — `elementFromPoint` over the trigger
    returned `.panel-title`. Worth knowing for anything else put in that
    corner.
  - **The simulation line stays out in the attribution.** It is the one thing a
    casual visitor has to see without opening anything, which is why it did not
    move into the panel with everything else.
- **The map credits its own data now.** Route geometry is OSM-derived, which
  ODbL requires be said, and Mapbox's default control only covers the basemap —
  so the default control is off and one carrying `customAttribution` replaces
  it. `customAttribution` is read at construction only; adding a second control
  instead prints Mapbox's credits twice. The last line of it says the fleet is
  a scheduled simulation, which is the one place a casual visitor will see it.
- **No redirect rules, and `not_found_handling` stays `none`.** Deep links are
  query strings on one page, not paths, so an SPA rewrite has nothing to do —
  and it would answer every unknown path with `index.html` and a 200, handing
  the artifact loader a page of HTML to parse as JSON where a swept hash should
  have produced an honest 404.

## What this project is made of, and on whose terms

Audited 2026-09-12, source by source — nineteen feeds, assets and libraries.
Nothing is unlawful and no source forbids this use; what was missing was
**credit**, in five places, all now closed. `README.md` carries the register
and `THIRD-PARTY-NOTICES.md` the bundled components.

- **Almost nothing here states a licence at all.** Not Transjakarta's GTFS —
  Transitland records only its own terms against it — not KCI, not MRT, not
  either LRT. That is not permission and it is not refusal; it is silence, and
  the basis for use is that a timetable is *data*, which UU 28/2014 Pasal 41
  huruf b puts outside copyright, plus Pasal 43 huruf b for anything published
  by or for government absent a protection notice.
- **Reading a published endpoint is not illegal access.** UU ITE Pasal 30 is
  about acting "tanpa hak" and about breaking security. Every endpoint here is
  unauthenticated and public; no token is guessed and no `robots.txt` is
  disobeyed. They were read one by one — `binamarga.pu.go.id` disallows
  `/assets/`, `/invt/`, `/v3/` and our `/contents/cctv_tol` is allowed;
  `lrtjakarta.co.id` signals `ai-train=no`, which does not bite because nothing
  here trains anything.
- **Mapbox GL JS 3 is not open source**, which is easy to assume from an npm
  dependency. It is licensed under the Mapbox TOS, needs an account in good
  standing, and the licence "terminates automatically" without one. The
  wordmark and attribution control must stay visible — which is the other
  reason the phone layout reserves a bottom strip (trap 13).
- **Self-hosting a font is redistributing it.** The OFL requires its text to
  travel with the Font Software; `public/fonts/` had the `.woff2` and no
  licence. `OFL.txt` sits beside it now.
- **Transitland's terms ask for visible attribution** and the walk table is
  40,466 edges of their hosted Valhalla. The map credited OSM, the operators
  and the cameras, and not them. It does now.
- **`public/artifacts/` is an ODbL Derivative Database.** It carries
  OSM-derived geometry, so share-alike reaches it and the repository's MIT
  licence does not. Stated explicitly in `README.md`, because a reader is
  otherwise entitled to assume one licence covers the whole repo.
- **Non-commercial is load-bearing in exactly two places**, and it is worth
  knowing which: Pasal 43 huruf d, which covers the guideline's pictogram
  artwork — moot here, since the glyphs are redrawn — and Mapbox's 50,000 map
  loads a month, which binds before any host's bandwidth does. ODbL, OFL, MIT
  and Apache do not distinguish commercial use at all.
- **A GPL repo cannot relicense someone else's government data.** The 612
  street-camera positions come from an archived GPL-3.0 mirror of a DKI open
  data release. The licence covers that repo's code; the coordinates are facts
  and DKI is the upstream holder. Credited anyway.
- **One thing to keep an eye on:** the MRT timetable is read from
  `beweb-dev.jakartamrt.co.id` — a *development* host. Not a legal problem, but
  not an address meant for public consumption either, and it can vanish without
  notice.

## Traps this codebase has already fallen into

Each of these shipped broken once. They are cheap to reintroduce.

1. **Never rebuild an interactive panel every frame.** Replacing markup between
   a mousedown and the following mouseup means the browser never fires `click`,
   and the buttons silently stop working. Build the shell once per selection;
   write only the values that change. This killed the follow button.

2. **Test with native input, not `.click()`.** `.click()` synthesises the event
   and skips the press/release pairing, so it passes even when a real click is
   impossible. Use CDP `Input.dispatchMouseEvent`. The harness at
   `scratchpad/probe.mjs` supports `{_click:[x,y]}` + `PROBE_JS2`.

3. **Throttle on real time, not simulated time.** The stop card once refreshed
   every 15 *simulated* seconds — at 1200× playback that is every frame.

4. **Adapt to the theme, not the hour.** Standard's `monochrome` theme keeps a
   pale ground at every light preset, so its night view still needs dark ink;
   on the default theme night really is dark and the ink flips. Read the theme,
   not the clock — `applyStopTheme` does.

5. **Camera events fire for the camera's own moves.** `dragstart` / `rotatestart`
   need an `e.originalEvent` check, or the follow animation cancels itself.

6. **GTFS times pass midnight.** A last bus at 24:44 is 00:44 tomorrow.
   Wrapping it silently made a 24-hour route look 28 minutes long.

7. **Never store an array index that outlives a sort.** The walk table was built
   as indices into `dataset.stops`; `sortDataset()` then reordered that array
   and every index came to mean a different stop. **40,083 of 40,817 edges** ended
   up over 500 m apart — worst pair 74 km — in a table whose entire contract is
   400 m. The canonical dataset now carries stop **ids**, which survive any
   reordering, and the encoder maps them to indices where indices are wanted.
   `validate.mjs` checks every edge against the geography it claims.

8. **A trip with no shape is not a vehicle.** Four Cikarang patterns match no OSM
   relation, so `shapes.get('s-1')` returned undefined and `locate()` threw —
   *inside the frame loop*, which froze the clock at 00:00:00 and stopped the
   entire fleet. The fleet now skips them; they stay in the timetable, because a
   train you cannot draw is still one you can catch.

9. **A symbol layer with `icon-allow-overlap: false` can render nothing at
   all.** Symbol collision is global across the style, not per layer, so the
   basemap's own POI and road labels win every contest in a dense city. Set
   false, **zero of 612 camera pins were placed anywhere in the viewport** — a
   layer you deliberately switch on that draws nothing. `icon-ignore-placement`
   matters too, or the fix is paid for by silently deleting Standard's labels.
   Declutter with `minzoom`, which is a rule rather than a contest.

10. **`canPlayType('application/vnd.apple.mpegurl')` returns `"maybe"` in
    Chrome.** It does not identify Safari, and treating a truthy answer as
    "native HLS works here" sends every Chrome user down a path where the video
    sits at `readyState 0` with no error — indistinguishable from a dead camera.
    Test for `window.MediaSource`, which is what hls.js actually needs, and
    leave the native path to browsers that have no MSE at all.

11. **A 200 is not a stream.** `jmlive.jasamarga.com` answers **HTTP 200 with a
    zero-byte body** for a camera that is registered but not publishing. A
    liveness pass over status codes scored 68% and was measuring nothing; the
    same sample judged on whether the body contains `#EXTM3U` *and* a segment
    gave a different set entirely. Same shape as trap 10 — a truthy answer that
    does not mean what it appears to.

13. **`top: auto` does not move an absolutely positioned box out of the way.**
    It returns it to its static position, which on a phone was the top — the
    same place the other rail already was, at the same `z-index`. The clock
    painted over the finder and over the detail card's close control, so a card
    opened by tapping the map could not be shut (JAKAR-62). The rule read like
    it expressed an intent and expressed nothing. **If a panel must move, say
    where**: pair it with a `bottom`, or lay the column out rather than nudging
    it. And credit does not chase a gap — the Mapbox wordmark and the
    attribution badge get a reserved strip no panel may enter, because a rule
    that keeps them visible in *most* states is not what the licences ask.

12. **Two correct components, ordered wrongly, make a broken state.** Restoring
    a camera from a link switched the layer on and *then* moved the clock to
    live. The frame loop's live gate fires in between and does exactly what it
    exists to do — switch the camera layer off — so the link ended with a camera
    card open over a torn-down layer whose own toggle still read on. Nothing was
    faulty in isolation, which is why no unit test would have found it. Where an
    invariant is enforced by a loop rather than by a function, **establish the
    condition before the state that depends on it**: go live, then switch the
    layer on. `ensureCameras` exists so the question "is this camera in the
    build?" can be answered without switching anything at all.

14. **A sentinel is not a measurement.** Rail sources publish departure boards,
    not frequencies, so every rail trip is stored as a one-off window carrying
    a **1-second headway** meaning "this runs once". Read as a service interval
    it says two false things: the line card offered a Bogor train "tiap 0 mnt",
    and *Warnai per frekuensi* put all nine rail lines in the under-5-minute
    band — the most frequent thing on the map. Both were live from the day rail
    shipped and no test saw either, because the value is real, positive and
    consistent. `MIN_HEADWAY` is 60 s: the feed's genuine headways start at
    180 s. Found by reading the card, which is the tenth bug on that list.

## The live camera layer

Public CCTV, playing in the map, after `mt3d-plugin-livecam` in Mini Tokyo 3D
(JAKAR-54, JAKAR-55). **798 cameras** from three sources that are *not*
interchangeable — the difference is carried to the UI rather than smoothed over,
and the last of them is filtered on a different rule entirely.

| Source | Cameras | Position |
| --- | --- | --- |
| `cctv-jsc` — the geolocated set | 612 | published coordinates, `precision: exact` |
| `dki-jkt` — the portal's own | 46 | inferred from the street name, `precision: estimated` |
| BPJT / Bina Marga — the toll roads | 143 | published coordinates, `kind: toll` (JAKAR-55) |

- **The streams need no proxy and no key.** JakCCTV is a thin wrapper over a
  Flussonic media server that answers `access-control-allow-origin: *` with no
  auth token, so the browser fetches HLS directly. `preview.jpg` and
  `preview.mp4` come free per stream and are what the poster uses.
- **There is no coordinate source.** The portal lists 50 cameras and no
  positions; `/api/cctv`, `/api/camera` and `/publik/data` are 404 and
  `api.jakarta.go.id` does not resolve. Positions come from a community mirror
  of the DKI open data release — 2,288 rows, and stale: its own host is gone
  and **only 662 (29%) of its streams still answer**. Hence the probe.
- **Probing is 15 minutes, and the reason is worth knowing.** A live camera
  answers in ~55 ms; a decommissioned one takes **ten seconds** before the
  server returns 404. Two thirds of the list is dead, so sequentially that is
  over four hours. Shortening the timeout would be faster and worse — it turns
  "the server says this is gone" into "we gave up asking" — so the wait is kept
  and sixteen probes overlap. This is the one adapter that does not use
  `snap.get`.
- **The portal is flaky.** It answered, then refused TCP for an hour, while the
  media host stayed up throughout. It is fetched best-effort and `meta.json`
  records `portal: unreachable` — nothing downstream needs it.
- **Cameras load only when the layer is switched on**, from their own artifact
  (**14.6 KB brotli** for all 801), and `hls.js` is a dynamic import so it splits into
  its own chunk. A viewer who never opens the layer pays for neither.
- **The layer is gated on live mode**, exactly as the Mini Tokyo 3D plugin gates
  itself with `clockModes: ['realtime']`. A camera shows the street now; the
  clock can be replaying a Tuesday in March at 1200x. Leaving live unchecks the
  toggle, hides the layer, closes the card and tears the stream down.
- **The card says the map and the camera disagree**, because they do. There is
  no realtime feed for any Jakarta operator, so a vehicle on the map is where
  the timetable puts it. Mini Tokyo 3D warns about this with *realtime* data and
  a delay of seconds; ours is a scheduled simulation and the gap is larger. The
  camera is a window on the real street, never confirmation of the simulation.
- **Not attempted: matched camera bearing.** MT3D hand-authors `zoom`, `bearing`
  and `pitch` per camera so the map flies to look the way the lens looks. That
  is its best trick and it does not scale from ~20 cameras to 801.
- **The portal's own cameras are the good ones, and nothing geolocates them.**
  Thamrin, Gatot Subroto, S. Parman, Gerbang Pemuda — all on Transjakarta
  corridors, all high definition, and **46 of 46 live** against 29% of the
  geolocated set. What they do carry is the street, in the stream id itself
  (`501844_JKP_DISHUB_JL.-MH.-THAMRIN-C01_CCTV-01`), so the position is
  recovered from the street: `data/camera-places.json` names an OSM feature per
  site and `--source=cctv` fetches its geometry.
- **Half a street is the error, and admitting it beats withholding the camera.**
  Which end of Gatot Subroto camera C11 sits on is not knowable from its name.
  These ship as `precision: 'estimated'`, the card says *perkiraan lokasi*, and
  correcting one is a one-line edit in `camera-places.json` — a different
  `street`, an `along` fraction, or an explicit `lat`/`lon`.
- **Sites sharing a street are spread along it**, in site order, so three
  cameras on Gatot Subroto land at three places on Gatot Subroto rather than in
  one heap at its midpoint. Points come from the OSM ways for that name and are
  **sorted along the street's longest axis rather than stitched** — a major
  Jakarta road is two carriageways plus service roads, and stitching those
  produces exactly the out-and-back that cost a day on the rail relations.
  Sorting cannot fail that way; the worst it does is interleave the
  carriageways, which for an estimate is no error at all.
- **Geocoding services are no use here.** Mapbox returned the *same* coordinate
  — the Jakarta Pusat centroid — for MH Thamrin, Gerbang Pemuda *and* Gatot
  Subroto. It has no street-level data for these; OSM does.
- **Constrain the street search to DKI.** There is a Jalan MH Thamrin in
  Tangerang and an unbounded name search finds it first.
- **Overpass answers in three shapes** — a way with `out geom` carries vertices,
  a way or relation with `out center` carries a centre, and a plain node carries
  its own `lat`/`lon`. Handling only the first two silently lost Taman Literasi.
- **Channels of one device share a position legitimately.** They are cameras on
  one pole, so they are not spread apart, and the card offers them as buttons —
  without which the extra channels are unreachable, their pins being at the same
  point.
- **An unmapped site is named in the build output, never silently dropped.**
  Each one is a row somebody has to add, and a count does not say which.
- **The card opens full width over the map.** The `<video>` element is *moved*
  into the overlay rather than a second one created: moving a node does not
  reset media state, so the stream keeps playing, where a second element would
  open a second connection and rebuffer from scratch.
- **A camera is shareable as `?cam=<id>`** (JAKAR-57), and restoring one is not
  like restoring a stop. It has to fetch the layer, because cameras load only
  when asked for; it has to leave the map alone if the link already framed it;
  and it has to reconcile a link that carries a replay time, which is asking for
  two things that cannot both hold. **The camera wins and the card says the
  time was dropped** — it is the rarer and more specific ask, and one it would
  take 801 pins to recover by hand, while a replay time is one click to set
  again. Moving the clock without saying so is the answer that was ruled out.
- **Switch the layer on only once the clock is live.** `setCameras` while the
  clock is still replaying hands the frame loop the exact state it exists to
  tear down, and it does — leaving a camera card open over a layer switched back
  off, with its own toggle still reading on. `ensureCameras` fetches the set and
  fills the map source without turning anything on, so a link can ask whether a
  camera is still in the build before anything is switched at all. An unknown id
  then changes nothing rather than needing to be undone.

## Toll cameras, and why they need two sources

JAKAR-55. Jakarta's daytime population lives outside Jakarta, and the commuter
services this map carries — Royaltrans, Transjabodetabek — spend most of the
journey on a toll road the map showed nothing of.

- **Neither source works alone.** `bpjt.pu.go.id/cctv/` embeds an `allStreams`
  object with coordinates, KM marker, road and operator for 1,530 cameras
  nationwide, and is the only thing that geolocates any of them. But its table
  was written once on **2026-05-11** and has not moved since, and **Jasa Marga
  has rotated every stream id** in that time: zero of its 239 BPJT URLs appear
  on Bina Marga's live pages, and they play 0/10 where Bina Marga plays 10/10.
  Jasa Marga is 61% of the usable cameras.
- **The staleness is read from the rows, not from the fetch** (JAKAR-56). Every
  BPJT record carries `updated_at` and every one of the 1,530 says 2026-05-11,
  while the page itself answers daily — so the snapshot is always fresh and the
  data behind it has not moved in four months. `snapshot-freshness` cannot see
  that; `toll-camera-sources` reads the rows and warns past 90 days. This is the
  Comuline lesson in a different source: an endpoint that still answers is not
  an endpoint that is still maintained.
- **So resolve in two steps: BPJT's own URL if it is live, else the (road, KM)
  join to a Bina Marga page.** 52 direct, 91 recovered by the join.
- **The join needs BPJT to state a KM, and on several roads it does not.** JORR
  S, Akses Tanjung Priok and Pondok Aren-Serpong have an empty `nama_km`, so
  they survive only on step 1. **Joining those by card order was rejected** —
  the two sources disagree on how many cameras a road has, so an order join
  shifts every camera on the road to a different kilometre. That is the failure
  this project has already had twice.
- **Prefix-matching road names is ambiguous and the ingest resolves it once.**
  "Jakarta-Cikampek" and "Jakarta-Cikampek II Selatan" agree on their first
  sixteen characters; picking the wrong one joins a camera to a different
  motorway. The slug is resolved during ingest and written to `roads.json`, so
  the transform never guesses.
- **The join is 100% wherever it can run** (JAKAR-56). Measured from the feed
  side, road by road: of the 173 kilometre markers Bina Marga publishes live,
  135 are matched, and every road that misses is one where BPJT states no KM at
  all. Jakarta-Cikampek 26/26, Jalan Layang MBZ 30/30, JORR E 15/15, Sedyatmo
  11/11; Dalam Kota is the only partial at 13/14. **What is lost is 47 live
  streams on five roads** — Akses Tanjung Priok, JORR W1, Cimanggis-Cibitung,
  Bekasi-Cawang-Kampung Melayu, Tangerang-Merak — which are reachable pictures
  of real carriageways that nothing can place.
- **Count a match where it happens, not where it ships.** `matchedDirect` and
  `matchedJoined` count resolution; `direct` and `joined` count what survived
  the 150 m proximity filter. Conflating them reported a broken join on BORR,
  whose join matches all five cameras and whose cameras are then all dropped for
  sitting 35 km from any route this map draws. Freshness checks are entitled to
  judge the *source*, and our own filter is not the source.
- **Bina Marga repeats a card per carriageway and can repeat the URL with it.**
  BORR lists eight cards over six distinct streams. Counting cards overstates
  what a road publishes and leaves a camera looking unmatched when there was
  never a second picture for it — so `pageStreams` counts distinct URLs.
- **Proximity is judged against route paths, not stops.** 64% of toll cameras
  lie within 150 m of a path the fleet drives against 41% within 400 m of a
  stop, and the services passing them are Royaltrans (112) and Transjabodetabek
  (109). The distribution is sharply bimodal — 141 within 100 m, then almost
  nothing until 400 — so 150 m is a real boundary rather than a round number.
- **A toll camera far from any stop is not a fault in it.** The gate branches on
  `kind`: street cameras are checked against the stop they name, toll cameras
  against the nearest route path.
- **The build prints the join road by road, and the last build is kept.** A road
  going dark is invisible in the totals — Jasa Marga is 61% of the network and
  would mask every other operator at once — so `last-build.json` carries the
  per-road split and the next build compares against it. What is watched: the
  table's own age, either resolution arm collapsing, a road that resolved
  cameras last time and none now, and a road where both sides have material and
  nothing matched.

## Feed quirks that shaped the design

Full detail in `README.md`; the short version:

- **Headways, not departures.** There is no departure row to look up — it is
  computed from `frequencies.txt`. All of it lives in `timetable.js`.
- **A route's headway is not one number, and some routes claim to run all
  night.** Corridor 8 carries fourteen patterns whose headways run from 225 s to
  3600 s, so quoting the first one as "tiap 9 mnt" states a precision the feed
  does not have — the line card shows the spread. Separately, 88 trips declare
  `00:00-23:59` against 558 at `05:00-22:00`, which is why ~2,000 buses are still
  out at 23:30. **That is the feed's claim, not a transform bug** — checked
  against the raw `frequencies.txt`. The feed also never varies a headway by time
  of day, so a 225 s corridor stays 225 s at 03:00.
- **`transfers.txt` declares 7 interchange pairs.** The real number, derived
  from coordinates, is 28,737. Walking nearly doubles the network's interchange
  options.
- **Stations are containers.** `stop_times` references platforms, which point at
  the station via `parent_station`. Anything asking "what serves this stop?"
  must fold platforms in.
- **Fares do not sum.** 3-hour integrated transfer window; 101 of 240 routes are
  free.

## The Transjakarta feed host

- **Its TLS certificate expired on 1 September 2026** (wildcard
  `*.transjakarta.co.id`) and was **renewed by 10 September**. While it was
  expired the host stayed up and still served the zip; every ordinary client
  refused it, which reads like an outage and is not — `curl` returned exit 60
  and no HTTP status at all. It now verifies against the system trust store
  (`ssl_verify_result=0`) and needs no bypass.
- **The ingest adapter tries origin, then the Mobility Database mirror, then —
  only with `--insecure` — a bypass scoped to one request.** Which one answered
  is recorded in the snapshot's `meta.json`, because "we silently used the
  mirror for six months" is its own bug. **Never disable TLS verification
  globally in a build script.** That record is what made the recovery a
  one-line check rather than an investigation: every snapshot up to
  2026-09-06 says `servedBy=cache`/`mirror`, and 2026-09-10 says
  `servedBy=origin`.
- **The 2026-09-10 snapshot is the first from the origin**, and it carries the
  real 240 routes against the mirror's 252. Those twelve were withdrawn
  services the map had been drawing as though they ran. Re-ingesting moved the
  whole network: 261 routes to 249, 8,281 stops to 8,236, and three toll
  cameras dropped because the only routes passing them no longer exist.
- **A stale mirror is not a broken mirror, which is why nothing alerted.**
  Every check passed for four days on a feed that was twelve routes wrong.
  `snapshot-freshness` measures when we last *fetched*, and we were fetching
  daily — from a copy that had stopped matching. Same lesson as the BPJT table
  in JAKAR-56: an endpoint that still answers is not an endpoint that is still
  right. What caught it was checking the origin by hand.
- `gtfs.transjakarta.co.id` itself is a **login-gated GTFS upload portal**
  (NIK/password, © 2022), not a data portal. The public zip is an artifact it
  publishes.

**There is no GTFS-Realtime for any Jakarta operator.** Checked: no realtime
paths on the GTFS host, nothing in the Transitland entry, no Indonesian realtime
feed in the Mobility Database catalogue, no Tije API hostname resolves, and no
public documentation. An external research document supplied OTP updater config
pointing at `api.transport.jakarta.go.id`, which returns **NXDOMAIN** — do not
build against it. The app is a scheduled simulation by design, not for want of a
feed.

## KCI feed quirks (KRL)

Found while building the feed, so they are not re-discovered:

- **The station list is not the whole universe.** `Grogol` and `Karet` appear in
  `train-schedule` stop sequences but are absent from `/stations` entirely — not
  flagged disabled, simply missing. Joining from the list alone silently drops
  **121 trips**, 120 of them through Grogol. Build the station set from the union
  of the list and the stations the trips actually call at.
- **There is no date parameter.** `date`, `tanggal`, `day` and `schedule_date`
  are all ignored — every variant returns the same payload. Saturday and Sunday
  harvests came back byte-identical (549 rows at Manggarai, same trains, same
  times), so whether the API varies by day at all is **unresolved until a
  weekday harvest**. Modelled as one service covering every day.
- **Times wrap past midnight** (trap 6). Train 1469 runs Bogor 23:10 → Jakarta
  Kota 00:37. Any backwards step is midnight; add a day and keep it added.
- **Match a pattern to geometry on the same criterion the validator checks.**
  Scoring by how many stops a relation covers once matched a Jakarta Kota
  pattern to the Cikarang loop, which does not serve Jakarta Kota — the overlap
  elsewhere was enough to win. Require *every* stop to lie near the track.
- **Four Cikarang patterns have no drawable geometry, and the gap is upstream.**
  OSM ends every "Lin Lingkar Cikarang" relation at Kampung Bandan; six trips
  carry on one stop further to Jakarta Kota, which sits **754 m** off the track
  — so the matcher refuses them all and draws nothing. The best relation covers
  18 of 19 stops. It is not fixable by splicing a donor: the full racket is a
  *closed loop* with both ends at Cikarang, so Kampung Bandan is interior rather
  than a terminus, and the half rackets that do end there take the Angke routing
  and miss Kemayoran by 3.5 km. Attaching a spur would need loop rotation and
  trimming — machinery that can silently mis-draw a train, for **6 trips of
  3,216 (0.2%)**. The fix belongs in OSM: extend the relation over the
  Kampung Bandan → Jakarta Kota leg, which Lin Tanjung Priuk already covers to
  within 20 m. Until then, drawing nothing stays right.

- **A unique terminus is not a bug when the source states trip identity.**
  Rangkasbitung really does run 13 trains a day terminating at Tigaraksa. Only
  *inferred* patterns can be wrong about their branch, which is why `pattern`
  carries an `inferred` flag and the check skips the rest.

## Assembling an OSM route relation

**A relation's ways are not a path until you make them one.** Concatenating the
members in listed order is the obvious approach and it is wrong twice over:

- **A rail relation routinely carries both tracks.** Naive concatenation runs
  the line out and back — "Lin Bogor: Bogor → Jakarta Kota" came out **103.1 km
  against 50.6 km end to end**, ratio 2.04. Stops then projected onto opposite
  passes, so consecutive stations were 15 km apart instead of 5, and a followed
  train appeared to **loop between Bojonggede and Citayam** while its status
  advanced normally. That is what the bug looks like from the outside.
- **The members are not in connected order.** Anchoring on the first way and
  only extending the tail discards everything past the first gap: it dropped 124
  of Rangkasbitung's ways and reduced the MRT line to 300 metres.

So `stitch()` grows the path from **both ends**, reversing a way when that is the
end which matches, and retries until nothing more connects. What still will not
attach is a parallel track or a spur — the same route again — and is dropped.

After: Bogor 54.8 km (ratio 1.08), Rangkasbitung 72.9 km, MRT 15.6 km, **zero
ways dropped** on any of them.

## Placing stops on a shape

`patterns.bin` carries each stop's distance along its shape in metres, so
positioning a vehicle at runtime is a binary search and a lerp rather than a
projection per frame. Three traps, each of which produced visibly wrong
geometry before it was fixed:

- **Project sequentially, not by nearest point.** Most Jakarta bus routes are
  loops, so a stop is genuinely close to the shape twice and the nearest match
  can be the later pass. Naive projection put **343 of 803 patterns** in reverse.
- **Constrain the offset, not just the segment.** Restricting each stop to a
  later segment still lets it land at a smaller position *within* that segment.
  That left 229 patterns running backwards.
- **Try the shape both ways round.** A shape has a direction and so does a
  pattern, and nothing makes them agree — the shape matcher picks by coverage,
  which cannot tell an outbound relation from its inbound twin. Projected the
  wrong way every stop clamps to the first offset and the pattern comes out with
  zero length: 80 of 803. Judge the two directions on **span**, not on fitting
  error — a reversed shape fits just as closely, and the collapse to zero length
  is what gives it away.

- **Bound how far ahead a stop may be matched, and never leave the first stop
  unbounded.** `projectForward` took the globally nearest segment at or after
  the previous stop. On an out-and-back shape that let one stop match the
  *return* leg, after which every later stop was forced to the tail and clamped
  there: **158 of 806 patterns collapsed**, one bus jumping 63 km in 54 seconds
  and then standing still for 50 stops. Span cannot detect it — a collapsed
  pattern has a *large* span. Two things fix it, and both are needed: a reach
  window (`gap x 100 km/h`, floor 500 m, as `build-data.mjs` has always done),
  and preferring the **earliest** match within 60 m for the first stop, which is
  the one with nothing to be after. After: 0 collapsed, fastest leg 173 km/h
  against 4,225, and `encodePatterns` throws if one ever collapses again.

Now: 0 backwards, 0 collapsed, 4 zero-span, median pattern 18.1 km.

## The bus feed, in the canonical model

`scripts/transform/sources/transjakarta.mjs`. Points that cost time:

- **`route_desc` already states the category.** Deriving it from route names
  instead put 136 of 252 routes in "Lainnya". The feed says BRT, Mikrotrans,
  Royaltrans; read it rather than guess at it.
- **There are no departure rows.** A trip is a pattern plus headway windows, so
  buses are the first source to use the canonical trip's `frequency` arm. The
  per-stop offsets live on the *pattern*, identical for every trip that runs it.
- **A station is accessible if any of its platforms is.** The feed records the
  flag on platforms and only stations are drawn, so it has to propagate upward.
- **Shapes are simplified at encode time, not in the model.** How finely a line
  is drawn is a rendering decision; the canonical dataset keeps what the source
  said. At 1e-5 degrees it halves the vertices and saves 100 KB brotli.
- **The walk table is built last, across every mode.** 40,466 edges within
  400 m, **770 of them between different modes** — a bus stop and a rail platform
  never appear in the same operator's feed, so this is the only place
  interchange between them can come from.
- `build-data.mjs` still exists and still feeds the running app. Two paths
  briefly producing the same network is the safe way through.

## Artifacts, and why they are binary

`npm run transform` writes `public/artifacts/`: a `manifest.json` plus
content-hashed, mode-sliced files. **All four modes** — 249 routes, 3,203 trips,
8,236 stops, a 40,466-edge walk table and 798 cameras — come to **997 KB
gzipped / 624 KB brotli**, against 1.33 MB gzipped for the buses alone on the
old path.

- **Trips are binary because JSON was the wrong shape for them.** A trip stores
  a pattern index, a uint32 first call, then a uint16 delta per stop. Stop
  identity lives once on the pattern rather than once per trip, which is where
  the saving comes from: 5.3× smaller gzipped than the same trips as JSON.
- **A uint16 delta caps a leg at 18 hours** and the encoder throws if one
  exceeds it — which is what an un-unwrapped midnight looks like, so the error
  says so rather than truncating (trap 6, caught at the last possible moment).
- **Everything but the manifest is content-hashed** and safe to cache forever;
  the manifest is the only mutable file. This depends on the build being
  deterministic, which is why the canonical dataset is sorted and stably
  serialised before it reaches the encoder. `npm run test-transform` proves the
  encoding round-trips losslessly.
- **The manifest carries per-mode provenance** — which snapshot, what date, how
  many days old. Every rail source is scraped and none is contracted, so
  freshness is data the UI can read rather than a fact buried in a build log.
- **Old hashed files are swept** on each build; anything not in the new manifest
  is from a previous one.
- `npm run transform -- --json` still writes `data/build/canonical.json` for
  inspection, so binary artifacts never mean an unreadable pipeline.

## Loading artifacts in the browser

`src/data/artifact-loader.js` loads manifest → core → modes, decoding in a
Worker and caching in IndexedDB. Measured against the real artifacts:

| Step | Cost |
| --- | --- |
| manifest + core | **9 ms, 30 KB** — 145 stops, 9 routes, 97 patterns, no trip data |
| one mode (metro) | 28 ms, 3 files, 504 trips |
| second visit | **0 network fetches**, 4 files from IndexedDB, 14 ms |
| commuter_rail (1,097 trips, 17,848 stop times) | 21 ms decode, **0 main-thread long tasks** |

- **Core is first meaningful paint.** Stops and routes are drawable before a
  single trip has been fetched.
- **Mode toggles must gate loading, not just drawing.** Loading one mode fetches
  exactly its own files; a mode never asked for costs nothing. That is the whole
  reason artifacts are sliced per mode.
- **The `.bin` artifacts are fetched as `.br`, because no CDN will compress
  them.** Netlify and Cloudflare both decide by content type and neither
  compresses `application/octet-stream`, so `shapes-bus` shipped **1,299 KB
  where its brotli is 248** — 1.3 MB a visit across the set, to an audience
  mostly on a phone. `npm run transform` already wrote a `.br` beside every
  artifact and nothing used them. Measured in a real browser after: **664 KB
  transferred for 2,512 KB decoded**, 16 brotli requests, no fallbacks.
  - **The guard is the manifest's own byte count.** Whether a host honours
    `Content-Encoding` from a `_headers` file cannot be found out from the
    browser, and one that strips it returns raw brotli — the wrong length,
    which would decode as noise. A length mismatch refetches the plain file, so
    the worst case is one wasted request rather than a map that never loads.
  - **Brotli is safe to assume.** The build targets es2022, whose floor
    (Chrome 94, Safari 15.4) is years past brotli's (Chrome 50, Safari 11).
  - **Dev and preview serve it the same way**, through a twelve-line Vite
    middleware. Without it the local path silently takes the fallback on every
    file: working, twice as slow, and not what production does.
  - **The two hosts genuinely disagree, so the answer is asked once and
    remembered.** Netlify honours the header; **Cloudflare Workers strips it**
    while applying every other rule in the same `_headers` block — measured, not
    assumed. Whether a host honours it is a property of the origin, so one
    mismatch disables the brotli path for the rest of the session and writes
    `localStorage`, which is already scoped per origin. Without that, the host
    that says no pays sixteen wasted round trips instead of one, and this
    change would have made it *slower* than doing nothing.
  - **Cloudflare's half is now carried by a Worker script, because no header
    can carry it** (JAKAR-61). What re-encodes a body there is the runtime, not
    the `_headers` file, so `worker/index.js` re-declares `Content-Encoding: br`
    and returns the asset with `encodeBody: 'manual'` — the documented way to
    say "already encoded, pass it through". `run_worker_first` scopes it to
    `/artifacts/*`, so nothing else reaches JavaScript. Cloudflare now measures
    what Netlify measures: **16 brotli requests, 0 fallbacks, 664 KB for
    2,512 KB decoded**, against 2,120 KB before. The fallback and the length
    guard both stay — they are what made the disagreement measurable instead of
    a broken map, and they are still the only thing standing between a host
    that changes its mind and a page of noise.
  - **`Accept-Encoding` cannot be tested inside a Worker.** The obvious guard —
    only claim brotli if the client admits to taking it — is inert: the runtime
    rewrites the header to a constant `br, gzip` before the Worker sees it, so
    it reads the same for a client that sent `gzip` alone and for one that sent
    nothing. Measured against `wrangler dev`, and left out rather than left in
    looking like protection. Same shape as traps 10 and 11.
  - **Verify a host with `node scratchpad/verify-artifacts.mjs <origin>`.**
    It fetches every `.bin` as its `.br` and measures the inflated length
    against the manifest — the loader's own fallback trigger, so it asks what
    the browser asks. A header dump cannot answer this: `Content-Encoding: br`
    over a double-compressed body decodes to noise and looks perfect.
  - **Do not judge a Workers deploy while it is rolling out.** Run immediately
    after the push, that checker reported all sixteen artifacts wrong; minutes
    later, all sixteen right, with nothing changed in between and requests
    landing in different colos (`cf-ray`). The bytes were correct throughout —
    `curl` on the raw wire body inflated once to exactly the manifest length.
    Give a deploy a couple of minutes before believing a failure, and confirm
    against the raw body rather than one tool's opinion.
  - **`npx wrangler dev` runs the real workerd runtime against `dist/`**, so
    this is testable on a laptop rather than only by deploying — which is what
    the ticket assumed and what made every previous hosting fix cost a deploy
    cycle. It is also where the doubled `Cache-Control` showed up: Cloudflare
    concatenates *every* matching `_headers` rule, and two of them match a
    `.br`. The Worker normalises it; `_headers` is left alone, because the rule
    that looks redundant on Cloudflare is the one carrying Netlify.
- **Buffers are transferred, not cloned.** The worker takes ownership, so
  anything needing to survive a decode must be copied first — a structured clone
  of the payload would cost more than the decode it saved.
- **IndexedDB is keyed by filename, and every filename carries a content hash**,
  so a hit is the right bytes by construction and needs no revalidation. Stale
  entries are swept against the current manifest.
- **The cache is an optimisation.** Private browsing and blocked site data both
  make IndexedDB throw; every call is wrapped and the map works without it.

## Rebuilding trips from departure boards

KRL states which train a departure belongs to. MRT and both LRTs do not, so
trips are rebuilt in `scripts/transform/reconstruct.mjs`: estimate each leg's
run time as the **median** gap to the next departure downstream, then walk the
line claiming departures within tolerance. What stays unclaimed at station *i*
is a train that started there — which is how a short working looks from
outside, and MRT really does run one from Blok M at 05:00.

Patterns built this way carry `inferred: true`, and only inferred patterns are
checked for branch mis-assignment.

- **A terminus publishes no departures.** Chaining from the boards alone stops
  one station short of where the train actually goes; the final arrival comes
  from the same leg measured in the opposite direction.
- **Match relation stops to stations by position, not id.** A relation's `stop`
  members are `railway=stop` nodes while the name join matches `railway=station`
  nodes — the same places with different ids.
- **LRT Jabodebek reconciles exactly, and only because run times come from
  geometry.** Its four streams are rebuilt in two stages — inbound from the
  branch termini, then outbound anchored where the branch becomes identifiable —
  with all streams claiming in departure order. Both service days now account
  for every published departure: weekday 107 + 109 inbound and 107 + 107
  outbound against a 430-departure Cawang board; weekend 69 + 67 and 67 + 67
  against 270.
- **Never infer a run time from a board that merges directions.** A symmetric
  timetable puts *opposite-direction* trains at a consistent offset that looks
  exactly like a journey — Halim→Cawang peaks at 60 s, twelve times above
  background, and it is a train passing. `scripts/transform/geometry.mjs`
  projects stations onto the OSM track instead; distance knows nothing about the
  timetable, so it cannot be fooled. A fitted speed is *rejected* unless it lands
  in a plausible band, because board times are quantised to whole minutes and
  least squares happily returns 150 km/h to fit a flat line.
- **Tolerance scales with the leg, and inbound gets twice as much as outbound.**
  Geometry run times carry model error proportional to length. And an inbound
  chain starts at a branch terminus, so it is certainly a real train — every one
  that breaks early leaves a departure at an anchor station that outbound then
  counts as a phantom trip.
- **A chain must move forward in time.** Matching purely on "nearest to the
  prediction" lets a trip arrive a minute before it left. The temporal check
  caught 13 of them the moment tolerance widened.
- **One station name can mean two stations.** LRT Jabodebek calls its western
  terminus "Dukuh Atas BNI"; in OSM that name belongs to the *MRT* station
  (`station=subway`), while the LRT one 541 m away is "Dukuh Atas Bank Syariah
  Indonesia" (`station=light_rail`). Source-specific overrides live in the
  normaliser, not in `data/aliases.json`.

## Routing the walk table

Transfers used to be a straight line at 4.8 km/h. The *speed* was right —
measured 4.92 km/h — but the straight line ignores whatever is in the way, and
11% of edges were out by more than three minutes. Sentul and Simpang Sentul are
**62 m apart and 2,579 m on foot**; the model offered that as a 46-second
transfer.

`npm run ingest -- --source=walk` routes every pair through Transitland's hosted
Valhalla and `npm run transform` uses the result. Points that cost time:

- **The `walk` adapter is the one that reads the project's own output.** Which
  pairs to route *is* the walk table, which only exists after a transform, so
  unlike every other source it depends on `data/build/canonical.json`. A first
  build therefore cannot have it, and the transform says so rather than failing.
- **Valhalla caps a matrix at 2,500 cells** — sources × targets, *not* the
  location count, which is exactly what "Exceeded max locations: 2500" sounds
  like and is not. 50 × 50 sits on the limit; 49 × 59 is refused.
- **Ask in blocks, not per edge.** One request per edge is 40,817 requests;
  grouping stops so a block's sources and targets overlap makes it 276. The
  price is ~6× more cells computed than kept.
- **Put the key in a header, never the query string.** As a parameter it landed
  in the URL that the snapshot client prints on failure, and straight into a log
  file.
- **Directions are averaged.** Valhalla answers each way separately and they
  differ — 2,028 s one way against 1,916 s back, because crossings are not
  symmetric. The canonical table is undirected, so one number stands for both;
  the mean is unbiased where taking the larger would inflate the whole network
  to guard against a few.
- **Why not route locally.** The Geofabrik Java extract is 855 MB and needs a
  PBF reader. Overpass would be ~300 MB of tiles from a server that asks people
  not to bulk-extract — and a buffer small enough to afford is small enough to
  clip the very detours this exists to find: even at 500 m it needs 666 km² and
  would truncate a 2.2 km path.

## Data, by mode

All four modes now build. What each source actually is, so it is not re-derived:

| Mode | Feed |
| --- | --- |
| Transjakarta (bus) | Official GTFS, in use. The only Indonesian feed on Transitland. |
| KRL Commuter Line | No official GTFS, but `kci.id` serves three unauthenticated JSON endpoints and one returns whole trip stop-sequences. **Built** — see JAKAR-28. |
| MRT Jakarta | No GTFS, but a Strapi API serves the timetable. **Built** — JAKAR-29. |
| LRT Jakarta / Jabodebek | No GTFS. Jabodebek renders its timetable into the page; Jakarta answers a form POST. **Both built** — JAKAR-29. |

The router itself is mode-agnostic — RAPTOR treats a train as a pattern with
stops and times — so journey planning and reachability should extend without
structural change. The rendering, config and filtering are what assume buses.

## State of play

**All four modes are live on the default boot path**, drawn at their own sizes,
with a walk table that has been routed rather than estimated, and each mode now
drawn as its own **Kapsul** body rather than a scaled box (JAKAR-49). **798
public cameras** sit on the network and play live in the card, or full width over
the map — 658 on the streets (JAKAR-54) and 140 on the toll roads (JAKAR-55).

**It is public, on two hosts, and it works on a phone.** Both send the same 640
KB of artifacts (JAKAR-61), the layout is one column below 700px (JAKAR-62), and
the render path has been measured on hardware somebody actually rides the bus
with (JAKAR-60).

The app can: run live or replay a day, follow a vehicle (chase or on-board,
with its own controls), preview a line and watch only its vehicles run, show
how far you can get from any stop or any point in a time budget, answer "what
is near this point", show first/last departure, colour by live frequency, and
share any view as a link — a camera included — and watch the actual street, or
the actual toll carriageway, through a public CCTV camera beside the simulated
fleet.

It deliberately does **not** plan a journey from A to B any more.

**It now looks like Jakarta rather than like a template** (JAKAR-64). The
typeface is Plus Jakarta Sans, the accent is Transjakarta's own signage blue,
type sits on a seven-step scale where fifteen ad-hoc sizes used to be, and the
controls are the size Google Maps makes them. The rider can also choose what the
map underneath looks like — Warna, Pudar or Mono.

**Everything the 2026-09-11 session changed**, so it is not re-derived:

| | |
| --- | --- |
| Buttons | Six pill implementations became one `.btn` system, two intents, three sizes |
| Typeface | Plus Jakarta Sans, self-hosted, 27 KB for the full variable axis |
| Type | Fifteen ad-hoc sizes became a seven-step scale on a 15px base |
| Space | A 4px grid, where padding had used every integer from 2 to 14 |
| Controls | 29-33px became 36/40/48, with 44px hit areas on the small ones |
| Fields | The finder's two boxes are real 48px inputs, inset, with a focus ring |
| Colour | The accent is `configs.categories`' own Transjakarta blue, not a stock `#35a7ff` |
| Map style | Warna / Pudar / Mono, remembered in `localStorage` (the light preset stays on the clock) |
| Probe | `PROBE_WIDTH`/`PROBE_HEIGHT` — the phone arm, which is the only one that catches a size change becoming a layout change |
| Docs | `.interface-design/system.md` is the design system of record |

**Everything the 2026-09-10 session changed**, so it is not re-derived:

| | |
| --- | --- |
| Compression | Cloudflare serves the artifacts brotli through `worker/index.js`; 2,120 KB became 664 KB, level with Netlify (JAKAR-61) |
| Mobile perf | Measured on a Galaxy S25-class device: the median frame hits the budget in every view; what it costs is tail frames (JAKAR-60) |
| Levers | Gedung 3D off is the only one that works. Monochrome is not a lever, and capping dpr buys 12% for 9x fewer pixels |
| `?bench` | An on-device benchmark, lazily imported. Results live in `scratchpad/device-bench/` |
| Mobile layout | One column: read at the top, act at the bottom. Layanan folds instead of vanishing (JAKAR-62) |
| Feed host | Its certificate was renewed; the adapter takes the origin again, and twelve withdrawn routes left the map |
| Network | 261 routes to **249**, 8,281 stops to **8,236**, walk table re-routed to 40,466 edges with no estimates |

**Everything the 2026-09-06/08 sessions changed**, so it is not re-derived:

| | |
| --- | --- |
| Boot path | `?data=artifacts` is now the default; `?data=legacy` reaches the old bundle |
| Finder | Navigasi / Jalur tabs; two editable end fields; line preview |
| Rails | Left = act, right = read; Layanan moved under the clock |
| Follow | Its own HUD — camera, speed, stop |
| Vehicles | Per-mode size and acceleration; heading smoothed over distance |
| Vehicle shape | Kapsul bodies, one geometry and one instanced mesh per mode (JAKAR-49) |
| Walk table | All 40,466 edges routed through Valhalla |
| Durations | Over an hour read "1 jam 9 mnt" |
| Cameras | Live CCTV on the network, gated to live mode, fullscreen on click |
| Camera sources | Street coords from a stale mirror; 46 placed from street names; toll needs BPJT joined to Bina Marga |
| Camera freshness | `toll-camera-sources` watches the BPJT table's own age and the join, road by road (JAKAR-56) |
| Camera links | `?cam=<id>` restores a camera: loads the layer, forces live, and says so (JAKAR-57) |
| Probe harness | `scratchpad/probe.mjs` rebuilt — real Chrome over CDP, step lists, screenshots |
| Render cost | Measured on a real GPU at last (JAKAR-58): the fleet is 0.2-2.6 ms, the basemap is the rest |

**Ten bugs have been found by using the app rather than by testing it**, every
one of which passed the whole automated suite first: the walk table joining stops
74 km apart (trap 7), the frame loop crashing on a shapeless trip (trap 8), 158
of 806 patterns collapsed so vehicles teleported then stood still, 43 unservable
stops offered in search, a camera layer where **not one of 612 pins rendered**
(trap 9), a video player broken for every Chrome user (trap 10), a liveness
probe measuring nothing because a 200 came back empty (trap 11), and a camera
deep link that opened a card over a layer the live gate had already torn down
(trap 12), and a phone where the clock covered the card you had just opened and
nothing could close it (trap 13), and nine rail lines advertising a train
"tiap 0 mnt" while the frequency layer called them the most frequent services
on the map (trap 14). The ninth is the one to notice: it was found by the
person who owns the project opening it on his own phone, after every check in
the repo had passed. The tenth was found by reading a card while changing
something else on it.

That is the pattern to expect, and the reason two things stay: the legacy path,
which was clean in every data case, and `scratchpad/probe.mjs`, which is the only
thing that has ever caught the interaction ones.

**Open work is in Plane.** Start a session by reading the project's
**"Next Session — Start Here"** page, which is kept current. Next up are
**JAKAR-65** (mobile type and controls are still undersized — the scale is
currently identical on a phone and a desktop) and **JAKAR-66** (*"sekitar sini"*
opens over the part of the map being navigated on a phone), both raised by the
owner at the end of the 2026-09-11 session. **JAKAR-50** is done: the line
codes, the line colours and the mode glyphs are in, and the licence question
that blocked it turned out to have an answer.

## Known weak points

- ~~**Walking is straight-line**~~ — **fixed (JAKAR-40).** All 40,466 edges now
  carry real pedestrian times from Valhalla, re-routed against the current stop
  set on 2026-09-10. The measurement below is what the
  old model was wrong by, kept because it is why the work was done.

  Re-measured over 400 pairs against the *fixed* walk table (JAKAR-45; the first
  run, JAKAR-24, was measured against the corrupted one and not all of its
  findings survived):

  - implied speed p50 **4.92 km/h** against the model's 4.8 — so leave the speed
    alone, the geometry is what is wrong. This conclusion did survive.
  - **absolute** error is the number that matters, not the ratio: median **29 s**,
    p90 191 s, p99 805 s, worst **+27 min**. Ratio explodes on short pairs — a
    5 m gap walked in 320 m is 84x and only four minutes — and reading the ratio
    is what produced the wrong target last time.
  - **11% of pairs are underestimated by over 3 minutes**, which is enough to
    change which itinerary wins.
  - **Same-name pairs are not the problem.** The first run blamed them for 64%
    of the tail; measured properly they are 23% of it, and same-name pairs have
    a *better* median ratio than average (1.07). There are 3,584 of them, not
    the 127 that run claimed.
  - The real tail is **barriers**: PLN Senayan to Pulo Kamboja is 142 m apart and
    2,213 m on foot; St. Klender Muka to St. Klender is 187 m and 1,334 m. A
    railway, river or limited-access road intervenes and the crossing is distant.
    Selecting those needs routing, not a name test.

  Routing the whole table confirmed the sample almost exactly: **12.4% of edges
  (5,050) were out by more than three minutes**, against the 11% predicted. 980
  were out by more than ten. Worst: Sekolah Fatimiyah Perdana to SMA Angkasa 1,
  293 m apart and **3,356 m on foot** — a 38-minute error. Detour factor p50
  1.24, p90 2.68, p99 **17.5**. The clusters are Halim and Roxy, both places
  where a toll road or a railway sits between two stops a street apart.
- ~~**GPU performance is unmeasured**~~ — **measured (JAKAR-58).** On an Apple
  M4 the fleet costs **0.2-2.6 ms a frame** and the basemap costs the rest; see
  "What the render path actually costs" below. What is still unmeasured is a
  low-end device — but a phone has now answered (JAKAR-60). On a Galaxy
  S25-class device the median frame hits the budget in **every** view, street
  level included, and what the map costs is tail frames rather than a low
  ceiling. Two things follow. **A 4x CPU throttle over-predicts badly for a
  phone with a real GPU** — it said 17 fps where hardware says 54 — so treat
  that arm as a floor for a slow device and never as a phone. And **a mid-range
  Android is still unmeasured**: an S25 is the good case, and `?bench` makes
  the next device a one-minute job.
- **Interaction is entirely unmeasured.** Every frame-rate number this project
  has — JAKAR-58's, JAKAR-60's, all of them — is a *static camera*. A map is
  used by panning and pinching, and nothing here has ever measured hitching
  during a gesture. It is the most likely home for "feels bad on a phone" and
  the largest remaining blind spot; an external review raised it and was
  right.
- **The basemap is the expensive half, and on a slow CPU it is the whole
  problem.** At street level Mapbox Standard alone is ~95% of the frame, and at
  4x CPU throttle it is 52 ms of a 59 ms frame with the fleet removed entirely.
  Any performance work aimed at the vehicles is aimed at the wrong thing.
- ~~**The map style is private**~~ — **fixed.** The basemap is now stock
  `mapbox://styles/mapbox/standard`, so the app runs on any Mapbox token rather
  than only one on the style's own account. The cost is that the fleet no longer
  has a grey city to itself: Standard is full colour and the vehicles compete
  with it. If they stop reading, Standard's `monochrome` theme is one
  `setConfigProperty('basemap', 'theme', 'monochrome')` away.
- **Cross-mode walking is still unmeasured.** The routed table covers every
  edge, but only 7 of the 400 sampled pairs were bus-to-rail, so the interchanges
  the multi-modal map most depends on have never been checked as a group. They
  are also the ones most likely to sit across a barrier.
- **Camera bearing is unmatched.** The pin flies the map to the camera's
  position but not to its *view*; MT3D hand-authors `bearing`/`pitch` per camera
  and that does not scale to 801. Deriving it is an open question.
- **46 camera positions are estimates**, inferred from street names because no
  source geolocates them. They land on the right street and beside a plausible
  corridor stop, but not on the right pole. `data/camera-places.json` is how one
  gets corrected.
- ~~**Vehicles are still boxes**~~ — **fixed (JAKAR-49).** Each mode has its own
  Kapsul body: 360 triangles for a bus, 792 for an eight-car KRL set. What is
  still open is that the fleet is now ~2M triangles at the evening peak against
  72k before, and **that has never been drawn on a real GPU** — see the unmeasured
  GPU point above.
- **Four Cikarang patterns are undrawable**, and the gap is in OSM rather than
  here — 6 trips, 0.2%. See the KCI feed notes above and JAKAR-44.
