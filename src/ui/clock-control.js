import configs from '../configs';

const DAY = 86400;

/*
   A full Jakarta day in one minute — but not at a constant rate, and not from
   midnight.

   A linear sweep from 00:00 spends its first twelve seconds on a dark and very
   nearly empty city, and then ten flat seconds crossing the middle of the
   afternoon, which is most of the reason the first build of this read as
   boring. It starts at 04:00 instead, where the first buses are, and it is
   paced by the fleet's own day profile: the same 144-bucket curve that is
   already drawn behind the scrubber decides how much of the minute each part
   of the day gets. The morning and evening peaks — the two moments six
   thousand vehicles are actually doing something — come out slow, and the
   small hours pass in a blink.

   `DWELL_FLOOR` is what stops the quiet parts being skipped outright. At zero
   weight the empty hours would take no time at all and the sweep would jump,
   which loses the thing the timelapse is for: seeing the city fill up.
*/
const TIMELAPSE_DURATION = 60_000,
    TIMELAPSE_START = 4 * 3600,
    DWELL_FLOOR = 0.3,

    /*
       How sharply the dwell follows the fleet size.

       Proportional was tried first and barely reads: Jakarta's service profile
       is broad rather than peaked — midday sits at about three quarters of the
       evening maximum — so a linear weight gave the peaks 0.317 hours a second
       against midday's 0.33, which nobody could see. Cubed, the same curve
       spends visibly longer on the two peaks and still passes the small hours
       in a blink, because the floor is what governs down there rather than the
       exponent.
    */
    DWELL_GAMMA = 3;

function pad(n) {
    return String(n).padStart(2, '0');
}

function formatOffset(seconds) {
    const s = ((seconds % DAY) + DAY) % DAY;

    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;
}

/**
 * A scheduled time: `05:03`, not `05:03:00`.
 *
 * No departure board in the world quotes seconds, and a timetable that does
 * reads as machine output. `formatOffset` keeps them because it drives the
 * clock, which is the one readout that is genuinely ticking.
 */
function formatClock(seconds) {
    const s = ((seconds % DAY) + DAY) % DAY;

    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
});

/**
 * The time readout, playback transport and speed control.
 *
 * Playback is expressed as a time of day rather than an absolute instant: the
 * timetable repeats daily, so scrubbing within the day is the useful gesture.
 */
export default class ClockControl {

