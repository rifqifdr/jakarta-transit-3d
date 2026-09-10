import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './css/style.css';

import configs from './configs';
import Clock from './clock';
import Network from './network';
import Fleet from './fleet';
import VehicleLayer from './layers/vehicle-layer';
import ClockControl from './ui/clock-control';
import LayerPanel from './ui/layer-panel';
import SearchControl, {CATEGORY_COLOR} from './ui/search-control';
import DetailPanel from './ui/detail-panel';
import {nextDeparture, serviceSpan, servesOn} from './routing/timetable';
import Router from './routing/router';
import FollowHUD from './ui/follow-hud';
import Journey from './ui/journey';
import Reach from './ui/reach';
import Ride from './ui/ride';
import {applyState, readState, startSync} from './url-state';
import {StreamPlayer, cameraIcon, loadCameras} from './cameras';

// Read at module load, not at the point of use: `startSync` writes the query
// string from app state on its first tick, so any flag it does not serialise
// is gone by the time the app is built. `?bench` is not app state and never
// should be — it is an instrument, not a view worth sharing.
const WANTS_BENCH = new URLSearchParams(location.search).has('bench');

const RAD = Math.PI / 180,
    // How close to a bus, in screen pixels, a click has to land.
    PICK_RADIUS = 18,

    // The turn-by-turn style view used while following a bus.
    NAV_ZOOM = 17,
    NAV_PITCH = 65,
    // How far ahead of the bus to centre, as a fraction of viewport height.
    // The pitched view compresses this, so the bus lands around two thirds
    // down the screen rather than at the literal fraction.
    NAV_LOOK_AHEAD = 0.34,
    // Riding on board rather than behind: the camera drops to roughly roof
    // height and looks along the road. Mapbox caps pitch at 85, and the
    // look-ahead is much larger so the bus itself falls below the frame.
    ONBOARD_ZOOM = 18.4,
    ONBOARD_PITCH = 82,
    ONBOARD_LOOK_AHEAD = 0.75,

    // Time constant for the camera's turn, in seconds. Shape vertices make the
    // bus's own heading snap by as much as 90 degrees between one frame and the
    // next; the view leans through that instead of jerking. Expressed as a
    // decay over elapsed time rather than per frame, so it turns at the same
    // rate whatever the frame rate.
    NAV_TURN_TAU = 0.32;

mapboxgl.accessToken = __MAPBOX_TOKEN__;

function mercToLngLat(x, y) {
    return [
        x * 360 - 180,
        (2 * Math.atan(Math.exp((180 - y * 360) * RAD)) - Math.PI / 2) / RAD
    ];
}

const BASEMAP_THEME_KEY = 'tj:basemap-theme',
    BASEMAP_THEMES = ['default', 'faded', 'monochrome'];

/**
 * The basemap theme is a preference, not a view, so it is remembered rather
 * than put in the URL: a shared link is about where and when, and someone
 * else's taste in map colour is not part of that.
 *
 * Wrapped because private browsing and blocked site data both make
 * `localStorage` throw on access, exactly as the artifact cache is wrapped.
 */
function readBasemapTheme() {
    try {
        const saved = localStorage.getItem(BASEMAP_THEME_KEY);

        return BASEMAP_THEMES.includes(saved) ? saved : 'default';
    } catch {
        return 'default';
    }
}

/**
 * Applies a theme and then re-reads it, because `applyStopTheme` branches on
 * the theme rather than on the hour (trap 4): monochrome keeps a pale ground at
 * every light preset, so its night view still needs dark ink. Setting the one
 * without refreshing the other leaves the stops inked for the previous map.
 */
function setBasemapTheme(app, theme) {
    const {map} = app;

    map.setConfigProperty('basemap', 'theme', theme);
    applyStopTheme(map, app.lastPreset);
    try {
        localStorage.setItem(BASEMAP_THEME_KEY, theme);
    } catch {
        // A preference that cannot be saved is still a preference that works
        // for this session.
    }
}

// Mapbox Standard ships four lighting presets; picking one from the simulated
// hour makes playback read as a day passing over the city.
function lightPreset(hour) {
    return hour < 5 || hour >= 19 ? 'night' :
        hour < 7 ? 'dawn' :
            hour < 17 ? 'day' : 'dusk';
}

/**
 * Restyles the stop layers for whatever the basemap is currently showing.
 *
 * A single palette cannot serve both ends of the day: dark dots disappear on a
 * night map, white labels disappear on a noon one. Stops are drawn as holes
 * punched in the ground - filled with the ground colour, outlined in the ink
 * colour - which reads correctly either way round.
 *
 * Which way round, though, is a property of the theme rather than the light
 * preset. Standard's `monochrome` theme keeps a pale ground at every preset,
 * dimming only its buildings, so its night view still needs dark ink — which is
 * why this reads the theme and not just the hour. On the default theme night is
 * genuinely dark and the ink flips.
 */
function applyStopTheme(map, preset) {
    const theme = map.getConfigProperty('basemap', 'theme'),
        dark = theme !== 'monochrome' &&
            (preset === 'night' || preset === 'dusk'),
        ground = dark ? '#0b0f14' : '#ffffff',
        ink = dark ? '#ffffff' : '#2b3644',
        minor = dark ? '#93a1b3' : '#8a97a8';

    map.setPaintProperty('stop-circles', 'circle-color', ground);
    map.setPaintProperty('stop-circles', 'circle-stroke-color',
        map.__accessibleOnly ?
            '#0f9d63' :
            ['case', ['==', ['get', 'station'], 1], ink, minor]
    );
    map.setPaintProperty('stop-labels', 'text-color', ink);
    map.setPaintProperty('stop-labels', 'text-halo-color',
        dark ? 'rgba(11,15,20,0.9)' : 'rgba(255,255,255,0.9)');
}

const status = document.getElementById('loader-status');

/**
 * Gathers the panels into two columns: act on the left, read on the right.
 *
 * Done by re-parenting rather than by changing where each panel mounts, so the
 * panels keep building themselves exactly as before — including the rule that
 * a panel's shell is built once per selection and only its values rewritten.
 * Moving a node does not rebuild it, so following a vehicle survives this.
 *
 * Layanan moved to the right because it is a filter you set once and then read,
 * not a step in finding or planning anything. Everything on the left is now
 * something you do, in the order you do it.
 */
function buildRails() {
    if (document.getElementById('left-rail')) {
        return;
    }

    // Order is the order of use: find, then plan or inspect.
    const rails = {'left-rail': ['search', 'detail'], 'right-rail': ['clock', 'layers']};

    for (const [id, panels] of Object.entries(rails)) {
        const rail = document.createElement('div');

        rail.id = id;
        document.body.appendChild(rail);
        for (const panelId of panels) {
            const panel = document.getElementById(panelId);

            if (panel) {
                rail.appendChild(panel);
            }
        }
    }
}

