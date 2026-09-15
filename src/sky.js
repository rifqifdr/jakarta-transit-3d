/**
 * Where the sun is over Jakarta, and the tint that follows it.
 *
 * Mapbox Standard offers four lighting presets and nothing between them, so
 * the basemap's own transition is a step: `day` holds for ten hours and then
 * the whole city changes at once. This is the continuous half, composited on
 * our side — a faint gradient over the map canvas whose colour and strength
 * track the sun's altitude, warm through both twilights and cool through the
 * night.
 *
 * It is deliberately the *app's* layer rather than the basemap's. `setLights`
 * would give real moving light and is a one-way door — calling it resets
 * `lightPreset` to `day` for the life of the style and the night palette never
 * comes back (trap 19). A DOM overlay composites on top of whatever Mapbox is
 * doing, costs one style write, and can be taken away again.
 *
 * Restraint is the whole design. At peak it is 13% ink at the top of the frame
 * and nothing at the bottom, which is enough that the hour turning is
 * something you see in the whole frame rather than only in the stop labels,
 * and little enough that it never argues with the basemap underneath.
 */

const RAD = Math.PI / 180;

// Jakarta, for the sun. A city-wide view spans well under a degree, so one
// position serves the whole map — the sun does not rise meaningfully earlier
// over Bekasi than over Tangerang.
const SUN_AT = [106.8272, -6.2];

/**
 * The sun's altitude in degrees, for a time of day and a day of the year.
 *
 * A first-order declination model, no equation of time. At six degrees south
 * the error is a few minutes against a half-hour from round hour bands, and
 * it drifts correctly across the year rather than being a pair of numbers that
 * happen to be right in September.
 */
export function sunAltitude(lngLat, dayOfYear, secondsOfDay) {
    const lat = lngLat[1] * RAD,
        // Solar noon is a little before 12:00 local: Jakarta sits east of the
        // meridian its +07:00 offset is drawn for.
        noon = 12 * 3600 - (lngLat[0] - 105) * 240,
        hourAngle = (secondsOfDay - noon) / 43200 * Math.PI,
        declination = -23.44 * RAD *
            Math.cos(2 * Math.PI * (dayOfYear + 10) / 365.25);

    return Math.asin(
        Math.sin(lat) * Math.sin(declination) +
        Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)
    ) / RAD;
}

/**
 * Altitude, and whether the sun is on its way up.
 *
 * Both halves of the sky read the same two numbers: the preset needs `rising`
 * to tell dawn from dusk, and so does the tint — a Jakarta sunrise is pinker
 * and shorter than its sunset, and using one ramp for both is what makes a
 * day-in-a-minute look like it runs backwards in the evening.
 */
export function sunPosition(date, secondsOfDay) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0),
        dayOfYear = Math.floor((date.getTime() - start) / 86400000),
        at = seconds => sunAltitude(SUN_AT, dayOfYear, seconds),
        altitude = at(secondsOfDay);

    return {altitude, rising: at(secondsOfDay + 60) > altitude};
}

/*
   The ramps, keyed by solar altitude, in descending order.

   Shared above the horizon and below civil twilight; the two twilights differ
   only in the band between, which is where they actually look different. Alpha
   is the strength at the *top* of the frame — the gradient takes it down from
   there, so what a reader sees averaged over the map is roughly half these
   numbers.
*/
const HIGH = [
        {alt: 60, rgb: [255, 255, 255], a: 0},
        {alt: 24, rgb: [255, 246, 220], a: 0.022},
        {alt: 8, rgb: [255, 216, 154], a: 0.055}
    ],
    DUSK = [
        {alt: 2, rgb: [255, 150, 74], a: 0.10},
        {alt: -3, rgb: [232, 96, 78], a: 0.12}
    ],
    DAWN = [
        {alt: 2, rgb: [255, 178, 132], a: 0.085},
        {alt: -3, rgb: [206, 120, 142], a: 0.105}
    ],
    LOW = [
        {alt: -8, rgb: [88, 92, 164], a: 0.12},
        {alt: -14, rgb: [42, 54, 122], a: 0.13},
        {alt: -30, rgb: [24, 34, 88], a: 0.13}
    ];

function rampFor(rising) {
    return [...HIGH, ...(rising ? DAWN : DUSK), ...LOW];
}

/** Interpolates the ramp at one altitude. */
function sample(ramp, altitude) {
    if (altitude >= ramp[0].alt) {
        return ramp[0];
    }
    for (let i = 1; i < ramp.length; i++) {
        const b = ramp[i];

        if (altitude >= b.alt) {
            const a = ramp[i - 1],
                t = (altitude - a.alt) / (b.alt - a.alt);

            return {
                rgb: a.rgb.map((v, k) => Math.round(v + (b.rgb[k] - v) * t)),
                a: a.a + (b.a - a.a) * t
            };
        }
    }
    return ramp[ramp.length - 1];
}

/**
 * The gradient for one sun position.
 *
 * Strongest at the top and gone by four fifths of the way down. That is both
 * what a pitched camera should show — the top of the frame is where the sky
 * is — and what keeps the tint off the Mapbox wordmark and the attribution
 * badge in the bottom strip, which are a licence condition rather than a gap
 * to fill (trap 13).
 */
export function skyGradient({altitude, rising}, {monochrome = false} = {}) {
    const {rgb, a} = sample(rampFor(rising), altitude);
    /*
       Mono keeps the hour and loses the hue.

       The monochrome basemap exists to take the colour out of the city so six
       thousand vehicles have it to themselves, and washing an amber sunset
       back over it would undo exactly that. Dropped to its own luminance
       instead: the frame still visibly darkens and lifts through the day, and
       the only colour on screen is still the fleet.
    */
    const [r, g, b] = monochrome ?
            (l => [l, l, l])(Math.round(
                rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
            )) :
            rgb,
        at = k => `rgba(${r}, ${g}, ${b}, ${(a * k).toFixed(3)})`;

    return `linear-gradient(to bottom, ${at(1)} 0%, ${at(0.62)} 34%, ` +
        `${at(0.24)} 66%, ${at(0)} 84%)`;
}

/**
 * The overlay itself.
 *
 * One element, one style write, and a quantised key so the write only happens
 * when the tint has actually moved. Driven from the frame loop, which at 1200x
 * would otherwise rebuild a gradient string sixty times a second for a colour
 * that had not visibly changed.
 */
export default class Sky {

    constructor() {
        const me = this,
            el = me.el = document.createElement('div');

        el.id = 'sky';
        el.setAttribute('aria-hidden', 'true');
        document.body.appendChild(el);
        me._key = null;
    }

    /**
     * Applies the tint for a sun position.
     *
     * Quantised to a fifth of a degree of altitude: finer than anything the
     * eye can separate at this alpha, and coarse enough that a whole
     * day-in-a-minute sweep is a few hundred writes rather than a few thousand.
     */
    update(sun, options = {}) {
        const me = this,
            mono = !!options.monochrome,
            key = `${Math.round(sun.altitude * 5)}:${sun.rising ? 1 : 0}:${mono ? 1 : 0}`;

        if (key === me._key) {
            return me;
        }
        me._key = key;
        me.el.style.backgroundImage = skyGradient(sun, {monochrome: mono});
        return me;
    }

}
