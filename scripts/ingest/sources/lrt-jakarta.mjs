/**
 * LRT Jakarta (Kelapa Gading — Velodrome), the six-station line.
 *
 * The smallest network here and, until now, the one unresolved source: the
 * page shows nothing until a form is submitted, so there was no way to tell
 * whether the timetable was reachable at all. It is. The form posts back to
 * itself with `stasiun_awal` / `stasiun_akhir` and no CSRF token, and the
 * response carries the departure list.
 *
 * What the response actually contains: departures from the *origin* in the
 * direction of the destination. Asking for 6→1 and 6→2 returns the same list,
 * because both are southbound from Kelapa Gading. So the whole timetable is
 * covered by each station against each terminus — ten requests, not the
 * thirty that every ordered pair would cost.
 *
 * Station ids run 6 (Kelapa Gading) down to 1 (Velodrome), which is also
 * their geographic order along the line.
 */
const URL = 'https://lrtjakarta.co.id/jadwal.html',

    // id -> name, in line order north to south. Taken from the form's own
    // <option> values so it stays honest to the source.
    STATIONS = [
        [6, 'Stasiun Kelapa Gading'],
        [5, 'Stasiun Boulevard Utara Summarecon Mall'],
        [4, 'Stasiun Boulevard Selatan'],
        [3, 'Stasiun Pulomas'],
        [2, 'Stasiun Equestrian'],
        [1, 'Stasiun Velodrome']
    ],

    // The two ends of the line. Any destination beyond the origin gives the
    // same list, so a terminus stands in for the whole direction.
    TERMINI = [6, 1];

export default {
    id: 'lrt-jakarta',
    label: 'LRT Jakarta — schedule form (lrtjakarta.co.id)',
    interval: 800,

    async fetch(snap, log) {
        await snap.writeJson('stations.json', STATIONS.map(([id, name]) => ({id, name})));

        let fetched = 0,
            failures = 0;

        for (const [origin] of STATIONS) {
            for (const terminus of TERMINI) {
                if (origin === terminus) {
                    continue;
                }

                const name = `schedules/${origin}-to-${terminus}.html`;

                try {
                    if (!snap.has(name)) {
                        await snap.write(name, await snap.get(URL, {
                            method: 'POST',
                            body: `stasiun_awal=${origin}&stasiun_akhir=${terminus}&search_jadwal=`,
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                                Referer: URL
                            }
                        }));
                    }

                    const html = await snap.read(name),
                        times = (html.match(/\b[0-2][0-9]:[0-5][0-9]\b/g) || []).length;

                    // A 200 with no times means the form silently rejected the
                    // post — the failure this source is most likely to have,
                    // since there is no API contract to break loudly.
                    if (!times) {
                        throw new Error('response contains no departure times');
                    }
                    fetched++;
                    log(`  ${origin} → ${terminus}: ${times} times`);
                } catch (error) {
                    failures++;
                    log(`  ! ${origin} → ${terminus}: ${error.message.slice(0, 110)}`);
                }
            }
        }

        return {
            counts: {stations: STATIONS.length, pairs: fetched, failures},
            sources: [URL],
            notes: [
                'Form POST: stasiun_awal / stasiun_akhir / search_jadwal, no CSRF token.',
                'The response lists departures from the origin in the direction of the destination — 6→1 and 6→2 are identical, so each station against each terminus covers the line.',
                'Observed a flat 10-minute headway: 102 departures, 05:30–22:20 from Kelapa Gading.',
                'No trip identity. Reconstruct by chaining, which is safe here because the line is linear with no branches or short workings.',
                'OSM has only 4 of the 6 stations for this line — a known upstream gap to fix by hand or upstream.'
            ]
        };
    }
};
