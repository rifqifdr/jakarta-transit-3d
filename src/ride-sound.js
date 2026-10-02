/**
 * Sound while following a vehicle: the cabin, and the station announcer.
 *
 * Off until someone asks for it, from the follow HUD. Nothing here loads before
 * then — the ambience is a megabyte, fetched on the first tap — and nothing
 * plays outside following.
 *
 * **What is real and what is not.** No KRL recording is openly licensed: the
 * announcements KAI Commuter plays are its own, and the recordings of them
 * online are their uploaders'. So the cabin is a CC0 recording of a generic
 * electric multiple unit (KRL runs ex-Japanese EMUs, so it is the right kind of
 * train — see `public/sounds/SOURCES.md`), the announcer is the device's own
 * Indonesian voice, and the chime before it is synthesised here rather than
 * copied from KRL's. A voice that reads any name also means any station and
 * any line get announced, not only the stations somebody recorded.
 *
 * Trains only have the cabin for now: there is no openly licensed recording of
 * a Jakarta bus, and an EMU's hum under a Transjakarta bus would be wrong. A
 * bus still gets its announcements.
 */
const AMBIENCE_URL = '/sounds/emu-interior.mp3',
    // How long two copies of the loop overlap, so the 48 s recording has no
    // seam: each fades in over this while the last fades out.
    CROSSFADE_S = 3,
    // The cabin at speed, and standing at a platform or with the clock paused.
    // Not silent when standing: a train with its doors open still hums.
    MOVING_GAIN = 0.55,
    STANDING_GAIN = 0.2,
    // While the announcer speaks, so the name is heard over the cabin.
    DUCKED_GAIN = 0.12;

export default class RideSound {

    constructor() {
        const me = this;

        me.on = false;
        me._ctx = null;
        me._buffer = null;
        me._key = null;
        me._speaking = false;
        me._voice = null;
        me._rail = false;
        me._still = false;
    }

    /**
     * Switches sound on, from inside a tap — browsers allow audio, and iOS
     * allows speech, only when a person started it.
     */
    async enable() {
        const me = this;

        if (!me._ctx) {
            me._ctx = new AudioContext();
            me._master = me._ctx.createGain();
            me._master.gain.value = 0;
            me._master.connect(me._ctx.destination);
        }
        await me._ctx.resume();

        // iOS speaks only if the first utterance came from a gesture. An empty
        // one, now, is what lets the announcer talk later on its own.
        if ('speechSynthesis' in window) {
            speechSynthesis.speak(new SpeechSynthesisUtterance(''));
            me._pickVoice();
            speechSynthesis.onvoiceschanged = () => me._pickVoice();
        }

        me.on = true;
        // The current stop is not announced on switching on — only arrivals
        // from here, which is what a passenger who just sat down would hear.
        me._key = null;

        if (!me._buffer) {
            try {
                const bytes = await (await fetch(AMBIENCE_URL)).arrayBuffer();

                me._buffer = await me._ctx.decodeAudioData(bytes);
            } catch {
                // No cabin, still an announcer. A failed fetch is not worth
                // more than that.
            }
        }
        if (me.on && me._buffer && !me._looping) {
            me._startLoop();
        }
        return me;
    }

    disable() {
        const me = this;

        me.on = false;
        me._key = null;
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        if (me._ctx) {
            me._master.gain.setTargetAtTime(0, me._ctx.currentTime, 0.15);
            clearTimeout(me._loopTimer);
            me._looping = false;
            for (const source of me._sources ?? []) {
                try {
                    source.stop(me._ctx.currentTime + 0.5);
                } catch {
                    // Already stopped.
                }
            }
            me._sources = [];
        }
        return me;
    }

    /**
     * Once a frame while a vehicle is followed and sound is on.
     *
     * Arrival is a change of stop index, not the vehicle standing: rail
     * timetables built from departure boards often give a stop no dwell, so a
     * train can reach Cilebut and leave in the same instant and never be
     * "standing" at all. `stopIndex` moves to the next stop at the moment of
     * arrival either way.
     */
    update(info, {paused}) {
        const me = this;

        if (!me.on || !info) {
            return;
        }

        me._rail = info.route?.mode && info.route.mode !== 'bus';
        me._still = paused || info.standing;
        me._setLevel();

        const key = `${info.run}:${info.stopIndex}`,
            previous = me._key;

        me._key = key;
        if (previous === null || previous === key) {
            return;
        }
        // A different vehicle is a new ride, not an arrival.
        if (previous.split(':')[0] !== String(info.run)) {
            return;
        }
        // The stop just reached, with a dwell or without: `describe` points
        // `atStop` at the platform it is standing at, and at the stop it last
        // passed when it is moving — which, the instant the index changes, is
        // the same stop.
        if (info.atStop) {
            me._announce(info.atStop.name, me._rail);
        }
    }

