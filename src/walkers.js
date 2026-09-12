/**
 * People on the pavements (JAKAR-79).
 *
 * Six thousand vehicles move through a city with nobody in it, and at street
 * level the emptiness is what you notice. This puts a crowd on the footways —
 * decoration, deliberately, and the only thing on this map not derived from a
 * timetable.
 *
 * ## Where they are allowed to walk, and the answer that did not work
 *
 * The ticket said this was already solved: the walk table is 40,466 edges
 * really routed through Valhalla (JAKAR-40), so walkers on those paths are on
 * real pavement. It is not solved, for two reasons found in that order.
 *
 * **The routes were never kept.** Valhalla's matrix endpoint answers with a
 * time and a distance per pair and no geometry at all — `sources_to_targets`
 * carries `time`, `distance` and the snapped endpoints, nothing between them.
 * We know how long each real path is and not where it runs.
 *
 * What looked like a way out: the table cannot say where a path goes, but it
 * can say which *straight lines* are honest. An edge whose routed length is
 * within 15% of the straight line between its stops has no room in it for a
 * detour. That selects 14,569 edges whose true detour factor is p50 1.02, p99
 * 1.16, max 1.21 — measured against the real distances — and it excludes every
 * barrier case the routing was bought to find, Sentul to Simpang Sentul being
 * 62 m apart and 2,579 m on foot.
 *
 * **It was built, and it put people on live railway tracks.** At Tanah Abang,
 * `Tanah Abang -> Jln. Taman Jatibaru Timur` is 395 m apart with a true detour
 * factor of **1.04**, and the real route is the Jatibaru bridge, which runs
 * nearly parallel to the straight line. Same length, different ground. The
 * lesson outlasts the code that taught it: **a length test cannot tell you a
 * line is on the ground.** Forty people standing in a rail yard is exactly the
 * kind of claim this map does not make.
 *
 * ## What it does instead
 *
 * Route shapes. They are OSM ways that vehicles are driven along, so they are
 * on the ground by construction, and the error left is a few metres of lateral
 * offset rather than a city block. A walker is positioned exactly as a vehicle
 * is — a shape and a distance along it, through `network.locate` — and then
 * pushed sideways to the kerb.
 *
 * Which shapes is a decision, and the categories differ:
 *
 * - **In: Mikrotrans, Integrasi, Rusun, Bus Wisata.** 440 of 740 shapes,
 *   7,470 km of surface street. Mikrotrans especially — 98 routes of ordinary
 *   Jakarta side streets, which is what a pavement runs beside.
 * - **Out: BRT Koridor.** A corridor shape is the *median* busway, so the kerb
 *   is two carriageways away and a few metres sideways is the middle of moving
 *   traffic.
 * - **Out: Royaltrans and Transjabodetabek.** These spend the journey on a
 *   toll road, where there is no pavement and nobody may walk.
 * - **Out: every rail mode.** A viaduct, a tunnel, or a running line.
 *
 * Measured in view: 6.6 km of eligible street at Bundaran HI, 15 km at Blok M,
 * 24 km at Tanah Abang, 10.7 km at Kelapa Gading — hundreds of people each.
 * **Nothing at Bekasi or Bogor**, where Transjakarta runs no street service and
 * the map therefore holds no surface geometry at all; those are KRL and
 * Transjabodetabek territory. The crowd is where Jakarta's street network is
 * drawn, which is true rather than a bug.
 */

// Metres per second. The p50 of the routed walk table (4.97 km/h), which is
// also what JAKAR-45 measured over 400 sampled pairs — so the crowd walks at
// the speed the network's own transfer times are built on.
const WALK_SPEED = 1.382;

/*
   Which categories are surface streets a person may stand beside. See the
   header: this is the judgement the whole feature rests on, and the exclusions
   matter more than the inclusions.
*/
const STREET_CATEGORIES = new Set([
    'Mikrotrans',
    'Angkutan Umum Integrasi',
    'Rusun',
    'Bus Wisata'
]);

// One person per this much street. Jakarta's footways are busier; the map is
// not a crowd simulation, and a close queue of identical figures reads as a
// conveyor belt rather than as a city.
const METRES_PER_WALKER = 16;

// The ceiling on how many are drawn at once. Past it the crowd is thinned
// rather than truncated — filling street by street until the cap ran out was
// the first version, and it put all 800 people on the first few streets while
// the rest of the view stayed empty.
const CAPACITY = 800;