async function main() {
    // The artifact set is the default: it carries all four modes, and booting
    // a multi-modal map into a bus-only network was the wrong first impression.
    //
    // `?data=legacy` still boots the old build-data.mjs bundle — 240 routes,
    // buses only. It stays because `npm run test-routing` runs against it, so
    // it is the only thing that can catch a mistake in the artifact path. It is
    // what caught the walk table joining stops 74 km apart (JAKAR-41).
    const useArtifacts = new URLSearchParams(location.search).get('data') !== 'legacy',
        network = await (useArtifacts ? Network.loadArtifacts : Network.load)(text => {
            status.textContent = text;
        }),
        clock = new Clock(),
        fleet = new Fleet(network);

    status.textContent = 'Menyiapkan peta...';

    const map = new mapboxgl.Map({
        container: 'map',
        style: configs.style,
        center: configs.defaultCenter,
        zoom: configs.defaultZoom,
        pitch: configs.defaultPitch,
        bearing: configs.defaultBearing,
        minZoom: configs.minZoom,
        maxZoom: configs.maxZoom,
        maxBounds: configs.bounds,
        antialias: true,
        // Replaced rather than configured: `customAttribution` is only
        // readable at construction, and adding a second control would print
        // Mapbox's credits twice.
        attributionControl: false
    });

    // Route geometry and station positions are derived from OpenStreetMap, so
    // ODbL requires the credit — the basemap's own attribution does not cover
    // data this app derived itself. The last clause is not a legal
    // requirement: every vehicle on screen is where the timetable says it
    // should be, and a map this convincing needs to say so somewhere a person
    // will find it.
    map.addControl(new mapboxgl.AttributionControl({
        compact: true,
        customAttribution: [
            'Jadwal: Transjakarta, KAI Commuter, MRT Jakarta, LRT Jakarta & Jabodebek',
            'Geometri jalur: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> (ODbL)',
            'CCTV: JakCCTV / Dishub DKI, BPJT, Bina Marga',
            '<strong>Simulasi terjadwal — bukan posisi kendaraan sebenarnya</strong>'
        ]
    }), 'bottom-right');

    map.addControl(new mapboxgl.NavigationControl({visualizePitch: true}), 'bottom-right');
    map.addControl(new mapboxgl.GeolocateControl({trackUserLocation: true}), 'bottom-right');

    const vehicleLayer = new VehicleLayer(fleet);

    vehicleLayer.categoryColor = new Map(configs.categories.map(c =>
        [c.id, parseInt(c.color.slice(1), 16)]
    ));

    const app = {
        map, clock, network, fleet, vehicleLayer,
        selectedRun: -1,
        trackedRun: -1,
        selectedStop: null,
        lastPreset: null,
        router: new Router(network),
        cameraMode: 'chase',
        routeColouring: 'category',
        // The live CCTV layer. `cameras` stays null until the layer is first
        // switched on — its artifact is not fetched before then.
        cameras: null,
        selectedCamera: null,
        camerasOn: false,
        streamPlayer: new StreamPlayer(),
        // Chase-camera state while following a bus.
        nav: {run: -1, bearing: 0, settling: false, time: 0, mode: 'chase'}
    };

    await new Promise(resolve => map.on('style.load', resolve));

    // Before the layers, not after. `applyStopTheme` branches on the theme, and
    // the frame loop runs it on its first pass to set the light preset — so the
    // theme has to be true by then or the stops are inked for the default map
    // and stay that way until the hour changes. Establish the condition before
    // the state that depends on it (trap 12).
    map.setConfigProperty('basemap', 'theme', readBasemapTheme());

    addRouteLayers(app);
    addReachLayers(app);
    addJourneyLayers(app);
    addStopLayers(app);
    addCameraLayers(app);
    map.addLayer(vehicleLayer);

    buildUI(app);
    wireInteraction(app);

    applyState(app, readState(), {
        onRoute: route => selectRoute(app, route),
        onStop: stop => showStop(app, stop),
        onCategoryRestored: (category, visible) => {
            app.layerPanel.setCategoryUI(category, visible);
            applyRouteFilter(app);
        },
        onAccessRestored: on => {
            app.layerPanel.setLayerUI('accessible', on);
            setAccessibleOnly(app, on);
        },
        onCamera: (id, options) => restoreCamera(app, id, options)
    });
    startSync(app);

    // Exposed for debugging and automated checks.
    window.__tj = app;

    // `?bench` runs the on-device render benchmark (JAKAR-60). Dynamically
    // imported, so a visitor who never asks for it downloads none of it —
    // the same arrangement `hls.js` has. Failure is deliberately silent
    // beyond the console: a debug flag must never be able to break a boot.
    if (WANTS_BENCH) {
        import('./bench.js')
            .then(module => module.default(app))
            .catch(error => console.error('bench failed', error));
    }

    document.getElementById('loader').classList.add('hidden');
    loop(app);
}

// ---------------------------------------------------------------- map layers

function addRouteLayers({map, network}) {
    map.addSource('routes', {type: 'geojson', data: network.lines});

    const colorExpression = [
        'match', ['get', 'category'],
        ...configs.categories.flatMap(c => [c.id, c.color]),
        '#8a94a3'
    ];

    map.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'routes',
        layout: {'line-cap': 'round', 'line-join': 'round'},
        paint: {
            'line-color': colorExpression,
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 13, 1.6, 17, 4],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.28, 13, 0.4, 17, 0.55]
        }
    });

    // Drawn above the base lines so a searched route stands out against the
    // 700 shapes behind it.
    map.addLayer({
        id: 'route-highlight',
        type: 'line',
        source: 'routes',
        layout: {'line-cap': 'round', 'line-join': 'round'},
        filter: ['==', ['get', 'route'], ' '],
        paint: {
            'line-color': '#ffffff',
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 17, 7],
            'line-opacity': 0.95
        }
    });
}

function addJourneyLayers({map}) {
    map.addSource('journey', {
        type: 'geojson',
        data: {type: 'FeatureCollection', features: []}
    });

    // A dark casing under the coloured leg keeps the line readable wherever it
    // crosses the 700 route lines already on the map.
    map.addLayer({
        id: 'journey-casing',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'kind'], 'ride'],
        layout: {'line-cap': 'round', 'line-join': 'round'},
        paint: {
            'line-color': '#0b0f14',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 16],
            'line-opacity': 0.8
        }
    });

    map.addLayer({
        id: 'journey-ride',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'kind'], 'ride'],
        layout: {'line-cap': 'round', 'line-join': 'round'},
        paint: {
            'line-color': ['get', 'color'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5.5, 16, 11]
        }
    });

    map.addLayer({
        id: 'journey-walk',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'kind'], 'walk'],
        layout: {'line-cap': 'round'},
        paint: {
            'line-color': '#5c6b7c',
            'line-width': 3,
            'line-dasharray': [0.4, 1.8]
        }
    });

    map.addLayer({
        id: 'journey-points',
        type: 'circle',
        source: 'journey',
        filter: ['==', ['get', 'kind'], 'point'],
        paint: {
            'circle-radius': 5,
            'circle-color': '#ffffff',
            'circle-stroke-color': '#0b0f14',
            'circle-stroke-width': 2
        }
    });
}

function addReachLayers({map}) {
    map.addSource('reach', {
        type: 'geojson',
        data: {type: 'FeatureCollection', features: []}
    });

    map.addLayer({
        id: 'reach-points',
        type: 'circle',
        source: 'reach',
        paint: {
            'circle-color': ['get', 'color'],
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, ['case', ['==', ['get', 'band'], 0], 6, 2.5],
                16, ['case', ['==', ['get', 'band'], 0], 12, 7]
            ],
            'circle-opacity': 0.85,
            'circle-stroke-width': ['case', ['==', ['get', 'band'], 0], 3, 0],
            'circle-stroke-color': '#0b0f14'
        }
    });
}

