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
import MapLayersPanel from './ui/map-layers';
import MapStyleControl from './ui/map-style';
import SearchControl from './ui/search-control';
import Credits from './ui/credits';
import {
    installSprite, lineColorExpression, routeColor, routeMark, vehicleColors
} from './kodefikasi';
import DetailPanel from './ui/detail-panel';
import {nextDeparture, serviceSpan, servesOn} from './routing/timetable';
import Router from './routing/router';
import FollowHUD, {DEFAULT_CAMERA} from './ui/follow-hud';
import Tour from './tour';
import RideSound from './ride-sound';
import Sky, {sunPosition} from './sky';
import Reach, {EDGE_SECONDS} from './ui/reach';
import {applyState, readState, startSync} from './url-state';
import {StreamPlayer, cameraIcon, loadCameras} from './cameras';

// Read at module load, not at the point of use: `startSync` writes the query
// string from app state on its first tick, so any flag it does not serialise
// is gone by the time the app is built. `?bench` is not app state and never
// should be — it is an instrument, not a view worth sharing. Its value picks
// the arms: `?bench=static`, `?bench=motion`, or bare for both.
const BENCH = new URLSearchParams(location.search).get('bench');

const RAD = Math.PI / 180,
    // How close to a bus, in screen pixels, a click has to land.
    PICK_RADIUS = 18,

    /*
       Navigasi: the egocentric view.

       The automotive framing: the camera sits behind and just above the
       vehicle, the horizon is in frame, and what fills the screen is the road
       ahead rather than the district around it. Pitch 78 of Mapbox's 85
       maximum is where the ground plane starts reading as *road surface
       receding* instead of as a tilted map. A third framing, `chase` — a map
       at 65 degrees that happened to be following something — was removed: it
       was the bird's-eye view this mode kept being mistaken for.

       The look-ahead is what puts the ego low in the frame: it centres the
       camera on a point this fraction of a viewport ahead, so the vehicle
       itself sits near the bottom where a driver's own bonnet would be.
       Smaller than `onboard`, which pushes the vehicle off the bottom of the
       screen entirely. The pitched view compresses it, so the vehicle lands
       lower than the literal fraction.
    */
    EGO_ZOOM = 17.6,
    EGO_PITCH = 78,
    EGO_LOOK_AHEAD = 0.46,
    // How much of the road ahead the nav ribbon fades out over, as a fraction
    // of the whole trip. Beyond it the route dissolves rather than running to
    // a hard stop at the horizon.
    EGO_FADE = 0.06,

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

/*
   Which of Standard's four presets the sky is closest to.

   Four is all Mapbox Standard offers, so what is left to get right is *when*
   they change — and round hours get that wrong everywhere. The old bands put
   dawn at 05:00 and dusk at 17:00-19:00; Jakarta's sun comes up around 05:55
   and goes down around 17:50, so the map was lighting its dawn an hour before
   the sky did and holding dusk for an hour after dark. The sun maths lives in
   `sky.js`, which is also what drives the continuous tint over the canvas.

   A continuously moving sun on the basemap itself was tried and rejected —
   see trap 19 for why `setLights` is a one-way door.
*/
function lightPreset({altitude, rising}) {
    if (altitude > 6) {
        return 'day';
    }
    // Civil twilight, near enough: the sky still carries colour down to about
    // six degrees below the horizon, which is where Standard's dawn and dusk
    // presets stop being believable too.
    if (altitude > -6) {
        return rising ? 'dawn' : 'dusk';
    }
    return 'night';
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
    const rails = {'left-rail': ['search', 'detail'], 'right-rail': ['clock', 'layers', 'map-layers']};

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

    /*
       The credits, in one strip in the bottom-right corner.

       Mapbox's own attribution — "© Mapbox © OpenStreetMap Improve this map" —
       and `Sumber data`, which opens the panel naming every source, side by
       side as one line. They used to sit in opposite corners, the credits
       control bottom-left beside the wordmark, and read as two unrelated
       things, which is what a credit is not meant to be.

       Mapbox's control is *wrapped*, not rewritten. Its text comes from the
       style's own sources and its feedback link follows the view, so copying
       the words out would be a licence condition kept by hand and broken the
       first time the style changed. And the trigger cannot go inside it:
       Mapbox sanitises `customAttribution` hard — a `<button>` arrived as bare
       text and an `<a class="js-credits">` lost its class, both looking
       operable and neither being so. So the strip is a control of our own
       holding theirs and ours.

       Route geometry and station positions are derived from OpenStreetMap, so
       ODbL requires that credit, which Mapbox's line already carries. The
       simulation line is not a legal requirement: every vehicle on screen is
       where the timetable says it should be, and a map this convincing needs
       to say so somewhere a person will find it without opening anything. On
       a narrow screen Mapbox folds its line behind an (i), as its own control
       always has, and `Sumber data` stays beside it.
    */
    const attribution = new mapboxgl.AttributionControl({
        customAttribution: ['Simulasi terjadwal — bukan posisi kendaraan sebenarnya']
    });

    map.addControl({
        onAdd(m) {
            const el = document.createElement('div');

            el.className = 'mapboxgl-ctrl credit-strip';
            el.appendChild(attribution.onAdd(m));
            el.insertAdjacentHTML('beforeend',
                '<button type="button" class="credit-strip-link js-credits">Sumber data</button>');
            this._el = el;
            return el;
        },
        onRemove() {
            attribution.onRemove();
            this._el.remove();
        }
    }, 'bottom-right');

    map.addControl(new mapboxgl.NavigationControl({visualizePitch: true}), 'bottom-right');
    map.addControl(new mapboxgl.GeolocateControl({trackUserLocation: true}), 'bottom-right');

    const vehicleLayer = new VehicleLayer(fleet);

    vehicleLayer.lineColor = vehicleColors(network.routes);

    const app = {
        map, clock, network, fleet, vehicleLayer,
        // Built before the frame loop rather than in `buildUI`, because the
        // loop's first pass writes to it — the same reason the basemap theme
        // is established before the layers (trap 12).
        sky: new Sky(),
        selectedRun: -1,
        trackedRun: -1,
        selectedStop: null,
        lastPreset: null,
        router: new Router(network),
        cameraMode: DEFAULT_CAMERA,
        routeColouring: 'category',
        // The live CCTV layer. `cameras` stays null until the layer is first
        // switched on — its artifact is not fetched before then.
        cameras: null,
        selectedCamera: null,
        camerasOn: false,
        streamPlayer: new StreamPlayer(),
        // Chase-camera state while following a bus.
        nav: {run: -1, bearing: 0, settling: false, time: 0, mode: null}
    };

    await new Promise(resolve => map.on('style.load', resolve));

    // Before the layers, not after. `applyStopTheme` branches on the theme, and
    // the frame loop runs it on its first pass to set the light preset — so the
    // theme has to be true by then or the stops are inked for the default map
    // and stay that way until the hour changes. Establish the condition before
    // the state that depends on it (trap 12).
    map.setConfigProperty('basemap', 'theme', readBasemapTheme());

    addRouteLayers(app);
    addNavLayers(app);
    addTourLayers(app);
    addReachLayers(app);
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
            app.mapLayers.setLayerUI('accessible', on);
            setAccessibleOnly(app, on);
        },
        onCamera: (id, options) => restoreCamera(app, id, options),
        onTour: route => {
            selectRoute(app, route);
            // After the preview's `fitBounds`: a tour's first `jumpTo` against
            // a flight still easing in makes the opening shot stutter.
            setTimeout(() => tourPreviewedRoute(app), 1500);
        }
    });
    startSync(app);

    // Exposed for debugging and automated checks.
    window.__tj = app;

    // `?bench` runs the on-device render benchmark (JAKAR-60). Dynamically
    // imported, so a visitor who never asks for it downloads none of it —
    // the same arrangement `hls.js` has. Failure is deliberately silent
    // beyond the console: a debug flag must never be able to break a boot.
    if (BENCH !== null) {
        import('./bench.js')
            .then(module => module.default(app, {only: BENCH}))
            .catch(error => console.error('bench failed', error));
    }

    document.getElementById('loader').classList.add('hidden');
    loop(app);
}

