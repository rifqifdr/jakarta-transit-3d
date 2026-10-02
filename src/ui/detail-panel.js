import {formatClock, formatOffsetWithDay} from './clock-control';
import {formatDuration} from './format';
import {routeColor, routeMark, lineName} from '../kodefikasi';

const RUPIAH = new Intl.NumberFormat('id-ID');

/** A fare as a rider would read it: free services say so outright. */
function formatFare(fare) {
    if (!fare) {
        return 'Tarif tidak tersedia';
    }
    if (fare.price === 0) {
        return 'Gratis';
    }

    // Rail prices by distance, so its fare is a floor rather than a price. The
    // trailing "+" is the difference between stating a tariff and misstating one.
    return `Rp ${RUPIAH.format(fare.price)}${fare.distanceBased ? '+' : ''}`;
}

/**
 * The transfer allowance attached to a fare. Transjakarta's integrated ticket
 * lets you keep travelling within a window on one tap, which is often worth
 * more than the fare itself.
 */
function formatTransfers(fare) {
    if (!fare || !fare.transferDuration) {
        return '';
    }

    const hours = fare.transferDuration / 3600,
        window = Number.isInteger(hours) ? `${hours} jam` :
            `${Math.round(fare.transferDuration / 60)} menit`,
        base = fare.transfers === null ?
            `Transit bebas dalam ${window}` :
            `${fare.transfers}× transit dalam ${window}`,
        lines = [fare.note, base];

    // JakLingko caps a whole multi-modal journey, which is the number a
    // passenger actually pays once more than one mode is involved.
    if (fare.integratedCap) {
        lines.push(`Maks Rp ${RUPIAH.format(fare.integratedCap)} antarmoda (JakLingko)`);
    }
    return lines.filter(Boolean).join('<br>');
}

/**
 * The inspector for a selected bus or stop.
 *
 * A tracked bus reports a new position every frame, but the card must not be
 * rebuilt at that rate: replacing its markup between a mousedown and the
 * following mouseup means the browser never produces a click, which silently
 * breaks the buttons inside it. The markup is therefore built once per
 * selection and only the values that actually change are written afterwards.
 */
export default class DetailPanel {

    constructor(network, {
        onTrack, onClose,
        onReach, onBudget, onFreeOnly, onFromPoint,
        onCameraExpand, onCameraChannel, onTour, onReachPlay
    }) {
        const me = this;

        me.network = network;
        me.onTrack = onTrack;
        me.onClose = onClose;
        me.onReach = onReach;
        me.onCameraExpand = onCameraExpand;
        me.onCameraChannel = onCameraChannel;
        me.onBudget = onBudget;
        me.onFreeOnly = onFreeOnly;
        me.onFromPoint = onFromPoint;
        me.onTour = onTour;
        me.onReachPlay = onReachPlay;
        me.mode = null;
        me._key = null;
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'panel';
        el.id = 'detail';
        document.body.appendChild(el);

        el.addEventListener('change', event => {
            if (event.target.closest('.js-free')) {
                me.onFreeOnly(event.target.checked);
            }
        });

        el.addEventListener('click', event => {
            const budget = event.target.closest('.js-budget');

            if (event.target.closest('.detail-close')) {
                me.close();
                me.onClose();
            } else if (event.target.closest('.js-track')) {
                me.onTrack();
            } else if (event.target.closest('.js-tour')) {
                me.onTour?.();
            } else if (event.target.closest('.js-from-point')) {
                me.onFromPoint();
            } else if (event.target.closest('.js-reach')) {
                me.onReach();
            } else if (event.target.closest('.js-reach-play')) {
                me.onReachPlay?.();
            } else if (event.target.closest('.js-cam-ch')) {
                me.onCameraChannel?.(event.target.closest('.js-cam-ch').dataset.camera);
            } else if (event.target.closest('.js-cam-expand')) {
                me.onCameraExpand?.();
            } else if (budget) {
                me.onBudget(+budget.dataset.budget);
            }
        });
    }

    close() {
        const me = this;

        me.mode = null;
        me._key = null;
        me.el.classList.remove('open', 'riding');
    }