function addStopLayers({map, network}) {
    const features = [];

    for (const stop of network.stops.values()) {
        // Platforms sit metres from their parent station; drawing only the
        // station keeps corridor stops from turning into a blob.
        if (stop.parent) {
            continue;
        }
        features.push({
            type: 'Feature',
            properties: {
                id: stop.id,
                name: stop.name,
                station: stop.station ? 1 : 0,
                accessible: stop.accessible ? 1 : 0
            },
            geometry: {type: 'Point', coordinates: [stop.lon, stop.lat]}
        });
    }

    map.addSource('stops', {type: 'geojson', data: {type: 'FeatureCollection', features}});

    map.addLayer({
        id: 'stop-circles',
        type: 'circle',
        source: 'stops',
        minzoom: 12,
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                12, ['case', ['==', ['get', 'station'], 1], 3, 1.6],
                17, ['case', ['==', ['get', 'station'], 1], 8, 4.5]
            ],
            'circle-color': '#0b0f14',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 17, 2],
            'circle-stroke-color': [
                'case', ['==', ['get', 'station'], 1], '#ffffff', '#93a1b3'
            ],
            'circle-opacity': 0.9
        }
    });

    map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: 'stops',
        minzoom: 14.5,
        filter: ['==', ['get', 'station'], 1],
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.1],
            'text-anchor': 'top'
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(11,15,20,0.9)',
            'text-halo-width': 1.4
        }
    });
}

/**
 * The live camera layer.
 *
 * An empty source and a hidden symbol layer, created at boot so the layer
 * exists before there is anything to put in it — the cameras artifact is only
 * fetched the first time the toggle is used, and adding a Mapbox layer
 * mid-interaction is how style races start.
 *
 * A symbol layer rather than DOM markers: there are around a thousand cameras,
 * and a thousand absolutely-positioned elements the browser has to keep in
 * sync with the map is a different order of cost from one GPU draw.
 */
function addCameraLayers({map}) {
    if (!map.hasImage('camera-pin')) {
        map.addImage('camera-pin', cameraIcon(), {pixelRatio: 2});
        map.addImage('camera-pin-toll', cameraIcon(44, {toll: true}), {pixelRatio: 2});
    }

    map.addSource('cameras', {
        type: 'geojson',
        data: {type: 'FeatureCollection', features: []}
    });

    map.addLayer({
        id: 'camera-markers',
        type: 'symbol',
        source: 'cameras',
        // Below this the pins are a crowd rather than a choice; the network is
        // what the map is for at city zoom.
        minzoom: 13,
        layout: {
            'icon-image': ['case', ['==', ['get', 'toll'], 1], 'camera-pin-toll', 'camera-pin'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.34, 17, 0.52],

            // Both true, and neither is a detail. Symbol collision is global
            // across the style, not per layer: with `allow-overlap` false the
            // basemap's own POI and road labels win every contest, and **zero
            // of 612 pins were placed anywhere in the viewport** — a layer you
            // deliberately switch on that draws nothing at all. `ignore-placement`
            // keeps the reverse from happening too, so the pins do not silently
            // delete Standard's labels in exchange.
            //
            // Decluttering comes from `minzoom` instead, which is a rule about
            // when cameras are worth showing rather than a contest they lose.
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            visibility: 'none'
        }
    });
}

/**
 * Turns the camera layer on or off, fetching its artifact the first time.
 *
 * Loading is gated on the toggle rather than on the build: the whole reason
 * cameras are a separate artifact is that someone who never opens the layer
 * should never pay for it.
 */
async function setCameras(app, on) {
    app.camerasOn = on;

    if (on) {
        await ensureCameras(app);
    }
    app.map.setLayoutProperty('camera-markers', 'visibility', on ? 'visible' : 'none');

    if (!on) {
        closeCamera(app);
    }
}

/**
 * Fetches the camera set and fills the map source, without switching anything
 * on.
 *
 * Separate from `setCameras` so a link can ask "is this camera in the build?"
 * before turning a layer on — the layer is gated on live mode, and switching it
 * on while the clock is still replaying gives the frame loop a state it is
 * built to tear down.
 */
async function ensureCameras(app) {
    if (app.cameras) {
        return app.cameras;
    }
    try {
        const loaded = await loadCameras();

        // A build with no cameras is a normal state, not a failure — the
        // layer is an overlay on the network, not part of it.
        app.cameras = loaded?.cameras ?? [];
        app.map.getSource('cameras').setData({
            type: 'FeatureCollection',
            features: app.cameras.map((camera, index) => ({
                type: 'Feature',
                properties: {index, name: camera.name, toll: camera.kind === 'toll' ? 1 : 0},
                geometry: {type: 'Point', coordinates: [camera.lon, camera.lat]}
            }))
        });
    } catch (error) {
        console.warn('cameras unavailable', error);
        app.cameras = [];
    }
    return app.cameras;
}

/**
 * Opens one camera, and starts its stream.
 *
 * `fly` is false when a link already framed the map on this camera: flying
 * again would animate away from the very view the link was sent to show.
 * `notice` is a line for the card, used when restoring one had to overrule
 * something else the link asked for.
 */
function showCamera(app, camera, {fly = true, notice = null} = {}) {
    app.selectedCamera = camera;
    app.selectedStop = null;
    app.selectedRun = -1;
    app.trackedRun = -1;
    app.nearby = null;
    app.cameraNotice = notice;
    if (fly) {
        app.map.flyTo({center: [camera.lon, camera.lat], zoom: 16.5, duration: 900});
    }
}

// Shown when a link carried both a camera and a replay time. The two cannot
// both hold, and moving the clock without saying so would leave someone
// looking at a live street convinced they were watching Tuesday morning.
const CAMERA_FORCED_LIVE =
    'Tautan ini membawa waktu tayang ulang. Kamera hanya bisa menampilkan ' +
    'keadaan <strong>sekarang</strong>, jadi jam dikembalikan ke mode LIVE.';

/**
 * Opens a camera named in a link (JAKAR-57).
 *
 * Three things have to happen here that a click never needs:
 *
 * - **The layer has to be fetched.** Cameras load only when someone asks for
 *   them, so `app.cameras` is null until this turns the layer on.
 * - **The clock has to be live**, because the layer only exists in live mode.
 *   A link carrying a camera *and* a replay time has asked for two things that
 *   cannot both hold. The camera wins — it is the rarer and more specific ask,
 *   and one it would take 801 pins to recover by hand — and the card says the
 *   time was dropped. Moving the clock silently is the one answer ruled out.
 * - **The camera may be gone.** Ids come from a build, and a link outlives one.
 *   An unknown id changes nothing at all, rather than leaving a layer switched
 *   on and a clock moved for a camera that never appeared.
 *
 * The order of the last two is not free. Switching the layer on while the clock
 * is still replaying hands the frame loop the one state it exists to tear down,
 * and it does — leaving a camera card open over a layer that had been switched
 * back off, with its own toggle still reading on. Hence `ensureCameras`, which
 * answers "is it in this build?" without turning anything on.
 */
async function restoreCamera(app, id, {framed = false} = {}) {
    const camera = (await ensureCameras(app)).find(item => item.id === id);

    if (!camera) {
        return;
    }

    const replaying = !app.clock.live;

    if (replaying) {
        app.clock.goLive();
        app.clockControl?.syncSpeed();
    }
    app.layerPanel.setLayerUI('cameras', true);
    await setCameras(app, true);
    showCamera(app, camera, {fly: !framed, notice: replaying ? CAMERA_FORCED_LIVE : null});
    app.syncUrl?.();
}