    constructor(clock, fleet) {
        const me = this;

        me.clock = clock;
        me.fleet = fleet;
        me._scrubbing = false;
        me._render();

        // The URL's speed is applied to the clock long before this panel is
        // built, so a reloaded 128x link used to show a 1x slider over a clock
        // running at 128x — and only dragging the slider put them back in step.
        me.syncSpeed();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'panel';
        el.id = 'clock';
        el.innerHTML = `
            <div class="clock-top">
                <div class="clock-time">00:00:00</div>
                <button class="clock-live" type="button">LIVE</button>
                <button class="clock-fold js-fold" type="button"
                        title="Sembunyikan kontrol waktu"><span class="chevron"></span></button>
            </div>
            <div class="clock-date"></div>
            <div class="clock-controls">
                <button class="icon js-play" type="button" title="Jeda / lanjut">❚❚</button>
                <div class="scrub-wrap">
                    <canvas class="js-profile" height="34"></canvas>
                    <input class="clock-scrub" type="range" min="0" max="86399" step="1" value="0">
                </div>
            </div>
            <div class="speed-row">
                <span>Kecepatan</span>
                <input class="js-speed" type="range" min="0" max="${configs.speeds.length - 1}" step="1" value="0">
                <output>1&times;</output>
            </div>
            <div class="clock-jumps">
                <button class="btn btn-sm js-jump" data-t="21600" type="button" title="06:00">Fajar</button>
                <button class="btn btn-sm js-jump" data-t="27000" type="button" title="07:30 — puncak pagi">Pagi</button>
                <button class="btn btn-sm js-jump" data-t="43200" type="button" title="12:00">Siang</button>
                <button class="btn btn-sm js-jump" data-t="63000" type="button" title="17:30 — puncak sore">Sore</button>
            </div>
            <div class="clock-count">Armada beroperasi <b>0</b></div>
            <div class="clock-actions">
                <button class="btn timelapse js-timelapse" type="button"
                        title="Putar 24 jam dalam 60 detik">
                    <span class="js-tl-label">Tonton 24 jam</span>
                    <span class="tl-progress"></span>
                </button>
                <button class="btn js-showreel" type="button"
                        title="Terbangkan jalur satu per satu">Putar otomatis</button>
            </div>
        `;
        document.body.appendChild(el);

        me._time = el.querySelector('.clock-time');
        me._date = el.querySelector('.clock-date');
        me._live = el.querySelector('.clock-live');
        me._scrub = el.querySelector('.clock-scrub');
        me._speed = el.querySelector('.js-speed');
        me._speedOut = el.querySelector('output');
        me._play = el.querySelector('.js-play');
        me._count = el.querySelector('.clock-count b');
        me._profileCanvas = el.querySelector('.js-profile');
        me._timelapseBtn = el.querySelector('.js-timelapse');
        me._timelapseLabel = el.querySelector('.js-tl-label');
        me._timelapseProgress = el.querySelector('.tl-progress');
        me._showreelBtn = el.querySelector('.js-showreel');
        me._timelapse = null;
        // Set by `main.js`, which owns the reel — this panel only carries the
        // button, the same arrangement the layer rows have.
        me.onShowreel = null;

        // Folding exists for the phone, where this panel is 169px of a 674px
        // screen and everything below the time is a control you touch once.
        // The button is hidden above the mobile breakpoint rather than built
        // conditionally, so a rotation or a resize never leaves the clock
        // folded with no way to open it.
        el.querySelector('.js-fold').addEventListener('click', () => me.fold());

        me._live.addEventListener('click', () => {
            if (me._timelapse) { me.stopTimelapse(false); }
            me.clock.goLive();
            me._speed.value = '0';
            me._speedOut.innerHTML = '1&times;';
            me._paused = false;
            me._play.textContent = '❚❚';
        });

        me._play.addEventListener('click', () => {
            if (me._timelapse) { me.stopTimelapse(false); }
            me._paused = !me._paused;
            me._play.textContent = me._paused ? '▶' : '❚❚';
            me.clock.setSpeed(me._paused ? 0 : configs.speeds[+me._speed.value]);
        });

        // Another control changed the speed. Reflect it here rather than
        // letting the two disagree about what the clock is doing.
        me.syncSpeed = () => {
            const speed = me.clock.speed;

            if (!speed || document.activeElement === me._speed) {
                return;
            }

            // Nearest rather than exact: a link can carry any `s=` value, and a
            // slider parked at 1x beside a clock running at 128x is the bug
            // this exists to stop. The readout shows the real speed either way.
            let index = 0;

            for (let i = 1; i < configs.speeds.length; i++) {
                if (Math.abs(configs.speeds[i] - speed) < Math.abs(configs.speeds[index] - speed)) {
                    index = i;
                }
            }
            me._speed.value = String(index);
            me._speedOut.innerHTML = `${speed}&times;`;
            me._paused = false;
            me._play.textContent = '❚❚';
        };

        me._speed.addEventListener('input', () => {
            if (me._timelapse) { me.stopTimelapse(false); }
            const speed = configs.speeds[+me._speed.value];

            me._speedOut.innerHTML = `${speed}&times;`;
            me._paused = false;
            me._play.textContent = '❚❚';
            me.clock.setSpeed(speed);
        });

        // While the pointer is down the readout follows the slider rather than
        // the clock, so the handle does not fight the running simulation.
        me._scrub.addEventListener('pointerdown', () => {
            if (me._timelapse) { me.stopTimelapse(false); }
            me._scrubbing = true;
        });
        const release = () => {
            me._scrubbing = false;
        };

        me._scrub.addEventListener('pointerup', release);
        me._scrub.addEventListener('pointercancel', release);
        me._scrub.addEventListener('input', () => {
            me.clock.setTimeOffset(+me._scrub.value);
        });

        me._timelapseBtn.addEventListener('click', () => {
            if (me._timelapse) {
                me.stopTimelapse();
            } else {
                me.startTimelapse();
            }
        });

        me._showreelBtn.addEventListener('click', () => me.onShowreel?.());

        el.querySelectorAll('.js-jump').forEach(btn => {
            btn.addEventListener('click', () => {
                if (me._timelapse) { me.stopTimelapse(false); }
                me.clock.setTimeOffset(+btn.dataset.t);
            });
        });
    }

