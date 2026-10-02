const RAD = Math.PI / 180,

    // Bearing smoothing time constant, matching the follow camera: shape
    // vertices make the heading snap by as much as 90 degrees between one
    // frame and the next, so the view leans through that instead of jerking.
    TAU = 0.32,

    // Waypoint spacing in metres, rather than a fixed count. 80 points over a
    // 3 km Mikrotrans loop is a waypoint every 37 m and over a 50 km Bogor run
    // one every 630 m — and at the zoom this flies at, the viewport is about
    // 1.5 km across, so the long route was being cut corner to corner. Spacing
    // by distance makes the path the same shape whatever the route's length.
    WAYPOINT_M = 120,
    MIN_WAYPOINTS = 24,
    MAX_WAYPOINTS = 900,

    // How far ahead the bearing tangent looks, in metres. A fraction of the
    // route would be 2.2 km on a Bogor run, which faces the camera at where
    // the line goes in general rather than at the road it is over.
    LOOK_AHEAD_M = 400,

    /*
       Ground speed, in metres per second, and the duration it is clamped to.

       A fixed duration is what a first build reaches for and it is wrong in
       both directions: 30 seconds end to end is 360 km/h over a 3 km feeder
       and 6,000 km/h over a 50 km commuter line. Fixing the speed instead
       makes every tour read at the same pace, and the clamp keeps a very
       short route from being over before it registers and a very long one
       from outstaying its welcome.
    */
    GROUND_SPEED = 620,
    MIN_DURATION = 14000,
    MAX_DURATION = 95000,

    // The share of the flight spent accelerating in, and out again.
    EASE = 0.14,

    // How long the line's name holds at the start, and how long a stop's name
    // stays up after the camera passes it.
    TITLE_MS = 2600,
    CAPTION_MS = 2300;

/** Haversine distance in metres — good enough for resampling. */
function distance(a, b) {
    const R = 6371000,
        dLat = (b[1] - a[1]) * RAD,
        dLon = (b[0] - a[0]) * RAD,
        sinLat = Math.sin(dLat / 2),
        sinLon = Math.sin(dLon / 2),
        h = sinLat * sinLat +
            Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * sinLon * sinLon;

    return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Compass bearing from a to b, in degrees. */
function bearing(a, b) {
    const dLon = (b[0] - a[0]) * RAD,
        y = Math.sin(dLon) * Math.cos(b[1] * RAD),
        x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
            Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dLon);

    return (Math.atan2(y, x) / RAD + 360) % 360;
}

/**
 * Resamples a route's coordinates into points spaced evenly by length, and
 * reports the total.
 *
 * Spacing by cumulative segment length rather than by index is what makes a
 * straight long edge and a wiggly short one each come out smooth — uniform
 * index spacing rushes through curves and crawls along straights.
 */
function resample(coords) {
    const cum = [0];
    let total = 0;

    for (let i = 1; i < coords.length; i++) {
        total += distance(coords[i - 1], coords[i]);
        cum.push(total);
    }
    if (total <= 0) {
        return {path: coords.slice(), total: 0};
    }

    const n = Math.max(MIN_WAYPOINTS,
            Math.min(MAX_WAYPOINTS, Math.round(total / WAYPOINT_M) + 1)),
        out = [],
        step = total / (n - 1);
    let j = 0;

    for (let k = 0; k < n; k++) {
        const target = k * step;

        while (j < cum.length - 2 && cum[j + 1] < target) {
            j++;
        }
        const segLen = cum[j + 1] - cum[j],
            frac = segLen > 0 ? (target - cum[j]) / segLen : 0,
            a = coords[j],
            b = coords[j + 1] || a;

        out.push([
            a[0] + (b[0] - a[0]) * frac,
            a[1] + (b[1] - a[1]) * frac
        ]);
    }
    return {path: out, total, step};
}

/**
 * Eases the flight in and out without changing its duration.
 *
 * A tour that starts at full speed on frame one is a cut, not a move. This is
 * a linear middle with a smoothstep at each end, so most of the route is
 * covered at the constant pace `GROUND_SPEED` names and only the first and
 * last `EASE` of it is spent getting there.
 */
function easeTravel(t) {
    const e = EASE,
        // Normalised so the three pieces still cover exactly 1 at t = 1.
        span = 1 - e;

    if (t < e) {
        const u = t / e;

        return e * u * u / 2 / span;
    }
    if (t > 1 - e) {
        const u = (1 - t) / e;

        return 1 - e * u * u / 2 / span;
    }
    return (t - e / 2) / span;
}

