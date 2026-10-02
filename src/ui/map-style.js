/**
 * Mapbox Standard's own themes. Three, not four — `custom` is in the schema but
 * needs a `theme-data` payload, which is a style-authoring feature rather than
 * something to put in front of a rider.
 *
 * This is a legibility control, not a performance one. `monochrome` was
 * measured as no help at all to a phone's frame times (JAKAR-60); what it does
 * is take the colour out of the city so six thousand vehicles have it to
 * themselves, which is the trade the README has described since the basemap
 * stopped being a private style.
 */
const THEMES = [
    {id: 'default', label: 'Warna', hint: 'Peta Mapbox Standard apa adanya'},
    {id: 'faded', label: 'Pudar', hint: 'Kota diredam, armada lebih menonjol'},
    {id: 'monochrome', label: 'Mono', hint: 'Kota tanpa warna — armada paling menonjol'}
];

/**
 * Tampilan peta: the map's style, in the map's own corner.
 *
 * It sat in Layanan between the service filters and the layer switches, a
 * third kind of thing in a panel about the network. Google Maps keeps its map
 * style in a thumbnail in the bottom-left corner of the map, and so does this:
 * the button shows what the map looks like now, and opens the three choices
 * beside it, each drawn as a small picture of itself rather than named alone.
 *
 * A Mapbox control, so it sits with the wordmark and moves with the map's own
 * corners on a phone, where the bottom of the screen belongs to the finder.
 */
export default class MapStyleControl {

    constructor({theme = 'default', onTheme}) {
        const me = this;

        me.theme = theme;
        me.onTheme = onTheme;
    }

    onAdd() {
        const me = this,
            el = me._el = document.createElement('div');

        el.className = 'mapboxgl-ctrl map-style';
        el.innerHTML = `
            <button class="map-style-toggle js-style-toggle" type="button"
                    aria-expanded="false" aria-controls="map-style-picker"
                    title="Tampilan peta">
                <span class="map-swatch js-current"></span>
                <span class="map-style-name js-current-name"></span>
            </button>
            <div class="map-style-picker panel" id="map-style-picker" role="group"
                 aria-label="Tampilan peta" hidden>
                ${THEMES.map(t => `
                    <button class="map-style-option js-theme" type="button"
                            data-theme="${t.id}" title="${t.hint}" aria-pressed="false">
                        <span class="map-swatch" data-theme="${t.id}"></span>
                        <span class="map-style-name">${t.label}</span>
                    </button>
                `).join('')}
            </div>
        `;

        me._toggle = el.querySelector('.js-style-toggle');
        me._picker = el.querySelector('.map-style-picker');

        me._toggle.addEventListener('click', () => me.open(me._picker.hidden));
        me._picker.addEventListener('click', event => {
            const option = event.target.closest('.js-theme');

            if (!option) {
                return;
            }
            if (option.dataset.theme !== me.theme) {
                me.theme = option.dataset.theme;
                me.onTheme?.(me.theme);
            }
            me._sync();
            me.open(false);
        });

        // A popover closes the way every popover does: a press anywhere else,
        // or Escape — after which focus goes back to the button that opened
        // it, so a keyboard is not left stranded on the map.
        me._outside = event => {
            if (!el.contains(event.target)) {
                me.open(false);
            }
        };
        me._escape = event => {
            if (event.key === 'Escape' && !me._picker.hidden) {
                me.open(false);
                me._toggle.focus();
            }
        };
        document.addEventListener('pointerdown', me._outside);
        document.addEventListener('keydown', me._escape);

        me._sync();
        return el;
    }

    onRemove() {
        document.removeEventListener('pointerdown', this._outside);
        document.removeEventListener('keydown', this._escape);
        this._el.remove();
    }

    open(open) {
        this._picker.hidden = !open;
        this._toggle.setAttribute('aria-expanded', String(open));
        return this;
    }

    /**
     * The button shows the map as it is, by picture and by name — as Google
     * Maps labels its own thumbnail with the map type rather than with what
     * the control is. "Tampilan" did not fit 64px at a phone's 14px anyway.
     * The picker marks which of the three that is.
     */
    _sync() {
        const me = this,
            current = THEMES.find(t => t.id === me.theme) ?? THEMES[0];

        me._el.querySelector('.js-current').dataset.theme = current.id;
        me._el.querySelector('.js-current-name').textContent = current.label;
        for (const option of me._el.querySelectorAll('.js-theme')) {
            option.setAttribute('aria-pressed', String(option.dataset.theme === me.theme));
        }
    }

}