    /** Shows a vehicle, updating in place as it moves along its route. */
    showVehicle(info, {tracking}) {
        const me = this,
            key = `vehicle:${info.run}`;

        if (me._key !== key) {
            me._buildVehicle(info);
            me._key = key;
            me.mode = 'vehicle';
            me.el.classList.add('open');
            me.el.scrollTop = 0;
        }
        me._updateVehicle(info, tracking);

        /*
           Riding: the card is the journey and nothing else.

           While a vehicle is being followed, the bar at the bottom of the
           screen already says which line, where it is headed and how to stop;
           what it cannot show is where the vehicle is along its line. So the
           card keeps the progress bar and the run of stops around the vehicle
           — the one behind, the one it is at, the ones coming — and drops the
           rest: status, destination, departure, stop count and fare are all
           either in the bar already or not what anyone riding along is asking.
        */
        me.el.classList.toggle('riding', !!tracking);
    }

    // The parts of a bus card that hold still for the whole run.
    _buildVehicle(info) {
        const me = this,
            {trip, route} = info,
            color = routeColor(route),
            fare = me.network.fareForRoute(route.id),
            transferNote = formatTransfers(fare);

        me.el.innerHTML = `
            <div class="detail-head">
                ${routeMark(route)}
                <div>
                    <div class="detail-title">${trip.headsign || route.longName}</div>
                    <div class="detail-sub">${route.category} &middot; ${route.longName}</div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="detail-body">
                <div class="row">
                    <span class="k">Status</span>
                    <span class="v js-status"></span>
                </div>
                <div class="row">
                    <span class="k js-aheadkey"></span>
                    <span class="v js-ahead"></span>
                </div>
                <div class="row">
                    <span class="k">Berangkat</span>
                    <span class="v">${formatClock(info.departure)}</span>
                </div>
                <div class="row">
                    <span class="k">Perhentian</span>
                    <span class="v js-count"></span>
                </div>
                <div class="row">
                    <span class="k">Tarif</span>
                    <span class="v">
                        <span class="fare ${fare && fare.price === 0 ? 'free' : ''}">${formatFare(fare)}</span>
                        ${transferNote ? `<div class="fare-note">${transferNote}</div>` : ''}
                    </span>
                </div>
                <div class="progress"><span class="js-progress"></span></div>
                <div class="stoplist js-stoplist"></div>
                <button class="btn btn-lg btn-block js-tour" type="button">Jelajahi rute ini</button>
            </div>
            <div class="detail-actions">
                <button class="btn btn-accent btn-lg btn-block js-track" type="button"></button>
            </div>
        `;

        me._el = {
            status: me.el.querySelector('.js-status'),
            aheadKey: me.el.querySelector('.js-aheadkey'),
            ahead: me.el.querySelector('.js-ahead'),
            count: me.el.querySelector('.js-count'),
            progress: me.el.querySelector('.js-progress'),
            stoplist: me.el.querySelector('.js-stoplist'),
            track: me.el.querySelector('.js-track')
        };
        me._stopIndex = -1;
        me._tracking = null;
    }

    _updateVehicle(info, tracking) {
        const me = this,
            el = me._el,
            {trip} = info,
            index = info.stopIndex;

        el.status.textContent = info.standing ? 'Berhenti di halte' : 'Dalam perjalanan';
        el.aheadKey.textContent = info.standing ? 'Di halte' : 'Menuju';
        el.ahead.textContent = (info.standing ? info.atStop : info.nextStop)?.name ?? '—';
        el.count.textContent = `${index + 1} / ${info.stopCount}`;
        el.progress.style.width = `${(info.progress * 100).toFixed(1)}%`;

        // The timetable only moves when the bus reaches another stop.
        if (index !== me._stopIndex) {
            me._stopIndex = index;

            const stops = trip.stops,
                from = Math.max(0, index - 1),
                // A window around the bus, not all 154 stops some Mikrotrans
                // patterns carry.
                to = Math.min(stops.length, index + 5),
                rows = [];

            for (let i = from; i < to; i++) {
                const stop = me.network.stops.get(stops[i]),
                    state = i < index ? 'done' : i === index ? 'now' : '';

                rows.push(`
                    <div class="stoprow ${state}">
                        <span class="tick"></span>
                        <span>${stop ? stop.name : stops[i]}</span>
                        <span class="t">${formatClock(info.departure + trip.arrivals[i])}</span>
                    </div>
                `);
            }
            el.stoplist.innerHTML = rows.join('');
        }

        if (tracking !== me._tracking) {
            me._tracking = tracking;
            el.track.textContent = tracking ? 'Berhenti mengikuti' : 'Ikuti kendaraan ini';
            el.track.classList.toggle('on', tracking);
        }
    }