/**
 * A cinematic flight along a route's path.
 *
 * The camera traces the line from end to end at a fixed ground speed, turning
 * to face the direction of travel, naming the line as it sets off and each
 * stop as it passes. It runs its own `requestAnimationFrame` loop — like
 * `bench.js` does, and unlike the follow camera — so it needs no wiring into
 * the frame loop beyond construction. Any map gesture (a drag, a scroll, a
 * tap) cancels it and hands control back to the user, the same gesture a
 * driver makes to leave a navigation view.
 *
 * The clock keeps running underneath; the fleet keeps moving. A corridor at
 * the evening peak is a different thing from the same corridor at midday, and
 * the tour is a lens over that rather than a pause from it.
 */
export default class Tour {

    constructor(map) {
        const me = this;

        me.map = map;
        me.active = false;
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'tour-hud';
        el.innerHTML = `
            <div class="tour-caption js-tour-caption" hidden></div>
            <div class="panel tour-bar">
                <div class="tour-meta">
                    <div class="tour-line js-tour-line"></div>
                    <div class="tour-sub js-tour-sub"></div>
                </div>
                <button class="btn btn-sm btn-danger js-tour-stop" type="button">Berhenti</button>
                <span class="tour-progress"><i class="js-tour-progress"></i></span>
            </div>
        `;
        document.body.appendChild(el);

        /*
           You are here, without a vehicle to be it.

           The tour flies the path itself, so the point it has reached is the
           camera's centre — which is *not* the centre of the screen. A line
           preview frames its route with padding to keep it clear of the card,
           and the padding stays: measured, the camera's centre sat at x=840 of
           a 1440px window, and a mark fixed at the screen's middle stood
           120px off the line it was meant to be on. So it is placed where the
           map projects that point, once a frame. Hazard yellow, because that
           is the one thing it means in this interface: here, now.
        */
        me._here = document.createElement('div');
        me._here.className = 'tour-here';
        me._here.hidden = true;
        document.body.appendChild(me._here);

        me._caption = el.querySelector('.js-tour-caption');
        me._lineEl = el.querySelector('.js-tour-line');
        me._subEl = el.querySelector('.js-tour-sub');
        me._progress = el.querySelector('.js-tour-progress');

        el.addEventListener('click', event => {
            if (event.target.closest('.js-tour-stop')) {
                me.stop();
            }
        });
    }

    /**
     * Flies the given path.
     *
     * `stops` is optional and carries `{name, distance}` in metres along the
     * same path, so the caption can name each one as the camera reaches it.
     * `title` is markup — the line's own `routeMark`, so a tour of the Bogor
     * line opens on the pedoman's red C rather than on a feed label.
     *
     * `onProgress` is told, every frame, how far along the path the camera is
     * and where the next stop is, both as fractions of the path — what the map
     * needs to draw the route as done, under way and ahead. `onEnd` fires
     * however the tour stops: run to the end, Berhenti, or a hand on the map.
     */
    start(coordinates, {zoom = 14.5, pitch = 60, title = '', subtitle = '',
        stops = [], onDone, onProgress, onEnd} = {}) {
        const me = this;

        me.stop();
        if (!coordinates || coordinates.length < 2) {
            return;
        }
        const {path, total} = resample(coordinates);

        if (path.length < 2) {
            return;
        }
        me.active = true;
        me._path = path;
        me._total = total;
        me._zoom = zoom;
        me._pitch = pitch;
        me._duration = Math.max(MIN_DURATION,
            Math.min(MAX_DURATION, total / GROUND_SPEED * 1000));
        me._onDone = onDone || null;
        me._onProgress = onProgress || null;
        me._onEnd = onEnd || null;
        // Public, so a caller can turn its own distances along the same path
        // into the fractions `onProgress` speaks in.
        me.total = total;
        me._start = performance.now();
        me._lastFrame = me._start;
        me._bearing = null;
        // Sorted and walked with an index rather than searched each frame: a
        // tour passes its stops in order by construction.
        me._stops = stops.filter(s => Number.isFinite(s.distance))
            .sort((a, b) => a.distance - b.distance);
        me._nextStop = 0;
        me._captionUntil = 0;

        me._lineEl.innerHTML = title;
        me._subEl.textContent = subtitle;
        me._progress.style.width = '0%';
        me.el.classList.add('open');
        me._here.hidden = false;
        me._showCaption(title, TITLE_MS, true);

        // `dragstart` is a Mapbox map event fired by user panning only;
        // `jumpTo` never fires it. `pointerdown` and `wheel` on the canvas are
        // raw DOM events, which the programmatic camera never produces either.
        // Together these cover every gesture a person would make to take the
        // map back — a drag, a scroll, a tap.
        const cancel = me._cancel = () => me.stop();

        me.map.on('dragstart', cancel);
        const canvas = me.map.getCanvas();

        canvas.addEventListener('pointerdown', cancel);
        canvas.addEventListener('wheel', cancel, {passive: true});

        me._raf = requestAnimationFrame(me._tick = () => me._frame());
    }

