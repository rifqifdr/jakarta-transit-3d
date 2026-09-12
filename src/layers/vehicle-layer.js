import {
    AmbientLight, Camera, Color, DirectionalLight, DynamicDrawUsage,
    InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, MeshBasicMaterial, Quaternion,
    RingGeometry, Scene, Vector3, WebGLRenderer
} from 'three';
import mapboxgl from 'mapbox-gl';
import configs from '../configs';
import {CAPACITY} from '../fleet';
import {WALKER_CAPACITY} from '../walkers';
import vehicleGeometry from './vehicle-geometry';
import walkerGeometry from './walker-geometry';

// How much larger than life the tracked vehicle is drawn.
const SELECTED_SCALE = 1.7;

// What a focused vehicle is lifted towards, so it separates from the line it
// is running on rather than melting into it.
const FOCUS_TINT = new Color(0xffffff);

// Mode profiles, flattened to arrays indexed per instance. Index 0 is the
// fallback, which is why `bus` is read explicitly rather than taken as
// whichever key happens to come first.
const MODE_IDS = ['bus', ...Object.keys(configs.modes).filter(id => id !== 'bus')],
    MODE_INDEX = new Map(MODE_IDS.map((id, i) => [id, i])),
    MODE_DIMS = MODE_IDS.map(id => configs.modes[id] ?? configs.modes.bus);

/**
 * Draws the fleet as instanced 3D vehicles in a Mapbox custom layer.
 *
 * One instanced mesh per mode, four in all (JAKAR-49): a bus and a train want
 * different shapes, not just different scales, and instancing varies only the
 * matrix and the colour. Four draw calls for six thousand vehicles is still one
 * per mode rather than one per vehicle, which is the constraint that matters —
 * anything per route or per vehicle would multiply draw calls by the fleet.
 *
 * Each mode's geometry is built inside the same base box, so the per-mode zoom
 * inflation below is unchanged by the shape: size lives in `configs.modes` and
 * shape lives in `vehicle-geometry.js`, and neither knows about the other.
 *
 * Mapbox hands the layer a matrix that maps Mercator coordinates in [0, 1] to
 * clip space. Working in that space directly would exhaust float32 precision -
 * a metre in Jakarta is about 1.6e-8 Mercator units - so the scene is built in
 * metres around a fixed origin and the origin transform is folded into the
 * camera's projection matrix instead.
 */
export default class VehicleLayer {

    constructor(fleet, walkers = null) {
        const me = this;

        me.id = 'buses';
        me.type = 'custom';
        me.renderingMode = '3d';
        me.fleet = fleet;

        /*
           The crowd is drawn in this layer's own pass rather than in a layer
           of its own (JAKAR-79).

           A second Mapbox custom layer means a second `WebGLRenderer`, a
           second scene and a second `resetState()` every frame — a full GL
           state reset, to draw the smallest objects on the map. The people are
           a different subject and live in their own files, `walkers.js` for
           where they are and `walker-geometry.js` for what they look like;
           what they share with the fleet is one pass, one camera and one
           material, which is a rendering decision rather than a modelling one.
        */
        me.walkers = walkers;

        me.origin = mapboxgl.MercatorCoordinate.fromLngLat(configs.defaultCenter, 0);
        me.metre = me.origin.meterInMercatorCoordinateUnits();

        me._matrix = new Matrix4();
        me._position = new Vector3();
        me._scale = new Vector3();
        me._quaternion = new Quaternion();
        me._axis = new Vector3(0, 0, 1);
        me._color = new Color();
        me._selection = -1;
        me._generation = -1;
        me._dimmed = false;
        me._focusRoute = null;
        me._focusMask = null;
        me._focusGeneration = -1;
        me._modeOf = null;
        // Where each active slot sits in its own mode's mesh, and how many
        // slots each mode holds. Both are rebuilt on the same gate as `_modeOf`.
        me._slotAt = null;
        me._modeCount = new Int32Array(MODE_IDS.length);
        me._modeGeneration = -1;
        // Scratch, so the per-frame scale table is not reallocated every frame.
        me._modeScale = MODE_DIMS.map(() => ({x: 1, y: 1, z: 1}));
        me._hideSelected = false;

        me._originMatrix = new Matrix4()
            .makeTranslation(me.origin.x, me.origin.y, me.origin.z)
            .scale(new Vector3(me.metre, -me.metre, me.metre));
    }

