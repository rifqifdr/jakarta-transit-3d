/**
 * Rebuilding trips from station departure boards.
 *
 * KRL states which train a departure belongs to. MRT and both LRTs do not —
 * they publish a list of times per station per direction and leave the rest to
 * you. Turning that back into vehicles is the whole difficulty of JAKAR-29,
 * and it is the only place in the pipeline where the output is inferred rather
 * than read.
 *
 * The method:
 *
 *   1. Estimate the run time between each adjacent pair of stations, as the
 *      *median* gap between a departure and the next departure downstream. The
 *      median matters: trains inserted mid-line skew the mean, and the run
 *      time has to describe the ordinary case.
 *
 *   2. Walk the line from the first station, and for each departure not yet
 *      claimed, follow it downstream — predicting the next call and snapping to
 *      a real departure within tolerance. A departure claimed by one trip
 *      cannot be claimed by another.
 *
 *   3. Whatever is left unclaimed at station i is a train that *started* at
 *      station i. That is not an error; it is how a short working looks from
 *      the outside, and MRT genuinely runs one from Blok M at 05:00.
 *
 * Failing to find a match downstream ends the trip there, which is how a train
 * terminating early looks. Both behaviours fall out of the same loop rather
 * than needing to be special-cased.
 */

// How far a predicted call may sit from a real departure and still be believed
// to be the same train. Dwell varies, published times are rounded, and the run
// time is a median — but two minutes is far below the tightest headway here
// (MRT peaks at five), so a wrong match cannot hide inside it.
const DEFAULT_TOLERANCE_S = 120,

    // A "trip" of one stop is a departure nothing connects to. Usually the very
    // last service of the day at a terminus, and not a vehicle worth drawing.
    MIN_STOPS = 2;

