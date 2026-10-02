export default {
    // Stock Mapbox Standard. `lightPreset` (time-of-day) and `show3dObjects`
    // (the Gedung 3D toggle) are both its own `basemap` import config, so the
    // map code needs nothing special to drive it.
    //
    // This replaced a private style built on the same base, which rendered only
    // for tokens on its own account — so the app now works on any Mapbox token.
    // What was lost with it is the monochrome theme: the fleet used to be the
    // only colour on a grey city, and on Standard it competes with the
    // basemap's own. If the vehicles stop reading, that is where to look.
    style: 'mapbox://styles/mapbox/standard',

    // Jakarta. Asia/Jakarta is UTC+7 year round, with no daylight saving.
    timezone: 'Asia/Jakarta',
    timezoneOffset: 7 * 3600,

    defaultCenter: [106.8272, -6.1754],
    defaultZoom: 12.4,
    defaultBearing: 0,
    defaultPitch: 55,

    minZoom: 9,
    maxZoom: 20,

    // Jakarta and its immediate commuter belt, which the Transjabodetabek
    // routes reach. Keeps the camera from wandering off the network.
    bounds: [[106.35, -6.75], [107.30, -5.85]],

    // Vehicle dimensions in metres, used for the instanced model. These are
    // the *base* box the geometry is built at; every mode is drawn by scaling
    // that box, so one instanced mesh still draws the whole fleet.
    vehicleLength: 12,
    vehicleWidth: 2.6,
    vehicleHeight: 3.2,

    // Per mode: the real thing's size, and how briskly it gets going.
    //
    // A six-car train is not a bigger bus (JAKAR-27). Lengths are the common
    // formation actually run in Jakarta rather than the maximum the stock
    // allows, and accelerations are typical service values, not test figures —
    // a heavy EMU pulls away noticeably slower than a metro set.
    //
    // `mode` is absent on the legacy bus-only path, so `bus` is also the
    // fallback for anything unlabelled.
    modes: {
        bus: {length: 12, width: 2.6, height: 3.2, acceleration: 1.0},
        // KRL runs 8- and 12-car sets; 8 x 20 m is the common one.
        commuter_rail: {length: 160, width: 3.0, height: 3.8, acceleration: 0.7},
        // MRT Jakarta: six cars.
        metro: {length: 120, width: 2.9, height: 3.9, acceleration: 1.1},
        // LRT Jakarta runs two cars, LRT Jabodebek six. Split the difference —
        // they share a mode and the difference is not worth a fourth profile.
        light_rail: {length: 80, width: 2.65, height: 3.7, acceleration: 1.0}
    },

    // Below this zoom vehicles are drawn larger than life so the network stays
    // legible; at closer zooms they settle to true size.
    trueScaleZoom: 16,
    maxObjectScale: 11,

    // Fallback acceleration in m/s^2 for anything without a mode profile. Kept
    // separate from `modes.bus` so the fallback is a deliberate value rather
    // than whichever mode happens to be listed first.
    acceleration: 1.0,

    // Playback speeds offered by the clock control and the follow HUD. It went
    // to 1200x while the timelapse needed a day in a minute; with that gone,
    // 128x — a day in about eleven minutes — is the most anything here asks
    // for, and the top three stops only made the slider harder to aim.
    speeds: [1, 2, 4, 8, 16, 32, 64, 128],

    // Mode labels, in the order they head the layer panel. Mode sits above
    // category because they are different axes: category is an operator's
    // product line (BRT, Mikrotrans), mode is what the vehicle *is*. A rider
    // choosing "no trains" is making a mode decision, not a product one.
    modeLabels: [
        {id: 'bus', label: 'Bus'},
        {id: 'commuter_rail', label: 'Kereta Komuter'},
        {id: 'metro', label: 'MRT'},
        {id: 'light_rail', label: 'LRT'}
    ],

    // Service categories, in the order they appear in the layer panel, with
    // the palette used for vehicles and route lines. GTFS route_color is used
    // where it is meaningful, but the categories are what riders navigate by.
    categories: [
        {id: 'BRT', label: 'BRT Koridor', color: '#0d5eaf'},
        {id: 'Angkutan Umum Integrasi', label: 'Integrasi', color: '#d4145a'},
        {id: 'Mikrotrans', label: 'Mikrotrans', color: '#2fa84f'},
        {id: 'Transjabodetabek', label: 'Transjabodetabek', color: '#7b3fa0'},
        {id: 'Royaltrans', label: 'Royaltrans', color: '#e08b00'},
        {id: 'Rusun', label: 'Rusun', color: '#00a0a8'},
        {id: 'Bus Wisata', label: 'Bus Wisata', color: '#e0559b'},

        // Rail. Still listed as categories because that is the axis the panel
        // filters on, but these are a different *mode*, not another Transjakarta
        // product — the distinction JAKAR-27 has to make properly. Colours are
        // the operators' own, as OSM records them.
        {id: 'Commuter Line', label: 'Commuter Line (KRL)', color: '#ec2329'},
        {id: 'MRT', label: 'MRT Jakarta', color: '#CE0037'},
        {id: 'LRT Jabodebek', label: 'LRT Jabodebek', color: '#20409A'},
        {id: 'LRT Jakarta', label: 'LRT Jakarta', color: '#f16227'}
    ]
};