/**
 * Opens the playing camera large, over the map.
 *
 * The `<video>` element is **moved** into the overlay rather than a second one
 * being created beside it. Moving a node does not reset media state, so the
 * stream keeps playing from where it was; a second element would open a second
 * connection to the camera and start it buffering from scratch, which is both
 * slower and twice the bandwidth for one picture.
 */
function expandCamera(app) {
    const video = app.detail.el.querySelector('.cam-video');

    if (!video || app.cameraOverlay) {
        return;
    }

    const overlay = document.createElement('div'),
        camera = app.selectedCamera;

    overlay.className = 'cam-overlay';
    overlay.innerHTML = `
        <div class="cam-overlay-inner">
            <div class="cam-overlay-head">
                <span class="badge cam-badge">LIVE</span>
                <span class="cam-overlay-title"></span>
                <button class="cam-overlay-close" type="button" aria-label="Tutup">&times;</button>
            </div>
            <div class="cam-overlay-stage"></div>
            <div class="cam-overlay-foot"></div>
        </div>
    `;
    overlay.querySelector('.cam-overlay-title').textContent = camera?.name ?? '';
    overlay.querySelector('.cam-overlay-foot').textContent = camera
        ? `${camera.precision === 'estimated' ? 'Perkiraan lokasi · ' : ''}${camera.distance} m dari halte terdekat`
        : '';

    // Remember where it came from, so closing puts it back rather than leaving
    // the card with a hole in it.
    app.cameraOverlay = {overlay, video, home: video.parentElement};
    overlay.querySelector('.cam-overlay-stage').appendChild(video);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', event => {
        // The backdrop closes; the video itself does not, or every attempt to
        // look at something in the picture shuts it.
        if (event.target === overlay || event.target.closest('.cam-overlay-close')) {
            collapseCamera(app);
        }
    });
    app._cameraKeys = event => {
        if (event.key === 'Escape') {
            collapseCamera(app);
        }
    };
    document.addEventListener('keydown', app._cameraKeys);
}

/** Puts the video back in the card. Idempotent, like every other teardown here. */
function collapseCamera(app) {
    const open = app.cameraOverlay;

    if (!open) {
        return false;
    }
    app.cameraOverlay = null;
    document.removeEventListener('keydown', app._cameraKeys);

    // Back to the card first, then remove the overlay — the other order
    // destroys the video along with its parent and stops the stream.
    if (open.home && open.home.isConnected) {
        open.home.insertBefore(open.video, open.home.firstChild);
    }
    open.overlay.remove();
    return true;
}

/**
 * Closes the camera card and tears the stream down.
 *
 * Idempotent, because the frame loop calls it whenever the conditions for
 * showing a camera stop holding — leaving a stream playing behind a closed
 * card would keep pulling video for a panel nobody can see.
 */
function closeCamera(app) {
    if (!app.selectedCamera) {
        return false;
    }
    app.selectedCamera = null;
    collapseCamera(app);
    app.streamPlayer.destroy();
    if (app.detail.mode === 'camera') {
        app.detail.close();
    }
    return true;
}

// ------------------------------------------------------------------------ ui

function buildUI(app) {
    const {map, clock, fleet, network} = app;

    app.clockControl = new ClockControl(clock, fleet);

    app.layerPanel = new LayerPanel(fleet, {
        basemapTheme: readBasemapTheme(),
        onBasemapTheme: theme => setBasemapTheme(app, theme),
        onCategoryToggle: () => applyRouteFilter(app),
        onLayerToggle: (layer, on) => {
            if (layer === 'routes') {
                for (const id of ['route-lines', 'route-highlight']) {
                    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
                }
            } else if (layer === 'stops') {
                for (const id of ['stop-circles', 'stop-labels']) {
                    map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
                }
            } else if (layer === 'accessible') {
                setAccessibleOnly(app, on);
            } else if (layer === 'headway') {
                setRouteColouring(app, on ? 'headway' : 'category');
            } else if (layer === 'cameras') {
                setCameras(app, on);
            } else {
                map.setConfigProperty('basemap', 'show3dObjects', on);
            }
        }
    });

    app.legend = app.layerPanel;

    app.search = new SearchControl(network, {
        onSelectRoute: route => selectRoute(app, route),

        // Typing an end plans the journey the moment the second one lands,
        // which is the whole point of the two fields.
        onSetEnd: (which, stop) => {
            clearRoutePreview(app);
            app.journey.setEnd(which, stop, clock.getTimeOffset(), clock.getDayOfWeek());
            if (app.journey.active) {
                app.detail.showJourney(app.journey);
            } else {
                map.flyTo({center: [stop.lon, stop.lat], zoom: 15, duration: 1000});
            }
        },
        onSwap: () => {
            app.journey.swap(clock.getTimeOffset(), clock.getDayOfWeek());
            if (app.journey.active) {
                app.detail.showJourney(app.journey);
            }
        },
        onClear: () => {
            app.journey.clear();
            app.detail.close();
        }
    });

    app.journey = new Journey({
        network,
        router: app.router,
        onChange: () => {
            drawJourney(app);
            // The fields are the journey's display, so anything that sets an
            // end elsewhere — a stop card, a deep link — has to reach them.
            app.search.syncEnds(app.journey.from, app.journey.to);
            app.syncUrl?.();
        }
    });

    app.reach = new Reach({
        network,
        router: app.router,
        onChange: () => {
            drawReach(app);
            app.syncUrl?.();
        }
    });

    app.ride = new Ride({
        clock,
        fleet,
        network,
        onExit: () => exitRide(app),
        onCamera: mode => setCameraMode(app, mode)
    });

    app.followHud = new FollowHUD({
        clock,
        onStop: () => {
            app.trackedRun = -1;
        },
        onCamera: mode => setCameraMode(app, mode),
        onSpeed: speed => {
            clock.setSpeed(speed);
            app.clockControl.syncSpeed();
        }
    });

    app.detail = new DetailPanel(network, {
        onTrack: () => {
            app.trackedRun = app.trackedRun === app.selectedRun ? -1 : app.selectedRun;
        },
        // Setting one end of a journey from whichever stop card is open.
        onJourneyEnd: which => {
            const stop = app.selectedStop;

            if (!stop) {
                return;
            }
            app.selectedRun = -1;
            app.vehicleLayer.setSelection(-1);
            app.journey.setEnd(which, stop, clock.getTimeOffset(), clock.getDayOfWeek());
            if (app.journey.active) {
                app.selectedStop = null;
            }
        },
        onReach: () => {
            const stop = app.selectedStop;

            if (!stop) {
                return;
            }
            app.selectedRun = -1;
            app.vehicleLayer.setSelection(-1);
            app.reach.setOrigin(stop, clock.getTimeOffset(), clock.getDayOfWeek());
            app.selectedStop = null;
        },
        onBudget: minutes => app.reach.set('budget', minutes),
        onFreeOnly: on => app.reach.set('freeOnly', on),
        onFromPoint: () => {
            if (!app.nearby) {
                return;
            }
            const [lon, lat] = app.nearby.point;

            app.journey.setEnd(
                'from',
                {name: 'Titik dipilih', lon, lat},
                clock.getTimeOffset(), clock.getDayOfWeek()
            );
            app.nearby = null;
        },
        onRide: () => {
            const itinerary = app.journey.chosen;

            if (!itinerary) {
                return;
            }
            // Remember where the camera was, so leaving puts it back.
            app.rideReturn = {
                center: map.getCenter(), zoom: map.getZoom(),
                pitch: map.getPitch(), bearing: map.getBearing()
            };
            app.ride.start(itinerary);
        },
        onSelectItinerary: index => {
            app.journey.selected = index;
            drawJourney(app);
        },
        onSort: sort => {
            app.journey.sort = sort;
            app.journey.selected = 0;
            app.journey.sortResults();
            drawJourney(app);
        },
        onCameraExpand: () => expandCamera(app),

        // Switching channel is switching camera: they are separate streams on
        // one pole, and the frame loop rebuilds the card because the key changes.
        onCameraChannel: id => {
            const next = app.cameras?.find(camera => camera.id === id);

            if (next && next.id !== app.selectedCamera?.id) {
                collapseCamera(app);
                app.selectedCamera = next;
            }
        },

        onClose: () => {
            app.selectedRun = -1;
            app.trackedRun = -1;
            app.selectedStop = null;
            app.nearby = null;
            app.vehicleLayer.setSelection(-1);
            app.journey.clear();
            app.reach.clear();
            clearRoutePreview(app);
            // Closing the card has to stop the stream too, or the video keeps
            // pulling segments for a panel nobody can see.
            closeCamera(app);
            app.search.syncEnds(null, null);
        }
    });

    // Every panel the rail collects now exists, so gather them.
    buildRails();

    // On a phone the header is above the map rather than beside it, so it has
    // to be short or it eats the thing it is a header for. Both panels in it
    // start folded — the time and LIVE still read at a glance, and one tap
    // opens either. Initial state only: once a person unfolds something it
    // stays unfolded, and this never runs again.
    if (window.matchMedia('(max-width: 700px)').matches) {
        app.clockControl?.fold(true);
        app.layerPanel?.toggle(true);
    }
}

