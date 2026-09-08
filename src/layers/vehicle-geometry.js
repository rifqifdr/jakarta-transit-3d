import {BufferGeometry, Float32BufferAttribute} from 'three';
import configs from '../configs';

/**
 * The Kapsul body (JAKAR-49): a rounded shell with a tapered nose and a window
 * band, built once per mode and drawn by `vehicle-layer.js` as one instanced
 * mesh per mode.
 *
 * Two constraints shape everything here.
 *
 * **The window band is vertex colour, not a second mesh.** The fleet is drawn
 * instanced — ~6,000 vehicles where only the matrix and the colour vary — so a
 * second object would multiply draw calls by the fleet size. Three multiplies
 * the geometry's `color` attribute into the per-instance colour, which means a
 * darker band can be baked into the geometry and still come out tinted by
 * whichever category colour the instance is wearing.
 *
 * **Every mode is built inside the same base box.** `configs.vehicleWidth x
 * vehicleLength x vehicleHeight` is what the zoom inflation divides by
 * (JAKAR-39), so a geometry that outgrew it would draw a 160 m train 1.8 km
 * long. Modes differ in *shape* — how much of the length is nose, how many cars
 * the window band is broken into — never in size. Size stays in `configs.modes`.
 */

// How much of the instance colour each surface keeps. These multiply, so they
// can only darken — which is all that is wanted: glass is the body colour with
// the light taken out of it, and it stays legible whatever the category colour.
//
// The multiply happens in linear space, not sRGB, so these read darker than the
// same numbers picked in a colour picker.
const BODY = 1
    , GLASS = 0.34
    , UNDER = 0.5
    // Every coupling, drawn right around the body rather than only along the
    // window band. The map is pitched, so what a 160 m train shows is mostly
    // roof: a band confined to its sides is under a pixel high at any zoom the
    // whole formation fits in, and the train reads as a painted bar. Segmented
    // across the roof it reads as a train from the same distance.
    , COUPLING = 0.52;

// Where the nose is sampled, as a fraction of its length from the tip. Denser
// at the tip because that is where the profile turns hardest.
const NOSE_SAMPLES = [0, 0.28, 0.62, 1]
    , NOSE_SAMPLES_RAIL = [0, 0.45, 1];

/**
 * Per mode, in fractions of the base box. `cars` is the new dimension the
 * ticket asks for: a train's window band is broken at every coupling, which is
 * what stops a 160 m KRL set reading as one very long bus.
 *
 * `nose` is a fraction of the *whole* length, so it shrinks on rail by design —
 * a cab is four metres of a 160 m formation, and drawing it proportionally to a
 * bus's would give the train a wedge for a front end.
 *
 * The window band's own height is worth stating in fractions before touching it:
 * `windowLow` to `1 - roofRadius - windowTop` is the whole of it, and a first
 * pass that left rail with 8% of the body height drew a band no wider than an
 * anti-aliased line. A quarter to a third of the height is what reads as a
 * window.
 */
const SPECS = {
    bus: {
        nose: 0.15, tail: 0.09, tipX: 0.46, tipZ: 0.68,
        roofRadius: 0.30, floorRadius: 0.15,
        windowLow: 0.36, windowTop: 0.02,
        cars: 1, carWindow: 0.88, samples: NOSE_SAMPLES
    },
    // 8 x 20 m, the common KRL formation — the same one `configs.modes` sizes.
    commuter_rail: {
        nose: 0.028, tail: 0.028, tipX: 0.58, tipZ: 0.74,
        roofRadius: 0.34, floorRadius: 0.11,
        windowLow: 0.40, windowTop: 0.02,
        cars: 8, carWindow: 0.72, samples: NOSE_SAMPLES_RAIL
    },
    // MRT Jakarta: six cars.
    metro: {
        nose: 0.036, tail: 0.036, tipX: 0.52, tipZ: 0.70,
        roofRadius: 0.36, floorRadius: 0.11,
        windowLow: 0.41, windowTop: 0.02,
        cars: 6, carWindow: 0.74, samples: NOSE_SAMPLES_RAIL
    },
    // Four, splitting LRT Jakarta's two and Jabodebek's six the same way
    // `configs.modes` splits their lengths.
    light_rail: {
        nose: 0.05, tail: 0.05, tipX: 0.54, tipZ: 0.72,
        roofRadius: 0.34, floorRadius: 0.11,
        windowLow: 0.40, windowTop: 0.02,
        cars: 4, carWindow: 0.74, samples: NOSE_SAMPLES_RAIL
    }
};

