import configs from './configs';

const DAY = 86400;

/**
 * The simulation clock.
 *
 * In live mode it tracks the real time in Jakarta. In playback mode it runs
 * from a chosen instant at a multiple of real time. Everything downstream asks
 * it for one number: seconds elapsed since local midnight.
 */
export default class Clock {

    constructor() {
        const me = this;

        me.speed = 1;
        me.live = true;
        me._baseTime = Date.now();
        me._basePerf = performance.now();
        me._listeners = new Set();
    }

    /** Milliseconds since the Unix epoch, as the simulation sees it. */
    getTime() {
        const me = this;

        if (me.live) {
            return Date.now();
        }
        return me._baseTime + (performance.now() - me._basePerf) * me.speed;
    }

    /**
     * Seconds since midnight in Jakarta, in [0, 86400).
     *
     * GTFS expresses times past midnight as 25:10:00 rather than 01:10:00, so
     * callers that need to match a late-night trip also test this value plus a
     * day (see Fleet).
     */
    getTimeOffset() {
        return (this.getTime() / 1000 + configs.timezoneOffset) % DAY;
    }

    /** A Date positioned so its UTC fields read as Jakarta local time. */
    getLocalDate() {
        return new Date(this.getTime() + configs.timezoneOffset * 1000);
    }

    /** Day of week in Jakarta, 0 = Sunday, as GTFS calendar.txt orders it. */
    getDayOfWeek() {
        return this.getLocalDate().getUTCDay();
    }

    setSpeed(speed) {
        const me = this;

        me._rebase();
        me.speed = speed;
        if (speed !== 1) {
            me.live = false;
        }
        return me._emit();
    }

    /** Returns to following the real Jakarta clock at 1x. */
    goLive() {
        const me = this;

        me.live = true;
        me.speed = 1;
        me._rebase();
        return me._emit();
    }

    /** Jumps to a given time of day, in seconds since local midnight. */
    setTimeOffset(seconds) {
        const me = this,
            date = me.getLocalDate();

        date.setUTCHours(0, 0, 0, 0);
        me.live = false;
        me._baseTime =
            date.getTime() - configs.timezoneOffset * 1000 + seconds * 1000;
        me._basePerf = performance.now();
        return me._emit(true);
    }

    // Freezes the current instant so a change of speed or mode does not make
    // the clock jump.
    _rebase() {
        const me = this;

        me._baseTime = me.getTime();
        me._basePerf = performance.now();
    }

    onChange(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    _emit(seeked = false) {
        for (const fn of this._listeners) {
            fn(this, seeked);
        }
        return this;
    }

}