function median(values) {
    if (!values.length) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Run time between each adjacent pair, inferred from the boards themselves.
 *
 * Taking the gap to the *next* departure downstream is the obvious method and
 * it is wrong on a merged board. Where a station publishes both directions,
 * the nearest following departure is frequently an opposite-direction train
 * that has nothing to do with the one being followed, and the estimate comes
 * out short. LRT Jabodebek's weekday Cibubur inbound collapsed from 109 trips
 * to 38 that way, while the sparser weekend service reconciled perfectly —
 * which is exactly the shape of a density-dependent bias.
 *
 * So instead of one candidate per departure, every downstream departure inside
 * a plausible window is a candidate, and the run time is the value that recurs
 * most. A real leg produces the same offset once per train; spurious pairings
 * scatter. The mode finds the signal where the median cannot.
 */
const BUCKET_S = 10,
    MIN_LEG_S = 30,

    // Adjacent stations on these networks are two to six minutes apart. Ten
    // minutes is generous; beyond it a "gap" is a different train.
    MAX_LEG_S = 600,

    // Only the first few downstream departures are candidates.
    //
    // Without this the histogram is biased towards *large* offsets: under a
    // regular headway the gaps cluster at runTime + k×headway, and more pairs
    // fit inside the window at higher k, so the mode drifts upward. It put
    // Ciliwung nineteen minutes from Cikoko, two adjacent stations about a
    // kilometre apart.
    MAX_CANDIDATES = 3;

export function estimateRunTimes(boards) {
    const runTimes = [];

    for (let i = 0; i < boards.length - 1; i++) {
        const from = boards[i],
            to = boards[i + 1],
            histogram = new Map();

        for (const departure of from) {
            let taken = 0;

            for (const arrival of to) {
                const gap = arrival - departure;

                if (gap < MIN_LEG_S) {
                    continue;
                }
                if (gap > MAX_LEG_S || taken >= MAX_CANDIDATES) {
                    break;
                }
                taken++;

                const bucket = Math.round(gap / BUCKET_S);

                if (!histogram.has(bucket)) {
                    histogram.set(bucket, []);
                }
                histogram.get(bucket).push(gap);
            }
        }

        let best = null,
            bestCount = 0;

        for (const [, gaps] of [...histogram.entries()].sort((a, b) => a[0] - b[0])) {
            if (gaps.length > bestCount) {
                bestCount = gaps.length;
                best = gaps;
            }
        }
        runTimes.push(best ? median(best) : 0);
    }
    return runTimes;
}

/**
 * A claim ledger shared between reconstruction passes.
 *
 * A station on a shared trunk appears in several lines at once — LRT
 * Jabodebek's Cawang is on both the Bekasi and Cibubur branches, in both
 * directions — and its board is the four streams merged. Passing one ledger
 * through every pass is what stops two lines claiming the same train, and what
 * makes "whatever is left" mean something after the unambiguous streams have
 * taken their share.
 */
export function createClaims() {
    return new Map();
}

function isClaimed(claims, key, index) {
    return claims.get(key)?.has(index) ?? false;
}

function claim(claims, key, index) {
    if (!claims.has(key)) {
        claims.set(key, new Set());
    }
    claims.get(key).add(index);
}

/**
 * @param boards     departures per station, in geographic order, seconds, ascending
 * @param keys       stable station identifiers, parallel to boards, for the ledger
 * @param claims     shared ledger from createClaims(); one is made if omitted
 * @param tolerance  how far a prediction may miss and still match
 * @returns {trips, runTimes, stats}
 */
export function reconstructTrips(boards, {
    tolerance = DEFAULT_TOLERANCE_S,
    minStops = MIN_STOPS,
    terminusRunTime = null,
    keys = null,
    claims = null,
    anchor = 0,
    startAt = null
} = {}) {
    const ledger = claims ?? createClaims(),
        stationKeys = keys ?? boards.map((_, i) => `#${i}`),

        // Run times are measured only from departures nobody has claimed yet,
        // so a pass over a shared trunk is not skewed by the streams that have
        // already been lifted out of it.
        runTimes = estimateRunTimes(boards.map((board, i) =>
            board.filter((_, index) => !isClaimed(ledger, stationKeys[i], index)))),
        trips = [],
        stats = {
            originatingAt: new Array(boards.length).fill(0),
            terminatedEarly: 0,
            orphans: 0,
            terminusArrivalsAdded: 0
        };

    // Where a chain may begin.
    //
    // Left open, every unclaimed departure starts a trip — which is right when
    // a board holds one direction, because what is left over really is a train
    // that started there. It is badly wrong when a board merges directions and
    // branches, as LRT Jabodebek's trunk does: 430 departures then spawn
    // hundreds of trips that never existed. Naming the stations that can
    // originate a service is what keeps the leftovers meaningful.
    const mayStart = startAt ? new Set(startAt) : null;

    // Chains normally begin at the head of the line. On a branching network
    // they cannot: an outbound train leaving Dukuh Atas is not identifiably
    // Bekasi or Cibubur until it has passed Cawang, so starting there would
    // assign a branch by whichever pass happened to run first. Anchoring at the
    // first station only one branch serves makes the identity certain, and the
    // trunk is then filled in by extending the chain backwards.
    for (let start = anchor; start < boards.length; start++) {
        if (mayStart && !mayStart.has(start)) {
            continue;
        }
        for (let index = 0; index < boards[start].length; index++) {
            if (isClaimed(ledger, stationKeys[start], index)) {
                continue;
            }

            const stops = [start],
                times = [boards[start][index]];

            claim(ledger, stationKeys[start], index);

            let current = boards[start][index];

            for (let station = start + 1; station < boards.length; station++) {
                const predicted = current + runTimes[station - 1];

                let bestIndex = -1,
                    bestDelta = Infinity;

                for (let candidate = 0; candidate < boards[station].length; candidate++) {
                    if (isClaimed(ledger, stationKeys[station], candidate)) {
                        continue;
                    }

                    const delta = Math.abs(boards[station][candidate] - predicted);

                    if (delta < bestDelta) {
                        bestDelta = delta;
                        bestIndex = candidate;
                    }
                }

                // Nothing plausible downstream: the train terminates here.
                if (bestIndex < 0 || bestDelta > tolerance) {
                    if (station < boards.length - 1 || boards[station].length) {
                        stats.terminatedEarly++;
                    }
                    break;
                }

                claim(ledger, stationKeys[station], bestIndex);
                current = boards[station][bestIndex];
                stops.push(station);
                times.push(current);
            }

            // Extend backwards from the anchor through the shared trunk. Same
            // matching rule, run in reverse: predict the earlier call and snap
            // to a real departure.
            if (start === anchor && anchor > 0) {
                let earliest = times[0];

                for (let station = anchor - 1; station >= 0; station--) {
                    const predicted = earliest - runTimes[station];

                    let bestIndex = -1,
                        bestDelta = Infinity;

                    for (let candidate = 0; candidate < boards[station].length; candidate++) {
                        if (isClaimed(ledger, stationKeys[station], candidate)) {
                            continue;
                        }

                        const delta = Math.abs(boards[station][candidate] - predicted);

                        if (delta < bestDelta) {
                            bestDelta = delta;
                            bestIndex = candidate;
                        }
                    }

                    if (bestIndex < 0 || bestDelta > tolerance) {
                        break;
                    }
                    claim(ledger, stationKeys[station], bestIndex);
                    earliest = boards[station][bestIndex];
                    stops.unshift(station);
                    times.unshift(earliest);
                }
            }

            // A terminus publishes no departures — a train arrives and stops —
            // so a trip chained from the boards alone stops one station short of
            // where it actually goes. The final arrival is added from the run
            // time observed in the opposite direction, which is measured rather
            // than assumed, and only when the trip reached the penultimate stop.
            const last = boards.length - 1;

            if (terminusRunTime !== null &&
                !boards[last].length &&
                stops[stops.length - 1] === last - 1) {
                stops.push(last);
                times.push(times[times.length - 1] + terminusRunTime);
                stats.terminusArrivalsAdded++;
            }

            if (stops.length >= minStops) {
                trips.push({stops, times});
                stats.originatingAt[stops[0]]++;
            } else {
                stats.orphans++;
            }
        }
    }

    // Deterministic order: by first call, then by where they start.
    trips.sort((a, b) => a.times[0] - b.times[0] || a.stops[0] - b.stops[0]);
    return {trips, runTimes, stats};
}

// "05:13:20" or "05:13" -> seconds.
export function parseClock(text) {
    const parts = String(text).trim().split(':').map(Number);

    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) {
        return null;
    }
    return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

/**
 * Times on a board are wall-clock and a service day runs past midnight, so a
 * board that starts at 05:00 and ends at 00:30 has to be read as 05:00 to
 * 24:30. Any step backwards is the next day.
 */
export function unwrapBoard(times) {
    const out = [];
    let offset = 0;

    for (let i = 0; i < times.length; i++) {
        if (i && times[i] + offset < out[i - 1]) {
            offset += 86400;
        }
        out.push(times[i] + offset);
    }
    return out;
}

/**
 * Reconstructs several lines at once, claiming in time order.
 *
 * Running one line to completion and then the next looks equivalent and is
 * not. On a shared trunk the first pass claims whatever is nearest its own
 * predictions, including departures belonging to the other branch, and the
 * later pass then finds its trains already taken — LRT Jabodebek's Cibubur
 * inbound came out at 38 trips against a 109-departure board that way.
 *
 * Chaining every stream's candidate origins in departure order removes the
 * ordering bias: the train that leaves first claims first, whichever branch or
 * direction it belongs to. Weekend service reconciled either way because it is
 * sparse; weekday only reconciles like this.
 *
 * @param passes  [{boards, keys, anchor, startAt, terminusRunTime, tag}]
 */
export function reconstructInterleaved(passes, {tolerance = DEFAULT_TOLERANCE_S, minStops = MIN_STOPS, claims = null} = {}) {
    const ledger = claims ?? createClaims(),
        prepared = passes.map(pass => ({
            ...pass,
            // An explicit vector wins: where a caller can derive run times from
            // track geometry, that evidence is independent of the timetable and
            // beats anything inferable from a board that merges directions.
            // Otherwise measure from what is still unclaimed, so a later stage
            // is not skewed by the streams an earlier one has removed.
            runTimes: pass.runTimes ?? estimateRunTimes(pass.boards.map((board, i) =>
                board.filter((_, index) => !isClaimed(claims ?? createClaims(), pass.keys[i], index))))
        })),
        origins = [];

    for (const pass of prepared) {
        for (const start of pass.startAt) {
            (pass.boards[start] || []).forEach((time, index) => {
                origins.push({pass, start, index, time});
            });
        }
    }

    // The heart of it: earliest departure claims first, regardless of stream.
    origins.sort((a, b) => a.time - b.time);

    const result = new Map(prepared.map(pass => [pass.tag, []]));

    for (const origin of origins) {
        const {pass, start, index} = origin,
            {boards, keys, runTimes} = pass;

        if (isClaimed(ledger, keys[start], index)) {
            continue;
        }

        const stops = [start],
            times = [boards[start][index]];

        claim(ledger, keys[start], index);

        // Tolerance scales with the leg. A run time derived from geometry
        // carries model error proportional to its length — a 20% miss on a
        // 470-second leg is 94 seconds, past any flat threshold — while a short
        // leg must stay tight or it swallows the next train. Proportional keeps
        // both true.
        const toleranceFor = runTime => Math.max(tolerance, Math.round(0.25 * (runTime || 0))),

            // `after` and `before` keep a chain moving in one direction
            // through time. Without them the nearest departure to a prediction
            // can sit on the wrong side of the previous call, and the trip
            // arrives a minute before it left — which is exactly what the
            // temporal check caught once inbound tolerance was widened.
            nearest = (station, predicted, allowed, {after = -Infinity, before = Infinity} = {}) => {
                let bestIndex = -1,
                    bestDelta = Infinity;

                for (let candidate = 0; candidate < boards[station].length; candidate++) {
                    if (isClaimed(ledger, keys[station], candidate)) {
                        continue;
                    }

                    const time = boards[station][candidate];

                    if (time <= after || time >= before) {
                        continue;
                    }

                    const delta = Math.abs(time - predicted);

                    if (delta < bestDelta) {
                        bestDelta = delta;
                        bestIndex = candidate;
                    }
                }
                return bestDelta <= allowed ? bestIndex : -1;
            };

        let current = times[0];

        for (let station = start + 1; station < boards.length; station++) {
            const leg = runTimes[station - 1],
                hit = nearest(station, current + leg, toleranceFor(leg), {after: current});

            if (hit < 0) {
                break;
            }
            claim(ledger, keys[station], hit);
            current = boards[station][hit];
            stops.push(station);
            times.push(current);
        }

        // Backwards through the trunk from the anchor, same rule reversed.
        if (start === (pass.anchor ?? 0) && (pass.anchor ?? 0) > 0) {
            let earliest = times[0];

            for (let station = pass.anchor - 1; station >= 0; station--) {
                const leg = runTimes[station],
                    hit = nearest(station, earliest - leg, toleranceFor(leg), {before: earliest});

                if (hit < 0) {
                    break;
                }
                claim(ledger, keys[station], hit);
                earliest = boards[station][hit];
                stops.unshift(station);
                times.unshift(earliest);
            }
        }

        // A terminus publishes no departures, so its arrival is extrapolated.
        const last = boards.length - 1;

        if (pass.terminusRunTime != null && !boards[last].length && stops[stops.length - 1] === last - 1) {
            stops.push(last);
            times.push(times[times.length - 1] + pass.terminusRunTime);
        }

        if (stops.length >= minStops) {
            result.get(pass.tag).push({stops, times});
        }
    }

    for (const trips of result.values()) {
        trips.sort((a, b) => a.times[0] - b.times[0]);
    }
    return {byTag: result, claims: ledger};
}
