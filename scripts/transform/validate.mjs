/**
 * The validation gate. A build that fails here must not publish.
 *
 * With one hand-checked GTFS feed this would be optional. With six scraped
 * sources it is the difference between shipping stale data and shipping wrong
 * data — and wrong is worse, because stale announces itself and wrong does
 * not. Every check below exists because the failure it looks for has actually
 * been observed in this data, not because it seemed prudent.
 *
 * Errors fail the build. Warnings are recorded and printed. The distinction
 * is whether a human could look at the map and see the problem: a train at
 * null island is an error, a slightly stale snapshot is a warning.
 */
import {MODE_IDS} from './model.mjs';

// A trip whose times run backwards by roughly a day is a missing midnight
// unwrap; one that jumps backwards by minutes is a reconstruction that spliced
// two vehicles together. Different bugs, different fixes, so they are reported
// differently.
const WRAP_THRESHOLD_SECONDS = 12 * 3600,

    // How far a stop may sit from the shape it is supposed to lie on. Jakarta
    // platforms are wide and OSM geometry is a centreline, so this is generous
    // — it is looking for a join to the wrong station, not for precision.
    MAX_STOP_TO_SHAPE_M = 400,

    // Snapshot ages beyond which a source is suspect. Rail timetables change a
    // few times a year; a source that has not moved in a season has probably
    // stopped moving at all.
    STALE_WARN_DAYS = 30,
    STALE_ERROR_DAYS = 120,

    // Build-over-build change beyond which something has probably broken
    // upstream rather than genuinely changed.
    DRIFT_WARN = 0.10,
    DRIFT_ERROR = 0.30,

    // BPJT's table is the only source of coordinates for any toll camera, and
    // it is rewritten wholesale rather than per row. A table that has not been
    // rewritten in a season is one whose page still answers while the data
    // behind it has stopped moving — the Comuline lesson, and invisible to the
    // snapshot-age check, which only knows when we last fetched (JAKAR-56).
    BPJT_TABLE_WARN_DAYS = 90,

    // How far the direct/joined split may move build over build before it is
    // worth saying so. Jasa Marga has rotated every stream id once already;
    // when it happens again the direct half drops and only the join carries
    // the layer, and nothing else would report it.
    TOLL_SPLIT_WARN = 0.25,

    // A road that resolved this many cameras and now resolves none has gone
    // dark; fewer than this and the swing is noise.
    TOLL_ROAD_FLOOR = 5;

class Report {

    constructor() {
        const me = this;

        me.checks = [];
        me.errors = [];
        me.warnings = [];
    }

    // `sample` keeps the first few offenders so a failure is actionable
    // without dumping ten thousand lines.
    add(check, level, message, sample = []) {
        const me = this,
            entry = {check, level, message, sample: sample.slice(0, 5)};

        (level === 'error' ? me.errors : me.warnings).push(entry);
        return entry;
    }

    pass(check, detail) {
        this.checks.push({check, status: 'pass', detail});
    }

    fail(check, detail) {
        this.checks.push({check, status: 'fail', detail});
    }

    get ok() {
        return this.errors.length === 0;
    }
}

/**
 * @param dataset      canonical dataset
 * @param previous     the counts from the last successful build, for drift
 * @param snapshots    [{source, ageDays, date}] from the ingest metas
 * @param toll         the cctv-tol transform's report, for the join checks
 * @param previousToll the same report from the last successful build
 */
export function validate(dataset, {
    previous = null, snapshots = [], toll = null, previousToll = null
} = {}) {
    const report = new Report();

    referentialIntegrity(dataset, report);
    modeIntegrity(dataset, report);
    temporalOrder(dataset, report);
    patternTermini(dataset, report);
    stopsNearShapes(dataset, report);
    walkTableSane(dataset, report);
    camerasSane(dataset, report);
    tollSources(toll, previousToll, report);
    freshness(snapshots, report);
    drift(dataset, previous, report);

    return report;
}

// ---------------------------------------------------------------------------


/**
 * Every camera must stand where it says it stands.
 *
 * The coordinate table behind this layer is a stale community mirror of a
 * government release, joined to a live probe by stream name. That is exactly
 * the shape of the join that produced trap 7 — two lists reconciled on a key,
 * with nothing checking the result against geography. A camera whose position
 * is wrong is not a subtle failure either: it puts a video of one street on
 * top of a different one, which is worse than showing no camera at all.
 *
 * The `distance` each camera carries is checked against the stop it names,
 * rather than trusted, because that field is what the UI will tell a viewer.
 */
