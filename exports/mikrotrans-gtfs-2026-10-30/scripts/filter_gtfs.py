"""Cut a GTFS feed down to the routes of one route_desc, keeping it valid.

Rows are copied verbatim with their original columns; only rows are dropped.
Usage: python3 -I filter_gtfs.py <gtfs_dir> <route_desc> <out_dir>
"""
import csv, os, sys

src, desc, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)

def read(name):
    p = os.path.join(src, name)
    if not os.path.exists(p):
        return None, []
    with open(p, encoding='utf-8-sig', newline='') as f:
        r = csv.reader(f)
        head = next(r)
        head = [h.strip() for h in head]
        rows = [dict(zip(head, [c.strip() for c in row])) for row in r if row]
    return head, rows

T = {n[:-4]: read(n) for n in sorted(os.listdir(src)) if n.endswith('.txt')}

def rows(t): return T[t][1] if t in T else []

routes = [r for r in rows('routes') if r['route_desc'] == desc]
route_ids = {r['route_id'] for r in routes}
trips = [t for t in rows('trips') if t['route_id'] in route_ids]
trip_ids = {t['trip_id'] for t in trips}
stop_times = [s for s in rows('stop_times') if s['trip_id'] in trip_ids]
frequencies = [f for f in rows('frequencies') if f['trip_id'] in trip_ids]

stops_by_id = {s['stop_id']: s for s in rows('stops')}
stop_ids = {s['stop_id'] for s in stop_times}
# Parents travel with their platforms, or parent_station points at nothing.
frontier = set(stop_ids)
while frontier:
    parents = {stops_by_id[s]['parent_station'] for s in frontier
               if s in stops_by_id and stops_by_id[s].get('parent_station')}
    frontier = parents - stop_ids
    stop_ids |= parents
stops = [s for s in rows('stops') if s['stop_id'] in stop_ids]

shape_ids = {t['shape_id'] for t in trips if t.get('shape_id')}
shapes = [s for s in rows('shapes') if s['shape_id'] in shape_ids]
service_ids = {t['service_id'] for t in trips}
calendar = [c for c in rows('calendar') if c['service_id'] in service_ids]
calendar_dates = [c for c in rows('calendar_dates') if c['service_id'] in service_ids]

fare_rules = [f for f in rows('fare_rules') if f['route_id'] in route_ids]
fare_ids = {f['fare_id'] for f in fare_rules}
fare_attributes = [f for f in rows('fare_attributes') if f['fare_id'] in fare_ids]

agency_ids = {r['agency_id'] for r in routes} | {f['agency_id'] for f in fare_attributes}
agency = [a for a in rows('agency') if a['agency_id'] in agency_ids]

transfers = [t for t in rows('transfers')
             if t['from_stop_id'] in stop_ids and t['to_stop_id'] in stop_ids]
ticketing_identifiers = [t for t in rows('ticketing_identifiers') if t['stop_id'] in stop_ids]
tdl_ids = {x.get('ticketing_deep_link_id') for x in agency + routes} - {'', None}
ticketing_deep_links = [t for t in rows('ticketing_deep_links')
                        if t['ticketing_deep_link_id'] in tdl_ids]

kept = dict(agency=agency, calendar=calendar, calendar_dates=calendar_dates,
            fare_attributes=fare_attributes, fare_rules=fare_rules,
            frequencies=frequencies, routes=routes, shapes=shapes,
            stop_times=stop_times, stops=stops, transfers=transfers, trips=trips,
            ticketing_identifiers=ticketing_identifiers,
            ticketing_deep_links=ticketing_deep_links)

for name, (head, all_rows) in T.items():
    if name not in kept:
        print(f'  ! {name}.txt not handled, left out')
        continue
    keep = kept[name]
    if not keep and name not in ('agency', 'routes', 'trips', 'stops', 'stop_times'):
        print(f'  - {name}.txt: 0 of {len(all_rows)} rows, file omitted')
        continue
    with open(os.path.join(out, name + '.txt'), 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(head)
        for r in keep:
            w.writerow([r.get(h, '') for h in head])
    print(f'  {name}.txt: {len(keep)} of {len(all_rows)} rows')

# Referential checks: every reference in the cut resolves inside the cut.
errs = []
sid = {s['stop_id'] for s in stops}
errs += [f'stop_time -> missing stop {s["stop_id"]}' for s in stop_times if s['stop_id'] not in sid]
errs += [f'stop -> missing parent {s["parent_station"]}' for s in stops
         if s.get('parent_station') and s['parent_station'] not in sid]
shp = {s['shape_id'] for s in shapes}
errs += [f'trip {t["trip_id"]} -> missing shape {t["shape_id"]}' for t in trips
         if t.get('shape_id') and t['shape_id'] not in shp]
svc = {c['service_id'] for c in calendar} | {c['service_id'] for c in calendar_dates}
errs += [f'trip {t["trip_id"]} -> missing service {t["service_id"]}' for t in trips
         if t['service_id'] not in svc]
tid_with_times = {s['trip_id'] for s in stop_times}
errs += [f'trip {t["trip_id"]} has no stop_times' for t in trips if t['trip_id'] not in tid_with_times]
rid_with_trips = {t['route_id'] for t in trips}
noTrips = [r['route_id'] for r in routes if r['route_id'] not in rid_with_trips]
print(f'\nroutes {len(routes)}, with trips {len(routes) - len(noTrips)}, trips {len(trips)}, '
      f'stops {len(stops)}, shapes {len(shape_ids)}')
if noTrips:
    print('routes with no trips:', ' '.join(noTrips))
print('integrity errors:', len(errs))
for e in errs[:20]:
    print('  ', e)
