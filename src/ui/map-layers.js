import {icon} from '../kodefikasi';
import {foldHead, setFolded} from './fold-head';

/*
   The map layers, as rows.

   Each carries an icon because a column of identical checkboxes gives a reader
   nothing to aim at — the eye lands on the icon and the label confirms it,
   which is how both reference apps build this list. `CCTV` and `Halte
   aksesibel` are named the way a rider would say them rather than the way the
   layer is implemented.
*/
const LAYER_TOGGLES = [
    {layer: 'routes', icon: 'jalur', label: 'Jalur rute', on: true},
    {layer: 'stops', icon: 'halte', label: 'Halte', on: true},
    {layer: 'buildings', icon: 'gedung', label: 'Gedung 3D', on: true},
    {layer: 'accessible', icon: 'aksesibel', label: 'Halte aksesibel'},
    {layer: 'headway', icon: 'frekuensi', label: 'Warnai per frekuensi', legend: true},
    {layer: 'trails', icon: 'jejak', label: 'Jejak kendaraan'},
    {layer: 'cameras', icon: 'cctv', label: 'CCTV', hint: 'Hanya tersedia dalam mode LIVE'}
];

/*
   Icon and label on the left, the switch on the right.

   A native checkbox sat between the icon and the words and made every row
   start with the same 18px square; moved to the trailing edge the switches
   line up in one column and the row reads left to right as a thing and then
   its state. The input is still there and still what the handler binds to —
   it is visually hidden, not replaced, so the label, the keyboard and the
   accessibility tree all keep working.
*/
function toggle({layer, icon: name, label, on}) {
    return `<label class="toggle">
        ${icon(name, 'toggle-icon')}
        <span class="toggle-label">${label}</span>
        <input type="checkbox" data-layer="${layer}"${on ? ' checked' : ''}>
        <span class="switch" aria-hidden="true"></span>
    </label>`;
}

/**
 * Lapisan peta: what the map draws on top of the city.
 *
 * Split out of Layanan, which had become three panels in one — the service
 * filters, the map style and these switches. A filter decides *which*
 * services; a layer decides *what is drawn*; one panel holding both made
 * neither easy to find. A legend sits under the row it explains, so the
 * frequency colours are read beside the switch that turned them on.
 */
export default class MapLayersPanel {

    constructor({onLayerToggle}) {
        const me = this;

        me.onLayerToggle = onLayerToggle;
        me._render();
    }

    _render() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'panel fold-panel';
        el.id = 'map-layers';
        el.innerHTML = `
            ${foldHead({id: 'map-layers', glyph: 'lapisan', title: 'Lapisan peta'})}
            <div class="fold-body" id="map-layers-body">
                ${LAYER_TOGGLES.map(t => toggle(t) +
                    (t.legend ? `<div class="layer-legend js-legend-${t.layer}"></div>` : '') +
                    (t.hint ? `<div class="row-hint js-hint-${t.layer}" hidden>${t.hint}</div>` : '')
                ).join('')}
            </div>
        `;
        document.body.appendChild(el);

        el.querySelector('.js-fold').addEventListener('click', () => me.toggle());
        for (const box of el.querySelectorAll('input[data-layer]')) {
            box.addEventListener('change', () => {
                me.onLayerToggle(box.dataset.layer, box.checked);
                me._summarise();
            });
        }
        me._summarise();
    }

    /** Shows the frequency legend under its switch, or clears it. */
    setMode(mode, bands) {
        const legend = this.el.querySelector('.js-legend-headway');

        legend.innerHTML = mode === 'headway' ? bands.map(b => `
            <div class="cat static">
                <span class="dot" style="background:${b.color}"></span>
                <span class="name">${b.label}</span>
            </div>
        `).join('') : '';
        return this;
    }

    /**
     * Whether the live camera layer can be switched on at all.
     *
     * A camera is showing the street *now*; the clock can be replaying a
     * Tuesday in March at 128x. There is no honest way to put those together,
     * so outside live mode the toggle is disabled rather than left to produce
     * a view that quietly means nothing. Mini Tokyo 3D's camera plugin makes
     * the same call — it declares `clockModes: ['realtime']` and switches
     * itself off otherwise.
     */
    setCamerasAvailable(available) {
        const me = this,
            box = me.el.querySelector('input[data-layer="cameras"]'),
            hint = me.el.querySelector('.js-hint-cameras');

        box.disabled = !available;
        box.closest('.toggle').classList.toggle('disabled', !available);
        hint.hidden = available;
        return me;
    }

    /** Reflects a layer toggle in the UI, without firing callbacks. */
    setLayerUI(layer, on) {
        const box = this.el.querySelector(`input[data-layer="${layer}"]`);

        if (box) {
            box.checked = on;
        }
        this._summarise();
        return this;
    }

    /** Folds the panel down to its header bar, or back open. */
    toggle(folded) {
        setFolded(this.el, folded);
        return this;
    }

    /** How many layers are on, so a folded bar still says something. */
    _summarise() {
        const on = this.el.querySelectorAll('input[data-layer]:checked').length;

        this.el.querySelector('.js-summary').textContent = `${on} aktif`;
    }

}
