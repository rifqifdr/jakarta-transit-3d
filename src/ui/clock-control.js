import configs from '../configs';

const DAY = 86400;

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
            <div class="clock-count">Armada beroperasi <b>0</b></div>
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

        // Folding exists for the phone, where this panel is 169px of a 674px
        // screen and everything below the time is a control you touch once.
        // The button is hidden above the mobile breakpoint rather than built
        // conditionally, so a rotation or a resize never leaves the clock
        // folded with no way to open it.
        el.querySelector('.js-fold').addEventListener('click', () => me.fold());

        me._live.addEventListener('click', () => {
            me.clock.goLive();
            me._speed.value = '0';
            me._speedOut.innerHTML = '1&times;';
            me._paused = false;
            me._play.textContent = '❚❚';
        });

        me._play.addEventListener('click', () => {
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
            const speed = configs.speeds[+me._speed.value];

            me._speedOut.innerHTML = `${speed}&times;`;
            me._paused = false;
            me._play.textContent = '❚❚';
            me.clock.setSpeed(speed);
        });

        // While the pointer is down the readout follows the slider rather than
        // the clock, so the handle does not fight the running simulation.
        me._scrub.addEventListener('pointerdown', () => {
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


    drawProfile(dayOfWeek) {
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

        const context = canvas.getContext('2d');

        context.scale(ratio, ratio);
        context.clearRect(0, 0, width, height);
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
        context.fillStyle = 'rgba(53, 167, 255, 0.28)';
        context.fill();

        me._profileDay = dayOfWeek;
        me._profileHidden = [...me.fleet.hidden].join(',');
        return me;
    }

    update() {
        const me = this,
            offset = me.clock.getTimeOffset();

        const dayOfWeek = me.clock.getDayOfWeek(),
            hiddenKey = [...me.fleet.hidden].join(',');

        // Redraw only when the day or the filters change; hiding Mikrotrans
        // should visibly flatten the curve, since it is over half the fleet.
        if (dayOfWeek !== me._profileDay || hiddenKey !== me._profileHidden) {
            me.drawProfile(dayOfWeek);
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
