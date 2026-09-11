/**
 * Riding a planned journey inside the simulation.
 *
 * The map already runs the whole fleet on the real timetable, so a plan is not
 * a drawing laid over it — it is a selection of vehicles that are already out
 * there. This binds each ride leg to the actual run serving it, winds the clock
 * to the departure, and hands the camera from bus to bus.
 *
 * That binding is the point. If the vehicle were synthesised for the animation
 * the feature would be a cutscene; because it is a real run, everything around
 * it — the buses it passes, the traffic on the corridor — is the same
 * simulation the rest of the map is showing.
 */
import {formatClock} from './clock-control';
import {formatRemaining} from './format';
import {routeColor, routeMark} from '../kodefikasi';

// Wound back slightly before departure so the ride opens with the bus pulling
// away rather than already under way.
const LEAD_IN_S = 8;

export default class Ride {

    constructor({clock, fleet, network, onExit, onCamera}) {
        const me = this;

        me.clock = clock;
        me.fleet = fleet;
        me.network = network;
        me.onExit = onExit;
        me.onCamera = onCamera;
        me.camera = 'chase';

        me.itinerary = null;
        me.timeline = [];
        me.index = -1;
        me.missing = null;

        me._render();
    }

    get active() {
        return !!this.itinerary;
    }

    /**
     * Begins a ride, resolving every leg to a run in the fleet first.
     *
     * A leg can fail to resolve if its service category is hidden, since the
     * fleet does not simulate what the layer panel has switched off. Those
     * categories are switched back on rather than leaving a gap in the journey.
     */
    start(itinerary) {
        const me = this,
            {fleet, network} = me;

        for (const leg of itinerary.legs) {
            if (leg.type !== 'ride') {
                continue;
            }

            const category = network.routes.get(leg.route).category;

            if (!fleet.isCategoryVisible(category)) {
                fleet.setCategoryVisible(category, true);
            }
        }

        me.itinerary = itinerary;
        me.timeline = me._buildTimeline(itinerary);
        me.index = 0;
        me.missing = null;
        me._built = false;

        me.clock.setSpeed(1);
        me.clock.setTimeOffset(Math.max(0, me.timeline[0].from - LEAD_IN_S));
        me.el.classList.add('open');
        return me;
    }

    stop() {
        const me = this;

        me.itinerary = null;
        me.timeline = [];
        me.index = -1;
        me.el.classList.remove('open');
        return me;
    }

    /**
     * Gives every leg a window on the clock.
     *
     * Ride legs carry their own times. A walk gets whatever gap sits between
     * the ride before it and the ride after, which is usually longer than the
     * walk itself — the rest is waiting at the stop, and showing that honestly
     * is part of the point.
     */
    _buildTimeline(itinerary) {
        const legs = itinerary.legs,
            timeline = [];

        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i];

            if (leg.type === 'ride') {
                timeline.push({leg, from: leg.departure, to: leg.arrival, type: 'ride'});
                continue;
            }

            const previous = timeline[timeline.length - 1],
                nextRide = legs.slice(i + 1).find(l => l.type === 'ride'),
                from = previous ? previous.to : itinerary.departure,
                to = nextRide ? nextRide.departure : from + leg.seconds;

