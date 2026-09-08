/**
 * The map's state, in the address bar.
 *
 * Everything else in this app is worth sending to someone — a corridor at the
 * morning peak, a planned journey, how far you can get from a stop for nothing,
 * what a toll carriageway looks like right now. None of it was shareable until
 * this existed.
 *
 * Parameters are kept short and legible so a link survives being pasted into a
 * chat, and anything malformed is ignored rather than fatal: a half-typed URL
 * should open the map, not a blank screen.
 */

const WRITE_INTERVAL_MS = 500;

function pad(n) {
    return String(n).padStart(2, '0');
}

function formatTime(seconds) {
    const s = Math.floor(seconds);

    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
}

// Accepts "07:30" and "07:30:15"; anything else is treated as absent.
function parseTime(value) {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value || '');

    if (!match) {
        return null;
    }

    const hours = +match[1],
        minutes = +match[2],
        seconds = +(match[3] || 0);

    if (hours > 23 || minutes > 59 || seconds > 59) {
        return null;
    }
    return hours * 3600 + minutes * 60 + seconds;
}

const number = (value, fallback = null) => {
    const parsed = Number(value);

    return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

/** Reads the current URL into a plain object. */
export function readState() {
    const params = new URLSearchParams(location.search),
        centre = (params.get('c') || '').split(',').map(Number),
        state = {};

    if (centre.length === 2 && centre.every(Number.isFinite)) {
        state.center = centre;
    }
    state.zoom = number(params.get('z'));
    state.pitch = number(params.get('p'));
    state.bearing = number(params.get('b'));
    state.time = parseTime(params.get('t'));
    state.speed = number(params.get('s'));
    state.stop = params.get('stop');
    state.route = params.get('route');
    state.bus = params.get('bus');
    state.follow = params.get('follow') === '1';
    state.from = params.get('from');
    state.fromPoint = (params.get('fromll') || '').split(',').map(Number);
    if (state.fromPoint.length !== 2 || !state.fromPoint.every(Number.isFinite)) {
        state.fromPoint = null;
    }
    state.to = params.get('to');
    state.reach = params.get('reach');
    state.budget = number(params.get('budget'));
    state.free = params.get('free') === '1';
    state.access = params.get('access') === '1';
    state.camera = params.get('cam');
    state.hidden = (params.get('hide') || '').split(',').filter(Boolean);
    return state;
}

/** Serialises the app's current state into a query string. */
export function serialise(app) {
    const {map, clock, journey, reach, fleet} = app,
        params = new URLSearchParams(),
        centre = map.getCenter();

    // The boot path has to survive its own URL rewrite. Without this a legacy
    // session silently becomes an artifact one on the next reload, which is the
    // opposite of what an escape hatch is for.
    const data = new URLSearchParams(location.search).get('data');

    if (data) {
        params.set('data', data);
    }

    params.set('c', `${centre.lng.toFixed(4)},${centre.lat.toFixed(4)}`);
    params.set('z', map.getZoom().toFixed(2));
    if (map.getPitch() > 0.5) {
        params.set('p', map.getPitch().toFixed(0));
    }
    if (Math.abs(map.getBearing()) > 0.5) {
        params.set('b', map.getBearing().toFixed(0));
    }

    // A live map is the default, so it needs no parameters at all.
    if (!clock.live) {
        params.set('t', formatTime(clock.getTimeOffset()));
        if (clock.speed !== 1) {
            params.set('s', String(clock.speed));
        }
    }

    if (journey.from && journey.to) {
        if (journey.from.id) {
            params.set('from', journey.from.id);
        } else {
            params.set('fromll', `${journey.from.lon.toFixed(5)},${journey.from.lat.toFixed(5)}`);
        }
        params.set('to', journey.to.id);
    } else if (reach.active) {
        params.set('reach', reach.origin.id);
        params.set('budget', String(reach.budget));
        if (reach.freeOnly) {
            params.set('free', '1');
        }
    } else if (app.selectedStop) {
        params.set('stop', app.selectedStop.id);
    } else if (app.selectedRun >= 0) {
        // Run indices are an internal detail that changes with the data build,
        // so a bus is named by its pattern and departure instead.
        const trip = app.network.trips[fleet.runTrip[app.selectedRun]];

        if (trip) {
            params.set('bus', `${trip.id}@${fleet.runStart[app.selectedRun]}`);
            if (app.trackedRun === app.selectedRun) {
                params.set('follow', '1');
            }
        }
    }

    // Outside the chain above rather than in it: a camera is an overlay, not
    // one of the mutually exclusive selections. Opening one already clears the
    // stop and the vehicle, so the chain writes nothing while a camera is up —
    // except a drawn journey, which stays on the map and stays in the link.
    if (app.selectedCamera) {
        params.set('cam', app.selectedCamera.id);
    }

    if (app.highlightedRoute) {
        params.set('route', app.highlightedRoute);
    }
    if (fleet.hidden.size) {
        params.set('hide', [...fleet.hidden].join(','));
    }
    if (map.__accessibleOnly) {
        params.set('access', '1');
    }
    return params.toString();
}

/**
 * Applies a parsed state to the app.
 *
 * Order matters: filters before selections, because hiding a category can
 * remove the very bus a link is pointing at.
 */
export function applyState(app, state, handlers) {
    const {map, clock, network, fleet} = app;

    for (const category of state.hidden) {
        fleet.setCategoryVisible(category, false);
        handlers.onCategoryRestored(category, false);
    }
    if (state.access) {
        handlers.onAccessRestored(true);
    }

    if (state.center) {
        map.jumpTo({
            center: state.center,
            zoom: state.zoom ?? map.getZoom(),
            pitch: state.pitch ?? map.getPitch(),
            bearing: state.bearing ?? map.getBearing()
        });
    }

    if (state.time !== null) {
        clock.setTimeOffset(state.time);
        if (state.speed) {
            clock.setSpeed(state.speed);
            // The panels are built before this runs, so the clock control has
            // already drawn its slider at 1x. Without this a reloaded 128x link
            // showed a 1x slider over a clock running at 128x, and only
            // dragging the slider put the two back in step.
            app.clockControl?.syncSpeed();
        }
    }

    if (state.route && network.routes.has(state.route)) {
        handlers.onRoute(network.routes.get(state.route));
    }

    // Restoring a journey or a reachability set would normally reframe the map;
    // an explicit camera in the link takes precedence over that.
    app.restoringCamera = !!state.center;

    const stopOf = id => (id ? network.stops.get(id) : null);

    if ((state.from || state.fromPoint) && state.to) {
        const from = state.fromPoint ?
            {name: 'Titik dipilih', lon: state.fromPoint[0], lat: state.fromPoint[1]} :
            stopOf(state.from),
            to = stopOf(state.to);

        if (from && to) {
            app.journey.setEnd('from', from, clock.getTimeOffset(), clock.getDayOfWeek());
            app.journey.setEnd('to', to, clock.getTimeOffset(), clock.getDayOfWeek());
        }
    } else if (state.reach) {
        const origin = stopOf(state.reach);

        if (origin) {
            if (state.budget) {
                app.reach.budget = state.budget;
            }
            app.reach.freeOnly = state.free;
            app.reach.setOrigin(origin, clock.getTimeOffset(), clock.getDayOfWeek());
        }
    } else if (state.stop) {
        const stop = stopOf(state.stop);

        if (stop) {
            handlers.onStop(stop);
        }
    } else if (state.bus) {
        const [tripId, runStart] = state.bus.split('@'),
            trip = network.tripById.get(tripId),
            run = trip ? fleet.findRun(trip.index, +runStart) : -1;

        if (run >= 0) {
            app.selectedRun = run;
            if (state.follow) {
                app.trackedRun = run;
            }
        }
    }

    app.restoringCamera = false;

    // Last, and asynchronous: the camera layer is fetched only when someone
    // asks for it, so restoring one has to load it first. `framed` says the
    // link already carried a view, in which case the camera must not fly the
    // map somewhere else — the same rule the journey follows above.
    if (state.camera) {
        handlers.onCamera?.(state.camera, {framed: !!state.center});
    }
}

/**
 * Keeps the URL in step with the map.
 *
 * Writes are throttled and use replaceState, so dragging the map does not fill
 * the history with hundreds of entries to back out through.
 */
export function startSync(app) {
    let last = '',
        timer = null;

    const write = () => {
        timer = null;

        const query = serialise(app);

        if (query !== last) {
            last = query;
            history.replaceState(null, '', `${location.pathname}?${query}`);
        }
    };

    const schedule = () => {
        if (timer === null) {
            timer = setTimeout(write, WRITE_INTERVAL_MS);
        }
    };

    for (const event of ['moveend', 'zoomend', 'pitchend', 'rotateend']) {
        app.map.on(event, schedule);
    }

    // Selections change without a map event, so they nudge the writer directly
    // rather than waiting to be noticed.
    app.syncUrl = schedule;

    // The clock has no event at all, so it still needs a poll to be caught.
    setInterval(schedule, WRITE_INTERVAL_MS * 2);
    write();
}

export {formatTime, parseTime};