/**
 * Restricts the stop layers to stops a wheelchair user can board from.
 *
 * The feed marks 100 of 8,091 stops as accessible, and they resolve to just 39
 * of the 7,488 stops drawn - all of them BRT corridor stations. Turning this on
 * empties the map almost completely, which is the point.
 */
function setAccessibleOnly(app, on) {
    const {map} = app,
        filter = on ? ['==', ['get', 'accessible'], 1] : null;

    map.__accessibleOnly = on;
    map.setFilter('stop-circles', filter);
    map.setFilter('stop-labels', on ?
        filter :
        ['==', ['get', 'station'], 1]
    );
    applyStopTheme(map, app.lastPreset);
    // Accessible stops are sparse enough to label from further out.
    map.setLayerZoomRange('stop-labels', on ? 11 : 14.5, 24);
}

/**
 * Puts the chosen itinerary on the map and steps the rest of the network back.
 *
 * With 700 route lines already drawn, a journey needs the surrounding network
 * dimmed or it simply disappears into it.
 */
function drawJourney(app) {
    const {map, journey} = app,
        data = journey.toGeoJSON();

    map.getSource('journey').setData(data);

    const showing = data.features.length > 0;

    map.setPaintProperty('route-lines', 'line-opacity', showing ?
        0.1 :
        ['interpolate', ['linear'], ['zoom'], 9, 0.28, 13, 0.4, 17, 0.55]
    );
    app.vehicleLayer.setDimmed(showing);

    // A link that names a camera means it. Framing the journey would throw
    // away the very view the link was sent to show.
    if (showing && !app.restoringCamera) {
        const bounds = new mapboxgl.LngLatBounds();

        for (const feature of data.features) {
            if (feature.geometry.type === 'LineString') {
                for (const coordinate of feature.geometry.coordinates) {
                    bounds.extend(coordinate);
                }
            }
        }
        if (!bounds.isEmpty()) {
            map.fitBounds(bounds, {padding: {top: 80, bottom: 80, left: 360, right: 360}, duration: 900});
        }
    }
}

function drawReach(app) {
    const {map, reach} = app,
        data = reach.toGeoJSON(),
        showing = reach.active;

    map.getSource('reach').setData(data);
    map.setPaintProperty('route-lines', 'line-opacity', showing ?
        0.08 :
        ['interpolate', ['linear'], ['zoom'], 9, 0.28, 13, 0.4, 17, 0.55]
    );
    // The reachable set is the subject; the ordinary stop dots would just add
    // noise on top of it.
    for (const id of ['stop-circles', 'stop-labels']) {
        map.setLayoutProperty(id, 'visibility', showing ? 'none' : 'visible');
    }
    app.vehicleLayer.setDimmed(showing);
}

// Headway bands. The feed's headways run from 180 s to 52,700 s - over fourteen
// hours - so without a sensible top band nearly every route lands in one bucket.
const HEADWAY_BANDS = [
    {maxMinutes: 5, color: '#00b8a0', label: 'di bawah 5 mnt'},
    {maxMinutes: 15, color: '#4d9be0', label: '5-15 mnt'},
    {maxMinutes: 30, color: '#a06fd0', label: '15-30 mnt'},
    {maxMinutes: Infinity, color: '#c9457f', label: 'lebih dari 30 mnt'}
];

/**
 * The current headway of every route, in seconds.
 *
 * A route runs several patterns; what a rider waits for is whichever comes
 * soonest, so the shortest active headway across its patterns is the honest
 * number.
 */
function currentHeadways({network, clock}) {
    const now = clock.getTimeOffset(),
        dayOfWeek = clock.getDayOfWeek(),
        headways = new Map();

    for (const trip of network.trips) {
        if (!servesOn(trip, network.calendar, dayOfWeek)) {
            continue;
        }
        for (const [start, end, headway] of trip.windows) {
            if (headway > 0 && now >= start && now < end) {
                const existing = headways.get(trip.route);

                if (existing === undefined || headway < existing) {
                    headways.set(trip.route, headway);
                }
            }
        }
    }
    return headways;
}

/**
 * Repaints the route lines by how long until the next bus.
 *
 * Category colour is static, so replaying a day changes the buses but not the
 * picture. Frequency colour makes the network breathe: service visibly thins
 * after 21:00, and you can see which corridors keep running.
 */
function applyHeadwayColours(app) {
    const {map} = app,
        headways = currentHeadways(app),
        cases = [];

    for (const [route, headway] of headways) {
        const band = HEADWAY_BANDS.find(b => headway <= b.maxMinutes * 60);

        cases.push(route, band.color);
    }

    map.setPaintProperty('route-lines', 'line-color', cases.length ?
        ['match', ['get', 'route'], ...cases, '#3b4654'] :
        '#3b4654');
    app.headwayCount = headways.size;
}

function applyCategoryColours({map}) {
    map.setPaintProperty('route-lines', 'line-color', [
        'match', ['get', 'category'],
        ...configs.categories.flatMap(c => [c.id, c.color]),
        '#8a94a3'
    ]);
}

function setRouteColouring(app, mode) {
    app.routeColouring = mode;
    if (mode === 'headway') {
        applyHeadwayColours(app);
    } else {
        applyCategoryColours(app);
    }
    app.legend.setMode(mode, HEADWAY_BANDS);
}