// A run of street shorter than this is not worth a walker: it is a stub at the
// edge of the view, or a corner clipped by the box test.
const MIN_SPAN_METRES = 30;

/*
   The zoom band, and why it is deeper than "street level".

   A person is not a small bus: at Jakarta's latitude a 1.7 m figure is 1.4 px
   tall at z16, **2.5 px at z16.8** — the zoom JAKAR-58 and JAKAR-60 both call
   street level — 5.7 px at z18 and 11.5 px at z19. Below this band they are
   sub-pixel grit on the basemap, and they cannot be inflated the way vehicles
   are below `trueScaleZoom`: an 11x person is a giant standing over the buses.

   So the band starts where true scale is legible rather than where the project
   happens to benchmark, and they scale in across a third of a zoom level
   rather than appearing all at once.
*/
const MIN_ZOOM = 17.2
    , FULL_ZOOM = 17.6;

/*
   How far beyond the viewport to select, as a fraction of its size.

   This is what makes the wrap invisible. A walker paces the in-view run of its
   own street and returns to the start on reaching the end, which is a
   teleport — so the runs are cut at the edge of a padded box, and every wrap
   happens off screen.
*/
const VIEW_PAD = 0.4;

// Re-select when the view has moved this fraction of its own width, or this
// much zoom. A pass over the eligible shapes is nothing per camera move and
// far too much sixty times a second.
const RESELECT_FRACTION = 0.22
    , RESELECT_ZOOM = 0.25;

// How far off the centreline a walker stands, in metres: a Mikrotrans street
// is a narrow carriageway, so this is the kerb rather than a guess at a road
// width. It is also the whole remaining error in a walker's position.
const KERB_MIN = 2.6
    , KERB_SPAN = 2.2;

// A stride, in metres, and how far the body rises on each one.
const STEP_LENGTH = 0.78
    , BOB = 0.035;

/*
   Mercator units per metre at Jakarta's latitude.

   The city spans about 0.9 degrees, over which `cos(lat)` moves from 0.9945 to
   0.9948, so one constant is exact to four decimal places across the whole
   map — and the alternative is converting a Mercator y back to a latitude for
   every walker, every frame, to learn nothing.
*/
const MERC_PER_METRE = 1 / (40075017 * 0.9942);

/*
   How much faster than life the crowd may be driven.

   The fleet obeys the clock exactly, at up to 1200x, because a vehicle has a
   timetable and being somewhere at a stated time is the whole point of it. A
   walker has no schedule and is not anywhere in particular, so there is
   nothing to be faithful to — and at 1200x a pedestrian crosses the frame
   inside one frame, which reads as flicker rather than as walking. They still
   stop dead when the clock is paused, because a city that kept moving while
   the clock was held would be a lie about what the pause means.
*/
const MAX_RATE = 8;

/**
 * A cheap deterministic hash, so every trait of a walker follows from which
 * walker it is.
 *
 * The in-view set is rebuilt whenever the camera moves far enough, and traits
 * drawn from a running generator would reshuffle the whole crowd each time —
 * everybody changing pace and side of the street mid-pan. Keyed by span and
 * index instead, and position is a function of the clock rather than
 * accumulated state, so nothing drifts and nothing has to be kept in step.
 */
function hash(a, b) {
    let h = (a * 0x27d4eb2d) ^ (b * 0x165667b1);

    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
}

export default class Walkers {

    constructor(network) {
        const me = this;

        me.network = network;
        me.count = 0;

        // The walker clock, in walked seconds. One scalar for the whole crowd:
        // a position is a function of it and of the walker's own traits, so
        // there is no per-walker state to keep in step or let drift.
        me.time = 0;

        // Eligible shapes and their bounding boxes, built once.
        me.streets = null;

        // The in-view selection: runs of street, as distances along a shape.
        me._spanShape = [];
        me._spanFrom = [];
        me._spanTo = [];

        // Which span each walker paces, and which walker of that span it is.
        me.spanOf = new Int32Array(CAPACITY);
        me.indexOf = new Int32Array(CAPACITY);

        // Per frame, read by the layer.
        me.mercX = new Float64Array(CAPACITY);
        me.mercY = new Float64Array(CAPACITY);
        me.bearing = new Float32Array(CAPACITY);
        me.lift = new Float32Array(CAPACITY);
        me.pose = new Uint8Array(CAPACITY);
        // Clothing hue, 0..1. A trait like any other, so it lives here rather
        // than in the layer: derived in the layer from Mercator x it barely
        // varied at all, because a street-level viewport spans about 1e-5 of
        // it and the whole crowd came out one colour.
        me.tint = new Float32Array(CAPACITY);
        me.scale = 0;

        // `locate` walks forward from a hint, so remembering where each walker
        // was last frame keeps it to a step or two. A stale hint is safe — it
        // restarts from the beginning of the shape when one does not hold.
        me._hint = new Int32Array(CAPACITY);
        me._at = null;
        me._zoom = -1;
        me._out = {x: 0, y: 0, bearing: 0, vertex: 0};
    }

