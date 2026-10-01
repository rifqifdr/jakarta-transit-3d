# Device benchmark results (JAKAR-60, JAKAR-63)

Raw `?bench` output, one file per run, kept because a number without its
device is not a measurement. Add a file rather than editing one — the point of
these is the series.

| URL | Runs | Takes |
| --- | --- | --- |
| `?bench=static` | three static views × three arms (JAKAR-60) | ~1 min |
| `?bench=motion` | six camera moves × four passes (JAKAR-63) | ~2.5 min |
| `?bench` | both, static first | ~3.5 min |

On a phone: open the deployed site with one of those, put the phone down, keep
the tab in front, and press *Copy result* at the end. The bench holds a screen
wake lock where the browser offers one (`env.wakeLock`); where it does not —
any plain `http://` address, such as a laptop's dev server on the LAN — the
screen timeout has to be longer than the run.

`observedCeilingHz` is the fastest rate the page was scheduled at, not the
panel's refresh rate: an S25 reports 60 on a 120 Hz display because Chrome
schedules the page at 60. Frame intervals quantising to 8.33 ms is the panel
showing through.

On a device vsync cannot be disabled, so `fps` means "kept up" and not "cost
this much". These are not comparable with `scratchpad/gpu-bench.json`, which
measures with the presentation clock removed.

## Static views

| File | Device | Street, shipped | Street, 3D off |
| --- | --- | --- | --- |
| `2026-09-09-galaxy-s25-a.json` | Samsung S25, Chrome 152 | 54 fps, p90 25.0 ms | 59 fps, p90 16.9 ms |
| `2026-09-09-galaxy-s25-b.json` | the same phone, 4 min later | 50 fps, p90 33.3 ms | 56 fps, p90 16.8 ms |

The two S25 runs are the same device four minutes apart, served by different
hosts. The host is a coincidence: the artifacts are identical and already
loaded before the bench starts. What separates them is that the phone got
warm, which costs more than the choice of view does.

**The `no3d` arm was called `flat` in the 2026-09-09 files.** It toggles
Mapbox Standard's extruded buildings and nothing else — same camera pitch,
same three.js vehicle layer, no 2D renderer anywhere. The old name was read by
one reviewer as a 2D map mode and produced a whole wrong conclusion, which is
why it is now named after what it changes.

## The moving camera (`bench: 2`)

Every frame number before this was a static camera. The motion arms move it
the way the app does, and each runs the same path four times:

| Motion | What moves | Over four seconds |
| --- | --- | --- |
| `pan` | sideways at street level, z16.8, 600 CSS px/s | 1.63 km |
| `zoom` | z12.5 → 16.5 over Bundaran HI, through the 3D and true-scale thresholds | 4 zoom levels |
| `rotate` | 170° on Sudirman at z15.5 | 170° |
| `flyTo` | four search-result flights, 1 s each, sampled only in the air | 24.7 km |
| `tour` | *Jelajahi jalur* on corridor 1, past its opening | 1.4 km, ~120° |
| `navigasi` | following a corridor 1 bus in the nav view, **at 16x** | ~0.3 km, ~70° |

| Pass | Is |
| --- | --- |
| `first` | the first time this run has seen that ground, so it pays for tiles |
| `shipped` | the same path again, as shipped |
| `no3d` | Gedung 3D off, after a priming pass of its own — the toggle re-parses every tile |

Navigasi is at 16x because at 1x the bus moved ten metres in a sample, which
is a parked view with a moving-camera label. 16x is one of the follow HUD's
own speeds.

Columns every row now carries, static rows included:

- **`droppedPct`** — display refreshes that showed no new frame, over all that
  went by, against `env.frameBudgetMs` (read at rest before anything runs).
  Relative to the display, so 50% on a 120 Hz laptop is a steady 60 fps.
- **`long`** — frames of 50 ms or more: a stall a person feels at any refresh
  rate. This is the one to compare across devices.
- **`tiles`** — tiles that arrived during the sample. Says whether a row was
  warm. It caught the old static street `no3d` arm sampling while 93 tiles
  were still arriving after `settle` had let it go.
- **`loaf`** — long animation frames and their blocking time (Chrome only;
  null elsewhere). Dropped frames with little blocking point at the GPU or the
  compositor; with a lot, at the main thread.
- **`moved`** — how far the camera went while recording. A screenshot proves
  an arm was in the right place; only this proves it moved.
- **`interrupted`** — the page was hidden, or delivered no frames, during the
  sample. Nothing else in that row is a measurement. A hidden page gets no
  animation frames while the timer ending the sample runs on, which once
  produced a row of zeros that passed for Navigasi.

| File | Device | Pan | Zoom | Rotate | flyTo | Tour | Navigasi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `2026-10-01-m4-motion.json` | Apple M4, 120 Hz, Chrome, 2880x1602 | 90 / 102 | 90 / 99 | 74 / 83 | 89 / 105 | 86 / 102 | 82 / 97 |

fps as shipped / with Gedung 3D off. On the M4, nothing stalls: one frame over
50 ms in eighteen rows, no main-thread blocking to speak of. Rotate is the slow
move — its median frame is 15-16 ms, half the display's rate, in every clean
run — and Gedung 3D off brings that back to 9 ms. 3D off is worth 10-16 fps in
every motion.

`2026-10-01-m4-motion-first-launch.json` is kept for one reason: it was the
first run after Chrome launched, and it was far worse than any later one —
zoom at 33-43 fps with seven stalls up to 388 ms and 1.3 s of main-thread
blocking, every motion near 60 fps. A cold shader or pipeline cache fits;
nothing here proves it. It predates `moved` and `interrupted` and ran Navigasi
at 1x. **It matters because it is what a first visit is**, so look for it in
the `first` rows on a phone.

**Still missing: a mid-range Android.** And a scripted camera is not a finger:
no touch events, no input latency, no refresh-rate boost a phone may grant
while a finger is down. These rows measure rendering under motion.
