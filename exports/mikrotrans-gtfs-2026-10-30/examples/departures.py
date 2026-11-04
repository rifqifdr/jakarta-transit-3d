"""List the departures at one stop on one day.

This feed has no departure rows. Each trip in trips.txt is a *pattern*, and
frequencies.txt says how often it runs. This script expands the two into
clock times, which is the step every use of this data needs first.

Standard library only.

    python3 departures.py ../gtfs B05728P 2026-11-05
    python3 departures.py ../gtfs B05728P 2026-11-05 07:00 08:00
"""
import csv, os, sys
from collections import defaultdict
from datetime import date

def read(gtfs, name):
    with open(os.path.join(gtfs, name), encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))

def secs(t):
    h, m, s = map(int, t.split(':'))
    return h * 3600 + m * 60 + s

def clock(s):
    return f'{s // 3600:02d}:{s % 3600 // 60:02d}'

def main(gtfs, stop_id, day, frm='00:00', to='23:59'):
    d = date.fromisoformat(day)
    ymd = d.strftime('%Y%m%d')
    weekday = ['monday', 'tuesday', 'wednesday', 'thursday',
               'friday', 'saturday', 'sunday'][d.weekday()]

    running = {c['service_id'] for c in read(gtfs, 'calendar.txt')
               if c[weekday] == '1' and c['start_date'] <= ymd <= c['end_date']}
    routes = {r['route_id']: r for r in read(gtfs, 'routes.txt')}
    trips = {t['trip_id']: t for t in read(gtfs, 'trips.txt')
             if t['service_id'] in running}

    # Minutes from the trip's first stop to this stop. A loop route can
    # call at the same stop twice, so keep every occurrence.
    first, here = {}, defaultdict(list)
    for st in read(gtfs, 'stop_times.txt'):
        tid = st['trip_id']
        if tid not in trips:
            continue
        if tid not in first:
            first[tid] = secs(st['departure_time'])
        if st['stop_id'] == stop_id:
            here[tid].append(secs(st['departure_time']) - first[tid])

    lo, hi = secs(frm + ':00'), secs(to + ':59')
    out = []
    for f in read(gtfs, 'frequencies.txt'):
        tid = f['trip_id']
        if tid not in here:
            continue
        start, end, step = secs(f['start_time']), secs(f['end_time']), int(f['headway_secs'])
        # A run leaves the first stop at start, start+step, ... before end.
        for leave in range(start, end, step):
            for offset in here[tid]:
                t = leave + offset
                if lo <= t <= hi:
                    r = routes[trips[tid]['route_id']]
                    out.append((t, r['route_short_name'], trips[tid]['trip_headsign']))

    name = next((s['stop_name'] for s in read(gtfs, 'stops.txt') if s['stop_id'] == stop_id), '?')
    print(f'{stop_id} {name} — {day} ({weekday}), {frm}-{to}: {len(out)} departures')
    for t, route, headsign in sorted(out):
        print(f'  {clock(t)}  {route:<10} {headsign}')

if __name__ == '__main__':
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
