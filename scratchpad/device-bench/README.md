# Device benchmark results (JAKAR-60)

Raw `?bench` output, one file per run, kept because a number without its
device is not a measurement. Add a file rather than editing one — the point of
these is the series.

`observedCeilingHz` is the fastest median any arm reached, not the panel's
refresh rate: an S25 reports 60 on a 120 Hz display because Chrome schedules
the page at 60. Frame intervals quantising to 8.33 ms is the panel showing
through.

On a device vsync cannot be disabled, so `fps` means "kept up" and not "cost
this much". These are not comparable with `scratchpad/gpu-bench.json`, which
measures with the presentation clock removed.

| File | Device | Street, shipped | Street, 3D off |
| --- | --- | --- | --- |
| `2026-09-09-galaxy-s25-a.json` | Samsung S25, Chrome 152 | 54 fps, p90 25.0 ms | 59 fps, p90 16.9 ms |
| `2026-09-09-galaxy-s25-b.json` | the same phone, 4 min later | 50 fps, p90 33.3 ms | 56 fps, p90 16.8 ms |

The two S25 runs are the same device four minutes apart, served by different
hosts. The host is a coincidence: the artifacts are identical and already
loaded before the bench starts. What separates them is that the phone got
warm, which costs more than the choice of view does.

**Still missing: a mid-range Android.** The S25 is a current flagship and this
is the good case.
