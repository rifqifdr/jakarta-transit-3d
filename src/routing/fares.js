/**
 * What a journey actually costs.
 *
 * Transjakarta prices per route, not per distance, and every fare carries a
 * 10,800-second (3 hour) integrated transfer window. So the cost of a journey
 * is emphatically not the sum of its legs: within the window you tap once.
 *
 * The split across the network:
 *   101 of 240 routes free (Mikrotrans, Rusun)
 *   129 at Rp 3,500
 *     9 premium at Rp 20,000-35,000 (Royaltrans)
 *
 * which is why "cheapest" is a real axis to sort on rather than a decoration.
 */

/**
 * Totals the fare for a sequence of legs.
 *
 * The model, in order of how much the feed actually tells us:
 *
 *  - A free route is always free and never opens a paid period. This matters:
 *    riding Mikrotrans first and BRT second still costs the BRT fare, which a
 *    naive "charge the first boarding" rule would report as free.
 *  - The first paid boarding opens a period and is charged in full.
 *  - Later paid boardings inside that period are covered by it.
 *  - Boarding something dearer than the period has covered so far charges the
 *    difference. The feed has no way to express how premium services combine
 *    with the integrated fare, so this is an assumption, flagged as such —
 *    it gives the sensible answer that a Rp 3,500 leg followed by a Rp 20,000
 *    Royaltrans leg costs Rp 20,000, not Rp 3,500 and not Rp 23,500.
 *  - A boarding after the window expires opens a fresh period.
 */
/**
 * Distance tariffs for the rail modes, mirroring scripts/transform/fares-rail.mjs.
 *
 * Rail prices by distance and Transjakarta does not, so `fares.byRoute` — one
 * price per route — is the right shape for buses and the wrong one for trains.
 * A leg's length is known (the pattern carries each stop's metres along its
 * shape), so the fare is computable rather than looked up.
 */
const RAIL_TARIFFS = {
    commuter_rail: {base: 3000, baseKm: 25, stepKm: 10, step: 1000, cap: null},
    metro: {base: 3000, baseKm: 3, stepKm: 3, step: 1000, cap: 14000},
    light_rail: {base: 5000, baseKm: 1, stepKm: 1, step: 700, cap: 20000}
};

export function distanceFare(mode, km) {
    const tariff = RAIL_TARIFFS[mode];

    if (!tariff) {
        return null;
    }
    if (!(km > tariff.baseKm)) {
        return tariff.base;
    }

    const blocks = Math.ceil((km - tariff.baseKm) / tariff.stepKm),
        total = tariff.base + blocks * tariff.step;

    return tariff.cap ? Math.min(total, tariff.cap) : total;
}

/**
 * The price of a single leg.
 *
 * A distance-based fare needs the leg's length; without one the base fare is
 * the honest answer, since it is the floor rather than a guess.
 */
function priceOfLeg(leg, fare, network) {
    if (!fare?.distanceBased) {
        return fare?.price ?? 0;
    }

    const mode = network.routes?.get?.(leg.route)?.mode ??
        network.routes?.find?.(r => r.id === leg.route)?.mode;

    return distanceFare(mode, leg.km ?? 0) ?? fare.price;
}

export function fareForLegs(legs, network) {
    const breakdown = [];
    let total = 0,
        periodStart = null,
        periodPaid = 0,
        currency = 'IDR';

    for (const leg of legs) {
        if (leg.type !== 'ride') {
            continue;
        }

        const fare = network.fareForRoute ?
            network.fareForRoute(leg.route) :
            lookupFare(network, leg.route);

        if (!fare) {
            breakdown.push({route: leg.route, charged: 0, note: 'unknown-fare'});
            continue;
        }
        currency = fare.currency || currency;

        const price = priceOfLeg(leg, fare, network);

        if (price === 0) {
            breakdown.push({route: leg.route, charged: 0, note: 'free'});
            continue;
        }

        const window = fare.transferDuration ?? 0,
            withinPeriod = periodStart !== null &&
                leg.departure - periodStart <= window;

        if (!withinPeriod) {
            periodStart = leg.departure;
            periodPaid = price;
            total += price;
            breakdown.push({route: leg.route, charged: price, note: 'new-fare'});
            continue;
        }

        // Covered by the period, unless this service costs more than it has
        // paid for so far.
        const difference = Math.max(0, price - periodPaid);

        if (difference > 0) {
            periodPaid = price;
            total += difference;
            breakdown.push({route: leg.route, charged: difference, note: 'upgrade'});
        } else {
            breakdown.push({route: leg.route, charged: 0, note: 'transfer'});
        }
    }

    // JakLingko caps a multi-modal journey at Rp 10,000 within three hours,
    // across TransJakarta, MRT, LRT, KRL and Mikrotrans. It is a ceiling on the
    // journey rather than a price on any route, which is why it can only be
    // applied here — and why it is the number a passenger actually pays as soon
    // as more than one mode is involved.
    const cap = journeyCap(legs, network),
        capped = cap !== null && total > cap;

    return {
        total: capped ? cap : total,
        uncapped: total,
        cap: capped ? cap : null,
        currency,
        breakdown,
        // True when the rider tapped once for the whole journey.
        singleTap: breakdown.filter(x => x.charged > 0).length <= 1
    };
}

/**
 * The integrated cap, when a journey qualifies for it.
 *
 * Only multi-modal journeys inside the window: a single bus ride is priced by
 * its own fare and is cheaper than the cap anyway.
 */
function journeyCap(legs, network) {
    const rides = legs.filter(leg => leg.type === 'ride');

    if (rides.length < 2) {
        return null;
    }

    const modes = new Set(rides.map(leg =>
        network.routes?.get?.(leg.route)?.mode ??
        network.routes?.find?.(r => r.id === leg.route)?.mode));

    if (modes.size < 2) {
        return null;
    }

    const first = rides[0].departure,
        last = rides[rides.length - 1].departure,
        fares = rides.map(leg => fareForRoute(network, leg.route)).filter(Boolean),
        cap = fares.map(f => f.integratedCap).find(Boolean),
        window = Math.max(0, ...fares.map(f => f.transferDuration ?? 0));

    return cap && last - first <= window ? cap : null;
}

/** The fare for a route, whichever shape of network object is to hand. */
export function fareForRoute(network, routeId) {
    return network.fareForRoute ?
        network.fareForRoute(routeId) :
        lookupFare(network, routeId);
}

// The browser's Network exposes fareForRoute(); the raw bundle does not.
function lookupFare(network, routeId) {
    const fares = network.fares;

    if (!fares) {
        return null;
    }

    const id = fares.byRoute[routeId];

    return id ? fares.attributes[id] : null;
}

const RUPIAH = new Intl.NumberFormat('id-ID');

/** A fare as a rider reads it. */
export function formatFare(total, currency = 'IDR') {
    if (total === 0) {
        return 'Gratis';
    }
    return currency === 'IDR' ? `Rp ${RUPIAH.format(total)}` : `${currency} ${total}`;
}
