/**
 * LRT Jabodebek — the departure board page on lrtjabodebek.kai.id.
 *
 * No API to find here: the whole timetable is server-rendered into a single
 * 3.8 MB page as 36 tables, one per station per day type. That makes the
 * snapshot trivially simple — one document — and the parsing a transform
 * problem rather than an ingest one.
 *
 * The hard part comes later. There are no train identifiers and no direction
 * labels, so trips have to be reconstructed by chaining departures along the
 * line, and at Cawang the line splits towards Harjamukti and Jati Mulya.
 */
const URL = 'https://lrtjabodebek.kai.id/jadwal-keberangkatan';

export default {
    id: 'lrt-jabodebek',
    label: 'LRT Jabodebek — departure boards (lrtjabodebek.kai.id)',
    interval: 500,

    async fetch(snap, log) {
        if (!snap.has('jadwal-keberangkatan.html')) {
            await snap.write('jadwal-keberangkatan.html', await snap.get(URL, {timeout: 120000}));
        }

        const html = await snap.read('jadwal-keberangkatan.html'),
            tables = (html.match(/table-jadwal-tarif/g) || []).length,
            times = (html.match(/\b[0-2][0-9]:[0-5][0-9]\b/g) || []).length;

        log(`page: ${(html.length / 1048576).toFixed(2)} MB, ${tables} tables, ${times} departure times`);

        // A page that still returns 200 but has lost its tables is exactly the
        // silent failure the validation gate is meant to catch, so record the
        // shape here where it is cheap.
        if (!tables || !times) {
            throw new Error('page fetched but contains no timetable — layout may have changed');
        }

        return {
            counts: {tables, times, bytes: html.length},
            sources: [URL],
            notes: [
                '36 tables = 18 stations x 2 day types (Hari Biasa, Hari Libur).',
                'Trunk stations list both directions (~430 weekday departures); termini list one (~214).',
                'No train ids and no direction labels — trips must be inferred by chaining, with a branch decision at Cawang.'
            ]
        };
    }
};