    /**
     * Collects the shapes a person may walk beside, once.
     *
     * Lazy, because this is a layer somebody may never switch on, and a
     * bounding box per shape is a pass over every vertex the network holds.
     */
    build() {
        const me = this,
            {network} = me;

        if (me.streets) {
            return me;
        }

        const wanted = new Set();

        for (const trip of network.trips) {
            const route = network.routes.get(trip.route);

            if (trip.shape && route && STREET_CATEGORIES.has(route.category)) {
                wanted.add(trip.shape.id);
            }
        }

        const shapes = [],
            box = [];

        for (const id of wanted) {
            const shape = network.shapes.get(id);

            if (!shape || shape.count < 2) {
                continue;
            }

            let minX = Infinity,
                maxX = -Infinity,
                minY = Infinity,
                maxY = -Infinity;

            for (let i = 0; i < shape.count; i++) {
                const x = network.merc[(shape.start + i) * 2],
                    y = network.merc[(shape.start + i) * 2 + 1];

                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
            shapes.push(shape);
            box.push(minX, maxX, minY, maxY);
        }

        me.streets = {shapes, box: Float64Array.from(box)};
        return me;
    }

    /** Nobody, without discarding the shape table. */
    clear() {
        this.count = 0;
        this._at = null;
        return this;
    }

    /**
     * Advances the crowd and, when the camera has moved far enough, rebuilds
     * which runs of street are in view.
     *
     * @param map        the map, for its viewport
     * @param simulated  elapsed *simulated* seconds since the last frame
     * @param real       elapsed real seconds, which is what caps the pace
     */
    update(map, simulated, real) {
        const me = this,
            zoom = map.getZoom();

        if (zoom < MIN_ZOOM) {
            return me.clear();
        }

        me.build();
        if (!me.streets.shapes.length) {
            return me.clear();
        }

        // Paused stays paused; otherwise the clock's own delta, up to
        // `MAX_RATE` times life. Never backwards: position is a function of
        // this, and scrubbing the clock back would walk the whole crowd in
        // reverse — which vehicles on this map genuinely do and people do not.
        me.time += Math.max(0, Math.min(simulated, real * MAX_RATE));

        me.scale = Math.min(1, Math.max(0,
            (zoom - MIN_ZOOM) / (FULL_ZOOM - MIN_ZOOM)));

        me._select(map, zoom);
        me._place();
        return me;
    }

    /** Rebuilds the in-view runs of street, if the view has moved enough. */
    _select(map, zoom) {
        const me = this,
            bounds = map.getBounds(),
            centre = map.getCenter(),
            width = bounds.getEast() - bounds.getWest(),
            at = me._at;

        if (at &&
            Math.abs(zoom - me._zoom) < RESELECT_ZOOM &&
            Math.abs(centre.lng - at.lng) < width * RESELECT_FRACTION &&
            Math.abs(centre.lat - at.lat) < width * RESELECT_FRACTION) {
            return;
        }
        me._at = {lng: centre.lng, lat: centre.lat};
        me._zoom = zoom;

        const {network} = me,
            {shapes, box} = me.streets,
            cum = network.cum,
            merc = network.merc,
            padLon = width * (0.5 + VIEW_PAD),
            padLat = (bounds.getNorth() - bounds.getSouth()) * (0.5 + VIEW_PAD),
            west = mercX(centre.lng - padLon),
            east = mercX(centre.lng + padLon),
            // Mercator y grows southward, so the northern edge is the smaller.
            north = mercY(Math.min(85, centre.lat + padLat)),
            south = mercY(Math.max(-85, centre.lat - padLat)),
            spanShape = me._spanShape,
            spanFrom = me._spanFrom,
            spanTo = me._spanTo;

        spanShape.length = 0;
        spanFrom.length = 0;
        spanTo.length = 0;

        let total = 0;

        for (let s = 0; s < shapes.length; s++) {
            // The shape's own box first: most of the network is nowhere near a
            // street-level viewport, and this rejects it in four comparisons.
            if (box[s * 4] > east || box[s * 4 + 1] < west ||
                box[s * 4 + 2] > south || box[s * 4 + 3] < north) {
                continue;
            }

            const {start, count} = shapes[s];
            let runFrom = -1;

            for (let i = 0; i <= count; i++) {
                const inside = i < count &&
                    merc[(start + i) * 2] > west &&
                    merc[(start + i) * 2] < east &&
                    merc[(start + i) * 2 + 1] > north &&
                    merc[(start + i) * 2 + 1] < south;

                if (inside) {
                    if (runFrom < 0) {
                        runFrom = i;
                    }
                    continue;
                }
                if (runFrom < 0) {
                    continue;
                }

                // `cum` is kilometres along the shape, which is what `locate`
                // takes; the spacing is in metres.
                const from = cum[start + runFrom],
                    to = cum[start + i - 1];

                if ((to - from) * 1000 >= MIN_SPAN_METRES) {
                    spanShape.push(s);
                    spanFrom.push(from);
                    spanTo.push(to);
                    total += (to - from) * 1000;
                }
                runFrom = -1;
            }
        }

        // Thin the crowd rather than truncate it: a dense interchange asks for
        // 1,300 walkers, and 800 spread over all of its streets is a city that
        // looks a little less busy, where filling the first streets to the cap
        // is a city with three crowded blocks and nothing past them.
        const spacing = Math.max(METRES_PER_WALKER, total / CAPACITY);
        let n = 0;

        for (let i = 0; i < spanShape.length && n < CAPACITY; i++) {
            const metres = (spanTo[i] - spanFrom[i]) * 1000,
                many = Math.max(1, Math.round(metres / spacing));

            for (let k = 0; k < many && n < CAPACITY; k++) {
                me.spanOf[n] = i;
                me.indexOf[n] = k;
                me._hint[n] = 0;
                n++;
            }
        }
        me.count = n;
    }

    /** Puts every walker where the clock says it is. */
    _place() {
        const me = this,
            {network, count, time, _out: out} = me,
            {shapes} = me.streets,
            spanShape = me._spanShape,
            spanFrom = me._spanFrom,
            spanTo = me._spanTo;

        for (let i = 0; i < count; i++) {
            const s = me.spanOf[i],
                k = me.indexOf[i],
                shape = shapes[spanShape[s]],
                from = spanFrom[s],
                to = spanTo[s],
                metres = (to - from) * 1000,

                // Traits, from which walker this is rather than from a
                // generator: where along the run it started, which way it is
                // going, how briskly, and which side of the street.
                seed = hash(s, k),
                side = hash(s, k + 9973) < 0.5 ? -1 : 1,
                back = hash(s, k + 4441) < 0.5,
                pace = WALK_SPEED * (0.86 + 0.3 * hash(s, k + 7717)),
                kerb = (KERB_MIN + KERB_SPAN * hash(s, k + 1259)) * side,

                walked = time * pace + seed * metres,
                // Wrapped within the run, which was cut at the edge of the
                // padded box — so the wrap itself happens off screen.
                along = walked % metres,
                km = back ? to - along / 1000 : from + along / 1000;

            network.locate(shape, km, me._hint[i], out);
            me._hint[i] = out.vertex;

            // Mercator y grows southward, so the unit vector along a compass
            // bearing is (sin, -cos) and its right-hand normal is (cos, sin).
            const bearing = back ? out.bearing + Math.PI : out.bearing,
                offset = kerb * MERC_PER_METRE,
                step = walked / STEP_LENGTH;

            me.mercX[i] = out.x + Math.cos(bearing) * offset;
            me.mercY[i] = out.y + Math.sin(bearing) * offset;
            me.bearing[i] = bearing;

            // One rise per footfall, and a pose held for one whole step —
            // `step` counts footfalls, so a stride is two of them and the legs
            // alternate on its parity.
            me.lift[i] = BOB * (1 - Math.cos(step * 2 * Math.PI)) / 2;
            me.pose[i] = (step % 2) < 1 ? 0 : 1;
            me.tint[i] = hash(s, k + 3313);
        }
    }

}

/** Web Mercator in [0, 1], the space the vehicle layer positions in. */
function mercX(lon) {
    return (lon + 180) / 360;
}

function mercY(lat) {
    const sin = Math.sin(lat * Math.PI / 180);

    return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

export {CAPACITY as WALKER_CAPACITY, MIN_ZOOM as WALKER_MIN_ZOOM, MAX_RATE as WALKER_MAX_RATE};
