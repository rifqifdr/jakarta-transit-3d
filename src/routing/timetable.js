/**
 * Timetable queries over the frequency-based feed.
 *
 * Transjakarta publishes headways, not departures. `frequencies.txt` says a
 * pattern runs every N seconds between two times, so there is no departure row
 * to look up — the departure has to be computed. Every question the router asks
 * of the schedule goes through here.
 *
 * All times are seconds since local midnight. A trip's `arrivals` and
 * `departures` are offsets from the start of its own run, so a run that departs
 * at time D calls at stop i at D + departures[i].
 *
 * Deliberately free of browser and app dependencies so it can be exercised in
 * Node without a map.
 */

const DAY = 86400;

/** Whether a trip's service runs on the given day (0 = Sunday, GTFS order). */
export function servesOn(trip, calendar, dayOfWeek) {
    const service = calendar[trip.service];

    return !!(service && service.days[dayOfWeek]);
}

/**
 * The first departure of a trip at or after `time`, as seen from one stop.
 *
 * Returns `{runStart, boardTime, wait}` — the time the vehicle began its run,
 * the time it departs this stop, and how long the rider waits — or null if the
 * pattern has no more departures that day.
 *
 * `boardTime` uses the stop's departure offset by default: a rider has to be
 * aboard when the bus leaves, and the feed records a real dwell between arrival
 * and departure. Pass basis 'arrival' for a departure board, where "arrives in
 * 3 minutes" is the useful phrasing.
 */
export function nextDeparture(trip, stopIndex, time, {basis = 'departure'} = {}) {
    const offset = basis === 'arrival' ?
        trip.arrivals[stopIndex] :
        trip.departures[stopIndex];
    let best = null;

    for (const [start, end, headway] of trip.windows) {
        if (headway <= 0) {
            continue;
        }

        // A run departing at D calls here at D + offset, so the earliest
        // acceptable run start is time - offset. Round up to the next multiple
        // of the headway inside the window.
        const earliest = time - offset,
            k = Math.max(0, Math.ceil((earliest - start) / headway)),
            runStart = start + k * headway;

        // Windows are half-open: the fleet expansion departs while t < end.
        if (runStart >= end) {
            continue;
        }

        const boardTime = runStart + offset;

        if (!best || boardTime < best.boardTime) {
            best = {runStart, boardTime, wait: boardTime - time};
        }
    }
    return best;
}

/**
 * As `nextDeparture`, but rolls over into tomorrow when today is exhausted.
 *
 * Service runs until 23:59, so a query late at night would otherwise report no
 * service rather than the first bus of the morning. Times past midnight are
 * returned beyond 86400 so they stay comparable with the query.
 */
export function nextDepartureAcrossMidnight(trip, stopIndex, time) {
    const today = nextDeparture(trip, stopIndex, time);

    if (today) {
        return today;
    }

    const tomorrow = nextDeparture(trip, stopIndex, 0);

    if (!tomorrow) {
        return null;
    }
    return {
        runStart: tomorrow.runStart + DAY,
        boardTime: tomorrow.boardTime + DAY,
        wait: tomorrow.boardTime + DAY - time,
        nextDay: true
    };
}

/** Every departure from a stop within a time range, earliest first. */
export function departuresBetween(trip, stopIndex, from, to, limit = 50) {
    const offset = trip.departures[stopIndex],
        results = [];

    for (const [start, end, headway] of trip.windows) {
        if (headway <= 0) {
            continue;
        }

        const earliest = Math.max(start, from - offset);
        let k = Math.max(0, Math.ceil((earliest - start) / headway));

        for (;;) {
            const runStart = start + k * headway;

            if (runStart >= end) {
                break;
            }

            const boardTime = runStart + offset;

            if (boardTime > to) {
                break;
            }
            if (boardTime >= from) {
                results.push({runStart, boardTime});
                if (results.length >= limit * trip.windows.length) {
                    break;
                }
            }
            k++;
        }
    }
    results.sort((a, b) => a.boardTime - b.boardTime);
    return results.slice(0, limit);
}

/** When a run that began at `runStart` reaches a later stop. */
export function arrivalAt(trip, runStart, stopIndex) {
    return runStart + trip.arrivals[stopIndex];
}

/** When a run that began at `runStart` leaves a stop. */
export function departureAt(trip, runStart, stopIndex) {
    return runStart + trip.departures[stopIndex];
}

/** The first and last time a trip departs a given stop on a service day. */
export function serviceSpan(trip, stopIndex) {
    const offset = trip.departures[stopIndex];
    let first = Infinity,
        last = -Infinity;

    for (const [start, end, headway] of trip.windows) {
        if (headway <= 0 || end <= start) {
            continue;
        }

        // The last run departs strictly before the window ends.
        const runs = Math.ceil((end - start) / headway) - 1;

        first = Math.min(first, start + offset);
        last = Math.max(last, start + runs * headway + offset);
    }
    return first === Infinity ? null : {first, last};
}

export {DAY};
