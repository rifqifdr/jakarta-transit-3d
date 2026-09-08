/**
 * Rail fares — the published tariffs, and an honest note about what the model
 * cannot yet express.
 *
 * Transjakarta prices per route, which is what `fares.byRoute` is shaped for.
 * Rail does not: KRL, MRT and LRT Jabodebek all price by *distance*, so a
 * single number per route is the wrong shape for them. Rather than leave the
 * panel saying "tarif tidak tersedia" — which reads as "we do not know", when
 * in fact the tariff is public and simply does not fit — each mode carries its
 * base fare plus a `distanceBased` flag, and the UI shows it as a floor:
 * "Rp 3.000+".
 *
 * Above all of it sits JakLingko: a multi-modal journey is capped at
 * Rp 10,000 within three hours, across TransJakarta, MRT, LRT, KRL and
 * Mikrotrans. That is a cap on the *journey*, not a price on a route, so it is
 * carried as the transfer note until the fare model grows a third layer.
 *
 * Proper distance-based fares and the journey cap are their own ticket.
 */

// Rp 10,000 across every mode, within three hours, on one JakLingko tap.
export const JAKLINGKO = {cap: 10000, windowSeconds: 3 * 3600};

/**
 * Distance tariffs, as the operators publish them.
 *
 * `base` covers everything up to `baseKm`; beyond that each started block of
 * `stepKm` adds `step`, up to `cap`. That shape fits all three, which is why it
 * is one function rather than three.
 */
export const RAIL_TARIFFS = {
    commuter_rail: {base: 3000, baseKm: 25, stepKm: 10, step: 1000, cap: null},
    metro: {base: 3000, baseKm: 3, stepKm: 3, step: 1000, cap: 14000},
    // LRT Jabodebek: Rp 5.000 for the first kilometre, Rp 700 each after.
    // LRT Jakarta is flat Rp 5.000, which this expresses as a zero step.
    light_rail: {base: 5000, baseKm: 1, stepKm: 1, step: 700, cap: 20000}
};

/** What one leg of `km` on `mode` costs, before any journey cap. */
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

export const RAIL_FARES = {
    commuter_rail: {
        id: 'krl-distance',
        price: 3000,
        distanceBased: true,
        // Rp 3,000 covers the first 25 km, then Rp 1,000 per further 10 km.
        note: 'Rp 3.000 untuk 25 km pertama, +Rp 1.000 tiap 10 km berikutnya'
    },
    metro: {
        id: 'mrt-distance',
        price: 3000,
        distanceBased: true,
        note: 'Tarif per jarak, Rp 3.000–14.000'
    },
    light_rail: {
        id: 'lrt-distance',
        price: 5000,
        distanceBased: true,
        note: 'LRT Jakarta Rp 5.000 rata; LRT Jabodebek per jarak'
    }
};

/**
 * Attaches a fare to every rail route that has none.
 *
 * Only fills gaps: anything the operator's own feed already priced is left
 * alone, because a published fare beats a modelled one.
 */
export function applyRailFares(dataset) {
    let attached = 0;

    for (const route of dataset.routes) {
        const tariff = RAIL_FARES[route.mode];

        if (!tariff || dataset.fares.byRoute[route.id]) {
            continue;
        }

        dataset.fares.attributes[tariff.id] = {
            price: tariff.price,
            currency: 'IDR',
            transfers: null,
            transferDuration: JAKLINGKO.windowSeconds,
            distanceBased: tariff.distanceBased,
            note: tariff.note,
            // The cap belongs to the journey, not the route. Carried here so the
            // UI can state it, and so it is not forgotten when fares grow up.
            integratedCap: JAKLINGKO.cap
        };
        dataset.fares.byRoute[route.id] = tariff.id;
        attached++;
    }
    return attached;
}