            timeline.push({leg, from, to: Math.max(to, from + 1), type: 'walk'});
        }
        return timeline;
    }

    /** Advances to whichever leg the clock is now inside. */
    advance(now) {
        const me = this;

        if (!me.itinerary) {
            return null;
        }

        const timeline = me.timeline,
            last = timeline[timeline.length - 1];

        if (now >= last.to) {
            return {done: true};
        }

        let index = timeline.findIndex(entry => now >= entry.from && now < entry.to);

        if (index < 0) {
            // Before the journey starts, hold on the first leg.
            index = now < timeline[0].from ? 0 : timeline.length - 1;
        }
        me.index = index;

        const entry = timeline[index];

        if (entry.type === 'walk') {
            const span = entry.to - entry.from,
                // Walk for as long as the walk takes, then wait at the stop.
                progress = Math.min(1, (now - entry.from) / Math.max(1, Math.min(span, entry.leg.seconds)));

            return {
                phase: 'walk',
                entry,
                progress: Math.max(0, progress),
                waiting: now - entry.from > entry.leg.seconds
            };
        }

        const trip = me.network.tripById.get(entry.leg.trip),
            run = trip ? me.fleet.findRun(trip.index, entry.leg.runStart) : -1,
            slot = run >= 0 ? me.fleet.slotOfRun(run) : -1;

        if (slot < 0) {
            // Two different situations, and conflating them reads as a fault
            // when it usually is not. Boarding at a pattern's first stop means
            // the run has not set out yet during the lead-in — that is normal,
            // and the camera should wait at the stop. Anything else is a run
            // the timetable promises but the fleet is not running.
            const boarding = now < entry.leg.departure;

            me.missing = boarding ? null : entry.leg;
            return {phase: 'ride', entry, info: null, boarding};
        }
        me.missing = null;
        return {phase: 'ride', entry, info: me.fleet.describe(slot), slot};
    }

    skip() {
        const me = this,
            next = me.timeline[me.index + 1];

        if (next) {
            me.clock.setTimeOffset(next.from);
        }
        return me;
    }

    // ------------------------------------------------------------------ hud

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'panel';
        el.id = 'ride';
        document.body.appendChild(el);

        el.addEventListener('click', event => {
            if (event.target.closest('.js-ride-exit')) {
                me.onExit();
            } else if (event.target.closest('.js-ride-skip')) {
                me.skip();
            } else if (event.target.closest('.js-ride-camera')) {
                me.camera = me.camera === 'chase' ? 'onboard' : 'chase';
                me.onCamera(me.camera);
            } else if (event.target.closest('.js-ride-speed')) {
                const speeds = [1, 2, 4, 8],
                    current = speeds.indexOf(me.clock.speed);

                me.clock.setSpeed(speeds[(current + 1) % speeds.length]);
            }
        });
    }

    /**
     * Updates the heads-up display.
     *
     * The controls are built once per ride and never rebuilt. Only the text
     * changes as the journey progresses — replacing the markup under the
     * pointer destroys the buttons between mousedown and mouseup, so a click
     * would never fire. The same rule the detail card learned the hard way.
     */
    updateHUD(state, now) {
        const me = this;

        if (!state || state.done) {
            return;
        }

        if (!me._built) {
            me._buildHUD();
        }

        const total = me.timeline.length,
            arrival = me.timeline[total - 1].to,
            remaining = Math.max(0, arrival - now),
            {title, sub, badge} = me._describe(state),
            el = me._el;

        el.title.textContent = title;
        el.sub.innerHTML = sub;
        el.badge.innerHTML = badge;
        el.eta.textContent = formatRemaining(remaining);
        el.arrive.textContent = `tiba ${formatClock(arrival)}`;
        el.step.textContent = `Tahap ${me.index + 1} / ${total}`;
        el.speed.textContent = `${me.clock.speed}\u00d7`;
        el.camera.textContent = me.camera === 'onboard' ? 'Dari atas' : 'Dari dalam';
        el.camera.classList.toggle('on', me.camera === 'onboard');

        for (let i = 0; i < el.segments.length; i++) {
            el.segments[i].classList.toggle('done', i < me.index);
            el.segments[i].classList.toggle('now', i === me.index);
        }
    }

    _buildHUD() {
        const me = this;

        me.el.innerHTML = `
            <div class="ride-main">
                <span class="js-badge"></span>
                <div class="ride-text">
                    <div class="ride-title js-title"></div>
                    <div class="ride-sub js-sub"></div>
                </div>
                <div class="ride-eta">
                    <div class="js-eta"></div>
                    <div class="ride-arrive js-arrive"></div>
                </div>
            </div>
            <div class="ride-progress">
                ${me.timeline.map(t => `<span class="ride-seg ${t.type}"></span>`).join('')}
            </div>
            <div class="ride-controls">
                <span class="ride-step js-step"></span>
                <button class="btn js-ride-camera" type="button"></button>
                <button class="btn js-ride-speed" type="button"></button>
                <button class="btn js-ride-skip" type="button">Lewati</button>
                <button class="btn js-ride-exit" type="button">Keluar</button>
            </div>
        `;
        me._el = {
            badge: me.el.querySelector('.js-badge'),
            title: me.el.querySelector('.js-title'),
            sub: me.el.querySelector('.js-sub'),
            eta: me.el.querySelector('.js-eta'),
            arrive: me.el.querySelector('.js-arrive'),
            step: me.el.querySelector('.js-step'),
            speed: me.el.querySelector('.js-ride-speed'),
            camera: me.el.querySelector('.js-ride-camera'),
            segments: [...me.el.querySelectorAll('.ride-seg')]
        };
        me._built = true;
    }

    /** What the display should say right now. */
    _describe(state) {
        const me = this,
            {entry} = state;

        if (state.phase === 'walk') {
            const to = me.network.stops.get(entry.leg.to);

            return {
                badge: '',
                title: state.waiting ?
                    `Menunggu di ${to ? to.name : entry.leg.to}` :
                    `Jalan ke ${to ? to.name : entry.leg.to}`,
                sub: state.waiting ?
                    `Keberangkatan berikutnya ${formatClock(entry.to)}` :
                    `${Math.round(entry.leg.seconds / 60)} menit jalan kaki`
            };
        }

        const route = me.network.routes.get(entry.leg.route),
            color = routeColor(route),
            badge = routeMark(route),
            to = me.network.stops.get(entry.leg.to);

        if (!state.info) {
            const at = me.network.stops.get(entry.leg.from);

            return {
                badge,
                title: state.boarding ?
                    `Menunggu di ${at ? at.name : entry.leg.from}` :
                    'Kendaraan ini sedang tidak beroperasi',
                sub: state.boarding ?
                    `Berangkat ${formatClock(entry.leg.departure)}` :
                    entry.leg.headsign || route.longName
            };
        }

        return {
            badge,
            title: state.info.standing ?
                `Berhenti di ${state.info.atStop?.name ?? ''}` :
                `Menuju ${state.info.nextStop?.name ?? ''}`,
            sub: `Turun di ${to ? to.name : entry.leg.to} &middot; ${
                Math.max(0, entry.leg.alightIndex - state.info.stopIndex)
            } perhentian lagi`
        };
    }

}

export {LEAD_IN_S};
