import {BufferGeometry, Float32BufferAttribute} from 'three';
import configs from '../configs';

/**
 * A person, low-poly, in the same idiom as the Kapsul bodies (JAKAR-79).
 *
 * Four parts — two legs, a torso, a head — as frustums, 48 triangles in all.
 * That is deliberately austere, and the reason is a measurement rather than a
 * budget: at Jakarta's latitude a 1.7 m person is **2.5 px tall at z16.8**, the
 * zoom this project calls street level, 5.7 px at z18 and 11.5 px at z19.
 * Detail below a pixel is not modesty, it is noise with a triangle cost — the
 * same lesson as the window band on a 160 m train, which was under a pixel high
 * at every zoom the formation fitted in.
 *
 * What does read at that size is a small upright mark, lighter on top, moving
 * along a pavement. So the shape spends its triangles on the silhouette:
 * shoulders wider than the waist, a head narrower again, legs apart.
 *
 * Two conventions are inherited from `vehicle-geometry.js` and matter:
 *
 * **Tint is vertex colour, and it can only darken.** Three multiplies the
 * geometry's `color` attribute into the per-instance colour, so the instance
 * carries the clothing colour and everything else is that colour with light
 * taken out of it. The torso is therefore 1.0 — it is the lightest part, which
 * is what puts the eye on the body rather than the shoes.
 *
 * **Everything is built inside one base box.** `configs.walker` is the box;
 * the layer scales by it and knows nothing of the shape, exactly as the fleet's
 * per-mode inflation divides by its own base box.
 */

// How much of the instance colour each part keeps. Multiplied in linear space,
// so these read darker than the same numbers picked by eye.
const SHIRT = 1
    , HEAD = 0.74
    // Trousers and shoes, which is also the half in shadow under a pitched
    // camera — the darker foot end is most of what says "standing up".
    , LEGS = 0.46;

/*
   The figure, in fractions of the base box: z along the height, x across the
   width, y through the depth. Feet at z = 0, facing +Y, which is the same
   convention the vehicles are modelled in (nose first along +Y) so one
   bearing rotation serves both.
*/
const HIP = 0.47
    , SHOULDER = 0.83
    , CHIN = 0.85;

// How far a leg swings from vertical, in radians. A real walk is nearer 25
// degrees at the hip, and this is less: the pose is held for half a stride
// rather than swept through, so the extremes are what is seen the whole time.
const STRIDE = 0.22;

/**
 * One frustum's twelve triangles, pitched about a pivot on the z axis.
 *
 * Flat normals per face, unlike the vehicle shell: there is no rounded surface
 * here to keep smooth, and at five pixels a shared normal would buy nothing.
 */
function prism(out, {x, z0, z1, w0, w1, d0, d1, tilt = 0, pivot = 0, tint}) {
    const cos = Math.cos(tilt)
        , sin = Math.sin(tilt)

        // Corners of the two rings, before the pitch: bottom then top,
        // counter-clockwise seen from above so the side strips face outwards.
        , ring = (z, w, d) => [
            {x: x + w / 2, y: d / 2, z},
            {x: x - w / 2, y: d / 2, z},
            {x: x - w / 2, y: -d / 2, z},
            {x: x + w / 2, y: -d / 2, z}
        ]
        , pitch = p => {
            const dz = p.z - pivot;

            return {
                x: p.x,
                // Rotation about the x axis, so a swung leg puts its foot
                // forward in y and lifts it slightly — which is what a leg
                // mid-stride actually does.
                y: p.y * cos - dz * sin,
                z: pivot + p.y * sin + dz * cos
            };
        }
        , bottom = ring(z0, w0, d0).map(pitch)
        , top = ring(z1, w1, d1).map(pitch)
        , faces = [];

    for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;

        faces.push([bottom[i], top[i], top[j]], [bottom[i], top[j], bottom[j]]);
    }
    // Caps. The top ring is counter-clockwise from above, so the underside
    // takes it reversed.
    faces.push([top[0], top[1], top[2]], [top[0], top[2], top[3]]);
    faces.push([bottom[2], bottom[1], bottom[0]], [bottom[3], bottom[2], bottom[0]]);

    for (const [a, b, c] of faces) {
        const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
            , vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
            , fx = uy * vz - uz * vy
            , fy = uz * vx - ux * vz
            , fz = ux * vy - uy * vx
            , len = Math.hypot(fx, fy, fz) || 1;

        for (const p of [a, b, c]) {
            out.position.push(p.x, p.y, p.z);
            out.normal.push(fx / len, fy / len, fz / len);
            out.colour.push(tint, tint, tint);
        }
    }
}

/**
 * One pose. `swing` is which leg is forward: +1, -1, or 0 for standing.
 */
function build(swing) {
    const {width: w, depth: d, height: h} = configs.walker
        , out = {position: [], normal: [], colour: []};

    // Legs first, so a reader of this file meets the figure from the ground up.
    for (const side of [-1, 1]) {
        prism(out, {
            x: side * w * 0.21,
            z0: 0,
            z1: h * HIP,
            w0: w * 0.3,
            w1: w * 0.34,
            d0: d * 0.9,
            d1: d,
            tilt: side * swing * STRIDE,
            pivot: h * HIP,
            tint: LEGS
        });
    }

    // The torso carries the silhouette: shoulders at the full width of the
    // box, waist narrower, and it is the only part at full instance colour.
    prism(out, {
        x: 0,
        z0: h * (HIP - 0.03),
        z1: h * SHOULDER,
        w0: w * 0.66,
        w1: w,
        d0: d * 0.82,
        d1: d,
        tint: SHIRT
    });

    prism(out, {
        x: 0,
        z0: h * CHIN,
        z1: h,
        w0: w * 0.44,
        w1: w * 0.4,
        d0: d * 0.62,
        d1: d * 0.58,
        tint: HEAD
    });

    const geometry = new BufferGeometry();

    geometry.setAttribute('position', new Float32BufferAttribute(out.position, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(out.normal, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(out.colour, 3));

    return geometry;
}

/**
 * The two poses of the walk cycle, left leg forward and right leg forward.
 *
 * Two poses rather than a skeleton or a shader displacement, which is what the
 * ticket asked to be measured before choosing. Instancing varies the matrix
 * and the colour only, so an animated pose costs either a vertex shader of our
 * own — and the fleet's material is shared, so that is a second material and a
 * second pipeline — or a mesh per pose. A mesh per pose is one extra draw call
 * for the whole crowd, and the per-instance loop that decides which mesh an
 * instance belongs to this frame is measured free at six thousand vehicles
 * (JAKAR-58), so at a few hundred people it is not on the table.
 */
export default function walkerGeometry() {
    return [build(1), build(-1)];
}
