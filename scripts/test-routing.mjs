/**
 * Tests for the routing layer.
 *
 * Runs against the real built network rather than fixtures, because the whole
 * point of these functions is to survive this particular feed. The core check
 * is a property test: the closed-form headway arithmetic must agree with a
 * brute-force enumeration of every run, on thousands of random queries.
 *
 *   npm run test-routing
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    arrivalAt, departuresBetween, departureAt, nextDeparture,
    nextDepartureAcrossMidnight, serviceSpan, servesOn
} from '../src/routing/timetable.js';
import Router from '../src/routing/router.js';
import {distanceFare, fareForLegs, formatFare} from '../src/routing/fares.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'),
    network = JSON.parse(readFileSync(join(ROOT, 'public/data/network.json'), 'utf8')),
    DAY = 86400;

// The Router expects the shape the browser's Network class exposes; rebuild
// just enough of it from the raw bundle so the search can be tested headless.
function nodeNetwork(raw) {
    return {
        trips: raw.trips,
        calendar: raw.calendar,
        walk: raw.walk,
        fares: raw.fares,
        routes: new Map(raw.routes.map(r => [r.id, r])),
        stops: new Map(raw.stops.map(s => [s.i, {
            id: s.i, name: s.n, lat: s.y, lon: s.x,
            station: !!s.s, accessible: !!s.a, parent: s.p
        }]))
    };
}

const net = nodeNetwork(network),
    router = new Router(net),
    stopByName = name => [...net.stops.values()].find(s =>
        s.name === name && !s.parent) ||
        [...net.stops.values()].find(s => s.name.startsWith(name) && !s.parent);

// Friday, matching the weekday services that carry most of the network.
const FRIDAY = 5;

function describe(itinerary) {
    return itinerary.legs.map(l => l.type === 'ride' ?
        `ride ${l.route} (${l.stops} stops)` :
        `walk ${Math.round(l.seconds / 60)}min`
    ).join(' → ');
}

let passed = 0,
    failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

// The ground truth: expand every run the way the fleet does and scan them.
function bruteNextDeparture(trip, stopIndex, time) {
    const offset = trip.departures[stopIndex];
    let best = null;

    for (const [start, end, headway] of trip.windows) {
        if (headway <= 0) {
            continue;
        }
        for (let runStart = start; runStart < end; runStart += headway) {
            const boardTime = runStart + offset;

            if (boardTime >= time && (!best || boardTime < best.boardTime)) {
                best = {runStart, boardTime};
            }
        }
    }
    return best;
}

// Deterministic PRNG so a failure is reproducible.
let seed = 20260905;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff,
    pick = a => a[Math.floor(rand() * a.length)];

// ---------------------------------------------------------------------------

section('Feed sanity');
check('network loaded', network.trips.length === 700, `${network.trips.length} trips`);
check('every trip has windows', network.trips.every(t => t.windows.length > 0));
check('arrivals and departures align with stops', network.trips.every(t =>
    t.arrivals.length === t.stops.length && t.departures.length === t.stops.length));
check('departures never precede arrivals at a stop', network.trips.every(t =>
    t.departures.every((d, i) => d >= t.arrivals[i])));

section('nextDeparture agrees with brute force (5,000 random queries)');
{
    let mismatches = 0,
        sampled = 0,
        nullAgreements = 0;

    for (let i = 0; i < 5000; i++) {
        const trip = pick(network.trips),
            stopIndex = Math.floor(rand() * trip.stops.length),
            time = Math.floor(rand() * DAY),
            actual = nextDeparture(trip, stopIndex, time),
            expected = bruteNextDeparture(trip, stopIndex, time);

        sampled++;
        if (!actual && !expected) {
            nullAgreements++;
            continue;
        }
        if (!actual || !expected ||
            actual.boardTime !== expected.boardTime ||
            actual.runStart !== expected.runStart) {
            mismatches++;
            if (mismatches <= 3) {
                console.log(`        ${trip.id} stop ${stopIndex} @${time}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
            }
        }
    }
    check('no mismatches', mismatches === 0, `${mismatches} of ${sampled}`);
    console.log(`        ${sampled} queries, ${nullAgreements} correctly reported no further service`);
}

section('Boundary behaviour');
{
    const trip = network.trips.find(t => t.windows.length === 1),
        [start, end, headway] = trip.windows[0],
        offset = trip.departures[0];

    check('a query exactly on a departure returns it with zero wait',
        (() => {
            const r = nextDeparture(trip, 0, start + offset);

            return r && r.boardTime === start + offset && r.wait === 0;
        })());

    check('one second later returns the following headway',
        (() => {
            const r = nextDeparture(trip, 0, start + offset + 1);

            return r && r.boardTime === start + headway + offset;
        })());

    check('a query before service returns the first departure',
        (() => {
            const r = nextDeparture(trip, 0, 0);

            return r && r.boardTime === start + offset;
        })());

    check('a query after the window closes returns nothing',
        nextDeparture(trip, 0, end + offset + 1) === null);

    check('the window is half-open — no run departs at or after end',
        (() => {
            const r = nextDeparture(trip, 0, end + offset - 1);

            return !r || r.runStart < end;
        })());
}

section('Multi-window trips');
{
    const multi = network.trips.filter(t => t.windows.length > 1);

    check('feed contains multi-window trips', multi.length > 0, `${multi.length} trips`);

    let ok = 0;

    for (const trip of multi) {
        let good = true;

        for (let t = 0; t < DAY; t += 900) {
            const a = nextDeparture(trip, 0, t),
                b = bruteNextDeparture(trip, 0, t);

            if ((!a) !== (!b) || (a && a.boardTime !== b.boardTime)) {
                good = false;
                break;
            }
        }
        if (good) {
            ok++;
        }
    }
    check('every multi-window trip matches brute force across the day',
        ok === multi.length, `${ok}/${multi.length}`);
}

section('Midnight rollover');
{
    const trip = network.trips.find(t => t.windows.length === 1),
        late = nextDepartureAcrossMidnight(trip, 0, DAY - 60);

    check('a late-night query rolls into tomorrow', !!late && late.nextDay === true);
    // A window opening at 00:00 with a zero stop offset puts tomorrow's first
    // departure exactly on the day boundary, so this is inclusive.
    check('tomorrow times are returned at or beyond 86400', !!late && late.boardTime >= DAY);
    check('the wait is positive and under a day',
        !!late && late.wait > 0 && late.wait < DAY, late ? `${late.wait}s` : '');
}

section('departuresBetween');
{
    let mismatches = 0;

    for (let i = 0; i < 400; i++) {
        const trip = pick(network.trips),
            stopIndex = Math.floor(rand() * trip.stops.length),
            from = Math.floor(rand() * (DAY - 7200)),
            to = from + 3600,
            list = departuresBetween(trip, stopIndex, from, to);

        // Every entry inside the range, strictly ordered, and matching the
        // first result from nextDeparture.
        const ordered = list.every((d, j) => j === 0 || d.boardTime >= list[j - 1].boardTime),
            inRange = list.every(d => d.boardTime >= from && d.boardTime <= to),
            first = nextDeparture(trip, stopIndex, from),
            headMatches = list.length === 0 ||
                (first && first.boardTime === list[0].boardTime);

        if (!ordered || !inRange || !headMatches) {
            mismatches++;
        }
    }
    check('ranges are ordered, bounded and consistent with nextDeparture',
        mismatches === 0, `${mismatches} of 400`);
}

section('serviceSpan (first and last bus)');
{
    let mismatches = 0;

    for (let i = 0; i < 400; i++) {
        const trip = pick(network.trips),
            stopIndex = Math.floor(rand() * trip.stops.length),
            span = serviceSpan(trip, stopIndex),
            first = bruteNextDeparture(trip, stopIndex, 0);

        // Brute-force the last departure too.
        let last = null;

        for (const [start, end, headway] of trip.windows) {
            if (headway <= 0) {
                continue;
            }
            for (let d = start; d < end; d += headway) {
                const boardTime = d + trip.departures[stopIndex];

                if (!last || boardTime > last) {
                    last = boardTime;
                }
            }
        }
        if (!span || !first || span.first !== first.boardTime || span.last !== last) {
            mismatches++;
            if (mismatches <= 2) {
                console.log(`        ${trip.id} stop ${stopIndex}: span ${JSON.stringify(span)} want first ${first?.boardTime} last ${last}`);
            }
        }
    }
    check('spans match brute force', mismatches === 0, `${mismatches} of 400`);
}

section('Service days');
{
    const counts = [0, 0, 0, 0, 0, 0, 0];

    for (let day = 0; day < 7; day++) {
        counts[day] = network.trips.filter(t => servesOn(t, network.calendar, day)).length;
    }
    console.log(`        trips by day (Sun..Sat): ${counts.join(', ')}`);
    check('every day has service', counts.every(c => c > 0));
    check('weekdays carry more service than Sunday', counts[1] > counts[0]);
    check('all 700 trips are reachable across the week',
        new Set(network.trips.filter(t =>
            [0, 1, 2, 3, 4, 5, 6].some(d => servesOn(t, network.calendar, d))
        )).size === 700);
}

section('Call times along a run');
{
    const trip = network.trips.find(t => t.stops.length > 10),
        run = nextDeparture(trip, 0, 6 * 3600);

    check('call times increase along the pattern',
        (() => {
            let previous = -Infinity;

            for (let i = 0; i < trip.stops.length; i++) {
                const a = arrivalAt(trip, run.runStart, i);

                if (a < previous) {
                    return false;
                }
                previous = a;
            }
            return true;
        })());
    check('a bus never departs a stop before it arrives',
        trip.stops.every((_, i) =>
            departureAt(trip, run.runStart, i) >= arrivalAt(trip, run.runStart, i)));
}

section('Router — direct journey');
{
    const from = stopByName('Blok M'),
        to = stopByName('Harmoni'),
        result = router.plan({from, to, time: 8 * 3600, dayOfWeek: FRIDAY});

    check('Blok M and Harmoni both resolve', !!from && !!to);
    check('a journey is found', result.itineraries.length > 0, result.error || '');

    const best = result.itineraries[0];

    if (best) {
        console.log(`        ${describe(best)} — ${Math.round(best.duration / 60)} min, ${best.transfers} transfers`);
        check('it is a single ride, no transfer', best.rides === 1 && best.transfers === 0);
        check('it uses corridor 1', best.legs[0].route === '1', best.legs[0].route);
        check('arrival is after departure', best.arrival > best.departure);
        check('the rider waits a sensible time to board',
            best.legs[0].wait >= 0 && best.legs[0].wait < 3600, `${best.legs[0]?.wait}s`);
    }
}

section('Router — journey requiring a transfer');
{
    const from = stopByName('Blok M'),
        to = stopByName('Pulo Gadung'),
        result = router.plan({from, to, time: 8 * 3600, dayOfWeek: FRIDAY});

    check('a journey is found', result.itineraries.length > 0, result.error || '');

    for (const itinerary of result.itineraries) {
        console.log(`        ${describe(itinerary)} — ${Math.round(itinerary.duration / 60)} min, ${itinerary.transfers} transfers`);
    }

    const best = result.itineraries[0];

    if (best) {
        check('no direct route exists, so it transfers', best.rides >= 2, `${best.rides} rides`);
        check('the first ride is corridor 1', best.legs[0].route === '1', best.legs[0].route);
        check('legs are contiguous — each starts where the last ended',
            best.legs.every((leg, i) => i === 0 || best.legs[i - 1].to === leg.from));
        check('ride times run forward through the journey',
            best.legs.filter(l => l.type === 'ride').every((l, i, a) =>
                i === 0 || l.departure >= a[i - 1].arrival));
        check('duration is plausible for the distance',
            best.duration > 20 * 60 && best.duration < 4 * 3600,
            `${Math.round(best.duration / 60)} min`);
    }
}

section('Router — Pareto set');
{
    const result = router.plan({
        from: stopByName('Blok M'),
        to: stopByName('Pulo Gadung'),
        time: 8 * 3600,
        dayOfWeek: FRIDAY
    });

    check('each extra ride actually buys a faster journey',
        result.itineraries.every((it, i, a) => i === 0 || it.arrival < a[i - 1].arrival));
    check('ride counts increase down the set',
        result.itineraries.every((it, i, a) => i === 0 || it.rides > a[i - 1].rides));
}

section('Router — error cases');
{
    const blokM = stopByName('Blok M');

    check('same origin and destination is reported',
        router.plan({from: blokM, to: blokM, time: 8 * 3600, dayOfWeek: FRIDAY}).error === 'same-stop');
    check('an unknown stop is reported',
        router.plan({from: 'not-a-stop', to: blokM, time: 8 * 3600, dayOfWeek: FRIDAY}).error === 'unknown-stop');
}

section('Router — performance');
{
    const nodes = network.walk.ids,
        queries = [];

    for (let i = 0; i < 60; i++) {
        queries.push([
            nodes[Math.floor(rand() * nodes.length)],
            nodes[Math.floor(rand() * nodes.length)]
        ]);
    }

    const started = Date.now();
    let solved = 0;

    for (const [from, to] of queries) {
        const r = router.plan({from, to, time: 8 * 3600, dayOfWeek: FRIDAY});

        if (r.itineraries.length) {
            solved++;
        }
    }

    const perQuery = (Date.now() - started) / queries.length;

    console.log(`        ${queries.length} random queries, ${solved} solved, ${perQuery.toFixed(0)} ms each`);
    check('a query stays under the 300 ms budget', perQuery < 300, `${perQuery.toFixed(0)} ms`);
    check('most random stop pairs are reachable',
        solved / queries.length > 0.8, `${solved}/${queries.length}`);
}

section('Fares — the 3-hour window');
{
    const routeWithPrice = price => net.routes.get(
        Object.keys(net.fares.byRoute).find(r => {
            const f = net.fares.attributes[net.fares.byRoute[r]];

            return f && f.price === price;
        })
    ).id;

    const free = routeWithPrice(0),
        standard = routeWithPrice(3500),
        premium = routeWithPrice(35000),
        ride = (route, departure) => ({type: 'ride', route, departure});

    check('a single free ride costs nothing',
        fareForLegs([ride(free, 0)], net).total === 0);
    check('a single standard ride costs its fare',
        fareForLegs([ride(standard, 0)], net).total === 3500);

    check('two standard rides inside the window cost one fare',
        fareForLegs([ride(standard, 0), ride(standard, 3600)], net).total === 3500);
    check('that counts as a single tap',
        fareForLegs([ride(standard, 0), ride(standard, 3600)], net).singleTap === true);

    check('a ride after the window expires is charged again',
        fareForLegs([ride(standard, 0), ride(standard, 10801)], net).total === 7000);
    check('exactly on the window boundary is still covered',
        fareForLegs([ride(standard, 0), ride(standard, 10800)], net).total === 3500);

    // The case a naive "charge the first boarding" rule gets wrong.
    check('free then paid still charges the paid leg',
        fareForLegs([ride(free, 0), ride(standard, 600)], net).total === 3500);
    check('paid then free charges only the paid leg',
        fareForLegs([ride(standard, 0), ride(free, 600)], net).total === 3500);
    check('a journey entirely on free routes costs nothing',
        fareForLegs([ride(free, 0), ride(free, 600), ride(free, 1200)], net).total === 0);

    check('upgrading to a premium service charges the difference',
        fareForLegs([ride(standard, 0), ride(premium, 600)], net).total === 35000);
    check('and not the sum of both',
        fareForLegs([ride(standard, 0), ride(premium, 600)], net).total !== 38500);

    check('formatting reads as a rider expects',
        formatFare(0) === 'Gratis' && formatFare(3500) === 'Rp 3.500');
}

section('Fares on real itineraries');
{
    const result = router.plan({
        from: stopByName('Blok M'),
        to: stopByName('Pulo Gadung'),
        time: 8 * 3600,
        dayOfWeek: FRIDAY
    });

    for (const it of result.itineraries) {
        console.log(`        ${it.rides} rides → ${formatFare(it.fare.total)}${it.fare.singleTap ? ' (one tap)' : ''}`);
    }
    check('every itinerary carries a fare', result.itineraries.every(i => i.fare));
    check('a multi-ride journey inside the window is not billed per leg',
        result.itineraries.every(i => i.fare.total <= 35000), 'no runaway totals');
}

section('Router — reachability');
{
    const from = stopByName('Dukuh Atas'),
        bands = [15, 30, 45, 60].map(minutes => ({
            minutes,
            count: router.reachable({
                from, time: 8 * 3600, dayOfWeek: FRIDAY, maxSeconds: minutes * 60
            }).length
        }));

    console.log(`        from Dukuh Atas at 08:00: ${
        bands.map(b => `${b.minutes}min → ${b.count} stops`).join(', ')
    }`);
    check('reach grows with the time budget',
        bands.every((b, i) => i === 0 || b.count >= bands[i - 1].count));
    check('an hour reaches a meaningful share of the network',
        bands[3].count > 500, `${bands[3].count} stops`);
    check('reachability never exceeds the network',
        bands[3].count <= network.walk.ids.length);
}

section('Access walking (JAKAR-23)');
{
    const ids = network.walk.ids,
        itineraries = [];
    let seed2 = 99;
    const rnd = () => (seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let i = 0; i < 200; i++) {
        const r = router.plan({
            from: ids[Math.floor(rnd() * ids.length)],
            to: ids[Math.floor(rnd() * ids.length)],
            time: 8 * 3600,
            dayOfWeek: FRIDAY
        });

        itineraries.push(...r.itineraries);
    }

    const startingOnFoot = itineraries.filter(i => i.legs[0]?.type === 'walk').length;

    console.log(`        ${itineraries.length} itineraries, ${startingOnFoot} now begin on foot`);
    check('journeys can now begin with a walk', startingOnFoot > 0);
    check('departure is still a number when the first leg is a walk',
        itineraries.every(i => Number.isFinite(i.departure)));
    check('no itinerary has two walks in a row',
        itineraries.every(i => i.legs.every((l, j) =>
            j === 0 || !(l.type === 'walk' && i.legs[j - 1].type === 'walk'))));
    check('no itinerary reboards the same vehicle it just left',
        itineraries.every(i => i.legs.every((l, j) =>
            j === 0 || l.type !== 'ride' || i.legs[j - 1].type !== 'ride' ||
            i.legs[j - 1].trip !== l.trip || i.legs[j - 1].runStart !== l.runStart)));
    check('legs remain contiguous after collapsing',
        itineraries.every(i => i.legs.every((l, j) =>
            j === 0 || i.legs[j - 1].to === l.from)));
    check('the wait before the first ride is never negative',
        itineraries.every(i => {
            const ride = i.legs.find(l => l.type === 'ride');

            return !ride || ride.wait >= 0;
        }));
}

section('Planning from a map point (JAKAR-12)');
{
    // Somewhere in Menteng, deliberately not on top of a stop.
    const point = {lon: 106.8320, lat: -6.1960},
        near = router.nearestNodes(point.lon, point.lat);

    console.log(`        ${near.length} stops within walking distance: ${
        near.slice(0, 3).map(n => `${n.stop.name} (${n.metres} m)`).join(', ')
    }`);
    check('a point finds stops around it', near.length > 0);
    check('they are ordered by distance',
        near.every((n, i) => i === 0 || n.metres >= near[i - 1].metres));
    check('none exceeds the access radius', near.every(n => n.metres <= 800));

    const result = router.plan({
        from: point,
        to: stopByName('Kampung Melayu'),
        time: 8 * 3600,
        dayOfWeek: FRIDAY
    });

    check('a journey can start from a point', result.itineraries.length > 0, result.error || '');

    const best = result.itineraries[0];

    if (best) {
        console.log(`        ${describe(best)} — ${Math.round(best.duration / 60)} min`);
        check('it begins on foot', best.legs[0].type === 'walk');
        check('the first leg records where you started',
            Array.isArray(best.legs[0].fromPoint));
        check('and where it put you', !!net.stops.get(best.legs[0].to));
        check('the rest of the journey is contiguous',
            best.legs.every((l, i) => i === 0 || best.legs[i - 1].to === l.from));
        check('duration is plausible', best.duration > 60 && best.duration < 4 * 3600);
    }

    check('a point in the sea reports nothing nearby',
        router.plan({
            from: {lon: 106.60, lat: -5.95},
            to: stopByName('Kampung Melayu'),
            time: 8 * 3600, dayOfWeek: FRIDAY
        }).error === 'nothing-nearby');
}

section('Reachability — free routes only');
{
    const query = (from, freeOnly) => router.reachable({
        from, time: 8 * 3600, dayOfWeek: FRIDAY, maxSeconds: 45 * 60, freeOnly
    });

    check('free patterns cover exactly the 101 free routes',
        new Set(router.patterns.filter(p => p.free).map(p => p.trip.route)).size === 101);

    // A BRT interchange served only by paid corridors: the filter should bite
    // hard, because there is nothing free to board.
    const paidOrigin = stopByName('Dukuh Atas'),
        paidAll = query(paidOrigin, false),
        paidFree = query(paidOrigin, true);

    console.log(`        from Dukuh Atas (paid corridors only): ${paidAll.length} stops, ${paidFree.length} free`);
    // No free route serves Dukuh Atas, but since the search may now walk before
    // boarding, a handful of free stops come within reach on foot. The point
    // stands: the free network barely touches the BRT interchanges.
    check('an origin with no free service reaches almost nothing for free',
        paidFree.length < paidAll.length * 0.05,
        `${paidFree.length} of ${paidAll.length}`);

    // An origin a Mikrotrans route actually serves, which is the case the
    // feature exists for.
    const mikro = net.trips.find(t => net.routes.get(t.route).category === 'Mikrotrans'),
        freeOrigin = net.stops.get(mikro.stops[0]),
        all = query(freeOrigin, false),
        free = query(freeOrigin, true);

    console.log(`        from ${freeOrigin.name} (on ${mikro.route}): ${all.length} stops, ${free.length} free`);
    check('a free-served origin still reaches most of its range for nothing',
        free.length > all.length * 0.5, `${free.length}/${all.length}`);
    check('the free network is a subset of the whole',
        (() => {
            const reachable = new Set(all.map(r => r.stop.id));

            return free.every(r => reachable.has(r.stop.id));
        })());
    check('nothing exceeds the time budget',
        all.every(r => r.seconds <= 45 * 60) && free.every(r => r.seconds <= 45 * 60));
}

// ---------------------------------------------------------------------------

section('Rail fares price by distance, and a journey is capped');
{
    // Published tariffs: KRL Rp 3.000 for 25 km then +Rp 1.000/10 km;
    // MRT Rp 3.000 rising to a Rp 14.000 ceiling; LRT Jabodebek Rp 5.000 for
    // the first km then Rp 700 each.
    check('KRL inside the base distance is the base fare', distanceFare('commuter_rail', 20) === 3000);
    check('KRL at exactly the base boundary does not step up', distanceFare('commuter_rail', 25) === 3000);
    check('KRL beyond the base steps once per 10 km',
        distanceFare('commuter_rail', 26) === 4000 && distanceFare('commuter_rail', 35) === 4000,
        `${distanceFare('commuter_rail', 26)} / ${distanceFare('commuter_rail', 35)}`);
    check('a 43 km Bogor run costs more than the base', distanceFare('commuter_rail', 43) === 5000,
        String(distanceFare('commuter_rail', 43)));
    check('MRT is capped', distanceFare('metro', 500) === 14000);
    check('LRT charges per kilometre after the first', distanceFare('light_rail', 2) === 5700);
    check('an unknown mode has no distance tariff', distanceFare('bus', 10) === null);

    // A network stub shaped like the browser's: routes by id, fares by route.
    const stub = {
        routes: new Map([
            ['bus-1', {id: 'bus-1', mode: 'bus'}],
            ['mrt-1', {id: 'mrt-1', mode: 'metro'}]
        ]),
        fares: {
            byRoute: {'bus-1': 'flat', 'mrt-1': 'mrt-distance'},
            attributes: {
                flat: {price: 3500, currency: 'IDR', transfers: null, transferDuration: 10800},
                'mrt-distance': {
                    price: 3000, currency: 'IDR', transfers: null, transferDuration: 10800,
                    distanceBased: true, integratedCap: 10000
                }
            }
        }
    };

    const cheap = fareForLegs([
        {type: 'ride', route: 'bus-1', departure: 0},
        {type: 'ride', route: 'mrt-1', departure: 600, km: 4}
    ], stub);

    check('a bus + MRT journey inside the window is one integrated fare',
        cheap.total <= 10000, String(cheap.total));

    // Two expensive legs that would otherwise exceed the cap.
    const dear = fareForLegs([
        {type: 'ride', route: 'mrt-1', departure: 0, km: 500},
        {type: 'ride', route: 'bus-1', departure: 600}
    ], stub);

    check('the JakLingko cap applies to a multi-modal journey', dear.total === 10000, String(dear.total));
    check('the uncapped total is still reported', dear.uncapped > dear.total,
        `${dear.uncapped} vs ${dear.total}`);
    check('the cap is named when it bites', dear.cap === 10000);

    // One mode only: priced on its own terms, no cap.
    const single = fareForLegs([
        {type: 'ride', route: 'mrt-1', departure: 0, km: 500},
        {type: 'ride', route: 'mrt-1', departure: 600, km: 500}
    ], stub);

    check('a single-mode journey is not capped', single.cap === null, String(single.cap));

    // Legs far apart in time are two journeys, not one capped journey.
    const apart = fareForLegs([
        {type: 'ride', route: 'mrt-1', departure: 0, km: 500},
        {type: 'ride', route: 'bus-1', departure: 40000}
    ], stub);

    check('a journey outside the 3-hour window is not capped', apart.cap === null);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