    /**
     * Draws the day's service level behind the scrubber.
     *
     * The slider is otherwise a featureless track, which hides the shape of the
     * day entirely — 682 buses at 04:30 against 6,138 at the evening peak. With
     * the curve on it you can see where the peaks are and drag straight to one.
     */
    /**
     * Collapses to the time and the LIVE badge, which is all this panel has to
     * say when it is not being used. Mirrors `LayerPanel.toggle` deliberately:
     * two panels sharing a rail that fold by different rules is worse than
     * either rule on its own.
     */
    fold(folded = !this.el.classList.contains('folded')) {
        this.el.classList.toggle('folded', folded);
        return folded;
    }

    /** Reflects the showreel's state, without firing the callback. */
    setShowreelUI(on) {
        this._showreelBtn.classList.toggle('on', on);
        this._showreelBtn.textContent = on ? 'Hentikan' : 'Putar otomatis';
        return this;
    }

    /**
     * Builds the pacing table: for each of the day's 144 buckets, the share of
     * the minute it gets.
     *
     * Weight is the fleet's own size at that time of day, floored so nothing
     * is skipped entirely, and the result is a cumulative table that
     * `_timeAt` inverts. Driving it from `fleet.profile` rather than from a
     * hand-written curve means it is right for a Sunday as well as a Tuesday,
     * and it re-shapes itself when a filter hides half the network — hiding
     * Mikrotrans really should change which part of the day is worth dwelling
     * on, because it changes what there is to see.
     */
    _buildPacing(dayOfWeek) {
        const counts = this.fleet.profile(dayOfWeek),
            n = counts.length,
            peak = Math.max(1, ...counts),
            cumulative = new Float64Array(n + 1),
            // Buckets are indexed from midnight; the sweep starts at 04:00 and
            // wraps, so the table is walked from that offset.
            from = Math.round(TIMELAPSE_START / DAY * n);
        let total = 0;

        for (let i = 0; i < n; i++) {
            total += DWELL_FLOOR + (1 - DWELL_FLOOR) *
                Math.pow(counts[(from + i) % n] / peak, DWELL_GAMMA);
            cumulative[i + 1] = total;
        }
        for (let i = 0; i <= n; i++) {
            cumulative[i] /= total || 1;
        }
        return {cumulative, buckets: n, from};
    }