    onAdd(map, gl) {
        const me = this,
            scene = me.scene = new Scene(),
            renderer = me.renderer = new WebGLRenderer({
                canvas: map.getCanvas(),
                context: gl,
                antialias: true
            });

        me.map = map;
        me.camera = new Camera();
        renderer.autoClear = false;

        const key = new DirectionalLight(0xffffff, 2.4);

        key.position.set(-0.4, 0.6, 1).normalize();
        scene.add(key, new AmbientLight(0xffffff, 1.5));

        // One material for all four meshes, so dimming stays one write. The
        // window band rides on the geometry's vertex colours, which three
        // multiplies into the per-instance colour - hence `vertexColors`, and
        // hence no second mesh for the glass.
        const material = me.material = new MeshLambertMaterial({
            color: 0xffffff,
            vertexColors: true
        });

        // Every mesh is allocated for the whole fleet rather than for its own
        // mode's share. Buses are all but a few hundred of it, so this is
        // ~3 MB of typed arrays that mostly go unused - but a per-mode cap that
        // was ever wrong would write past the end of an instance buffer, and
        // only the used prefix is uploaded (see the update ranges in `render`).
        me.meshes = MODE_IDS.map(id => {
            const mesh = new InstancedMesh(vehicleGeometry(id), material, CAPACITY);

            mesh.instanceMatrix.setUsage(DynamicDrawUsage);
            mesh.frustumCulled = false;
            mesh.count = 0;
            scene.add(mesh);

            return mesh;
        });

        // Two poses of one figure, a mesh each, so the whole crowd is two
        // draw calls whatever its size. Sharing the fleet's material is
        // deliberate: the walk cycle needs no shader of its own, and a
        // previewed line dims the city around it — people included.
        me.walkerMeshes = walkerGeometry().map(geometry => {
            const mesh = new InstancedMesh(geometry, material, WALKER_CAPACITY);

            mesh.instanceMatrix.setUsage(DynamicDrawUsage);
            mesh.frustumCulled = false;
            mesh.count = 0;
            scene.add(mesh);

            return mesh;
        });

        // A ring drawn under whichever vehicle is being tracked.
        const marker = me.marker = new Mesh(
            new RingGeometry(configs.vehicleLength * 0.75, configs.vehicleLength * 0.95, 32),
            new MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false
            })
        );

        marker.renderOrder = 10;
        marker.visible = false;
        scene.add(marker);
    }

    onRemove() {
        const me = this;

        for (const mesh of [...me.meshes, ...me.walkerMeshes]) {
            mesh.geometry.dispose();
        }
        me.material.dispose();
        me.marker.geometry.dispose();
        me.marker.material.dispose();
        me.renderer.dispose();
    }

    /** Highlights one slot of the active list, or -1 for none. */
    setSelection(slot) {
        this._selection = slot;
    }

    /**
     * Hides the tracked vehicle, for when the camera is riding on it.
     *
     * Scaling the instance away rather than skipping it keeps the instance
     * buffer contiguous with the active list, which everything else indexes by.
     */
    setSelectionHidden(hidden) {
        this._hideSelected = hidden;
    }

    /**
     * Shows only the vehicles running one route, or null for all of them.
     *
     * Previewing a line used to dim the whole fleet along with everything else,
     * which hid the very buses that line is running — the part that makes the
     * preview worth looking at. Now the rest of the fleet steps aside and this
     * route's vehicles keep moving at full brightness.
     *
     * Membership is resolved into a mask rather than tested per instance per
     * frame: at six thousand vehicles that is six thousand map lookups a frame.
     * The mask is rebuilt only when the active list changes or the focus does,
     * which is the same gate the colour buffer already uses.
     */
    setFocusRoute(routeId) {
        const me = this;

        if (me._focusRoute === routeId) {
            return;
        }
        me._focusRoute = routeId;
        me._focusGeneration = -1;
        // Focused vehicles are recoloured, so the colour buffer is stale too.
        me._generation = -1;
    }

    /**
     * Fades the fleet back so something else can be the subject.
     *
     * Six thousand vehicles are the loudest thing on the map; a drawn journey
     * disappears among them unless they step back.
     */
    setDimmed(dimmed) {
        const me = this;

        if (me._dimmed === dimmed) {
            return;
        }
        me._dimmed = dimmed;
        if (me.material) {
            me.material.transparent = dimmed;
            me.material.opacity = dimmed ? 0.22 : 1;
            me.material.needsUpdate = true;
        }
    }

    /**
     * Bus-shaped objects are a couple of pixels across at city-wide zooms, so
     * below `trueScaleZoom` they are drawn progressively larger than life to
     * keep the network readable - the same trade Mini Tokyo 3D makes.
     */
    _objectScale(zoom) {
        return Math.min(
            configs.maxObjectScale,
            Math.max(1, Math.pow(2, configs.trueScaleZoom - zoom))
        );
    }

    render(gl, matrix) {
        const me = this,
            {fleet, meshes, origin, metre, _matrix: m, _position: p,
                _scale: s, _quaternion: q, _axis: axis, _color: color} = me,
            count = fleet.activeCount,
            zoom = me.map.getZoom(),
            scale = me._objectScale(zoom),
            routes = fleet.network.routes,
            trips = fleet.network.trips,
            lineColor = me.lineColor,
            recolour = me._generation !== fleet.generation;

        // Rebuilt on a fleet change or a focus change; null means show all.
        if (me._focusRoute !== null && me._focusGeneration !== fleet.generation) {
            const mask = me._focusMask && me._focusMask.length >= count
                ? me._focusMask
                : new Uint8Array(Math.max(count, 1024));

            for (let i = 0; i < count; i++) {
                const trip = trips[fleet.runTrip[fleet.active[i]]];

                mask[i] = trip && trip.route === me._focusRoute ? 1 : 0;
            }
            me._focusMask = mask;
            me._focusGeneration = fleet.generation;
        }

        const focusMask = me._focusRoute === null ? null : me._focusMask;

        // Which mode each instance is, and where it sits in that mode's mesh.
        // Resolved once per fleet change rather than per instance per frame —
        // the same gate the colour buffer uses.
        if (me._modeGeneration !== fleet.generation) {
            const modeOf = me._modeOf && me._modeOf.length >= count
                    ? me._modeOf
                    : new Uint8Array(Math.max(count, 1024)),
                slotAt = me._slotAt && me._slotAt.length >= count
                    ? me._slotAt
                    : new Int32Array(Math.max(count, 1024)),
                counts = me._modeCount.fill(0);

            for (let i = 0; i < count; i++) {
                const trip = trips[fleet.runTrip[fleet.active[i]]],
                    k = MODE_INDEX.get(routes.get(trip.route)?.mode) ?? 0;

                modeOf[i] = k;
                slotAt[i] = counts[k]++;
            }
            me._modeOf = modeOf;
            me._slotAt = slotAt;
            me._modeGeneration = fleet.generation;
        }

        const modeOf = me._modeOf,
            slotAt = me._slotAt,
            base = configs;

        // Zoom inflation is per mode. Below `trueScaleZoom` a 12 m bus is drawn
        // larger than life so the network stays legible, but applying the same
        // multiplier to a 160 m train would draw it 1.8 km long. Inflating
        // towards a common on-screen length instead keeps every mode legible
        // and leaves the big ones at true size, where they are already visible.
        for (let k = 0; k < MODE_DIMS.length; k++) {
            const dims = MODE_DIMS[k],
                inflate = Math.max(1, scale * base.vehicleLength / dims.length),
                out = me._modeScale[k];

            out.x = inflate * dims.width / base.vehicleWidth;
            out.y = inflate * dims.length / base.vehicleLength;
            out.z = inflate * dims.height / base.vehicleHeight;
        }

        for (let i = 0; i < count; i++) {
            const bearing = fleet.bearing[i],
                mode = modeOf[i],
                mesh = meshes[mode],
                at = slotAt[i],
                dims = me._modeScale[mode],
                // The followed vehicle is the subject of the shot; at true
                // scale it is a few pixels of dark box against a dark street.
                // Scaled away rather than skipped, so the instance buffer
                // stays contiguous with the active list.
                factor = focusMask && !focusMask[i] ? 0 : (
                    i === me._selection ?
                        (me._hideSelected ? 0 : SELECTED_SCALE) :
                        1
                );

            s.set(dims.x * factor, dims.y * factor, dims.z * factor);
            p.set(
                (fleet.mercX[i] - origin.x) / metre,
                (origin.y - fleet.mercY[i]) / metre,
                0
            );
            // Scene +Y is north and bearings are clockwise from north, so the
            // rotation about the up axis is negated. The body is modelled nose
            // first along +Y, so this is also what points it where it is going.
            q.setFromAxisAngle(axis, -bearing);
            m.compose(p, q, s);
            mesh.setMatrixAt(at, m);

            // A vehicle keeps its colour for as long as it is in service, so
            // the colour buffer only needs rewriting when the fleet changes.
            if (recolour) {
                const trip = trips[fleet.runTrip[fleet.active[i]]];

                color.setHex(lineColor.get(trip.route));

                // A previewed line is drawn in its own category colour, so a
                // vehicle of that same colour disappears into the line it is
                // running on. Lifted towards white it reads as a vehicle on a
                // track, which is the whole point of the preview.
                if (focusMask) {
                    color.lerp(FOCUS_TINT, 0.62);
                }
                mesh.setColorAt(at, color);
            }
        }

        for (let k = 0; k < meshes.length; k++) {
            const mesh = meshes[k],
                n = me._modeCount[k];

            mesh.count = n;
            if (!n) {
                continue;
            }
            // Only the prefix that was written this frame is uploaded. Without
            // a range three re-sends the whole instance buffer, which here is
            // four buffers sized for the entire fleet.
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, n * 16);
            mesh.instanceMatrix.needsUpdate = true;
            if (recolour && mesh.instanceColor) {
                mesh.instanceColor.clearUpdateRanges();
                mesh.instanceColor.addUpdateRange(0, n * 3);
                mesh.instanceColor.needsUpdate = true;
            }
        }
        if (recolour) {
            me._generation = fleet.generation;
        }

        me._drawWalkers();

        const slot = me._selection;

        if (slot >= 0 && slot < count && !me._hideSelected) {
            me.marker.visible = true;
            me.marker.position.set(
                (fleet.mercX[slot] - origin.x) / metre,
                (origin.y - fleet.mercY[slot]) / metre,
                0.5
            );
            // The ring is built at bus length, so it has to grow with whatever
            // it is ringing — around a 160 m train a bus-sized one is a dot.
            const ring = me._modeScale[modeOf[slot]].y;

            me.marker.scale.set(ring, ring, ring);
        } else {
            me.marker.visible = false;
        }

        // Fold the model-origin transform into the projection so the scene can
        // be authored in metres: Mapbox's matrix expects Mercator units, where
        // float32 would quantise a position to several metres.
        me.camera.projectionMatrix
            .fromArray(matrix)
            .multiply(me._originMatrix);

        me.renderer.resetState();
        me.renderer.render(me.scene, me.camera);
        me.map.triggerRepaint();
    }

    /**
     * Places the crowd, from whatever `walkers.js` last worked out.
     *
     * The simulation is not run here — `main.js` advances it with the clock's
     * own deltas, exactly as it does the fleet — so this is the placement half
     * only, and it writes nothing at all when nobody is in view. Above the
     * zoom band that is the common case: a walker count of zero costs two
     * assignments and no upload.
     */
    _drawWalkers() {
        const me = this,
            walkers = me.walkers,
            meshes = me.walkerMeshes,
            {origin, metre, _matrix: m, _position: p, _scale: s,
                _quaternion: q, _axis: axis, _color: color} = me,
            count = walkers ? walkers.count : 0;

        if (!count) {
            for (const mesh of meshes) {
                mesh.count = 0;
            }
            return;
        }

        // Never inflated, unlike the fleet: they are drawn at the size a
        // person is, and the zoom band is chosen so that size is legible. What
        // does vary is the scale-in across the bottom of the band.
        const grow = walkers.scale,
            at = [0, 0];

        for (let i = 0; i < count; i++) {
            const pose = walkers.pose[i],
                mesh = meshes[pose],
                slot = at[pose]++;

            s.set(grow, grow, grow);
            p.set(
                (walkers.mercX[i] - origin.x) / metre,
                (origin.y - walkers.mercY[i]) / metre,
                walkers.lift[i]
            );
            q.setFromAxisAngle(axis, -walkers.bearing[i]);
            m.compose(p, q, s);
            mesh.setMatrixAt(slot, m);

            // Clothing, as a per-instance colour the geometry's own tints
            // multiply down from.
            //
            // Dark and desaturated, and twice as dark as it looks: this
            // shares the fleet's lights, which come to about 3.9 of combined
            // intensity, so a colour is drawn at roughly four times the value
            // set here before clipping. At lightness 0.62 — a perfectly
            // reasonable mid grey — eight hundred people came out pure white
            // and read as a field of pale posts, brighter than anything else
            // on a night basemap. The fleet is what has to stay loudest here;
            // the crowd is read by its shape and its movement instead.
            //
            // Called unconditionally, and that is the whole trick: three
            // allocates `instanceColor` *inside* `setColorAt`, so guarding the
            // call on the attribute existing means it never does. The crowd
            // then draws at white times its vertex tints, which the lights
            // clip — which is what "a field of pale posts" actually was.
            color.setHSL(walkers.tint[i], 0.25, 0.3);
            mesh.setColorAt(slot, color);
        }

        for (let k = 0; k < meshes.length; k++) {
            const mesh = meshes[k],
                n = at[k];

            mesh.count = n;
            if (!n) {
                continue;
            }
            // A walker changes pose as it walks, so unlike the fleet's colour
            // buffer both of these are rewritten every frame — which is why
            // only the written prefix is uploaded. At 800 people that is
            // 51 KB against the 2 x 800 instances the buffers are sized for.
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, n * 16);
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) {
                mesh.instanceColor.clearUpdateRanges();
                mesh.instanceColor.addUpdateRange(0, n * 3);
                mesh.instanceColor.needsUpdate = true;
            }
        }
    }

}