    /** Shows a stop, with the routes calling there and the next departures. */
    showStop(stop, departures, service = {}) {
        const me = this,
            key = `stop:${stop.id}`;

        if (me._key !== key) {
            me._buildStop(stop, service);
            me._key = key;
            me.mode = 'stop';
            me.el.classList.remove('riding');
            me.el.classList.add('open');
            me.el.scrollTop = 0;
        }
        me._updateDepartures(departures);
    }

    /**
     * A line, previewed: what it is, where it runs, what it costs.
     *
     * Static for as long as it is open — a line does not move — so unlike the
     * vehicle card this one is built once and never updated in place.
     */
    showRoute(route, {stops = [], color = '#666', headway = null, headwayMax = null} = {}) {
        const me = this,
            key = `route:${route.id}`;

        me.mode = 'route';
        me.el.classList.remove('riding');
        me.el.classList.add('open');
        if (me._key === key) {
            return;
        }
        me._key = key;

        const list = stops.map((stop, i) => `
                <div class="line-stop${i === 0 || i === stops.length - 1 ? ' end' : ''}">
                    <span class="line-node"></span>
                    <span class="line-name">${escape(stop.name)}</span>
                </div>
            `).join(''),
            facts = [
                // The pedoman's own name for the line, where it has one. The
                // feed says "COMMUTER LINE BOGOR" and the platform says "Lin
                // Sentral"; a rider who has read the signage deserves both.
                lineName(route),
                stops.length ? `${stops.length} perhentian` : null,
                headway ? (headwayMax && Math.round(headwayMax / 60) !== Math.round(headway / 60)
                    ? `tiap ${Math.round(headway / 60)}-${Math.round(headwayMax / 60)} mnt`
                    : `tiap ${formatDuration(headway)}`) : null,
                route.category
            ].filter(Boolean).join(' · ');

        me.el.innerHTML = `
            <div class="detail-head">
                <div>
                    <div class="detail-title">
                        ${routeMark(route)}
                        ${escape(route.longName || route.shortName || '')}
                    </div>
                    <div class="detail-sub">${escape(facts)}</div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="detail-body">
                <div class="line-stops" style="--line-color:${color}">${list}</div>
            </div>
            <div class="detail-actions">
                <button class="btn btn-accent btn-lg btn-block js-tour" type="button">
                    Jelajahi jalur ini
                </button>
            </div>
        `;
        me.el.scrollTop = 0;
    }