function applyRouteFilter({map, fleet}) {
    const visible = configs.categories
        .map(c => c.id)
        .filter(id => fleet.isCategoryVisible(id));

    map.setFilter('route-lines', ['in', ['get', 'category'], ['literal', visible]]);
}

/**
 * Previews one line: the card, and the map framed on it.
 *
 * Contrast here is made by taking the *rest* of the network away, not by
 * brightening the line. With 700 lines drawn, a brighter one is still a
 * brighter needle in the same haystack — the same reason `drawJourney` dims
 * rather than highlights. The highlight also takes the line's own category
 * colour instead of white, so the preview and the legend agree.
 */
function selectRoute(app, route) {
    const {map, network} = app,
        trip = network.trips.find(t => t.route === route.id),
        color = CATEGORY_COLOR.get(route.category) || '#ffffff';

    app.highlightedRoute = route.id;
    map.setFilter('route-highlight', ['==', ['get', 'route'], route.id]);
    map.setPaintProperty('route-highlight', 'line-color', color);
    // The line is the track, not the subject. Held back so the vehicles on it
    // read as objects rather than as bumps in a solid bar.
    map.setPaintProperty('route-highlight', 'line-opacity', 0.55);
    map.setPaintProperty('route-lines', 'line-opacity', 0.08);
    // Not dimmed: the fleet is filtered to this route instead, so its vehicles
    // stay at full brightness and keep running while everything else steps
    // back. Dimming here would hide the buses the preview is about.
    app.vehicleLayer.setDimmed(false);
    app.vehicleLayer.setFocusRoute(route.id);

    // Every pattern of a route carries its own headway, and they differ a lot
    // — corridor 8 runs from 225 s to 3600 s across its fourteen. Taking the
    // first one and labelling it "tiap 9 mnt" stated a precision the data does
    // not have, so the card shows the spread when there is one.
    const headways = [];

    for (const candidate of network.trips) {
        if (candidate.route !== route.id) {
            continue;
        }
        for (const window of candidate.windows ?? []) {
            if (window[2] > 0) {
                headways.push(window[2]);
            }
        }
    }

    const info = {
        stops: trip ? trip.stops.map(id => network.stops.get(id)).filter(Boolean) : [],
        color,
        headway: headways.length ? Math.min(...headways) : null,
        headwayMax: headways.length ? Math.max(...headways) : null
    };

    app.previewedRoute = {route, info};
    app.selectedRun = -1;
    app.trackedRun = -1;
    app.vehicleLayer.setSelection(-1);
    app.detail.showRoute(route, info);

    if (!trip) {
        return;
    }

    const bounds = new mapboxgl.LngLatBounds(),
        {start, count} = trip.shape;

    for (let i = 0; i < count; i++) {
        bounds.extend([network.coords[(start + i) * 2], network.coords[(start + i) * 2 + 1]]);
    }
    // Left padding clears the rail, which is where the card the user is
    // reading actually is.
    map.fitBounds(bounds, {
        padding: {top: 80, bottom: 80, left: 330, right: 90},
        pitch: configs.defaultPitch,
        duration: 1400
    });
}

/** Puts the network back after a line preview. */
function clearRoutePreview(app) {
    const {map} = app;

    if (!app.highlightedRoute) {
        return;
    }
    app.highlightedRoute = null;
    app.previewedRoute = null;
    map.setFilter('route-highlight', ['==', ['get', 'route'], ' ']);
    map.setPaintProperty('route-highlight', 'line-opacity', 0.95);
    map.setPaintProperty('route-lines', 'line-opacity',
        ['interpolate', ['linear'], ['zoom'], 9, 0.28, 13, 0.4, 17, 0.55]);
    app.vehicleLayer.setFocusRoute(null);
    app.vehicleLayer.setDimmed(false);
}

// --------------------------------------------------------------- interaction

function wireInteraction(app) {
    const {map} = app;

    map.on('click', event => {
        // Cameras first. A pin is a deliberate target drawn on top of
        // everything else, so a click that lands on one is not ambiguous the
        // way a bus sitting at a stop is.
        const camera = pickCamera(app, event.point);

        if (camera) {
            showCamera(app, camera);
            return;
        }

        const {slot, distance} = pickBus(app, event.point),
            stop = pickStop(app, event.point);

        // Buses linger at stops, so the two targets frequently overlap.
        // Whichever the click landed nearer to is the one the user meant.
        if (stop && !(distance < stop.distance)) {
            closeCamera(app);
            showStop(app, stop.stop);
            return;
        }
        if (slot >= 0) {
            closeCamera(app);
            app.selectedRun = app.fleet.active[slot];
            app.selectedStop = null;
            app.nearby = null;
            app.vehicleLayer.setSelection(slot);
            app.syncUrl?.();
            return;
        }

        // Neither a bus nor a stop: answer for wherever they actually tapped.
        closeCamera(app);
        showNearby(app, event.lngLat);
    });

    map.on('mousemove', event => {
        const over = pickCamera(app, event.point) ||
            pickBus(app, event.point).slot >= 0 || pickStop(app, event.point);

        map.getCanvas().style.cursor = over ? 'pointer' : '';
    });

    // Taking the map by hand means you no longer want it driven for you.
    // These events also fire for the camera's own moves, so only a gesture
    // carrying a DOM event counts - otherwise the follow view would cancel
    // itself the moment it turned with the bus.
    for (const event of ['dragstart', 'rotatestart']) {
        map.on(event, e => {
            if (e.originalEvent) {
                app.trackedRun = -1;
            }
        });
    }
}

/**
 * The camera under a click, if any.
 *
 * Unlike buses, camera pins are a real Mapbox layer, so the map's own hit
 * testing answers this exactly — with the icon's placement and collisions
 * already accounted for. A small box rather than a bare point because a pin is
 * a target people aim at with a finger.
 */
function pickCamera({map, cameras, camerasOn}, point) {
    if (!camerasOn || !cameras?.length) {
        return null;
    }

    const box = 6,
        hits = map.queryRenderedFeatures(
            [[point.x - box, point.y - box], [point.x + box, point.y + box]],
            {layers: ['camera-markers']}
        );

    return hits.length ? cameras[hits[0].properties.index] : null;
}

/**
 * Finds the bus nearest a screen point.
 *
 * The fleet lives in a custom WebGL layer, so Mapbox's feature query cannot see
 * it. Projecting the buses on screen and taking the nearest is cheap enough at
 * click frequency and avoids a second picking render pass.
 */
function pickBus({map, fleet, previewedRoute}, point) {
    const bounds = map.getBounds(),
        west = bounds.getWest(),
        east = bounds.getEast(),
        south = bounds.getSouth(),
        north = bounds.getNorth(),
        // A line preview scales every other vehicle to nothing. They are still
        // in the active list, so without this you can click bare map and select
        // a bus you cannot see.
        focus = previewedRoute ? previewedRoute.route.id : null,
        trips = fleet.network.trips;
    let bestSlot = -1,
        bestDistanceSq = PICK_RADIUS * PICK_RADIUS;

    for (let i = 0; i < fleet.activeCount; i++) {
        if (focus) {
            const trip = trips[fleet.runTrip[fleet.active[i]]];

            if (!trip || trip.route !== focus) {
                continue;
            }
        }

        const [lon, lat] = mercToLngLat(fleet.mercX[i], fleet.mercY[i]);

        if (lon < west || lon > east || lat < south || lat > north) {
            continue;
        }

        const screen = map.project([lon, lat]),
            dx = screen.x - point.x,
            dy = screen.y - point.y,
            distanceSq = dx * dx + dy * dy;

        if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestSlot = i;
        }
    }
    return {
        slot: bestSlot,
        distance: bestSlot < 0 ? Infinity : Math.sqrt(bestDistanceSq)
    };
}