function camerasSane(dataset, report) {
    const check = 'cameras',
        cameras = dataset.cameras ?? [];

    if (!cameras.length) {
        report.pass(check, 'no cameras in this build');
        return;
    }

    const byId = new Map(dataset.stops.map(stop => [stop.id, stop])),
        // The street builder's own radius, with room for coordinate rounding.
        streetLimit = 450,
        // A motorway camera is nowhere near a stop and that is not a fault in
        // it, so the toll half is judged against the route paths it overlooks.
        tollLimit = 200,
        offenders = [],
        unknown = [],
        misstated = [];

    for (const camera of cameras) {
        const stop = byId.get(camera.stop);

        if (camera.kind === 'toll') {
            const distance = distanceToAnyShape(camera.lat, camera.lon, dataset.shapes);

            if (distance > tollLimit) {
                offenders.push(`${camera.id} is ${Math.round(distance)} m from any route path`);
            }
        } else if (!stop) {
            unknown.push(`${camera.id} -> ${camera.stop}`);
            continue;
        } else {
            const distance = metres(camera.lat, camera.lon, stop.lat, stop.lon);

            if (distance > streetLimit) {
                offenders.push(`${camera.id} is ${Math.round(distance)} m from ${stop.name}`);
            }
        }

        // `distance` is shown to the viewer, so a wrong one is a wrong
        // statement rather than a harmless field — whichever kind it is.
        if (stop && camera.distance !== null) {
            const measured = metres(camera.lat, camera.lon, stop.lat, stop.lon);

            if (Math.abs(measured - camera.distance) > 25) {
                misstated.push(`${camera.id} says ${camera.distance} m, measures ${Math.round(measured)} m`);
            }
        }
    }

    if (unknown.length) {
        report.add(check, 'error', `${unknown.length} camera(s) name a stop that does not exist`, unknown);
    }
    if (offenders.length) {
        report.add(check, 'error',
            `${offenders.length} camera(s) too far from what they claim to overlook`, offenders);
    }
    if (misstated.length) {
        report.add(check, 'error',
            `${misstated.length} camera(s) misstate their distance to the stop`, misstated);
    }

    // These URLs come from third-party pages and end up in the DOM, so the
    // scheme is checked rather than assumed.
    const malformed = cameras.filter(c => !/^https:\/\/[^\s"'<>]+$/.test(c.stream || ''));

    if (malformed.length) {
        report.add(check, 'error', `${malformed.length} camera(s) have an unsafe stream URL`,
            malformed.map(c => c.id));
    }

    const toll = cameras.filter(c => c.kind === 'toll').length;

    if (!unknown.length && !offenders.length && !misstated.length && !malformed.length) {
        report.pass(check, `${cameras.length} cameras (${cameras.length - toll} street, ${toll} toll), all where they claim`);
    } else {
        report.fail(check, `${cameras.length} cameras`);
    }
}

/** Nearest vertex of any shape. Precise enough for a 200 m question. */
function distanceToAnyShape(lat, lon, shapes) {
    let best = Infinity;

    for (const shape of shapes) {
        const coords = shape.coords;

        for (let i = 0; i < coords.length; i += 2) {
            const d = metres(lat, lon, coords[i + 1], coords[i]);

            if (d < best) {
                best = d;
            }
        }
    }
    return best;
}

/**
 * Every walk edge must join two stops that are actually within walking range.
 *
 * This check exists because the walk table was built as *indices* into the stop
 * array and the dataset was sorted afterwards, which repointed all of them:
 * 40,083 of 40,817 edges ended up over 500 m apart, the worst pair 74 km, in a
 * table whose entire contract is "within 400 m". Nothing caught it — the router
 * happily planned a five-minute walk from Bojonggede to Pulo Gadung, and it
 * took reading an itinerary to notice.
 *
 * The edges now carry stop ids, so this cannot recur the same way. It is
 * checked anyway, because the failure was invisible for as long as nothing
 * compared an edge against the geography it claims.
 */
function walkTableSane(dataset, report) {
    const check = 'walk-table',
        // The builder's own radius, with room for the rounding that
        // simplification and coordinate scaling introduce.
        limit = 450,
        byId = new Map(dataset.stops.map(stop => [stop.id, stop])),
        offenders = [],
        unknown = [];

    for (const edge of dataset.transfers) {
        if (edge.kind !== 'walk') {
            continue;
        }

        const a = byId.get(edge.from),
            b = byId.get(edge.to);

        if (!a || !b) {
            unknown.push(`${edge.from} -> ${edge.to}`);
            continue;
        }

        const distance = metres(a.lat, a.lon, b.lat, b.lon);

        if (distance > limit) {
            offenders.push(`${a.name} -> ${b.name}: ${Math.round(distance)} m`);
        }
    }

    if (unknown.length) {
        report.add(check, 'error',
            `${unknown.length} walk edges reference a stop that is not in the dataset`, unknown);
    }
    if (offenders.length) {
        report.add(check, 'error',
            `${offenders.length} of ${dataset.transfers.length} walk edges join stops more than ${limit} m apart`,
            offenders);
    }
    if (unknown.length || offenders.length) {
        report.fail(check, `${offenders.length + unknown.length} bad edges`);
        return;
    }
    report.pass(check, `${dataset.transfers.length.toLocaleString()} edges, all within ${limit} m`);
}

function referentialIntegrity(dataset, report) {
    const check = 'referential-integrity',
        stops = new Set(dataset.stops.map(s => s.id)),
        stations = new Set(dataset.stations.map(s => s.id)),
        routes = new Set(dataset.routes.map(r => r.id)),
        patterns = new Map(dataset.patterns.map(p => [p.id, p])),
        shapes = new Set(dataset.shapes.map(s => s.id)),
        agencies = new Set(dataset.agencies.map(a => a.id)),
        missing = [];

    for (const route of dataset.routes) {
        if (!agencies.has(route.agency)) {
            missing.push(`route ${route.id} -> agency ${route.agency}`);
        }
    }
    for (const stop of dataset.stops) {
        if (stop.station && !stations.has(stop.station)) {
            missing.push(`stop ${stop.id} -> station ${stop.station}`);
        }
    }
    for (const pattern of dataset.patterns) {
        if (!routes.has(pattern.route)) {
            missing.push(`pattern ${pattern.id} -> route ${pattern.route}`);
        }
        if (pattern.shape && !shapes.has(pattern.shape)) {
            missing.push(`pattern ${pattern.id} -> shape ${pattern.shape}`);
        }
        for (const stopId of pattern.stops) {
            if (!stops.has(stopId)) {
                missing.push(`pattern ${pattern.id} -> stop ${stopId}`);
            }
        }
    }
    for (const trip of dataset.trips) {
        const pattern = patterns.get(trip.pattern);

        if (!pattern) {
            missing.push(`trip ${trip.id} -> pattern ${trip.pattern}`);
            continue;
        }
        if (trip.times && trip.times.length !== pattern.stops.length) {
            missing.push(`trip ${trip.id}: ${trip.times.length} times for ${pattern.stops.length} stops`);
        }
        if (!dataset.calendar[trip.service]) {
            missing.push(`trip ${trip.id} -> service ${trip.service}`);
        }
    }

    if (missing.length) {
        report.add(check, 'error', `${missing.length} dangling references`, missing);
        report.fail(check, `${missing.length} dangling`);
    } else {
        report.pass(check, `${dataset.trips.length} trips, ${dataset.patterns.length} patterns resolved`);
    }
}

function modeIntegrity(dataset, report) {
    const check = 'mode-integrity',
        problems = [],
        routeMode = new Map(dataset.routes.map(r => [r.id, r.mode]));

    for (const route of dataset.routes) {
        if (!MODE_IDS.has(route.mode)) {
            problems.push(`route ${route.id}: mode "${route.mode}"`);
        }
    }

    // A pattern that disagrees with its route about mode means a normaliser
    // guessed. Mode has one source of truth and it is the route.
    for (const pattern of dataset.patterns) {
        const expected = routeMode.get(pattern.route);

        if (pattern.mode && expected && pattern.mode !== expected) {
            problems.push(`pattern ${pattern.id}: mode ${pattern.mode} but route ${pattern.route} is ${expected}`);
        }
    }

    if (problems.length) {
        report.add(check, 'error', `${problems.length} mode problems`, problems);
        report.fail(check, `${problems.length} problems`);
    } else {
        const byMode = {};

        for (const route of dataset.routes) {
            byMode[route.mode] = (byMode[route.mode] || 0) + 1;
        }
        report.pass(check, Object.entries(byMode).map(([m, n]) => `${m}=${n}`).join(' ') || 'no routes yet');
    }
}

/**
 * Times must not run backwards along a pattern.
 *
 * This is the check that catches the MRT short working, and the reason it is
 * worth spelling out: a pattern's stops are already in *geographic* order, so
 * comparing times against that order is a real test. Sorting the departures by
 * time and then asserting they ascend proves nothing at all — it is circular,
 * and it is exactly the mistake that hid the Blok M case first time round.
 *
 * Reading the first northbound departure at each MRT station in line order
 * gives Lebak Bulus 05:00, Fatmawati 05:03:10, Cipete 05:06:10, Haji Nawi
 * 05:08:20, Blok A 05:10:40 — then Blok M 05:00:00. Two different trains leave
 * at 05:00; chaining naively splices them into one that travels backwards.
 */
function temporalOrder(dataset, report) {
    const check = 'temporal-order',
        patterns = new Map(dataset.patterns.map(p => [p.id, p])),
        backwards = [],
        wraps = [];

    for (const trip of dataset.trips) {
        if (!trip.times) {
            continue;
        }
        for (let i = 1; i < trip.times.length; i++) {
            const delta = trip.times[i] - trip.times[i - 1];

            if (delta >= 0) {
                continue;
            }

            const pattern = patterns.get(trip.pattern),
                at = pattern?.stops?.[i] ?? `index ${i}`,
                where = `trip ${trip.id} at ${at}: ${fmt(trip.times[i - 1])} -> ${fmt(trip.times[i])}`;

            if (-delta > WRAP_THRESHOLD_SECONDS) {
                wraps.push(where);
            } else {
                backwards.push(where);
            }
        }
    }

    if (wraps.length) {
        report.add(check, 'error',
            `${wraps.length} trips wrap backwards by most of a day — times were not unwrapped past midnight ` +
            '(a 23:10 departure arriving 00:37 is 24:37, not 00:37)', wraps);
    }
    if (backwards.length) {
        report.add(check, 'error',
            `${backwards.length} trips travel backwards in time along their own stop order — ` +
            'reconstruction has spliced separate vehicles (short workings, or a wrong branch)', backwards);
    }
    if (wraps.length || backwards.length) {
        report.fail(check, `${wraps.length} wraps, ${backwards.length} backwards`);
    } else {
        const scheduled = dataset.trips.filter(t => t.times).length;

        report.pass(check, `${scheduled} scheduled trips ascend along their patterns`);
    }
}

/**
 * An inferred pattern must end where its route can end.
 *
 * LRT Jabodebek splits at Cawang towards Harjamukti and Jati Mulya, and its
 * source gives no train ids and no direction labels — so a reconstructed trip
 * can plausibly be assigned to the wrong branch. A pattern whose last stop is
 * not a terminus of any known pattern on that route is the signature.
 *
 * Only inferred patterns are checked. Where the source states trip identity, as
 * KRL does, a unique terminus is simply a short working — Rangkasbitung really
 * does run thirteen trains a day that terminate at Tigaraksa, and flagging
 * those taught us nothing except to distrust the warning.
 */
function patternTermini(dataset, report) {
    const check = 'pattern-termini',
        byRoute = new Map();

    for (const pattern of dataset.patterns) {
        if (!pattern.inferred) {
            continue;
        }
        if (!byRoute.has(pattern.route)) {
            byRoute.set(pattern.route, []);
        }
        byRoute.get(pattern.route).push(pattern);
    }

    if (!byRoute.size) {
        report.pass(check, 'no inferred patterns to check');
        return;
    }

    const suspicious = [];

    for (const [routeId, patterns] of byRoute) {
        // Stops that terminate at least two patterns are real termini; one
        // pattern ending somewhere unique is what we are looking for.
        const endings = new Map();

        for (const pattern of patterns) {
            const last = pattern.stops[pattern.stops.length - 1];

            endings.set(last, (endings.get(last) || 0) + 1);
        }
        if (patterns.length < 4) {
            continue;
        }
        for (const [stopId, count] of endings) {
            if (count === 1) {
                suspicious.push(`route ${routeId}: only one of ${patterns.length} patterns ends at ${stopId}`);
            }
        }
    }

    if (suspicious.length) {
        report.add(check, 'warning',
            `${suspicious.length} routes have a pattern ending somewhere no other pattern does — ` +
            'check branch assignment', suspicious);
        report.fail(check, `${suspicious.length} suspicious endings`);
    } else {
        report.pass(check, `${byRoute.size} routes have consistent termini`);
    }
}

/**
 * Every stop on a pattern should lie near the shape that pattern follows.
 *
 * This is the check for a bad geometry join. Station names come from the
 * operator and coordinates come from OSM, matched on a normalised name — so a
 * near-miss ("Cipete" vs "Cipete Raya") puts a real station in the wrong place
 * rather than failing outright, and nothing else would notice.
 */
function stopsNearShapes(dataset, report) {
    const check = 'stops-near-shapes',
        stops = new Map(dataset.stops.map(s => [s.id, s])),
        shapes = new Map(dataset.shapes.map(s => [s.id, s.coords])),
        far = [];

    for (const pattern of dataset.patterns) {
        const coords = shapes.get(pattern.shape);

        if (!coords) {
            continue;
        }
        for (const stopId of pattern.stops) {
            const stop = stops.get(stopId);

            if (!stop) {
                continue;
            }

            const distance = distanceToPolyline(stop.lat, stop.lon, coords);

            if (distance > MAX_STOP_TO_SHAPE_M) {
                far.push(`${stop.name} (${stopId}) is ${Math.round(distance)} m from shape ${pattern.shape}`);
            }
        }
    }

    if (far.length) {
        report.add(check, 'error', `${far.length} stops sit more than ${MAX_STOP_TO_SHAPE_M} m from their own route`, far);
        report.fail(check, `${far.length} misplaced`);
    } else {
        report.pass(check, `all pattern stops within ${MAX_STOP_TO_SHAPE_M} m of their shape`);
    }
}

/**
 * The toll camera layer's two sources, watched for the way they will decay.
 *
 * JAKAR-56. Everything else in this gate asks whether the data is wrong; this
 * asks whether it has quietly stopped being right, which is the failure this
 * particular layer is built to have:
 *
 * - BPJT is the only source of coordinates and its table was written once, on
 *   2026-05-11. The page answers every day, so no fetch ever fails.
 * - Jasa Marga has already rotated every stream id once. That is why the
 *   (road, KM) join exists. When it rotates again the direct half drops to
 *   near zero and only the join carries the layer.
 * - And if BPJT is ever refreshed with a different KM label format, the join
 *   matches fewer cameras and the layer shrinks without erroring.
 *
 * All of it is warnings, not errors, and deliberately: the layer degrades to
 * *fewer* cameras rather than to wrong ones, and failing a four-mode build over
 * a camera source would be out of proportion. The one error is a layer that
 * resolved nothing at all from a snapshot that has streams in it, which is a
 * parse break rather than decay.
 */
function tollSources(toll, previous, report) {
    const check = 'toll-camera-sources';

    if (!toll) {
        report.pass(check, 'no cctv-tol snapshot in this build');
        return;
    }

    const resolved = toll.matchedDirect + toll.matchedJoined,
        detail = [];

    // ---- the table behind the page ---------------------------------------
    if (toll.tableAgeDays !== null && toll.tableAgeDays >= BPJT_TABLE_WARN_DAYS) {
        report.add(check, 'warning',
            `BPJT's table has not been rewritten in ${toll.tableAgeDays} days (${toll.tableWritten})`,
            ['it is the only source of coordinates for any toll camera']);
        detail.push(`table ${toll.tableAgeDays}d`);
    }

    // ---- the split, against the last build -------------------------------
    if (previous) {
        const moved = [];

        // Judged on what the sources resolved, not on what shipped: the
        // proximity filter moves when our own route network changes, and that
        // is not the upstream decaying.
        for (const arm of ['matchedDirect', 'matchedJoined']) {
            const was = previous[arm] ?? previous[arm === 'matchedDirect' ? 'direct' : 'joined'] ?? 0,
                now = toll[arm] ?? 0;

            if (was >= TOLL_ROAD_FLOOR && now === 0) {
                moved.push(`${arm}: ${was} -> 0 — that half of the layer has gone`);
            } else if (was && Math.abs(now - was) / was >= TOLL_SPLIT_WARN) {
                moved.push(`${arm}: ${was} -> ${now}`);
            }
        }
        if (moved.length) {
            report.add(check, 'warning', 'the direct/joined split moved since the last build', moved);
        }

        // A road going dark is invisible in the totals: Jasa Marga is 61% of
        // the network and would mask every other operator at once.
        const before = new Map((previous.byRoad ?? []).map(r => [r.road, r])),
            dark = [];

        for (const road of toll.byRoad ?? []) {
            const was = before.get(road.road),
                wasMatched = was ? (was.matchedDirect ?? was.direct) + (was.matchedJoined ?? was.joined) : 0;

            if (wasMatched >= TOLL_ROAD_FLOOR && road.matchedDirect + road.matchedJoined === 0) {
                dark.push(`${road.road}: ${wasMatched} -> 0`);
            }
        }
        if (dark.length) {
            report.add(check, 'warning', `${dark.length} road(s) resolved cameras last build and none now`, dark);
        }
        detail.push(`split ${previous.matchedDirect ?? previous.direct}/${previous.matchedJoined ?? previous.joined}` +
            ` -> ${toll.matchedDirect}/${toll.matchedJoined}`);
    } else {
        detail.push(`split ${toll.matchedDirect}/${toll.matchedJoined}`);
    }

    // ---- the join itself, from this build alone --------------------------
    // Needs no previous build, which makes it the strongest of these: both
    // sides had material to match and none of it matched, so the KM labels
    // have changed shape on one side or the other. Judged on `matchedJoined`
    // rather than on what shipped — BORR's join matches every camera and the
    // proximity filter then drops all five, which is not a broken join.
    const broken = (toll.byRoad ?? []).filter(road =>
        road.statesKm >= TOLL_ROAD_FLOOR &&
        road.pageStreams >= TOLL_ROAD_FLOOR &&
        road.matchedJoined === 0);

    if (broken.length) {
        report.add(check, 'warning',
            `${broken.length} road(s) state a KM and publish streams, and the join matched none`,
            broken.map(r => `${r.road}: ${r.statesKm} with a KM, ${r.pageStreams} streams, 0 joined`));
    }

    // Not a fault, but worth stating: on a road where BPJT names no kilometre
    // there is nothing to join on, and these streams are live and unreachable.
    // Guessing by card order is what was rejected, so they stay unclaimed.
    const orphaned = (toll.byRoad ?? [])
        .filter(road => road.statesKm === 0 && road.pageUnused > 0)
        .reduce((sum, road) => sum + road.pageUnused, 0);

    if (orphaned) {
        detail.push(`${orphaned} unreachable (no KM stated)`);
    }

    // ---- the one error ----------------------------------------------------
    // Reported last so the warnings above still say *why* it collapsed: a
    // total failure is most likely a page format change, and the join check is
    // what distinguishes that from every operator going dark at once.
    if (toll.inRegion > 0 && resolved === 0) {
        report.add(check, 'error',
            `${toll.inRegion} toll cameras in region and not one resolved to a live stream`,
            ["neither BPJT's own urls nor the (road, KM) join produced anything — check the page formats"]);
        report.fail(check, 'nothing resolved');
        return;
    }

    report.pass(check, [`${resolved} resolved`, ...detail].join(', '));
}

function freshness(snapshots, report) {
    const check = 'snapshot-freshness';

    if (!snapshots.length) {
        report.add(check, 'warning', 'no snapshot provenance supplied — cannot judge freshness');
        report.fail(check, 'unknown');
        return;
    }

    const stale = snapshots.filter(s => s.ageDays >= STALE_WARN_DAYS),
        dead = snapshots.filter(s => s.ageDays >= STALE_ERROR_DAYS);

    if (dead.length) {
        report.add(check, 'error',
            `${dead.length} sources have not been refetched in ${STALE_ERROR_DAYS} days`,
            dead.map(s => `${s.source}: ${s.date} (${s.ageDays}d)`));
    } else if (stale.length) {
        report.add(check, 'warning',
            `${stale.length} sources older than ${STALE_WARN_DAYS} days`,
            stale.map(s => `${s.source}: ${s.date} (${s.ageDays}d)`));
    }

    if (dead.length) {
        report.fail(check, `${dead.length} dead`);
    } else {
        report.pass(check, snapshots.map(s => `${s.source}=${s.ageDays}d`).join(' '));
    }
}

function drift(dataset, previous, report) {
    const check = 'volume-drift';

    if (!previous) {
        report.pass(check, 'no previous build to compare against');
        return;
    }

    const current = counts(dataset),
        moved = [];
    let worst = 0;

    // Adding a mode moves every total at once, and that is intent rather than
    // breakage. Drift is only meaningful across builds covering the same modes,
    // so a change in the mode set resets the comparison instead of drowning the
    // check in a change we asked for.
    if (previous.modes === undefined) {
        report.pass(check, 'previous build predates mode tracking — baseline reset');
        return;
    }
    if (previous.modes !== current.modes) {
        report.pass(check, `mode set changed (${previous.modes} -> ${current.modes}) — baseline reset`);
        return;
    }

    for (const key of Object.keys(current)) {
        const was = previous[key];

        if (!was) {
            continue;
        }

        const change = (current[key] - was) / was;

        worst = Math.max(worst, Math.abs(change));
        if (Math.abs(change) >= DRIFT_WARN) {
            moved.push(`${key}: ${was} -> ${current[key]} (${(change * 100).toFixed(1)}%)`);
        }
    }

    if (worst >= DRIFT_ERROR) {
        report.add(check, 'error', `volumes moved by more than ${DRIFT_ERROR * 100}% since the last build`, moved);
        report.fail(check, `${(worst * 100).toFixed(1)}% worst`);
    } else if (moved.length) {
        report.add(check, 'warning', 'volumes moved noticeably since the last build', moved);
        report.pass(check, `${(worst * 100).toFixed(1)}% worst`);
    } else {
        report.pass(check, 'stable');
    }
}

export function counts(dataset) {
    return {
        modes: new Set(dataset.routes.map(r => r.mode)).size,
        agencies: dataset.agencies.length,
        routes: dataset.routes.length,
        stations: dataset.stations.length,
        stops: dataset.stops.length,
        patterns: dataset.patterns.length,
        trips: dataset.trips.length,
        shapes: dataset.shapes.length,
        transfers: dataset.transfers.length,
        cameras: (dataset.cameras ?? []).length
    };
}

// ---------------------------------------------------------------------------

function fmt(seconds) {
    const s = ((seconds % 86400) + 86400) % 86400,
        day = seconds >= 86400 ? '+1d ' : '';

    return `${day}${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Local planar approximation at Jakarta's latitude; accurate to well under a
// metre over the distances this check cares about, and far cheaper than
// haversine across every vertex of every shape.
const M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

/** Equirectangular, which is exact enough at the few hundred metres this
    file measures and much cheaper than haversine. */
function metres(latA, lonA, latB, lonB) {
    return Math.hypot((latA - latB) * M_PER_DEG_LAT, (lonA - lonB) * M_PER_DEG_LON);
}

function distanceToPolyline(lat, lon, coords) {
    let best = Infinity;

    for (let i = 0; i < coords.length - 2; i += 2) {
        const d = distanceToSegment(
            (lon - coords[i]) * M_PER_DEG_LON, (lat - coords[i + 1]) * M_PER_DEG_LAT,
            0, 0,
            (coords[i + 2] - coords[i]) * M_PER_DEG_LON, (coords[i + 3] - coords[i + 1]) * M_PER_DEG_LAT
        );

        if (d < best) {
            best = d;
        }
    }
    return best;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax,
        dy = by - ay,
        lengthSquared = dx * dx + dy * dy;

    if (!lengthSquared) {
        return Math.hypot(px - ax, py - ay);
    }

    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));

    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Printable summary, used by the transform runner and the tests alike.
export function formatReport(report) {
    const lines = [];

    for (const {check, status, detail} of report.checks) {
        lines.push(`  ${status === 'pass' ? '✓' : '✗'} ${check.padEnd(20)} ${detail}`);
    }
    for (const entry of [...report.errors, ...report.warnings]) {
        lines.push(`  ${entry.level === 'error' ? 'ERROR' : 'warn '} ${entry.check}: ${entry.message}`);
        for (const sample of entry.sample) {
            lines.push(`        ${sample}`);
        }
    }
    return lines.join('\n');
}
