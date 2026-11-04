import csv, hashlib, json, os, sys
# Usage: python3 metadata.py <export_dir> <source_zip> <last_modified_utc> <fetched_at_utc>
D, src_zip, last_modified, fetched_at = sys.argv[1:5]
G = os.path.join(D, 'gtfs')
def read(n):
    with open(os.path.join(G, n), encoding='utf-8', newline='') as f: return list(csv.DictReader(f))
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
def secs(t): h, m, s = map(int, t.split(':')); return h*3600+m*60+s
files = {n: {'rows': len(read(n)), 'sha256': sha(os.path.join(G, n))} for n in sorted(os.listdir(G)) if n.endswith('.txt')}
cal = {c['service_id']: c for c in read('calendar.txt')}
trips = {t['trip_id']: t for t in read('trips.txt')}
freq = read('frequencies.txt')
def runs(day):
    return sum(len(range(secs(f['start_time']), secs(f['end_time']), int(f['headway_secs'])))
               for f in freq if cal[trips[f['trip_id']]['service_id']][day] == '1')
stops = read('stops.txt')
lat = [float(s['stop_lat']) for s in stops]; lon = [float(s['stop_lon']) for s in stops]
meta = {
  'name': 'Mikrotrans GTFS',
  'description': 'The Mikrotrans routes of the Transjakarta GTFS Schedule feed, cut out as a standalone, internally consistent GTFS feed.',
  'spec': 'GTFS Schedule (https://gtfs.org/schedule/reference/)',
  'filter': {'table': 'routes.txt', 'column': 'route_desc', 'equals': 'Mikrotrans',
             'rule': 'Rows are copied verbatim. Only rows are removed; no value is changed.'},
  'source': {
    'publisher': 'PT Transportasi Jakarta (Transjakarta)',
    'url': 'https://gtfs.transjakarta.co.id/files/file_gtfs.zip',
    'lastModified': last_modified,
    'fetchedAt': fetched_at,
    'bytes': os.path.getsize(src_zip),
    'sha256': sha(src_zip),
  },
  'license': {
    'stated': None,
    'note': 'Transjakarta publishes no licence for this feed. Credit Transjakarta as the source. Ask Transjakarta before redistributing or using it commercially.'
  },
  'timezone': 'Asia/Jakarta',
  'serviceCalendar': {'start': '2004-01-15', 'end': '2027-12-31'},
  'boundingBox': {'west': min(lon), 'south': min(lat), 'east': max(lon), 'north': max(lat)},
  'counts': {
    'routes': files['routes.txt']['rows'],
    'tripPatterns': files['trips.txt']['rows'],
    'stops': files['stops.txt']['rows'],
    'shapes': len({t['shape_id'] for t in trips.values()}),
    'runsPerDay': {'monday': runs('monday'), 'saturday': runs('saturday'), 'sunday': runs('sunday')},
  },
  'fare': {'fare_id': 'GR', 'price': 0, 'currency': 'IDR', 'note': 'Every Mikrotrans route is free in this feed.'},
  'files': files,
  'zip': {'file': 'mikrotrans-gtfs.zip', 'sha256': sha(os.path.join(D, 'mikrotrans-gtfs.zip')),
          'note': 'The same files as gtfs/, at the root of the zip, as GTFS tools expect.'},
  'omitted': {'transfers.txt': 'None of its 14 rows involve a Mikrotrans stop.'},
  'checks': {'referentialIntegrity': 'passed: every stop, parent station, shape and service a row refers to is in the cut',
             'officialValidator': 'not run'},
}
json.dump(meta, open(os.path.join(D, 'metadata.json'), 'w'), indent=2, ensure_ascii=False)
print(json.dumps(meta['counts'], indent=1))