    /**
     * A live street camera.
     *
     * The shell is built once per camera and never again — it holds a playing
     * `<video>`, and rebuilding the markup around it would tear the stream
     * down on every frame (trap 1, with a worse symptom than usual).
     * `onMount` therefore fires only on the build, and is where the stream is
     * attached.
     *
     * The caveat in the footer is not boilerplate. Everything else this panel
     * shows is a simulation running to a timetable; this is the one thing that
     * is real, and the two will visibly disagree. Saying so is the difference
     * between a window on the city and a claim about where the bus is.
     */
    showCamera(camera, {stop = null, notice = null, onMount = () => {}} = {}) {
        const me = this,
            // The notice is part of the key because it is part of the card. It
            // arrives with a restored link and never changes while one camera
            // is open, so this rebuilds once rather than every frame — which is
            // the rule the whole panel lives by.
            key = `camera:${camera.id}:${notice ? 1 : 0}`;

        me.mode = 'camera';
        me.el.classList.remove('riding');
        me.el.classList.add('open');
        if (me._key === key) {
            return;
        }
        me._key = key;

        // A motorway camera is described by its road, because "1.4 km from the
        // nearest stop" is true and useless. A street camera is described by
        // what it stands next to, which is the thing you were looking at.
        const where = camera.kind === 'toll'
                ? [escape(camera.road || 'Jalan tol'),
                    stop && camera.distance !== null
                        ? `${escape(stop.name)} ${(camera.distance / 1000).toFixed(1)} km`
                        : null].filter(Boolean).join(' &middot; ')
                : stop && camera.distance !== null
                    ? `Dekat ${escape(stop.name)} &middot; ${camera.distance} m`
                    : 'Lokasi terdekat tidak diketahui',

            // Several cameras on one pole. Without these buttons the extra
            // channels are unreachable: their pins sit at the same point and
            // only one can ever be clicked.
            channels = (camera.siblings ?? []).length > 1
                ? `<div class="cam-channels">${camera.siblings.map(sibling => `
                        <button class="btn btn-sm js-cam-ch${sibling.id === camera.id ? ' on' : ''}"
                            type="button" data-camera="${escape(sibling.id)}">
                            ${sibling.channel ? `Kamera ${sibling.channel}` : 'Kamera'}
                        </button>
                    `).join('')}</div>`
                : '';

        me.el.innerHTML = `
            <div class="detail-head">
                <span class="badge cam-badge${camera.kind === 'toll' ? ' toll' : ''}">LIVE</span>
                <div>
                    <div class="detail-title">${escape(camera.name)}</div>
                    <div class="detail-sub">${where}</div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="detail-body">
                <div class="cam-stage js-cam-expand" title="Perbesar">
                    <video class="cam-video" playsinline muted autoplay
                        ${camera.preview ? `poster="${escape(camera.preview)}"` : ''}></video>
                    <button class="cam-expand" type="button" aria-label="Perbesar">⤢</button>
                    <div class="cam-error" hidden></div>
                </div>
                ${channels}
                ${notice ? `<p class="cam-notice">${notice}</p>` : ''}
                ${camera.precision === 'estimated' ? `
                    <p class="cam-approx">
                        Posisi kamera <strong>diperkirakan</strong> dari nama jalan
                        pada kode siarannya &mdash; kamera ini berada di sekitar
                        sini, bukan tepat di titik ini.
                    </p>
                ` : ''}
                <p class="cam-note">
                    Siaran langsung dari jalan. Kendaraan di peta mengikuti
                    <strong>jadwal</strong>, bukan posisi sebenarnya &mdash; jadi
                    apa yang terlihat di kamera tidak harus sama dengan yang
                    bergerak di peta.
                </p>
                <p class="cam-credit">${camera.kind === 'toll'
                    ? 'CCTV jalan tol &middot; BPJT / Bina Marga &middot; Badan Usaha Jalan Tol'
                    : 'CCTV publik &middot; Pemprov DKI Jakarta / Balitower'}</p>
            </div>
        `;
        me.el.scrollTop = 0;
        onMount(
            me.el.querySelector('.cam-video'),
            me.el.querySelector('.cam-error')
        );
    }

    /**
     * What you can catch from an arbitrary point on the map.
     *
     * People tap where they are, not on a dot, so an empty patch of map should
     * still answer the question rather than doing nothing.
     */
    showNearby(nearby, departuresFor) {
        const me = this,
            key = `nearby:${nearby.point[0].toFixed(4)},${nearby.point[1].toFixed(4)}`;

        me.mode = 'nearby';
        me.el.classList.remove('riding');
        me.el.classList.add('open');
        if (me._key === key) {
            return;
        }
        me._key = key;

        const rows = nearby.stops.map(({stop, metres, seconds}) => {
            const departures = departuresFor(stop).slice(0, 2);

            return `
                <div class="near">
                    <div class="near-top">
                        <span class="near-name">${stop.name}</span>
                        <span class="t">${metres} m &middot; ${Math.max(1, Math.round(seconds / 60))} mnt</span>
                    </div>
                    <div class="near-deps">
                        ${departures.length ? departures.map(d => `
                            ${routeMark(d.route, {glyph: false})}
                            <span class="near-wait">${d.wait <= 0 ? 'tiba' : formatDuration(d.wait)}</span>
                        `).join('') : '<span class="near-wait">tidak ada layanan</span>'}
                    </div>
                </div>
            `;
        }).join('');

        me.el.innerHTML = `
            <div class="detail-head">
                <span class="badge" style="background:#42505f">◎</span>
                <div>
                    <div class="detail-title">Di sekitar sini</div>
                    <div class="detail-sub">
                        ${nearby.stops.length ? `${nearby.stops.length} halte dalam jarak jalan kaki` :
                            'Tidak ada halte dalam 800 m'}
                    </div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="detail-body">
                ${rows}
            </div>
            ${nearby.stops.length ?
                // The handler has set a reach origin since the journey planner went;
                // the label still said *Mulai perjalanan*, which is a promise
                // this map no longer makes. Same wording as the stop card's
                // own filled action, because it is the same action.
                '<div class="detail-actions"><button class="btn btn-accent btn-lg btn-block js-from-point" type="button">Lihat jangkauan dari sini</button></div>' :
                ''}
        `;
    }

