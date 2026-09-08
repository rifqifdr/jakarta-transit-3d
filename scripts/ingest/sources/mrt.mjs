/**
 * MRT Jakarta — the Strapi backend behind jakartamrt.co.id.
 *
 * There is no GTFS for MRT anywhere, but the website is a React app and its
 * timetable arrives as data rather than rendered HTML. Each station is one
 * `datum` record whose `object.schedule` holds semicolon-separated departure
 * lists per direction and day type.
 *
 * Two things to know. The host is named `beweb-dev` and yet serves
 * production, so expect it to move one day. And the middleware answers 500 to
 * any content type it does not recognise, which means endpoints have to be
 * discovered from the app rather than guessed.
 */
const BASE = 'https://beweb-dev.jakartamrt.co.id/middleware/api/datum',
    HEADERS = {Referer: 'https://www.jakartamrt.co.id/'},

    FIELDS = 'fields[]=id&fields[]=slug&fields[]=name',
    STATION_FILTER = 'filters[field][slug]=stasiun';

export default {
    id: 'mrt',
    label: 'MRT Jakarta — Strapi (jakartamrt.co.id)',
    interval: 200,

    async fetch(snap, log) {
        if (!snap.has('stations.json')) {
            await snap.write('stations.json', await snap.get(
                `${BASE}?${FIELDS}&${STATION_FILTER}&locale=id&pagination[pageSize]=100`,
                {headers: HEADERS}
            ));
        }

        const listed = (await snap.readJson('stations.json')).data || [];

        log(`stations: ${listed.length}`);

        let failures = 0;

        for (const station of listed) {
            const name = `stations/${station.slug}.json`;

            try {
                await snap.getInto(name, `${BASE}?${FIELDS}&fields[]=object&${STATION_FILTER}` +
                    `&filters[slug]=${encodeURIComponent(station.slug)}&pagination[limit]=1&sort[]=id:desc`,
                    {headers: HEADERS});
            } catch (error) {
                failures++;
                log(`  ! ${station.slug}: ${error.message.slice(0, 80)}`);
            }
        }

        return {
            counts: {stations: listed.length, failures},
            sources: [BASE],
            notes: [
                'Served from a host named beweb-dev despite being production — pin the hostname and expect it to move.',
                'Departure lists are semicolon-separated in object.schedule: weekdaysEnd, weekendsEnd, weekdaysStart, weekendsStart.',
                'Termini carry one direction only (Lebak Bulus has no Start, Bundaran HI no End) — correct, not missing data.',
                'Station boards give no trip identity, and MRT runs short workings from Blok M: reconstruct trips against geographic station order, never sorted time.'
            ]
        };
    }
};