    _showCaption(html, ms, isTitle = false) {
        const me = this;

        me._caption.innerHTML = html;
        me._caption.classList.toggle('title', isTitle);
        me._caption.hidden = !html;
        me._captionUntil = performance.now() + ms;
    }

    _frame() {
        const me = this;

        if (!me.active) {
            return;
        }
        const now = performance.now(),
            raw = Math.min(1, (now - me._start) / me._duration),
            t = easeTravel(raw),
            path = me._path,
            idx = t * (path.length - 1),
            i = Math.floor(idx),
            frac = idx - i,
            a = path[i],
            b = path[Math.min(i + 1, path.length - 1)],
            center = [
                a[0] + (b[0] - a[0]) * frac,
                a[1] + (b[1] - a[1]) * frac
            ];

        // The tangent looks a fixed distance ahead and behind rather than a
        // fixed number of waypoints, so it means the same thing on a feeder
        // loop and on a commuter line. At the ends the look-ahead clamps, so
        // the camera arrives facing where it was going rather than where it
        // has been.
        const reach = Math.max(1, Math.round(LOOK_AHEAD_M / (me._total /
                (path.length - 1)) / 2)),
            back = path[Math.max(0, i - reach)],
            fwd = path[Math.min(path.length - 1, i + reach)],
            target = bearing(back, fwd);

        let br = me._bearing;

        if (br === null) {
            br = target;
        } else {
            const elapsed = (now - me._lastFrame) / 1000,
                k = 1 - Math.exp(-elapsed / TAU);

            // Shortest angular path, so the camera never spins the long way
            // round from 359° to 1°.
            let d = target - br;

            d = ((d + 540) % 360) - 180;
            br += d * k;
        }
        me._bearing = br;
        me._lastFrame = now;

        me.map.jumpTo({
            center,
            bearing: br,
            zoom: me._zoom,
            pitch: me._pitch
        });

        const here = me.map.project(center);

        me._here.style.transform = `translate(${here.x.toFixed(1)}px, ${here.y.toFixed(1)}px)`;

        me._progress.style.width = `${(raw * 100).toFixed(1)}%`;

        // Name each stop as the camera reaches it. The title holds its own
        // window first, so the opening shot is the line rather than whichever
        // stop happens to sit at the terminus.
        const travelled = t * me._total;

        while (me._nextStop < me._stops.length &&
                me._stops[me._nextStop].distance <= travelled) {
            const stop = me._stops[me._nextStop++];

            if (now >= me._captionUntil) {
                me._showCaption(stop.name, CAPTION_MS);
            }
        }
        if (!me._caption.hidden && now >= me._captionUntil) {
            me._caption.hidden = true;
        }

        const next = me._stops[me._nextStop];

        me._onProgress?.({
            progress: travelled / me._total,
            next: next ? next.distance / me._total : 1,
            // Index into the stops as sorted here, by distance.
            nextIndex: me._nextStop
        });

        if (raw >= 1) {
            const done = me._onDone;

            me.stop();
            done?.();
        } else {
            me._raf = requestAnimationFrame(me._tick);
        }
    }

    stop() {
        const me = this;

        if (!me.active) {
            return;
        }
        me.active = false;
        me.el.classList.remove('open');
        me._caption.hidden = true;
        me._here.hidden = true;
        me._onDone = null;
        me._onProgress = null;

        // Taken first and fired last, so whatever it restores is restored
        // after the tour has let go of the camera, and a callback that calls
        // `stop()` again finds nothing left to end.
        const end = me._onEnd;

        me._onEnd = null;
        if (me._raf) {
            cancelAnimationFrame(me._raf);
            me._raf = null;
        }
        if (me._cancel) {
            me.map.off('dragstart', me._cancel);
            const canvas = me.map.getCanvas();

            canvas.removeEventListener('pointerdown', me._cancel);
            canvas.removeEventListener('wheel', me._cancel);
            me._cancel = null;
        }
        end?.();
    }

}
