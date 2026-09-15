import configs from '../configs';
import {routeColor} from '../kodefikasi';

/*
   Three framings, as a segmented control rather than a toggle.

   It was one button flipping between two states, which stops working the
   moment there are three — and three loose outline buttons would read as three
   unrelated actions. `.sorts` is the app's segmented control: one inset track
   with the current choice filled inside it, the same shape the reachability
   budgets and the basemap themes use.

   **Navigasi is the default.** Following a vehicle is a navigation task, and
   the bird's-eye framing was the thing this view kept being mistaken for; the
   old `chase` framing stays a click away for anyone who wants the map back.
*/
const CAMERAS = [
        {id: 'nav', label: 'Navigasi', hint: 'Pandangan mengemudi dari belakang kendaraan'},
        {id: 'chase', label: 'Peta', hint: 'Peta yang mengikuti kendaraan'},
        {id: 'onboard', label: 'Dari dalam', hint: 'Dari atap kendaraan'}
    ],
    DEFAULT_CAMERA = 'nav';

export {CAMERAS, DEFAULT_CAMERA};

/**
 * The controls for following a vehicle.
 *
 * Following is already a navigation view — the camera is locked to a moving
 * vehicle — but every control for it lived in the detail card at the side, so
 * driving along meant reading one corner and reaching to another. This is the
 * same shape as the ride HUD, minus the things that only a planned journey has:
 * there is no leg to skip and no itinerary to leave, so it carries the three
 * that do apply — where the camera sits, how fast time runs, and stopping.
 *
 * Speed offers `configs.speeds`, the same eleven the clock panel offers, rather
 * than the ride HUD's four. Two controls for one value that disagree about what
 * values exist is worse than either.
 *
 * Built once and only ever updated in place (trap 1): the readout changes every
 * frame, and rebuilding markup under the pointer means the browser never fires
 * `click` and the buttons silently die.
 */
export default class FollowHUD {

    constructor({clock, onStop, onCamera, onSpeed}) {
        const me = this;

        me.clock = clock;
        me.onStop = onStop;
        me.onCamera = onCamera;
        me.onSpeed = onSpeed;
        me.camera = DEFAULT_CAMERA;
        me.visible = false;
        me._key = null;
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'panel';
        el.id = 'follow-hud';
        el.innerHTML = `
            <div class="fh-id">
                <span class="fh-badge"></span>
                <div class="fh-text">
                    <div class="fh-headsign"></div>
                    <div class="fh-next"></div>
                </div>
            </div>
            <div class="fh-controls">
                <div class="sorts fh-cameras">
                    ${CAMERAS.map(c => `
                        <button class="btn btn-sm js-fh-camera${c.id === 'nav' ? ' on' : ''}"
                                type="button" data-camera="${c.id}"
                                title="${c.hint}">${c.label}</button>
                    `).join('')}
                </div>
                <div class="fh-speed">
                    <span>Kecepatan</span>
                    <input class="js-fh-speed" type="range" min="0"
                           max="${configs.speeds.length - 1}" step="1" value="0">
                    <output>1&times;</output>
                </div>
                <button class="btn btn-danger js-fh-stop" type="button">Berhenti</button>
            </div>
        `;
        document.body.appendChild(el);

        me._badge = el.querySelector('.fh-badge');
        me._headsign = el.querySelector('.fh-headsign');
        me._next = el.querySelector('.fh-next');
        me._cameraBtns = [...el.querySelectorAll('.js-fh-camera')];
        me._speed = el.querySelector('.js-fh-speed');
        me._speedOut = el.querySelector('output');

        el.addEventListener('click', event => {
            const camera = event.target.closest('.js-fh-camera');

            if (event.target.closest('.js-fh-stop')) {
                me.onStop();
            } else if (camera) {
                me.setCamera(camera.dataset.camera);
                me.onCamera(me.camera);
            }
        });

        me._speed.addEventListener('input', () => {
            const speed = configs.speeds[+me._speed.value];

            me._speedOut.innerHTML = `${speed}&times;`;
            me.onSpeed(speed);
        });
    }

    setCamera(mode) {
        const me = this;

        me.camera = mode;
        for (const button of me._cameraBtns) {
            button.classList.toggle('on', button.dataset.camera === mode);
        }
    }

    show(info) {
        const me = this,
            route = info.route,
            key = info.run;

        me.el.classList.add('open');
        me.visible = true;

        // The identity only changes when a different vehicle is followed.
        if (me._key !== key) {
            me._key = key;
            me._badge.textContent = route?.shortName || '—';
            me._badge.style.background = routeColor(route);
            me._headsign.textContent = info.trip?.headsign || route?.longName || '';
        }

        // Never write the slider while it is being dragged: assigning `value`
        // mid-gesture snaps the handle out from under the pointer.
        if (document.activeElement !== me._speed) {
            const index = configs.speeds.indexOf(me.clock.speed);

            if (index >= 0 && +me._speed.value !== index) {
                me._speed.value = String(index);
                me._speedOut.innerHTML = `${configs.speeds[index]}&times;`;
            }
        }

        // `standing` means it has pulled in and is at that stop rather than
        // bound for it, which is a different sentence.
        const stop = info.standing ? info.atStop : info.nextStop;

        me._next.textContent = stop
            ? `${info.standing ? 'Di' : 'Berikutnya'} · ${stop.name}` +
                ` · ${info.stopIndex + 1}/${info.stopCount}`
            : '';
    }

    /** Idempotent: this is called from the frame loop, so it must not write
        DOM sixty times a second while nothing is being followed. */
    hide() {
        const me = this;

        if (!me.visible) {
            return false;
        }
        me.visible = false;
        me.el.classList.remove('open');
        me._key = null;
        me.setCamera(DEFAULT_CAMERA);
        return true;
    }

}