// A half-ellipse: 0 at the tip, 1 at the base, and steep where it leaves the
// tip. A linear taper gives a wedge; this gives the rounded end the name is for.
const round = u => Math.sqrt(1 - (1 - u) * (1 - u));

const near = (a, b) => Math.abs(a - b) < 1e-6;

/** Arc points, excluding the first — the caller has already placed it. */
function arc(points, cx, cz, r, from, to, segments) {
    for (let i = 1; i <= segments; i++) {
        const a = from + (to - from) * i / segments;

        points.push({x: cx + r * Math.cos(a), z: cz + r * Math.sin(a)});
    }
}

/**
 * The cross-section, normalised to x in [-1, 1] and z in [0, 1] and traversed
 * counter-clockwise from the right-hand side. Counter-clockwise is what makes
 * the strip winding below come out facing outwards.
 *
 * The window band's own z bounds are points on the section rather than
 * something clipped later: colour is assigned per strip, so the band can only
 * have a hard edge where there is an edge to put it on.
 */
function crossSection({roofRadius: rt, floorRadius: rb, windowLow, windowTop}) {
    const windowHigh = 1 - rt - windowTop
        , points = [];

    points.push({x: 1, z: rb}, {x: 1, z: windowLow}, {x: 1, z: windowHigh}, {x: 1, z: 1 - rt});
    arc(points, 1 - rt, 1 - rt, rt, 0, Math.PI / 2, 3);
    points.push({x: -(1 - rt), z: 1});
    arc(points, -(1 - rt), 1 - rt, rt, Math.PI / 2, Math.PI, 3);
    points.push({x: -1, z: windowHigh}, {x: -1, z: windowLow}, {x: -1, z: rb});
    arc(points, -(1 - rb), rb, rb, Math.PI, Math.PI * 1.5, 2);
    points.push({x: 1 - rb, z: 0});
    arc(points, 1 - rb, rb, rb, Math.PI * 1.5, Math.PI * 2, 2);
    // That last arc closes on the point it started from.
    points.pop();

    return {points, windowLow, windowHigh};
}

/**
 * Rings along the length, and what the strip after each one is: BODY, GLASS
 * along the window band, or COUPLING right around.
 *
 * Both cabs are glass, and so is the middle of every car. What falls between
 * two cars is the coupling; what falls between a cab and the first window is
 * body, which is the pillar behind the driver.
 */
function rings(spec) {
    const {nose, tail, tipX, tipZ, cars, carWindow, samples} = spec
        , yNose = 1 - 2 * nose
        , yTail = -1 + 2 * tail
        , out = []
        , glassSpans = [[yNose, 1], [-1, yTail]]
        , couplings = [];

    for (const u of samples) {
        const e = round(u);

        // u is measured from the tip, so u = 0 is the point of each end.
        out.push({y: 1 - u * 2 * nose, sx: tipX + (1 - tipX) * e, sz: tipZ + (1 - tipZ) * e});
        out.push({y: -1 + u * 2 * tail, sx: tipX + (1 - tipX) * e, sz: tipZ + (1 - tipZ) * e});
    }

    const carLength = (yNose - yTail) / cars
        , margin = carLength * (1 - carWindow) / 2;

    for (let c = 0; c < cars; c++) {
        const y0 = yTail + c * carLength + margin
            , y1 = yTail + (c + 1) * carLength - margin;

        out.push({y: y0, sx: 1, sz: 1}, {y: y1, sx: 1, sz: 1});
        glassSpans.push([y0, y1]);
        if (c) {
            couplings.push([yTail + c * carLength - margin, y0]);
        }
    }

    out.sort((a, b) => a.y - b.y);

    const unique = out.filter((r, i) => i === 0 || !near(r.y, out[i - 1].y))
        , spans = [];

    for (let j = 0; j < unique.length - 1; j++) {
        const mid = (unique[j].y + unique[j + 1].y) / 2
            , within = ([a, b]) => mid > a && mid < b;

        spans.push(couplings.some(within) ? COUPLING
            : glassSpans.some(within) ? GLASS
                : BODY);
    }

    return {rings: unique, spans};
}

/**
 * Builds one mode's body.
 *
 * Normals are accumulated over the shared grid and only then flattened into
 * unindexed triangles. Colour is per strip, so vertices cannot be shared across
 * the band edge — but shading has to stay smooth over a rounded shell, and
 * `computeVertexNormals()` on unindexed geometry would facet the whole thing.
 */