/** The stop circle under a screen point, with how far the click missed by. */
function pickStop({map, network}, point) {
    const hit = map.queryRenderedFeatures(point, {layers: ['stop-circles']})[0];

    if (!hit) {
        return null;
    }

    const screen = map.project(hit.geometry.coordinates);

    return {
        stop: network.stops.get(hit.properties.id),
        distance: Math.hypot(screen.x - point.x, screen.y - point.y)
    };
}

/**
 * Upcoming departures from a stop.
 *
 * The feed is headway-based, so a departure is not a row to look up but the
 * next multiple of the headway that has not yet passed within a service window.
 */
function nextDepartures({network, clock, fleet}, stop, limit = 6) {
    const now = clock.getTimeOffset(),
        dayOfWeek = clock.getDayOfWeek(),
        // A station is served through its platforms, so match any of them.
        boardable = new Set(network.stopIdsFor(stop)),
        results = [];

    for (const trip of network.trips) {
        if (!servesOn(trip, network.calendar, dayOfWeek)) {
            continue;
        }

        const route = network.routes.get(trip.route);

        if (!fleet.isCategoryVisible(route.category)) {
            continue;
        }

        let index = -1;

        for (let i = 0; i < trip.stops.length; i++) {
            if (boardable.has(trip.stops[i])) {
                index = i;
                break;
            }
        }
        if (index < 0) {
            continue;
        }

        // A departure board reads as "arrives in 3 minutes", so this asks when
        // the bus pulls in rather than when it pulls away.
        const next = nextDeparture(trip, index, now, {basis: 'arrival'});

        if (next && next.wait < 3600) {
            results.push({route, headsign: trip.headsign, wait: next.wait});
        }
    }

    results.sort((a, b) => a.wait - b.wait);
    return results.slice(0, limit);
}

/** Shows what can be caught from an arbitrary point on the map. */
/**
 * When the first and last departure of the day call at a stop.
 *
 * "Last bus 22:47" is a real anxiety and the feed answers it exactly — it is
 * just a computation rather than a lookup, since the timetable is headway-based.
 * The service day matters: 50 trips are weekday-only and 32 Sunday-only, so the
 * answer genuinely changes with the day you ask about.
 */
function serviceHours({network, clock, fleet}, stop) {
    const dayOfWeek = clock.getDayOfWeek(),
        boardable = new Set(network.stopIdsFor(stop));
    let first = Infinity,
        last = -Infinity;

    for (const trip of network.trips) {
        if (!servesOn(trip, network.calendar, dayOfWeek)) {
            continue;
        }
        if (!fleet.isCategoryVisible(network.routes.get(trip.route).category)) {
            continue;
        }

        let index = -1;

        for (let i = 0; i < trip.stops.length; i++) {
            if (boardable.has(trip.stops[i])) {
                index = i;
                break;
            }
        }
        if (index < 0) {
            continue;
        }

        const span = serviceSpan(trip, index);

        if (span) {
            first = Math.min(first, span.first);
            last = Math.max(last, span.last);
        }
    }
    return first === Infinity ? null : {first, last};
}

function showNearby(app, lngLat) {
    const stops = app.router.nearestNodes(lngLat.lng, lngLat.lat);

    app.selectedRun = -1;
    app.trackedRun = -1;
    app.selectedStop = null;
    app.vehicleLayer.setSelection(-1);
    app.nearby = {point: [lngLat.lng, lngLat.lat], stops};
    app.syncUrl?.();
}

function showStop(app, stop) {
    if (!stop) {
        return;
    }
    app.syncUrl?.();
    clearRoutePreview(app);
    app.selectedRun = -1;
    app.trackedRun = -1;
    app.nearby = null;
    app.selectedStop = stop;
    app.vehicleLayer.setSelection(-1);
    app.detail.showStop(stop, nextDepartures(app, stop), {
        hours: serviceHours(app, stop),
        now: app.clock.getTimeOffset()
    });
}

// ------------------------------------------------------- navigation camera

/**
 * A point ahead of the bus along its heading.
 *
 * Centring the bus itself wastes most of the screen on road already travelled.
 * Centring a point in front of it sits the bus low in the frame, the way a
 * turn-by-turn view does, and because the distance is derived from the current
 * scale it holds its framing as you zoom.
 */
function lookAhead(map, [lon, lat], bearingDeg, fraction = NAV_LOOK_AHEAD) {
    const cosLat = Math.cos(lat * RAD),
        metresPerPixel = 40075017 * cosLat / (512 * Math.pow(2, map.getZoom())),
        ahead = metresPerPixel * map.getContainer().clientHeight * fraction,
        radians = bearingDeg * RAD;

    return [
        lon + ahead * Math.sin(radians) / (111320 * cosLat),
        lat + ahead * Math.cos(radians) / 110574
    ];
}

/** Rides along with the tracked bus, turning with it. */
function followCamera(app, info) {
    const {map, nav} = app,
        onboard = app.cameraMode === 'onboard',
        zoom = onboard ? ONBOARD_ZOOM : NAV_ZOOM,
        pitch = onboard ? ONBOARD_PITCH : NAV_PITCH,
        fraction = onboard ? ONBOARD_LOOK_AHEAD : NAV_LOOK_AHEAD;

    // Switching viewpoint mid-follow has to re-settle the camera, so treat it
    // like picking up a new bus.
    if (nav.mode !== app.cameraMode) {
        nav.mode = app.cameraMode;
        nav.run = -1;
    }

    if (nav.run !== info.run) {
        // Entering the follow view: swing in behind the bus and drop to street
        // level once, then hand over to the per-frame update below.
        nav.run = info.run;
        nav.bearing = info.bearing;
        nav.settling = true;
        nav.time = performance.now();
        map.easeTo({
            center: lookAhead(map, info.lngLat, info.bearing, fraction),
            bearing: info.bearing,
            zoom,
            pitch,
            duration: 900
        });
        map.once('moveend', () => {
            nav.settling = false;
        });
        return;
    }
    if (nav.settling) {
        return;
    }

    // Shortest-arc smoothing: corners swing through rather than snapping, and
    // the view never spins the long way round when the heading crosses north.
    const now = performance.now(),
        elapsed = Math.min((now - nav.time) / 1000, 0.25),
        delta = ((info.bearing - nav.bearing + 540) % 360) - 180;

    nav.time = now;
    nav.bearing += delta * (1 - Math.exp(-elapsed / NAV_TURN_TAU));
    map.jumpTo({
        center: lookAhead(map, info.lngLat, nav.bearing, fraction),
        bearing: nav.bearing
    });
}

/** Switches between riding behind the bus and riding on it. */
function setCameraMode(app, mode) {
    app.cameraMode = mode;
    // From on board you are inside the vehicle, so drawing it fills the frame.
    app.vehicleLayer.setSelectionHidden(mode === 'onboard');
}

