# Mikrotrans GTFS

This folder holds the **Mikrotrans** routes from Transjakarta's public GTFS feed, as a GTFS feed of their own. That's 98 routes, 227 trip patterns and 5,866 stops. Mikrotrans is Transjakarta's network of small feeder buses (the `JAK.xx` routes).

Nothing in it was edited. Rows were kept or dropped by one rule: keep the routes where `routes.txt` → `route_desc` is `Mikrotrans`, plus everything those routes refer to. Any GTFS tool can open it.

## What's in the folder

| Path | What it is |
| --- | --- |
| `mikrotrans-gtfs.zip` | The feed as one file. Use this with GTFS tools. |
| `gtfs/` | The same files unzipped, for reading or loading into a spreadsheet or database |
| `metadata.json` | Source, date, filter rule, counts and a SHA-256 for every file, in a form scripts can read |
| `examples/departures.py` | Lists the departures at a stop on a given day. Standard-library Python, no installs. |
| `scripts/` | The two scripts that made this export, for rebuilding it when the feed changes |

## Source

| | |
| --- | --- |
| Publisher | PT Transportasi Jakarta (Transjakarta) |
| URL | https://gtfs.transjakarta.co.id/files/file_gtfs.zip |
| Feed last modified | 30 Oct 2026 |
| Downloaded | 4 Nov 2026 |
| Timezone | Asia/Jakarta (WIB, UTC+7) |
| Calendar valid | 15 Jan 2004 – 31 Dec 2027 |

`metadata.json` has the checksum of the source zip, so you can tell later whether you're looking at the same feed.

## The one thing to understand first: this feed has no timetable

There are no departure times in this data. Every trip in `trips.txt` is a **pattern**: one route, in one direction, along one path. It is not a single bus run. `frequencies.txt` gives the frequency, for example "every 6 minutes from 05:00 to 22:00". The actual departures come from combining the two:

1. In `frequencies.txt`, a pattern leaves its first stop at `start_time`, then every `headway_secs`, until `end_time`.
2. In `stop_times.txt`, the times for that pattern are a template. What matters is the difference from the first stop. If stop 12 is 18 minutes after stop 1 in the template, every run reaches stop 12 18 minutes after it left.

So a pattern running 05:00–22:00 every 360 seconds is 170 runs a day. Across the network that comes to about **33,800 runs a day** (33,734 on Saturdays). `examples/departures.py` does exactly this:

```bash
cd examples
python3 departures.py ../gtfs B05728P 2026-11-05              # a whole day at Term. Tj. Priok 1
python3 departures.py ../gtfs B05728P 2026-11-05 07:00 08:00  # one hour
```

Some GTFS tools do this expansion for you (look for "frequencies" or "headway" support), and some ignore `frequencies.txt` completely. In that case every route looks like it runs once a day at 05:00. If counts look far too low, that's why.

## The files

| File | Rows | What's in it |
| --- | --- | --- |
| `agency.txt` | 1 | Transjakarta (`Tije`) |
| `routes.txt` | 98 | One row per route. `route_short_name` is the code riders see (`JAK.79`); `route_long_name` is its two ends; `route_color` is Transjakarta's colour for it. All `route_type` 3 (bus). |
| `trips.txt` | 227 | Patterns (see above). `direction_id` 0 or 1; `shape_id` points at its line. Half the routes have 2 (one each way), 13 have 1, and the rest have 3–5. |
| `frequencies.txt` | 227 | Exactly one window per pattern. 190 run every 6 min, 36 every 20 min, and 1 every 60 min. |
| `stop_times.txt` | 12,967 | The stop sequence of each pattern, with template times. Median 52 stops and 77 minutes end to end; the longest has 154 stops and takes 227 minutes. |
| `stops.txt` | 5,866 | Stop points, nearly all roadside stops with `B…` IDs. The 6 rows with `location_type` 1 are parent stations (terminals and BRT halte such as Tanah Abang and Pulo Gebang), and the `G…` rows are the bays inside them. |
| `shapes.txt` | 85,548 | One path per pattern (227), as ordered lat/lon points |
| `calendar.txt` | 3 | `SH` every day (225 patterns), `HK` weekdays (1), `HM` Sundays (1) |
| `fare_attributes.txt`, `fare_rules.txt` | 1, 98 | Every route uses fare `GR`: **Rp 0**. Mikrotrans is free. |
| `ticketing_identifiers.txt`, `ticketing_deep_links.txt` | 71, 1 | Links into Transjakarta's ticketing app. Most tools ignore these files and they're safe to drop. |