function build(spec) {
    const {points: section, windowLow, windowHigh} = crossSection(spec)
        , S = section.length
        , {rings: ring, spans} = rings(spec)
        , M = ring.length
        , halfWidth = configs.vehicleWidth / 2
        , halfLength = configs.vehicleLength / 2
        , height = configs.vehicleHeight
        , total = M * S + 2
        , px = new Float32Array(total)
        , py = new Float32Array(total)
        , pz = new Float32Array(total)
        , nx = new Float32Array(total)
        , ny = new Float32Array(total)
        , nz = new Float32Array(total);

    for (let j = 0; j < M; j++) {
        const {y, sx, sz} = ring[j];

        for (let i = 0; i < S; i++) {
            const v = j * S + i;

            px[v] = section[i].x * sx * halfWidth;
            py[v] = y * halfLength;
            pz[v] = section[i].z * sz * height;
        }
    }

    // The cap centres, at the middle of the ring they close.
    const rear = M * S
        , front = M * S + 1;

    px[rear] = 0;
    py[rear] = ring[0].y * halfLength;
    pz[rear] = 0.5 * ring[0].sz * height;
    px[front] = 0;
    py[front] = ring[M - 1].y * halfLength;
    pz[front] = 0.5 * ring[M - 1].sz * height;

    const faces = [];

    // Strips. With the section counter-clockwise and rings ascending in y,
    // this winding faces outwards; the mirror of it faces into the body and
    // is culled, which looks exactly like a vehicle that failed to draw.
    for (let j = 0; j < M - 1; j++) {
        for (let i = 0; i < S; i++) {
            const i2 = (i + 1) % S
                , a = j * S + i
                , a2 = j * S + i2
                , b = (j + 1) * S + i
                , b2 = (j + 1) * S + i2;

            faces.push([a, b, b2, j, i], [a, b2, a2, j, i]);
        }
    }
    for (let i = 0; i < S; i++) {
        const i2 = (i + 1) % S
            , last = (M - 1) * S;

        faces.push([rear, i, i2, -1, -1]);
        faces.push([front, last + i2, last + i, -1, -1]);
    }

    for (const [a, b, c] of faces) {
        const ux = px[b] - px[a], uy = py[b] - py[a], uz = pz[b] - pz[a]
            , vx = px[c] - px[a], vy = py[c] - py[a], vz = pz[c] - pz[a]
            , fx = uy * vz - uz * vy
            , fy = uz * vx - ux * vz
            , fz = ux * vy - uy * vx;

        for (const v of [a, b, c]) {
            nx[v] += fx;
            ny[v] += fy;
            nz[v] += fz;
        }
    }
    for (let v = 0; v < total; v++) {
        const len = Math.hypot(nx[v], ny[v], nz[v]) || 1;

        nx[v] /= len;
        ny[v] /= len;
        nz[v] /= len;
    }

    // Which surface a strip is, decided on the section edge it leaves from.
    const kind = i => {
        const a = section[i]
            , b = section[(i + 1) % S];

        if (near(a.z, 0) && near(b.z, 0)) {
            return UNDER;
        }
        if (near(Math.abs(a.x), 1) && near(a.x, b.x) &&
            Math.min(a.z, b.z) >= windowLow - 1e-6 &&
            Math.max(a.z, b.z) <= windowHigh + 1e-6) {
            return GLASS;
        }
        return BODY;
    };

    const strip = [];

    for (let i = 0; i < S; i++) {
        strip.push(kind(i));
    }

    const position = []
        , normal = []
        , colour = [];

    for (const [a, b, c, j, i] of faces) {
        // A cap is body. Elsewhere the strip's own surface decides, except that
        // glass only counts where the span says there is a window, and a
        // coupling darkens whatever it crosses.
        const surface = j < 0 ? BODY
                : strip[i] === GLASS && spans[j] !== GLASS ? BODY
                    : strip[i]
            , tint = j >= 0 && spans[j] === COUPLING ? Math.min(surface, COUPLING) : surface;

        for (const v of [a, b, c]) {
            position.push(px[v], py[v], pz[v]);
            normal.push(nx[v], ny[v], nz[v]);
            colour.push(tint, tint, tint);
        }
    }

    const geometry = new BufferGeometry();

    geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colour, 3));

    return geometry;
}

/**
 * One mode's body geometry. Anything unlabelled gets the bus, which is also
 * every vehicle on the legacy bus-only path.
 */
export default function vehicleGeometry(mode) {
    return build(SPECS[mode] ?? SPECS.bus);
}

export {SPECS};