    // ------------------------------------------------------------- ambience

    /** The cabin's level, eased so a change is a swell rather than a step. */
    _setLevel() {
        const me = this;

        if (!me._ctx) {
            return;
        }
        const target = !me._rail ? 0 :
            me._speaking ? DUCKED_GAIN :
            me._still ? STANDING_GAIN : MOVING_GAIN;

        if (target !== me._level) {
            me._level = target;
            me._master.gain.setTargetAtTime(target, me._ctx.currentTime, 0.4);
        }
    }

    /**
     * Plays the recording end over end, each copy fading in over the last's
     * fade-out, so the loop point is never heard.
     */
    _startLoop() {
        const me = this,
            ctx = me._ctx,
            length = me._buffer.duration,
            step = length - CROSSFADE_S;

        me._looping = true;
        me._sources = [];

        const schedule = at => {
            if (!me._looping) {
                return;
            }
            const source = ctx.createBufferSource(),
                fade = ctx.createGain();

            source.buffer = me._buffer;
            source.connect(fade);
            fade.connect(me._master);
            fade.gain.setValueAtTime(0, at);
            fade.gain.linearRampToValueAtTime(1, at + CROSSFADE_S);
            fade.gain.setValueAtTime(1, at + length - CROSSFADE_S);
            fade.gain.linearRampToValueAtTime(0, at + length);
            source.start(at);
            source.stop(at + length);
            source.onended = () => {
                me._sources = me._sources.filter(s => s !== source);
            };
            me._sources.push(source);

            // The next copy is queued a second before it is due, from a timer
            // rather than from `onended`, which fires too late to overlap.
            me._loopTimer = setTimeout(() => schedule(at + step),
                Math.max(0, (at + step - ctx.currentTime - 1) * 1000));
        };

        schedule(ctx.currentTime + 0.05);
    }

    // ------------------------------------------------------------ announcer

    /** Prefers an Indonesian voice; the browser's default otherwise. */
    _pickVoice() {
        const voices = speechSynthesis.getVoices();

        this._voice = voices.find(v => v.lang === 'id-ID') ??
            voices.find(v => v.lang?.toLowerCase().startsWith('id')) ?? null;
    }

    /**
     * "Tiba di Stasiun Cilebut", after a chime.
     *
     * The type word is added unless the name already carries it — some stop
     * names in the feeds begin with "Stasiun" or "Halte", and "Tiba di Stasiun
     * Stasiun Bogor" is the kind of thing an announcer never says.
     */
    _announce(name, rail) {
        const me = this;

        if (!('speechSynthesis' in window)) {
            return;
        }
        const kind = rail ? 'Stasiun' : 'Halte',
            place = /^(stasiun|halte)\b/i.test(name) ? name : `${kind} ${name}`,
            utterance = new SpeechSynthesisUtterance(`Tiba di ${place}`);

        utterance.lang = 'id-ID';
        if (me._voice) {
            utterance.voice = me._voice;
        }
        utterance.rate = 0.95;
        utterance.onend = utterance.onerror = () => {
            me._speaking = false;
            me._setLevel();
        };

        // One announcement at a time: at a fast clock the next station can
        // arrive before the last name is finished, and two voices over each
        // other is worse than the newer one alone.
        speechSynthesis.cancel();
        me._speaking = true;
        me._setLevel();

        const delay = me._chime();

        setTimeout(() => {
            if (me.on) {
                speechSynthesis.speak(utterance);
            }
        }, delay);
    }

    /**
     * Two soft notes, falling — the shape of a station chime, made here rather
     * than copied from anyone's. Returns how long it lasts, in milliseconds.
     */
    _chime() {
        const me = this,
            ctx = me._ctx;

        if (!ctx) {
            return 0;
        }
        const start = ctx.currentTime + 0.02;

        [[784, 0], [587, 0.32]].forEach(([frequency, offset]) => {
            const tone = ctx.createOscillator(),
                level = ctx.createGain(),
                at = start + offset;

            tone.type = 'sine';
            tone.frequency.value = frequency;
            level.gain.setValueAtTime(0, at);
            level.gain.linearRampToValueAtTime(0.22, at + 0.02);
            level.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
            tone.connect(level);
            // Straight to the speakers, not through the cabin's level: the
            // chime is the cue, and it should not be ducked by the thing it is
            // announcing.
            level.connect(ctx.destination);
            tone.start(at);
            tone.stop(at + 0.95);
        });
        return 900;
    }

}