`transfers.txt` from the full feed is left out, because none of its 14 rows involve a Mikrotrans stop.

## Common uses

- **Map it.** Load `stops.txt` as points (`stop_lon`, `stop_lat`). Build the lines from `shapes.txt`: group by `shape_id` and sort by `shape_pt_sequence`. In QGIS, the GTFS-GO plugin loads the zip directly.
- **Count service.** Frequency at a stop, runs per route, or stops with no service after 22:00. Expand frequencies first (see above).
- **Analyse in code.** `gtfs_kit` (Python) and `tidytransit` (R) both read the zip. For plain `pandas`, `pd.read_csv('gtfs/stops.txt', dtype=str)` works; read IDs as text so `JAK.10` and leading zeros survive.
- **Route with it.** OpenTripPlanner and similar engines take the zip as is. Mikrotrans by itself is a feeder network, though, so routing on it without the BRT and rail lines will give odd results.

## Know before you rely on it

- **This is the schedule Transjakarta publishes, not where buses really are.** There is no real-time feed for any Jakarta operator.
- **Frequencies are the same all day.** A pattern that runs every 6 minutes runs every 6 minutes at 05:00 and at 21:00, and travel time between stops does not change with traffic. That's how the feed is written, not a fault in this cut.
- **A few patterns claim to run all night.** `JAK.47-R05` and `JAK.47-R06` declare 00:00–23:59, and three patterns run 22:00–23:59. These come from the feed itself.
- **`shape_dist_traveled` is empty** in both `stop_times.txt` and `shapes.txt`. To get distances, compute them from the coordinates.
- **Most stops are marked not wheelchair accessible.** 5,685 stops have `wheelchair_boarding` = 2 (no) and the rest are blank (unknown).
- **Key on `stop_id`, not `stop_name`.** Names are nearly unique in this cut, but the bays at four terminals share their terminal's name.
- **Validation.** Every reference in the cut resolves: each stop, parent station, shape and service a row points to is present. The official MobilityData GTFS validator has **not** been run on it. To run it, with Docker installed: `docker run -v "$PWD":/work ghcr.io/mobilitydata/gtfs-validator -i /work/mikrotrans-gtfs.zip -o /work/validation`.

## Credit and licence

The data is Transjakarta's. **Transjakarta states no licence for this feed.** It doesn't grant permission and it doesn't forbid use. Indonesian copyright law (UU 28/2014, Pasal 41 huruf b) treats schedule data as facts rather than a protected work, which is the usual basis for using it. In practice:

- Credit it as **"Source: Transjakarta (PT Transportasi Jakarta) GTFS, October 2026"**.
- Internal analysis and non-commercial work rest on that basis. Jakarta Transit 3D uses the feed the same way.
- **If you plan to republish it or use it commercially, ask Transjakarta first** (naektije@transjakarta.co.id, per `agency.txt`). Nobody has a written answer from them yet.

## Rebuilding it when the feed changes

```bash
curl -sSo file_gtfs.zip https://gtfs.transjakarta.co.id/files/file_gtfs.zip
curl -sI https://gtfs.transjakarta.co.id/files/file_gtfs.zip | grep -i last-modified   # the feed's date
unzip -q file_gtfs.zip -d full
rm -rf gtfs mikrotrans-gtfs.zip
python3 scripts/filter_gtfs.py full Mikrotrans gtfs                # prints rows kept and an integrity check
(cd gtfs && zip -X ../mikrotrans-gtfs.zip *.txt)
python3 scripts/metadata.py . file_gtfs.zip <last-modified, UTC> <download time, UTC>
```

`filter_gtfs.py` takes any `route_desc` value (`metadata.py` is written for Mikrotrans, so its wording would need changing for another category). The full feed also has `BRT`, `Angkutan Umum Integrasi`, `Transjabodetabek`, `Rusun`, `Royaltrans` and `Bus Wisata`, so the same command cuts out any of them.

Made from the Jakarta Transit 3D project, which uses the same feed.
