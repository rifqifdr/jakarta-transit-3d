/**
 * The live camera layer: public CCTV, on the network, playing in the map.
 *
 * Jakarta's street cameras are served by a Flussonic media server that sends
 * `access-control-allow-origin: *` with no auth token, so this needs no proxy
 * and no key — the viewer's browser fetches the stream directly.
 *
 * **Nothing here is loaded until the layer is switched on.** The cameras
 * artifact is its own file for exactly that reason, and a viewer who never
 * opens the layer pays nothing for it.
 *
 * The honest caveat, which the UI has to carry rather than bury: this map is a
 * scheduled simulation. There is no realtime feed for any Jakarta operator, so
 * the vehicle drawn at a stop is where the timetable says it should be, not
 * where a vehicle is. The camera shows the actual street. They will disagree,
 * and the card says so — a camera is a window on the real place, never
 * confirmation of the simulation. Mini Tokyo 3D, which *does* have realtime
 * positions, still warns its users of the same gap for a delay of seconds.
 */
const COORD_SCALE = 1e6;

/**
 * Loads the cameras artifact. Returns null when the build has no cameras,
 * which is a normal state — the layer is an overlay, not part of the network.
 */
export async function loadCameras(base = 'artifacts/') {
    const manifest = await (await fetch(`${base}manifest.json`, {cache: 'no-cache'})).json();

    if (!manifest.cameras) {
        return null;
    }

    const data = await (await fetch(base + manifest.cameras.file)).json(),
        cameras = data.id.map((id, i) => ({
            id,
            name: data.name[i],
            lat: data.lat[i] / COORD_SCALE,
            lon: data.lon[i] / COORD_SCALE,

            // Full URLs: the toll cameras come from thirty-odd operators and
            // share no host with each other or with the street ones.
            hls: data.stream[i],
            preview: data.preview[i] || null,

            // 'toll' cameras overlook a motorway rather than standing beside a
            // stop, so the card describes them by road and kilometre instead.
            kind: data.kind[i] ? 'toll' : 'street',
            road: data.road[i] || null,

            // 'estimated' means the position came from the street name in the
            // stream id rather than from a published coordinate.
            precision: data.precision[i] ? 'estimated' : 'exact',
            channel: data.channel[i] || null,
            stop: data.stop[i] || null,
            distance: data.distance[i] >= 0 ? data.distance[i] : null
        }));

    // Several cameras genuinely share one pole. Without this they stack into a
    // single pin and only the top one can ever be opened; with it the card
    // offers the others. Grouped on the rounded position because that is what
    // "the same place" means here, and it is what the pin collapses to anyway.
    const groups = new Map();

    for (const camera of cameras) {
        const key = `${camera.lat.toFixed(5)},${camera.lon.toFixed(5)}`;

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(camera);
    }
    for (const group of groups.values()) {
        if (group.length < 2) {
            continue;
        }
        group.sort((a, b) => (a.channel ?? 0) - (b.channel ?? 0));
        for (const camera of group) {
            camera.siblings = group;
        }
    }

    return {cameras, groups};
}

/**
 * A camera pin, drawn to a canvas so the layer carries no image assets.
 *
 * Mapbox wants raw RGBA; drawing it here means one definition of what a camera
 * looks like and nothing to keep in sync on disk.
 */
export function cameraIcon(size = 44, {toll = false} = {}) {
    const canvas = document.createElement('canvas'),
        scale = 2,
        px = size * scale,
        ctx = canvas.getContext('2d');

    canvas.width = canvas.height = px;
    ctx.scale(scale, scale);

    const r = size / 2,
        centre = r;

    ctx.beginPath();
    ctx.arc(centre, centre, r - 4, 0, Math.PI * 2);
    // Toll cameras get their own colour, because they answer a different
    // question — what the motorway is doing, not what the street outside a stop
    // is doing — and a rider scanning the map should be able to tell without
    // opening one.
    ctx.fillStyle = toll ? '#7a4a12' : '#111820';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = toll ? '#f0a94a' : '#ffffff';
    ctx.stroke();

    // A camera body with a lens: legible at 22 px, which is all it has to be.
    ctx.fillStyle = toll ? '#f0a94a' : '#ffffff';
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(centre - 7.5, centre - 5, 11, 10, 2);
    } else {
        // Older Safari. A square body at 22 px reads the same as a rounded
        // one, and throwing here would take the whole layer with it.
        ctx.rect(centre - 7.5, centre - 5, 11, 10);
    }
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(centre + 4.5, centre - 1.5);
    ctx.lineTo(centre + 8.5, centre - 4.5);
    ctx.lineTo(centre + 8.5, centre + 4.5);
    ctx.lineTo(centre + 4.5, centre + 1.5);
    ctx.closePath();
    ctx.fill();

    return {
        width: px,
        height: px,
        data: new Uint8Array(ctx.getImageData(0, 0, px, px).data.buffer)
    };
}

/**
 * Plays one HLS stream into a `<video>`.
 *
 * Safari and iOS play HLS natively, so hls.js is imported only where it is
 * actually needed — it is the fourth dependency in this project and should not
 * be paid for by browsers that do not use it.
 *
 * `destroy()` is idempotent because the panel calls it on every close, whether
 * or not a stream was ever attached.
 */
export class StreamPlayer {

    constructor() {
        const me = this;

        me.hls = null;
        me.video = null;
    }

    async play(video, url, onError = () => {}) {
        const me = this;

        me.destroy();
        me.video = video;

        /*
         * Media Source first, native HLS only as the fallback — and that order
         * is the whole point.
         *
         * The obvious version of this asks `canPlayType` for HLS and treats a
         * truthy answer as "this browser plays HLS natively, use it". **Chrome
         * answers `"maybe"`**, exactly as Safari does, and then plays nothing:
         * the video sits at readyState 0 with no error, which looks like a dead
         * camera rather than a bug in the player. Written that way round it was
         * broken for every Chrome user and correct only on Safari, which is the
         * browser it was supposedly detecting.
         *
         * So the test is for Media Source Extensions, which is what hls.js
         * actually needs, and the native path is left to the browsers that have
         * no MSE at all — iOS, where native HLS is genuinely the right answer.
         */
        if (!window.MediaSource) {
            video.src = url;
            video.addEventListener('error', () => onError('Aliran tidak dapat dimuat'), {once: true});
            return video.play().catch(() => {});
        }

        const {default: Hls} = await import('hls.js');

        if (!Hls.isSupported()) {
            onError('Peramban ini tidak mendukung HLS');
            return;
        }

        // A camera is live: there is no value in buffering far behind the
        // edge, and a long buffer is exactly how a "live" view ends up a
        // minute stale.
        me.hls = new Hls({liveSyncDurationCount: 3, enableWorker: true});
        me.hls.loadSource(url);
        me.hls.attachMedia(video);
        me.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                // Cameras go off air without warning — 69% of the published
                // list is already gone — so a dead stream is an expected
                // outcome to report, not an exception to throw.
                onError('Kamera sedang tidak mengudara');
                me.destroy();
            }
        });
        video.play().catch(() => {});
    }

    destroy() {
        const me = this;

        if (me.hls) {
            me.hls.destroy();
            me.hls = null;
        }
        if (me.video) {
            me.video.removeAttribute('src');
            me.video.load();
            me.video = null;
        }
    }
}