// ---------------------------------------------------------------- map layers

function addRouteLayers({map, network}) {
    map.addSource('routes', {type: 'geojson', data: network.lines});

    const colorExpression = lineColorExpression();

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

/*
   The road ahead, in the egocentric view.

   A nav view's subject is not "the route" but "the route *from here forward*",
   and the difference is the whole feel of the thing. The followed trip's whole
   shape goes into the source once, when the vehicle is picked up; what moves
   every frame is `line-trim-offset`, which paints the travelled part
   transparent. That is a **paint** property, so the ribbon re-anchors to the
   vehicle sixty times a second without the source being touched at all — a
   `setData` per frame would round-trip through the GeoJSON worker and the
   ribbon would visibly lag behind the vehicle it is supposed to start at.

   Casing under core, the way every automotive renderer draws a route: the dark
   casing is what separates a bright ribbon from a bright road underneath it.
*/
function addNavLayers({map}) {
    map.addSource('nav-route', {
        type: 'geojson',
        // `line-trim-offset` and `line-gradient` both measure along the line,
        // and neither works without this.
        lineMetrics: true,
        data: {type: 'FeatureCollection', features: []}
    });

    map.addLayer({
        id: 'nav-route-casing',
        type: 'line',
        source: 'nav-route',
        layout: {'line-cap': 'round', 'line-join': 'round', visibility: 'none'},
        paint: {
            'line-color': '#05070c',
            'line-width': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 26],
            'line-opacity': 0.55,
            'line-blur': 2
        }
    });

    map.addLayer({
        id: 'nav-route-core',
        type: 'line',
        source: 'nav-route',
        layout: {'line-cap': 'round', 'line-join': 'round', visibility: 'none'},
        paint: {
            'line-color': '#4da3ff',
            'line-width': ['interpolate', ['linear'], ['zoom'], 14, 5, 18, 16],
            // Lit rather than shaded, so the ribbon holds its colour at night
            // as well as at noon — it is a signal, not a painted road marking.
            'line-emissive-strength': 1
        }
    });

    map.addSource('nav-stops', {
        type: 'geojson',
        data: {type: 'FeatureCollection', features: []}
    });

    map.addLayer({
        id: 'nav-stop-dots',
        type: 'circle',
        source: 'nav-stops',
        layout: {visibility: 'none'},
        paint: {
            'circle-radius': ['case', ['==', ['get', 'next'], 1], 8, 5],
            'circle-color': ['case', ['==', ['get', 'next'], 1], '#ffd400', '#ffffff'],
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#05070c',
            'circle-emissive-strength': 1
        }
    });

    map.addLayer({
        id: 'nav-stop-labels',
        type: 'symbol',
        source: 'nav-stops',
        layout: {
            visibility: 'none',
            'text-field': ['get', 'name'],
            'text-size': 13,
            'text-offset': [0, -1.4],
            'text-anchor': 'bottom',
            // The one place in this app that sets `text-allow-overlap`. A nav
            // view has a handful of labels and they are the point of it, so
            // losing the next stop's name to the basemap's own collision
            // budget would be trap 9 in its most annoying form.
            'text-allow-overlap': true,
            'text-ignore-placement': true
        },
        filter: ['==', ['get', 'next'], 1],
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#05070c',
            'text-halo-width': 1.8,
            'text-emissive-strength': 1
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

/**
 * Follows the sweep: which stops have been reached yet, and which have just
 * been reached.
 *
 * A filter and a radius, both driven off `secs` — the arrival time the search
 * was already returning. The leading edge is drawn larger and then settles,
 * which is what makes the spread read as a wavefront rather than as dots
 * appearing. At rest the frontier is `Infinity`, the filter passes everything,
 * and the interpolation collapses to the resting radius.
 */
function applyReachFrontier(app) {
    const {map, reach} = app;

    if (!map.getLayer('reach-points')) {
        return;
    }
    const frontier = reach.frontier,
        sweeping = Number.isFinite(frontier);

    map.setFilter('reach-points',
        sweeping ? ['<=', ['get', 'secs'], frontier] : null);

    /*
       1.9x at the instant of arrival, back to 1x a couple of minutes of
       journey time later.

       The multiply is pushed *inside* each zoom stop rather than wrapped
       around the whole interpolation, which looks like a needless
       complication and is not: Mapbox rejects a `zoom` expression anywhere
       but at the top level of a step or interpolate, so `['*', <zoom
       interpolate>, <pulse>]` throws on every frame — and throws from
       `setPaintProperty`, so the filter carries on sweeping and only the
       radius silently never applies.
    */
    const pulse = sweeping ? [
            'interpolate', ['linear'],
            ['-', frontier, ['get', 'secs']],
            0, 1.9,
            EDGE_SECONDS, 1
        ] : 1,
        at = (station, other) => ['*',
            ['case', ['==', ['get', 'band'], 0], station, other], pulse];

    map.setPaintProperty('reach-points', 'circle-radius', [
        'interpolate', ['linear'], ['zoom'],
        10, at(6, 2.5),
        16, at(12, 7)
    ]);
}

/*
   The stop layer at rest: a hole punched in the ground, filled with the ground
   colour and outlined in the ink colour, which reads correctly on a noon map
   and on a midnight one.

   Named once so that anything which repaints the stops for a view of its own
   can put back exactly this. A restore that only puts back the properties
   somebody remembered is how a layer ends up permanently three pixels bigger
   than it was — *Bus terakhir* repainted these until it was removed, and a
   view like it would again.
*/
const STOP_MINZOOM = 12,
    STOP_PAINT = {
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
    };

function addStopLayers(app) {
    const {map, network} = app,
        features = [];

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

    // Kept on the app so the last-departure view can annotate the features and
    // re-set them without reaching into the source's private `_data`.
    app.stopData = {type: 'FeatureCollection', features};
    map.addSource('stops', {type: 'geojson', data: app.stopData});

    map.addLayer({
        id: 'stop-circles',
        type: 'circle',
        source: 'stops',
        minzoom: STOP_MINZOOM,
        paint: {...STOP_PAINT}
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
    app.mapLayers.setLayerUI('cameras', true);
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
        onCategoryToggle: () => applyRouteFilter(app)
    });

    app.mapLayers = new MapLayersPanel({
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
            } else if (layer === 'trails') {
                app.vehicleLayer.setTrails(on);
            } else {
                map.setConfigProperty('basemap', 'show3dObjects', on);
            }
        }
    });

    app.legend = app.mapLayers;

    // Bottom-left, above the Mapbox wordmark, where Google Maps keeps its own
    // map-style thumbnail. Added here rather than with the other controls
    // because applying a theme needs `app` — the stop ink follows it.
    app.mapStyle = new MapStyleControl({
        theme: readBasemapTheme(),
        onTheme: theme => setBasemapTheme(app, theme)
    });
    map.addControl(app.mapStyle, 'bottom-left');

    app.search = new SearchControl(network, {
        onSelectRoute: route => selectRoute(app, route),

        // Both kinds do the same thing now: show me this. A line is previewed
        // on the map; a stop opens its card and the map goes to it.
        onSelectStop: stop => {
            clearRoutePreview(app);
            app.selectedRun = -1;
            app.vehicleLayer.setSelection(-1);
            app.selectedStop = stop;
            map.flyTo({center: [stop.lon, stop.lat], zoom: 15, duration: 1000});
        },
        onClear: () => {
            clearRoutePreview(app);
            app.detail.close();
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
    // The sweep only touches the map, not the card or the URL, so it gets its
    // own callback rather than going through `onChange` — which rebuilds the
    // panel, and rebuilding an interactive panel sixty times a second is
    // trap 1 with a new trigger.
    app.reach.onFrontier = () => applyReachFrontier(app);

    // Built now, silent and empty: nothing is fetched or played until the
    // follow HUD's Suara is pressed.
    app.rideSound = new RideSound();

    app.followHud = new FollowHUD({
        clock,
        onSound: on => (on ? app.rideSound.enable() : app.rideSound.disable()),
        onStop: () => {
            app.trackedRun = -1;
        },
        onCamera: mode => setCameraMode(app, mode),
        onSpeed: speed => {
            clock.setSpeed(speed);
            app.clockControl.syncSpeed();
        }
    });

    app.tour = new Tour(map);

    app.detail = new DetailPanel(network, {
        onTrack: () => {
            app.trackedRun = app.trackedRun === app.selectedRun ? -1 : app.selectedRun;
        },
        // One button id on two cards, because it is one idea — fly this line —
        // and the card already says which line it is about. Which trip that
        // means differs: the vehicle card tours the run on screen, the preview
        // card tours the longest pattern of the line it is showing.
        onTour: () => {
            if (app.detail.mode === 'route') {
                tourPreviewedRoute(app);
            } else {
                tourRoute(app);
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
        onReachPlay: () => app.reach.play(),
        onFromPoint: () => {
            if (!app.nearby) {
                return;
            }
            const [lon, lat] = app.nearby.point;

            // Reachability from an arbitrary point: the map answers "what is
            // within reach of *here*", which is the spatial question a tap on
            // empty map is actually asking.
            app.reach.setOrigin(
                {name: 'Titik dipilih', lon, lat},
                clock.getTimeOffset(), clock.getDayOfWeek()
            );
            app.nearby = null;
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
            app.reach.clear();
            app.tour?.stop();
            clearRoutePreview(app);
            // Closing the card has to stop the stream too, or the video keeps
            // pulling segments for a panel nobody can see.
            closeCamera(app);
        }
    });

    // The mode glyphs every badge draws through. Before the panels write any
    // markup — a `<use>` pointing at a symbol that is not in the document yet
    // renders nothing, and silently.
    installSprite();

    // The trigger lives inside Mapbox's own attribution markup, which is
    // rebuilt whenever the style's sources change, so the listener is
    // delegated from the document rather than bound to a button that may be
    // replaced under it.
    app.credits = new Credits();
    document.addEventListener('click', event => {
        if (event.target.closest('.js-credits')) {
            event.preventDefault();
            app.credits.show();
        }
    });

    // Every panel the rail collects now exists, so gather them.
    buildRails();

    // On a phone the header is above the map rather than beside it, so it has
    // to be short or it eats the thing it is a header for. Every panel in it
    // starts folded — the time and LIVE still read at a glance, and one tap
    // opens any of them. Initial state only: once a person unfolds something
    // it stays unfolded, and this never runs again.
    if (window.matchMedia('(max-width: 700px)').matches) {
        app.clockControl?.fold(true);
        app.layerPanel?.toggle(true);
        app.mapLayers?.toggle(true);
    } else {
        // On a desk the rail has room for one long panel, not two: both open,
        // Layanan and Lapisan peta each got half the height and both scrolled,
        // cut off mid-list. The layer switches are set once and their count
        // shows folded, so they are the one that starts as a bar.
        app.mapLayers?.toggle(true);
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

/*
   A timetabled run is stored as a one-off window carrying a 1-second headway.
   The rail sources publish departure boards rather than frequencies, so every
   rail trip has one — and it is a sentinel meaning "this runs once", not a
   service interval.

   Read as an interval it says two false things at once: the line card offered
   a Bogor train "tiap 0 mnt", and Warnai per frekuensi put all nine rail lines
   in the under-5-minute band, which is the most frequent thing on the map.
   Both were live from the day rail shipped. The feed's genuine headways start
   at 180 s, so a minute is comfortably below anything real and comfortably
   above the sentinel.
*/
const MIN_HEADWAY = 60;

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
            if (headway >= MIN_HEADWAY && now >= start && now < end) {
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
    map.setPaintProperty('route-lines', 'line-color', lineColorExpression());
}

function setRouteColouring(app, mode) {
    app.routeColouring = mode;
    if (mode === 'headway') {
        applyHeadwayColours(app);
    } else {
        applyCategoryColours(app);
    }
    app.legend.setMode(mode, HEADWAY_BANDS);
    app.layerPanel.setColouring(mode === 'headway');
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
        // The same pattern the tour flies, so the card's stop list and its
        // count describe the journey Jelajahi jalur ini then shows. It was the
        // feed's first pattern, which for the Bogor line is a 17-stop
        // Manggarai working: the card said 17 stops and the tour flew 24.
        trip = longestTrip(network, route.id),
        color = routeColor(route);

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
            if (window[2] >= MIN_HEADWAY) {
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

/*
   How long a finger has to stay down to mean "what is here" (JAKAR-66). Both
   reference apps drop a pin in this range, and it is far longer than the tail
   of a pan — 480ms of a finger held still is not something panning produces.
*/
const LONG_PRESS_MS = 480,
    // A finger is never still. Past this it was a pan, not a press.
    LONG_PRESS_SLOP = 12;

function wireInteraction(app) {
    const {map} = app;

    wireNearbyPress(app);

    map.on('click', event => {
        // The click that ends a long press would otherwise land on whatever
        // was under the finger and overwrite the card the press just opened.
        if (app.pressConsumed) {
            app.pressConsumed = false;
            return;
        }

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

        // Under a thumb, that answer is a press rather than a tap — so say so
        // and leave the map alone (JAKAR-66).
        if (app.touchPointer) {
            showPressHint(event.point);
            return;
        }
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

/*
   "Sekitar sini" is a press on a touch screen, and a click with a mouse
   (JAKAR-66).

   A tap that landed on nothing used to open the nearby card. That is right
   with a mouse — you do not pan by clicking — and wrong under a thumb:
   panning and pinching a map is a lot of touching, and every stray tap threw
   a card over **49% of a 390x844 phone**, measured, in the half of the screen
   the thumb is working in. So the gesture is now press-and-hold, which a pan
   cannot produce by accident and which is what both reference apps use to
   drop a pin.

   Gated on the pointer rather than on the viewport, though the complaint came
   from a phone. What makes the card hurt is that it is large relative to the
   screen *and* was not asked for, and both are properties of the input, not
   the width: the same phone held in landscape is 844px wide — past the 700px
   the layout switches at, so a width rule would miss it — and only 390px
   tall, where this card is taller than the whole viewport. A mouse in a
   narrow window has neither problem and keeps its click.
*/
function wireNearbyPress(app) {
    const {map} = app,
        surface = map.getCanvasContainer();

    // Where a single finger went down, and when. Null the moment the gesture
    // stops being a candidate — a second finger, or movement past the slop.
    let down = null;

    app.touchPointer = false;
    app.pressConsumed = false;

    // `pointerdown` rather than `touchstart` for this, because a touch screen
    // also fires a compatibility `mousedown` — after the click, which is too
    // late to be read as "this was a mouse" but early enough to corrupt a flag
    // set from mouse events. A pointer event says which it was, once.
    surface.addEventListener('pointerdown', event => {
        app.touchPointer = event.pointerType === 'touch';
    });

    surface.addEventListener('touchstart', event => {
        const touch = event.touches.length === 1 ? event.touches[0] : null;

        app.pressConsumed = false;

        // A second finger is a pinch, and a pinch is navigation.
        down = touch ?
            {x: touch.clientX, y: touch.clientY, at: event.timeStamp} :
            null;
    }, {passive: true});

    surface.addEventListener('touchmove', event => {
        const touch = event.touches[0];

        if (down && (!touch ||
            Math.hypot(touch.clientX - down.x, touch.clientY - down.y) > LONG_PRESS_SLOP)) {
            down = null;
        }
    }, {passive: true});

    surface.addEventListener('touchcancel', () => {
        down = null;
    }, {passive: true});

    /*
       Decided when the finger lifts, and from the events' own timestamps.

       Two things are deliberate here, and each replaced something that looked
       right and was measurably wrong.

       Not a timer: one has to be cancelled by the `touchend` of a short tap,
       and that event is only *dispatched* promptly — it is *processed*
       whenever the main thread gets to it. So a 480ms timer fires first and
       the cancellation arrives afterwards, and the tap has opened a card.

       And not `performance.now()` in the handler, which is when the browser
       got round to the event rather than when the finger moved. Measured in
       the probe: a 60ms tap arrived as `touchstart` at t=6667 and `touchend`
       at t=9221 — **2.5 seconds** of queueing, every tap a long press. That
       is a software rasteriser exaggerating a real effect, and the real
       effect matters here more than anywhere: this map is at its jankiest
       while being panned, which is exactly when JAKAR-66's stray taps
       happen. `timeStamp` is when the event was created, so it measures the
       finger and not the frame.
    */
    surface.addEventListener('touchend', event => {
        if (!down || event.timeStamp - down.at < LONG_PRESS_MS) {
            down = null;
            return;
        }

        const box = surface.getBoundingClientRect();

        // The click that ends this gesture is its own tail; without this it
        // lands on whatever was under the finger and overwrites the card.
        app.pressConsumed = true;
        hidePressHint();
        showNearby(app, map.unproject([down.x - box.left, down.y - box.top]));
        down = null;
    }, {passive: true});
}

/*
   A gesture nobody can find is a feature removed, so the tap that no longer
   opens the card says what does.

   Shown at the tap point rather than in a corner, because that is where the
   eye already is — and 54px above it, because the finger is on the point
   itself. Twice per visit and then never again: someone still tapping bare
   map after two of these is panning, not asking a question.
*/
const PRESS_HINT_LIMIT = 2;
let pressHintEl = null,
    pressHintTimer = null,
    pressHintsShown = 0;

function showPressHint(point) {
    if (pressHintsShown >= PRESS_HINT_LIMIT) {
        return;
    }
    if (!pressHintEl) {
        pressHintEl = document.createElement('div');
        pressHintEl.id = 'press-hint';
        pressHintEl.textContent = 'Tekan lama untuk lihat sekitar sini';
        document.body.appendChild(pressHintEl);
    }
    pressHintsShown++;

    // Clamped so the pill stays on screen when the tap was near an edge.
    const margin = 132;

    pressHintEl.style.left = `${Math.min(Math.max(point.x, margin), innerWidth - margin)}px`;
    pressHintEl.style.top = `${Math.max(point.y - 54, 12)}px`;
    pressHintEl.classList.add('open');

    clearTimeout(pressHintTimer);
    pressHintTimer = setTimeout(hidePressHint, 2600);
}

function hidePressHint() {
    clearTimeout(pressHintTimer);
    pressHintEl?.classList.remove('open');
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
function lookAhead(map, [lon, lat], bearingDeg, fraction) {
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
function followCamera(app, info, slot) {
    const {map, nav} = app,
        mode = app.cameraMode,
        // Two framings of the same ride: the automotive one from behind, and
        // from the roof.
        shot = mode === 'onboard' ?
            {zoom: ONBOARD_ZOOM, pitch: ONBOARD_PITCH, fraction: ONBOARD_LOOK_AHEAD} :
            {zoom: EGO_ZOOM, pitch: EGO_PITCH, fraction: EGO_LOOK_AHEAD},
        {zoom, pitch, fraction} = shot;

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
        // The road ahead is loaded once per vehicle, before the camera swings
        // in, so the ribbon is already under the bus when the view arrives
        // rather than appearing a beat later.
        setNavEmphasis(app, mode === 'nav');
        if (mode === 'nav') {
            setNavRoute(app, info);
        }
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

    if (mode === 'nav') {
        updateNavRoute(app, info, slot);
    }
}

/*
   `body.following` while a vehicle is followed, in either framing: the finder
   steps aside, and on a phone the card moves up under the header (see the
   stylesheet). Compared rather than written, because the frame loop calls it
   sixty times a second.
*/
function setFollowing(app, on) {
    if (app.following !== on) {
        app.following = on;
        document.body.classList.toggle('following', on);
    }
}

const NAV_LAYERS = ['nav-route-casing', 'nav-route-core',
    'nav-stop-dots', 'nav-stop-labels'];

/*
   What the egocentric view takes away.

   A nav view is a hierarchy — ego, then the road ahead, then just enough of
   the surroundings to place it — and the way to get one is subtraction, not
   emphasis. The same lesson the line preview learned: with seven hundred route
   lines drawn, a brighter needle is still in the same haystack.

   Everything here is a Standard config property or a layer we own, and every
   one of them is captured on the way in and put back on the way out. A view
   that restores only what somebody remembered is how a map ends up permanently
   missing its POI labels.
*/
const NAV_BASEMAP = {
    showPointOfInterestLabels: false,
    showPlaceLabels: false,
    showTransitLabels: false,
    showPedestrianRoads: false,
    // Road *labels* stay on — a navigation view without street names is a
    // diagram. What comes down is the roads' own brightness, so the ribbon
    // reads against them rather than competing with them.
    roadsBrightness: 0.35
};

function setNavEmphasis(app, on) {
    const {map} = app;

    if (on && !app.navRestore) {
        const restore = app.navRestore = {basemap: {}, layers: {}};

        for (const key of Object.keys(NAV_BASEMAP)) {
            restore.basemap[key] = map.getConfigProperty('basemap', key);
        }
        for (const id of ['stop-circles', 'stop-labels']) {
            restore.layers[id] = map.getLayoutProperty(id, 'visibility') ?? 'visible';
        }
        restore.routeOpacity = map.getPaintProperty('route-lines', 'line-opacity');
    }

    if (on) {
        for (const [key, value] of Object.entries(NAV_BASEMAP)) {
            map.setConfigProperty('basemap', key, value);
        }
        // The network's own lines all but vanish: the one line that matters is
        // being drawn by `nav-route` instead, from the vehicle forward.
        map.setPaintProperty('route-lines', 'line-opacity', 0.05);
        for (const id of ['stop-circles', 'stop-labels']) {
            map.setLayoutProperty(id, 'visibility', 'none');
        }
    } else if (app.navRestore) {
        const restore = app.navRestore;

        for (const [key, value] of Object.entries(restore.basemap)) {
            map.setConfigProperty('basemap', key, value);
        }
        for (const [id, value] of Object.entries(restore.layers)) {
            map.setLayoutProperty(id, 'visibility', value);
        }
        map.setPaintProperty('route-lines', 'line-opacity', restore.routeOpacity);
        app.navRestore = null;
    }

    for (const id of NAV_LAYERS) {
        map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
}

/**
 * Loads the followed trip's road into the nav source.
 *
 * Once per vehicle, not per frame. The whole shape goes in; which part of it
 * is *ahead* is decided every frame by `line-trim-offset`, which costs a paint
 * write rather than a source update.
 */
function setNavRoute(app, info) {
    const {map, network} = app,
        shape = info.trip?.shape;

    if (!shape) {
        return;
    }
    const lengthKm = network.cum[shape.start + shape.count - 1];

    map.getSource('nav-route').setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'LineString',
                coordinates: network.sliceShape(shape, 0, lengthKm)
            }
        }]
    });
    map.setPaintProperty('nav-route-core', 'line-color', routeColor(info.route));
    app.navLength = lengthKm;
    app.navStopIndex = -1;
}

/** The stops still ahead, with the immediate one marked. */
function setNavStops(app, info) {
    const {map, network} = app,
        trip = info.trip,
        features = [];

    if (trip) {
        // A short horizon on purpose: a nav view shows the next call and a
        // hint of what follows, not the remaining forty stops as a chain of
        // dots running to the horizon.
        const from = info.stopIndex,
            to = Math.min(trip.stops.length, from + 4);

        for (let i = from; i < to; i++) {
            const stop = network.stops.get(trip.stops[i]);

            if (!stop) {
                continue;
            }
            features.push({
                type: 'Feature',
                properties: {
                    name: stop.name,
                    next: i === (info.standing ? from : from + 1) ? 1 : 0
                },
                geometry: {type: 'Point', coordinates: [stop.lon, stop.lat]}
            });
        }
    }
    map.getSource('nav-stops').setData({type: 'FeatureCollection', features});
}

/**
 * Re-anchors the ribbon to the vehicle.
 *
 * `line-trim-offset` paints the given range of the line transparent, so
 * `[0, progress]` erases the road already driven and leaves exactly the road
 * ahead — the automotive primitive, and cheap enough to run every frame
 * because it is a paint property on a source that never changes.
 */
function updateNavRoute(app, info, slot) {
    const {map, fleet} = app,
        // Distance along the shape over the shape's own length, both in
        // kilometres — `info.progress` is along the *trip's* stop offsets,
        // which stop at the last call and can leave a tail of shape
        // unaccounted for.
        progress = app.navLength > 0 ?
            Math.max(0, Math.min(1, fleet.offset[slot] / app.navLength)) :
            0;

    for (const id of ['nav-route-casing', 'nav-route-core']) {
        map.setPaintProperty(id, 'line-trim-offset', [0, progress]);
        // A soft edge where the ribbon meets the vehicle, so the road does not
        // begin with a hard cut across the bonnet.
        map.setPaintProperty(id, 'line-trim-fade-range', [0, EGO_FADE]);
    }

    // The stop list only changes when the vehicle passes one.
    if (app.navStopIndex !== info.stopIndex) {
        app.navStopIndex = info.stopIndex;
        setNavStops(app, info);
    }
}

/** Switches between the three ways of riding along. */
function setCameraMode(app, mode) {
    app.cameraMode = mode;
    // From on board you are inside the vehicle, so drawing it fills the frame.
    // In `nav` it stays drawn and is the point — it is the ego, the thing
    // every other element on screen is positioned relative to.
    app.vehicleLayer.setSelectionHidden(mode === 'onboard');
    // Gated on actually following, not on the mode alone: the mode is reset to
    // its default when a ride ends, and without this that reset would switch
    // the navigation view *on* over a map nobody is riding.
    setNavEmphasis(app, mode === 'nav' && app.trackedRun >= 0);
}

/**
 * Flies the camera along a trip's own geometry, end to end.
 *
 * The path comes from the trip's shape rather than from `network.lines`, and
 * that is the whole correctness of it: `lines` carries one feature per
 * *shape*, not per route — 713 features for 249 routes, with 202 routes
 * carrying more than one and corridor 1 carrying eighteen. Matching on the
 * route id therefore returned whichever pattern happened to be first in the
 * buffer, so touring a vehicle regularly flew the opposite direction, or a
 * short working, rather than the run on screen. A trip knows its own shape.
 *
 * Stops come along with it, at their distances in metres, so the caption can
 * name each one as the camera reaches it. The offsets are on the pattern in
 * kilometres, which is the unit the whole simulation carries.
 */
function tourTrip(app, trip, route) {
    const {network} = app,
        shape = trip?.shape;

    if (!shape) {
        return false;
    }
    // From the first stop to the last, not from one end of the track to the
    // other: a pattern can start partway along a shape it shares, and the
    // stretch before its first stop is not part of the journey. Kilometres —
    // the unit the whole simulation carries, because `trip.offsets` are
    // kilometres and `locate` compares the two directly.
    const from = trip.offsets[0],
        to = trip.offsets[trip.offsets.length - 1],
        coordinates = network.sliceShape(shape, from, to);

    if (coordinates.length < 2) {
        return false;
    }
    const stops = trip.stops.map((id, i) => {
        const stop = network.stops.get(id);

        return stop ?
            {name: stop.name, distance: (trip.offsets[i] - from) * 1000, lngLat: [stop.lon, stop.lat]} :
            null;
    }).filter(Boolean);

    // The tour takes the camera; stop following whatever was under it.
    app.trackedRun = -1;
    app.tour.start(coordinates, {
        title: routeMark(route),
        subtitle: trip.headsign || route.longName || '',
        stops,
        onDone: () => app.detail.close(),
        onProgress: state => drawTourProgress(app, state),
        // However it ends — run out, Berhenti, or a hand on the map — the map
        // goes back to exactly what it was showing before.
        onEnd: () => setTourEmphasis(app, null)
    });
    setTourEmphasis(app, {coordinates, stops, color: routeColor(route), total: app.tour.total});
    return true;
}

/*
   Jelajahi jalur, drawn as a journey in progress.

   The tour flies a line end to end, and the line used to be the same flat
   highlight from the first frame to the last — nothing on the map said how far
   along it the camera was, what had been passed, or what was coming. So it is
   drawn the way a navigation view draws a route: grey where the camera has
   been, the line's own colour where it is going, and between them the stretch
   it is on now, up to the next stop, in the one colour this interface keeps
   for "here, now" (`--here-fill`). There is no vehicle at the front of it —
   the camera is the traveller — so "here" is a mark at the centre of the
   frame (`.tour-here`), and the fleet steps out of the way for the length of
   the flight.

   Everything else steps back with it: the other 700 lines all but vanish and
   the ordinary stops go, the same subtraction Navigasi uses, because a bright
   line in a full network is still a needle in the same haystack.
*/
const TOUR_DONE = '#8d98a8',
    // `--here-fill`, the platform-edge yellow.
    TOUR_NOW = '#f5c518',
    TOUR_LAYERS = ['tour-route-casing', 'tour-route-core', 'tour-stop-dots'],
    // What the tour hides, captured on the way in and put back on the way out.
    TOUR_HIDDEN = ['route-highlight', 'stop-circles', 'stop-labels', 'buses'];

function addTourLayers({map}) {
    const none = {type: 'FeatureCollection', features: []};

    // `line-gradient` measures along the line, and does not work without this.
    map.addSource('tour-route', {type: 'geojson', lineMetrics: true, data: none});
    map.addLayer({
        id: 'tour-route-casing',
        type: 'line',
        source: 'tour-route',
        layout: {'line-cap': 'round', 'line-join': 'round', visibility: 'none'},
        paint: {
            'line-color': '#05070c',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 14, 11, 18, 22],
            'line-opacity': 0.5,
            'line-blur': 1.5
        }
    });
    map.addLayer({
        id: 'tour-route-core',
        type: 'line',
        source: 'tour-route',
        layout: {'line-cap': 'round', 'line-join': 'round', visibility: 'none'},
        paint: {
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 6, 18, 13],
            // Replaced on the first frame; a gradient has to be an expression
            // over `line-progress` even when it is one colour.
            'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, TOUR_DONE, 1, TOUR_DONE],
            // Lit, so the route holds its colour on the night map too.
            'line-emissive-strength': 1
        }
    });
    map.addSource('tour-stops', {type: 'geojson', data: none});
    map.addLayer({
        id: 'tour-stop-dots',
        type: 'circle',
        source: 'tour-stops',
        layout: {visibility: 'none'},
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 5, 18, 8],
            'circle-color': '#ffffff',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#05070c',
            'circle-emissive-strength': 1
        }
    });
}

/** Puts the tour's route on the map and steps everything else back, or undoes it. */
function setTourEmphasis(app, tour) {
    const {map} = app;

    if (!tour) {
        const restore = app.tourRestore;

        if (!restore) {
            return;
        }
        app.tourRestore = null;
        document.body.classList.remove('touring');
        for (const id of TOUR_LAYERS) {
            map.setLayoutProperty(id, 'visibility', 'none');
        }
        for (const [id, value] of Object.entries(restore.layers)) {
            map.setLayoutProperty(id, 'visibility', value);
        }
        map.setPaintProperty('route-lines', 'line-opacity', restore.routeOpacity);
        return;
    }

    // Captured once, from whatever was showing — a line preview's own dimming
    // included — so the restore puts back that rather than a default.
    if (!app.tourRestore) {
        app.tourRestore = {
            routeOpacity: map.getPaintProperty('route-lines', 'line-opacity'),
            layers: Object.fromEntries(TOUR_HIDDEN.map(id =>
                [id, map.getLayoutProperty(id, 'visibility') ?? 'visible']))
        };
    }

    // Sorted as the tour sorts them, so an index from its `onProgress` names
    // the same stop here.
    const stops = tour.stops.filter(s => Number.isFinite(s.distance))
        .sort((a, b) => a.distance - b.distance);

    map.getSource('tour-route').setData({
        type: 'Feature',
        properties: {},
        geometry: {type: 'LineString', coordinates: tour.coordinates}
    });
    map.getSource('tour-stops').setData({
        type: 'FeatureCollection',
        features: stops.map((stop, i) => ({
            type: 'Feature',
            properties: {i, d: stop.distance / tour.total},
            geometry: {type: 'Point', coordinates: stop.lngLat}
        }))
    });

    app.tourColor = tour.color;
    app.tourDrawn = null;
    app.tourNextIndex = null;

    /*
       The map is the subject, so the card steps aside. On a phone the line
       card is a sheet over 60% of the screen, and the flight ran behind it
       with the tour bar landing on top of the card.

       And the camera's padding goes. A line preview frames its route with
       padding to keep it clear of the card, and that padding stays on the
       map: the tour's centre sat at x=840 of a 1440px window, flying the line
       down the right-hand side of a map whose card was no longer there. It is
       not put back afterwards: restoring it would shift the map sideways under
       the hand that just took it back.
    */
    document.body.classList.add('touring');
    map.setPadding({top: 0, right: 0, bottom: 0, left: 0});
    map.setPaintProperty('route-lines', 'line-opacity', 0.05);
    for (const id of TOUR_HIDDEN) {
        map.setLayoutProperty(id, 'visibility', 'none');
    }
    for (const id of TOUR_LAYERS) {
        map.setLayoutProperty(id, 'visibility', 'visible');
    }
    drawTourProgress(app, {
        progress: 0,
        next: stops.length ? stops[0].distance / tour.total : 1,
        nextIndex: 0
    });
}

/**
 * One frame of progress: done, under way, ahead.
 *
 * Paint properties only, like Navigasi's ribbon — the line itself went into
 * its source once, at the start, so moving the boundary is a `setPaintProperty`
 * rather than a `setData` round trip through the worker sixty times a second.
 * Skipped when nothing visible moved, and the stops only repainted when one is
 * passed.
 */
function drawTourProgress(app, {progress, next, nextIndex}) {
    const {map} = app;

    if (!app.tourRestore) {
        return;
    }

    // `step` needs its stops strictly rising, and the camera can sit exactly
    // on a stop for a frame.
    const p = Math.max(0, Math.min(progress, 0.9998)),
        n = Math.max(p + 0.0001, Math.min(next, 1)),
        key = `${p.toFixed(4)}|${n.toFixed(4)}`;

    if (key === app.tourDrawn) {
        return;
    }
    app.tourDrawn = key;
    map.setPaintProperty('tour-route-core', 'line-gradient',
        ['step', ['line-progress'], TOUR_DONE, p, TOUR_NOW, n, app.tourColor]);

    if (nextIndex === app.tourNextIndex) {
        return;
    }
    app.tourNextIndex = nextIndex;

    const passed = ['<', ['get', 'i'], nextIndex],
        isNext = ['==', ['get', 'i'], nextIndex];

    map.setPaintProperty('tour-stop-dots', 'circle-color',
        ['case', passed, TOUR_DONE, isNext, TOUR_NOW, '#ffffff']);
    map.setPaintProperty('tour-stop-dots', 'circle-stroke-color',
        ['case', passed, '#05070c', isNext, '#05070c', app.tourColor]);
    map.setPaintProperty('tour-stop-dots', 'circle-radius', ['interpolate', ['linear'], ['zoom'],
        10, ['case', isNext, 5, passed, 2.5, 3],
        14, ['case', isNext, 8, passed, 4, 5],
        18, ['case', isNext, 12, passed, 6, 8]]);
}

/** The longest pattern of a route — see `tourPreviewedRoute` for why longest. */
/*
   Longest by the journey, not by the track under it.

   This measured the *shape*, and patterns share shapes: on the Bogor line the
   winner was a Manggarai → Bogor working, 17 stops, laid on the whole Jakarta
   Kota → Bogor track. The tour then flew 9.7 km from Kota to Manggarai past
   nothing that pattern serves — invisible while the line was one flat colour,
   and obvious the moment it was drawn as progress, with no stop on it for the
   first sixth of the flight. The span between first and last stop is what a
   tour actually covers, so that decides, and more stops break a tie.
*/
function longestTrip(network, routeId) {
    let best = null,
        bestSpan = -1;

    for (const trip of network.trips) {
        if (trip.route !== routeId || !trip.shape || trip.offsets.length < 2) {
            continue;
        }
        const span = trip.offsets[trip.offsets.length - 1] - trip.offsets[0];

        if (span > bestSpan + 1e-6 ||
                (Math.abs(span - bestSpan) <= 1e-6 && trip.stops.length > best.stops.length)) {
            bestSpan = span;
            best = trip;
        }
    }
    return best;
}

/** Tours the route of the vehicle the card is currently showing. */
function tourRoute(app) {
    const {fleet, selectedRun} = app,
        slot = fleet.slotOfRun(selectedRun);

    if (slot < 0) {
        return;
    }
    const info = fleet.describe(slot);

    if (info) {
        tourTrip(app, info.trip, info.route);
    }
}

/**
 * Tours the line the preview card is showing.
 *
 * The longest pattern, not the first: a route's patterns include short
 * workings, and a tour of Cikarang that stops at Bekasi is a tour of the wrong
 * thing. Length is the honest tiebreak — it is the one that shows the most of
 * the line.
 */
function tourPreviewedRoute(app) {
    const {network, previewedRoute} = app;

    if (!previewedRoute) {
        return;
    }
    const {route} = previewedRoute,
        best = longestTrip(network, route.id);

    if (best) {
        tourTrip(app, best, route);
    }
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

        // One sun position per frame, read by two things: which of Standard's
        // four presets the basemap wears, and the continuous tint over the
        // canvas that fills in everything between them.
        const sun = sunPosition(clock.getLocalDate(), now),
            preset = lightPreset(sun);

        app.sky.update(sun, {
            monochrome: map.getConfigProperty('basemap', 'theme') === 'monochrome'
        });

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

        // Following is the only state this HUD belongs to. One guard here
        // rather than a hide() in every other branch — and the same for the
        // page's `following` class, which every way of stopping must clear.
        if (app.trackedRun < 0) {
            setFollowing(app, false);
        }
        if (app.trackedRun < 0 && app.followHud.hide()) {
            app.rideSound.disable();
            // Stopping while on board would otherwise leave the vehicle hidden
            // — the camera was inside it, so it was scaled away. `trackedRun`
            // is already -1 here, which is what makes this also tear the
            // navigation view down.
            setCameraMode(app, DEFAULT_CAMERA);
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
            app.mapLayers.setCamerasAvailable(clock.live);
            if (!clock.live && app.camerasOn) {
                app.mapLayers.setLayerUI('cameras', false);
                setCameras(app, false);
            }
        }

        if (app.selectedCamera) {
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
            // This loop reasserts its branch every frame, which is what wiped
            // the line card the moment it opened until it got a branch here.
            //
            // Behind the vehicle card, though: while a line is previewed its
            // own vehicles are the only ones you can click, so clicking one
            // means you want that train, not the line you found it from. The
            // map keeps the line focused either way.
            detail.showRoute(app.previewedRoute.route, app.previewedRoute.info);
        } else if (app.selectedRun >= 0) {
            const slot = fleet.slotOfRun(app.selectedRun);

            vehicleLayer.setSelection(slot);
            if (slot >= 0) {
                const info = fleet.describe(slot),
                    tracking = app.trackedRun === app.selectedRun;

                // In both framings the card stays, as the journey only — see
                // `DetailPanel.showVehicle`. Navigasi used to close it outright,
                // handing everything to the bar at the bottom, and that left
                // nothing on screen saying where along the line the vehicle was.
                detail.showVehicle(info, {tracking});
                setFollowing(app, tracking);
                if (tracking) {
                    followCamera(app, info, slot);
                    app.followHud.show(info);
                    app.rideSound.update(info, {paused: clock.speed === 0});
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