    /** Inverts the pacing table: progress through the minute to time of day. */
    _timeAt(pacing, p) {
        const {cumulative, buckets, from} = pacing;
        let lo = 0,
            hi = buckets;

        while (lo < hi) {
            const mid = (lo + hi) >> 1;

            if (cumulative[mid + 1] < p) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        const span = cumulative[lo + 1] - cumulative[lo],
            frac = span > 0 ? (p - cumulative[lo]) / span : 0;

        return ((from + lo + frac) * DAY / buckets) % DAY;
    }

    /**
     * Sweeps the clock through a full day in about a minute.
     *
     * The clock is driven by `setTimeOffset` each frame rather than by setting
     * a playback speed, which is what lets the sweep dwell on the peaks — a
     * speed is one number and this needs a curve. Everything downstream
     * follows the clock already, so the lighting, the scrubber, the readout,
     * the fleet and the frequency colouring all come along for free.
     */
    startTimelapse() {
        const me = this;

        me._timelapse = {
            start: performance.now(),
            duration: TIMELAPSE_DURATION,
            wasLive: me.clock.live,
            prevSpeed: me.clock.speed,
            prevOffset: me.clock.getTimeOffset(),
            pacing: me._buildPacing(me.clock.getDayOfWeek()),
            lastRate: 0,
            rateShownAt: 0
        };
        me._paused = false;
        me._play.textContent = '❚❚';
        me.clock.setTimeOffset(TIMELAPSE_START);
        me._timelapseBtn.classList.add('on');
        me._timelapseLabel.textContent = 'Berhenti';
        return me;
    }

    /**
     * Ends a timelapse. `restore` returns the clock to where it was — live, or
     * at the time and speed it was replaying — and is what the button itself
     * uses. Other controls pass false and let their own action take over.
     */
    stopTimelapse(restore = true) {
        const me = this;

        if (!me._timelapse) {
            return;
        }
        const t = me._timelapse;

        me._timelapse = null;
        me._timelapseBtn.classList.remove('on');
        me._timelapseLabel.textContent = 'Tonton 24 jam';
        me._timelapseProgress.style.width = '';

        if (restore) {
            if (t.wasLive) {
                me.clock.goLive();
            } else {
                me.clock.setTimeOffset(t.prevOffset);
                me.clock.setSpeed(t.prevSpeed);
            }
            me.syncSpeed();
        }
        // `syncSpeed` returns early on a speed of zero — it exists to stop a
        // slider disagreeing with a running clock, and a stopped clock has no
        // speed to agree about. That left the transport reading ❚❚ over a
        // clock that was not moving, so the paused case is restored here.
        if (restore && !t.wasLive && !t.prevSpeed) {
            me._paused = true;
            me._play.textContent = '▶';
        }
        return me;
    }


    /**
     * Draws the day's service level behind the scrubber, filled up to `at`.
     *
     * The curve alone shows the shape of the day — 682 buses at 04:30 against
     * 6,138 at the evening peak. Filling it up to the current time turns it
     * into a playhead as well, which is what makes a timelapse read as the
     * city breathing rather than as a number changing: the morning peak builds
     * under the cursor as it is being flown over.
     */
    drawProfile(dayOfWeek, at = null) {
        const me = this,
            canvas = me._profileCanvas;

        if (!canvas) {
            return me;
        }

        const width = canvas.clientWidth || canvas.parentElement.clientWidth;

        if (!width) {
            return me;
        }

        const ratio = window.devicePixelRatio || 1,
            height = canvas.height / ratio || 34,
            counts = me.fleet.profile(dayOfWeek),
            peak = Math.max(1, ...counts);

        canvas.width = width * ratio;
        canvas.height = height * ratio;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const context = canvas.getContext('2d'),
            // The accent, from the token rather than from a literal. This was
            // `rgba(53, 167, 255, …)` — the stock blue the whole interface was
            // repainted away from, left behind in a canvas where no stylesheet
            // sweep would ever find it.
            brand = getComputedStyle(document.documentElement)
                .getPropertyValue('--brand').trim() || '#0d5eaf',
            trace = () => {
                context.beginPath();
                context.moveTo(0, height);
                for (let i = 0; i < counts.length; i++) {
                    context.lineTo(
                        i / (counts.length - 1) * width,
                        height - counts[i] / peak * (height - 2)
                    );
                }
                context.lineTo(width, height);
                context.closePath();
            };

        context.scale(ratio, ratio);
        context.clearRect(0, 0, width, height);

        trace();
        context.fillStyle = 'rgba(13, 94, 175, 0.16)';
        context.fill();

        if (at !== null) {
            const x = Math.max(0, Math.min(1, at / DAY)) * width;

            // The same path, clipped to everything before now. Two fills of
            // one shape rather than two shapes, so the boundary is exact.
            context.save();
            context.beginPath();
            context.rect(0, 0, x, height);
            context.clip();
            trace();
            context.fillStyle = 'rgba(13, 94, 175, 0.42)';
            context.fill();
            context.restore();

            context.fillStyle = brand;
            context.fillRect(Math.min(width - 1, x), 0, 1, height);
        }

        me._profileDay = dayOfWeek;
        me._profileBucket = at === null ? null : Math.floor(at / DAY * 144);
        me._profileHidden = [...me.fleet.hidden].join(',');
        return me;
    }

    update() {
        const me = this;

        // Before anything reads the clock: the sweep owns the time while it
        // runs, so it has to be applied first or every readout below is one
        // frame behind the map.
        if (me._timelapse) {
            me._advanceTimelapse();
        }

        const offset = me.clock.getTimeOffset();

        const dayOfWeek = me.clock.getDayOfWeek(),
            hiddenKey = [...me.fleet.hidden].join(',');

        // Redraw when the day or the filters change — hiding Mikrotrans should
        // visibly flatten the curve, since it is over half the fleet — and
        // when the playhead moves into a new bucket. The profile has 144 of
        // them, so a full sweep costs at most 144 redraws of a 144-point path
        // rather than one per frame.
        const bucket = Math.floor(offset / DAY * 144);

        if (dayOfWeek !== me._profileDay || hiddenKey !== me._profileHidden ||
                bucket !== me._profileBucket) {
            me.drawProfile(dayOfWeek, offset);
        }

        me._time.textContent = formatOffset(offset);
        me._date.textContent = DATE_FORMAT.format(me.clock.getLocalDate());
        me._count.textContent = me.fleet.activeCount.toLocaleString('id-ID');
        me._live.classList.toggle('off', !me.clock.live);
        me._live.textContent = me.clock.live ? 'LIVE' : 'KE LIVE';
        if (!me._scrubbing) {
            me._scrub.value = String(Math.floor(offset));
        }

    }

    /**
     * One frame of the sweep: where in the day we are, and how fast that is.
     *
     * The rate readout is the point of the second half. A timelapse drove the
     * clock at 1440x while the speed output went on saying "1x", which is the
     * one number in this panel whose whole job is to say how fast time is
     * moving. It is measured from the curve rather than assumed, so it visibly
     * slows through the peaks — which is also the clearest signal that the
     * pacing is doing anything at all. Updated four times a second, because a
     * figure recomputed every frame is unreadable noise.
     */
    _advanceTimelapse() {
        const me = this,
            t = me._timelapse,
            now = performance.now(),
            p = Math.min(1, (now - t.start) / t.duration),
            at = me._timeAt(t.pacing, p);

        me.clock.setTimeOffset(at);
        me._timelapseProgress.style.width = `${(p * 100).toFixed(1)}%`;

        if (now - t.rateShownAt > 250) {
            // Differenced over a slice of the curve rather than over the last
            // frame: a frame delta divides two small numbers and jitters.
            const ahead = me._timeAt(t.pacing, Math.min(1, p + 0.004)),
                seconds = ((ahead - at) + DAY) % DAY,
                rate = seconds / (0.004 * t.duration / 1000);

            t.rateShownAt = now;
            me._speedOut.innerHTML = `${Math.round(rate / 10) * 10}&times;`;
        }

        if (p >= 1) {
            me.stopTimelapse();
        }
    }

}

/**
 * A time of day, marking anything past midnight as belonging to the next day.
 *
 * GTFS expresses a service that runs to 00:44 tomorrow as 24:44, and wrapping
 * that silently to "00:44" turns a route running around the clock into one that
 * appears to close 28 minutes after it opens.
 */
function formatOffsetWithDay(seconds) {
    const label = formatClock(seconds);

    return seconds >= DAY ? `${label} (+1)` : label;
}

export {formatClock, formatOffset, formatOffsetWithDay};