/** Leaves the ride and restores the camera the user had before it. */
function exitRide(app) {
    const {map, ride} = app;

    ride.stop();
    setCameraMode(app, 'chase');
    ride.camera = 'chase';
    app.nav.run = -1;
    app.vehicleLayer.setSelection(-1);
    if (app.rideReturn) {
        map.easeTo({...app.rideReturn, duration: 900});
        app.rideReturn = null;
    }
}

/**
 * Drives the camera through a planned journey.
 *
 * Ride legs reuse the follow camera, pointed at the run actually serving the
 * leg. Walk legs glide between the two stops at walking pace, so a transfer
 * reads as part of the journey rather than a cut.
 */
function rideCamera(app, state) {
    const {map, ride} = app;

    if (state.done) {
        exitRide(app);
        return;
    }

    if (state.phase === 'ride') {
        if (!state.info) {
            app.vehicleLayer.setSelection(-1);

            // Waiting for the bus to set out: hold on the boarding stop rather
            // than leaving the camera wherever it happened to be.
            const at = app.network.stops.get(state.entry.leg.from);

            if (state.boarding && at) {
                map.jumpTo({
                    center: [at.lon, at.lat],
                    zoom: Math.max(map.getZoom(), NAV_ZOOM),
                    pitch: NAV_PITCH
                });
            }
            return;
        }
        app.vehicleLayer.setSelection(state.slot);
        followCamera(app, state.info);
        return;
    }

    // Walking: interpolate between the two stops, facing the way you are going.
    const from = app.network.stops.get(state.entry.leg.from),
        to = app.network.stops.get(state.entry.leg.to);

    app.vehicleLayer.setSelection(-1);
    if (!from || !to) {
        return;
    }

    const t = state.progress,
        lon = from.lon + (to.lon - from.lon) * t,
        lat = from.lat + (to.lat - from.lat) * t,
        bearing = Math.atan2(
            (to.lon - from.lon) * Math.cos(lat * RAD),
            to.lat - from.lat
        ) / RAD;

    // Reuse the nav bearing smoothing so the hand-off from a bus is not a snap.
    const nav = app.nav,
        delta = ((bearing - nav.bearing + 540) % 360) - 180;

    nav.run = -1;
    nav.bearing += delta * 0.06;
    map.jumpTo({
        center: lookAhead(map, [lon, lat], nav.bearing),
        bearing: nav.bearing,
        zoom: Math.max(map.getZoom(), 16.5),
        pitch: NAV_PITCH
    });
}

// -------------------------------------------------------------- frame loop

function loop(app) {
    const {map, clock, fleet, vehicleLayer, clockControl, detail} = app;
    let lastStopRefresh = 0,
        lastLive = null;

    const frame = () => {
        const now = clock.getTimeOffset();

        fleet.update(now, clock.getDayOfWeek());
        clockControl.update();

        const hour = Math.floor(now / 3600),
            preset = lightPreset(hour);

        if (app.routeColouring === 'headway' &&
            Math.abs(now - (app.lastHeadwayAt ?? -1e9)) > 120) {
            app.lastHeadwayAt = now;
            applyHeadwayColours(app);
        }

        if (preset !== app.lastPreset) {
            app.lastPreset = preset;
            map.setConfigProperty('basemap', 'lightPreset', preset);
            applyStopTheme(map, preset);
        }

        // Following is the only state this HUD belongs to, and a ride has its
        // own. One guard here rather than a hide() in every other branch.
        if ((app.trackedRun < 0 || app.ride.active) && app.followHud.hide()) {
            // Stopping while on board would otherwise leave the vehicle hidden
            // — the camera was inside it, so it was scaled away.
            if (!app.ride.active) {
                setCameraMode(app, 'chase');
            }
        }

        // A camera shows the street *now*; the clock may be replaying a
        // Tuesday in March at 1200x. There is no honest way to show both, so
        // the layer is available only in live mode and shuts itself down when
        // the clock leaves it — the same call Mini Tokyo 3D's camera plugin
        // makes with `clockModes: ['realtime']`.
        //
        // Compared against the last frame rather than applied every frame:
        // this reaches into the DOM and the map's layout properties, and doing
        // that sixty times a second to write the value it already holds is
        // work for nothing.
        if (clock.live !== lastLive) {
            lastLive = clock.live;
            app.layerPanel.setCamerasAvailable(clock.live);
            if (!clock.live && app.camerasOn) {
                app.layerPanel.setLayerUI('cameras', false);
                setCameras(app, false);
            }
        }

        if (app.ride.active) {
            const state = app.ride.advance(now);

            if (state) {
                app.ride.updateHUD(state, now);
                rideCamera(app, state);
            }
            detail.showJourney(app.journey);
        } else if (app.selectedCamera) {
            // Its own branch, ahead of everything but a ride. Without one this
            // chain would overwrite the card on the very next frame — which is
            // exactly how the line preview appeared and vanished — and here it
            // would tear down a playing stream sixty times a second.
            detail.showCamera(app.selectedCamera, {
                stop: app.network.stops.get(app.selectedCamera.stop) ?? null,
                notice: app.cameraNotice ?? null,
                onMount: (video, errorEl) => {
                    app.streamPlayer.play(video, app.selectedCamera.hls, message => {
                        errorEl.textContent = message;
                        errorEl.hidden = false;
                    });
                }
            });
        } else if (app.nearby) {
            detail.showNearby(app.nearby, stop => nextDepartures(app, stop, 2));
        } else if (app.reach.active) {
            detail.showReach(app.reach);
        } else if (app.previewedRoute && app.selectedRun < 0) {
            // Ahead of the journey, because previewing a line is the more
            // recent choice — and because this loop reasserts its branch every
            // frame, which otherwise wipes the line card the moment it opens.
            //
            // Behind the vehicle card, though: while a line is previewed its
            // own vehicles are the only ones you can click, so clicking one
            // means you want that train, not the line you found it from. The
            // map keeps the line focused either way.
            detail.showRoute(app.previewedRoute.route, app.previewedRoute.info);
        } else if (app.journey.active && !app.previewedRoute) {
            // The preview guard only matters when a journey is already planned
            // and a line is previewed on top of it: clicking one of that line's
            // trains should then reach the vehicle branch, not fall back to the
            // journey card. Journey still outranks a vehicle otherwise.
            detail.showJourney(app.journey);
        } else if (app.selectedRun >= 0) {
            const slot = fleet.slotOfRun(app.selectedRun);

            vehicleLayer.setSelection(slot);
            if (slot >= 0) {
                const info = fleet.describe(slot);

                detail.showVehicle(info, {tracking: app.trackedRun === app.selectedRun});
                if (app.trackedRun === app.selectedRun) {
                    followCamera(app, info);
                    app.followHud.show(info);
                } else {
                    app.followHud.hide();
                    if (app.nav.run !== -1) {
                        app.nav.run = -1;
                    }
                }
            } else {
                // The run finished, or its category was hidden.
                app.selectedRun = -1;
                app.trackedRun = -1;
                detail.close();
            }
        } else if (app.selectedStop && performance.now() - lastStopRefresh > 3000) {
            lastStopRefresh = performance.now();
            detail.showStop(
                app.selectedStop,
                nextDepartures(app, app.selectedStop),
                {hours: serviceHours(app, app.selectedStop), now: now}
            );
        }

        requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
}

main().catch(error => {
    console.error(error);
    status.textContent = `Gagal memuat: ${error.message}`;
});
