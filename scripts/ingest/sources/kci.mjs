/**
 * KAI Commuter (KRL) — the official kci.id JSON API.
 *
 * No auth, no key. Three endpoints, and the third is the reason this is the
 * best-served mode we have: `train-schedule` returns the whole ordered stop
 * sequence for one train, which is a GTFS stop_times table in all but name.
 * Every other rail source gives station departure boards only, leaving trips
 * to be inferred.
 *
 * The harvest is ~1,200 requests and takes around half an hour, so it is
 * written one file per train and resumes rather than restarting.
 *
 * Nothing is filtered here. KAI Commuter also runs Yogyakarta, Solo, Merak,
 * Walahar and Jatiluhur services; dropping them is a transform decision, and
 * a snapshot that has already made decisions is not a snapshot.
 */
const BASE = 'https://kci.id/api/krl',

    // The site sends this on its own requests. Included to look like the
    // browser traffic this endpoint expects rather than to evade anything.
    HEADERS = {Referer: 'https://kci.id/perjalanan-krl/jadwal-kereta'},

    // Whole-day window; the endpoint requires both bounds.
    DAY = 'timefrom=00:00&timeto=23:59';

export default {
    id: 'kci',
    label: 'KAI Commuter (KRL) — kci.id',
    // 150 ms is fine for a hundred requests and reliably earns 429s across a
    // thousand — measured. The harvest is ~1,200 requests, so it starts here
    // and the shared client slows itself further if the source pushes back.
    interval: 600,

    async fetch(snap, log) {
        // ---- stations -----------------------------------------------------
        if (!snap.has('stations.json')) {
            await snap.write('stations.json', await snap.get(`${BASE}/stations`, {headers: HEADERS}));
        }

        const stations = (await snap.readJson('stations.json')).data || [],
            // fg_enable marks a station the timetable actually serves; the
            // list also carries a header row ("AREA JABODETABEK") that is not
            // a station at all.
            active = stations.filter(s => s.fg_enable === 1);

        log(`stations: ${stations.length} listed, ${active.length} active`);

        // ---- per-station departure boards ---------------------------------
        const trains = new Map();
        let boardFailures = 0;

        for (let i = 0; i < active.length; i++) {
            const station = active[i],
                name = `schedules/${station.sta_id}.json`;

            try {
                await snap.getInto(name, `${BASE}/schedules?stationid=${encodeURIComponent(station.sta_id)}&${DAY}`, {headers: HEADERS});
            } catch (error) {
                // One station in 110 has been seen returning a non-JSON body.
                // A single missing board costs us nothing — every train calls
                // at more than one station — so record it and continue.
                boardFailures++;
                log(`  ! ${station.sta_id}: ${error.message.slice(0, 110)}`);
                continue;
            }

            let rows;

            try {
                rows = (await snap.readJson(name)).data;
            } catch {
                boardFailures++;
                continue;
            }

            if (Array.isArray(rows)) {
                for (const row of rows) {
                    if (row.train_id && !trains.has(row.train_id)) {
                        trains.set(row.train_id, row.ka_name || '');
                    }
                }
            }
            if ((i + 1) % 25 === 0) {
                log(`  boards ${i + 1}/${active.length}, ${trains.size} trains seen`);
            }
        }

        // ---- full stop sequence per train ---------------------------------
        const ids = [...trains.keys()].sort();

        log(`trains: ${ids.length} distinct, fetching stop sequences`);

        let tripFailures = 0;

        for (let i = 0; i < ids.length; i++) {
            const name = `trains/${encodeURIComponent(ids[i])}.json`;

            try {
                await snap.getInto(name, `${BASE}/train-schedule?trainid=${encodeURIComponent(ids[i])}`, {headers: HEADERS});
            } catch (error) {
                tripFailures++;
                log(`  ! train ${ids[i]}: ${error.message.slice(0, 110)}`);
            }
            if ((i + 1) % 100 === 0) {
                log(`  trains ${i + 1}/${ids.length}`);
            }
        }

        return {
            counts: {
                stationsListed: stations.length,
                stationsActive: active.length,
                boardsFetched: active.length - boardFailures,
                boardFailures,
                trains: ids.length,
                tripFailures
            },
            sources: [`${BASE}/stations`, `${BASE}/schedules`, `${BASE}/train-schedule`],
            notes: [
                'Includes non-Jabodetabek KAI Commuter services (Yogyakarta, Solo, Merak, Walahar, Jatiluhur) — filter at transform time.',
                'train-schedule times are clock times and wrap past midnight; a 23:10 departure arriving 00:37 is the next day.'
            ]
        };
    }
};