    /** Renders the reachability panel, rebuilt whenever its options change. */
    showReach(reach) {
        const me = this,
            key = `reach:${reach.origin.id}:${reach.budget}:${reach.freeOnly}:${Math.floor(reach.time)}`;

        me.mode = 'reach';
        me.el.classList.remove('riding');
        me.el.classList.add('open');
        if (me._key !== key) {
            me._key = key;
            reach.renderInto(me.el);
        }
    }

    _buildStop(stop, service = {}) {
        const me = this,
            routeIds = [...me.network.routesAt(stop)],
            chips = routeIds.slice(0, 24).map(id => {
                const route = me.network.routes.get(id);

                return routeMark(route, {glyph: false});
            }).join(''),
            // Official interchange walks, where the feed records them.
            walkRows = me.network.transfersFrom(stop).map(({stop: target, minTime}) => `
                <div class="stoprow">
                    <span class="tick"></span>
                    <span>${target.name}</span>
                    ${minTime ? `<span class="t">${formatDuration(minTime)}</span>` : ''}
                </div>
            `).join('');

        me.el.innerHTML = `
            <div class="detail-head">
                <span class="badge" style="background:${stop.accessible ? '#0d7a4f' : '#42505f'}">${
                    stop.station ? 'ST' : 'H'
                }</span>
                <div>
                    <div class="detail-title">${stop.name}</div>
                    <div class="detail-sub">
                        ${routeIds.length} rute melayani halte ini
                        ${stop.accessible ? '&middot; <span class="access-tag">akses kursi roda</span>' : ''}
                    </div>
                </div>
                <button class="detail-close" type="button" title="Tutup">&times;</button>
            </div>
            <div class="detail-body">
                <div class="panel-title" style="margin-top:4px">Keberangkatan berikutnya</div>
                <div class="js-departures"></div>
                ${walkRows ? `
                    <div class="panel-title" style="margin-top:14px">Transit jalan kaki</div>
                    ${walkRows}
                ` : ''}
                ${me._hours(service)}
                <div class="panel-title" style="margin-top:14px">Rute</div>
                <div class="chips">${chips}</div>
            </div>
            <div class="detail-actions">
                <button class="btn btn-accent btn-lg btn-block js-reach" type="button">Lihat jangkauan</button>
            </div>
        `;
        me._el = {departures: me.el.querySelector('.js-departures')};
    }

    /**
     * Operating hours, with the last bus called out when it matters.
     *
     * Knowing the last bus left at 22:47 is only useful if you are told loudly
     * enough, and only near the end of the day.
     */
    _hours({hours, now}) {
        if (!hours) {
            return '';
        }

        // A last bus at 24:44 is 00:44 tomorrow, so before dawn the clock has
        // already wrapped past it and the comparison needs the extra day back.
        const DAY = 86400,
            reference = hours.last > DAY && now < DAY / 2 ? now + DAY : now,
            remaining = hours.last - reference,
            gone = remaining < 0,
            soon = !gone && remaining < 30 * 60;
        let note = '';

        if (gone) {
            note = `<div class="hours-note gone">Keberangkatan terakhir pukul ${formatOffsetWithDay(hours.last)}.</div>`;
        } else if (soon) {
            note = `<div class="hours-note soon">Keberangkatan terakhir ${Math.round(remaining / 60)} menit lagi.</div>`;
        }

        return `
            <div class="panel-title" style="margin-top:14px">Jam operasi</div>
            <div class="row">
                <span class="k">Keberangkatan pertama</span>
                <span class="v">${formatOffsetWithDay(hours.first)}</span>
            </div>
            <div class="row">
                <span class="k">Keberangkatan terakhir</span>
                <span class="v">${formatOffsetWithDay(hours.last)}</span>
            </div>
            ${note}
        `;
    }

    _updateDepartures(departures) {
        this._el.departures.innerHTML = departures.length ? departures.map(d => `
            <div class="stoprow dep">
                ${routeMark(d.route)}
                <span>${d.headsign}</span>
                <span class="t">${d.wait <= 0 ? 'tiba' : formatDuration(d.wait)}</span>
            </div>
        `).join('') : '<div class="stoprow">Tidak ada layanan saat ini</div>';
    }

}

/** Route and stop names come from the feed, so they are escaped before markup. */
function escape(text) {
    return String(text ?? '').replace(/[&<>"]/g, c =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
}
