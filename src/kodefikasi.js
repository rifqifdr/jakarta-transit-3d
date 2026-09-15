import configs from './configs';

/**
 * Kodefikasi: Jakarta's own line codes, colours and mode glyphs.
 *
 * Source is the Pedoman Sistem Informasi Penunjuk Arah (Wayfinding) DKI
 * Jakarta, pages 29-30 — the Lampiran to Keputusan Gubernur No. 31 Tahun 2022,
 * drawn up by ITDP Indonesia and TfJ-FDTJ for Pemprov DKI. It is the standard
 * on the platform signage and on the integration map, so a rider who has stood
 * at Manggarai already knows this alphabet.
 *
 * On the licence, since it is the question that blocked this for a while: a
 * codification scheme is a *system*, which UU 28/2014 Pasal 41 huruf b puts
 * outside copyright altogether, and a letter in a coloured disc is below the
 * threshold of originality — Wikimedia Commons has already published the same
 * Jakarta line roundels as {{PD-text}}. What does carry copyright is the
 * guideline's own pictogram artwork, so the glyphs at the bottom of this file
 * are redrawn here rather than extracted from its PDF. The credit belongs in
 * the map's attribution line, and is there.
 *
 * The feed disagrees with the guideline about rail colours and the guideline
 * wins: KAI Commuter publishes its own liveries (Bogor #E30A16, Cikarang
 * #0084D8) which are the *operator's*, while these are the city's integrated
 * set. One network, one alphabet — that is the entire point of the pedoman.
 */

/**
 * Per line: the official code, the colour, and the name the pedoman uses.
 *
 * Keyed by route id because that is what survives a rebuild — shortName is the
 * feed's own label and is exactly what this table exists to replace.
 */
const LINES = {
    // KRL Commuter Line. "Lin Sentral" is the Bogor line; the guideline names
    // lines by role, the feed names them by destination.
    'krl-commuter-line-bogor': {code: 'C', color: '#ec2329', line: 'Lin Sentral'},
    'krl-commuter-line-cikarang': {code: 'B', color: '#26baed', line: 'Lin Cikarang'},
    'krl-commuter-line-rangkasbitung': {code: 'R', color: '#99ca3e', line: 'Lin Rangkasbitung'},
    'krl-commuter-line-tangerang': {code: 'T', color: '#c25f28', line: 'Lin Tangerang'},
    'krl-commuter-line-tanjungpriuk': {code: 'TP', color: '#ef509a', line: 'Lin Tanjung Priok'},

    'mrt-north-south': {code: 'M', color: '#ca2047', line: 'Lin Utara Selatan'},

    'lrtj-lin-selatan': {code: 'S', color: '#f26324', line: 'LRT Jakarta Lin 1'},
    'lrtjb-cibubur': {code: 'CB', color: '#21409a', line: 'Lin Cibubur'},
    'lrtjb-bekasi': {code: 'BK', color: '#006838', line: 'Lin Bekasi'}
};

const CATEGORY_COLOR = new Map(configs.categories.map(c => [c.id, c.color]));

/** The line's own entry, or undefined for anything the pedoman does not code. */
export function lineOf(route) {
    return route ? LINES[route.id] : undefined;
}

/**
 * What a badge says. The coded lines use their official letter; everything
 * else keeps the feed's own number, which for a bus corridor already is the
 * codification — "Koridor 1" is badged `1` on the street too.
 */
export function routeCode(route) {
    return lineOf(route)?.code || route?.shortName || '—';
}

/**
 * What a line is painted. Falls through category to the fleet's old behaviour,
 * so the legacy bus-only path — where no route is in the table — is unchanged.
 *
 * This is the one function the vehicles, the route lines and every badge agree
 * through, which is why it replaced a bare `CATEGORY_COLOR.get(category)`
 * lookup repeated at nine call sites.
 */
export function routeColor(route) {
    return lineOf(route)?.color ||
        CATEGORY_COLOR.get(route?.category) ||
        '#666';
}

/**
 * The pedoman's own name for the line, where it has one — "Lin Sentral" beside
 * a feed that says "COMMUTER LINE BOGOR". Null where it does not, so a caller
 * can leave the row alone rather than print an empty separator.
 */
export function lineName(route) {
    return lineOf(route)?.line || null;
}

/*
   Mode is the axis the glyph draws, and `mode` is absent on the legacy path,
   so bus is the fallback there exactly as it is for size and acceleration.
*/
const GLYPHS = {
    bus: 'bus',
    commuter_rail: 'krl',
    metro: 'mrt',
    light_rail: 'lrt'
};

const MODE_LABEL = new Map(configs.modeLabels.map(m => [m.id, m.label]));

export function modeGlyph(route) {
    return GLYPHS[route?.mode] || GLYPHS.bus;
}

export function modeLabel(route) {
    return MODE_LABEL.get(route?.mode) || 'Bus';
}

/** Route and stop names come from the feed, so they are escaped before markup. */
function escape(text) {
    return String(text ?? '').replace(/[&<>"]/g, c =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
}

/**
 * A route's mark: the mode glyph, then the code on the line's own colour.
 *
 * Two elements because they answer two questions — what kind of vehicle is
 * this, and which line — and the pedoman separates them the same way, a mode
 * pictogram heading a group of line roundels. The badge is a disc for a coded
 * line and a rounded plate for everything else, which is the guideline's own
 * distinction: a circle holds a one- or two-letter code, a plate holds
 * `JAK.106`.
 *
 * Built here rather than at each call site because there were eight copies of
 * `<span class="badge" style="background:…">`, and the six pill buttons that
 * became one `.btn` are what that drift looks like a year later.
 *
 * The colour goes out as `--mark`, and as `background` only on a plate.
 *
 * An inline `background` beats any class rule, so emitting it on a ring badge
 * is what silently filled every rail roundel solid and swallowed its letter —
 * `.badge-line { background: none }` never had a chance. `.badge` keeps taking
 * its fill inline rather than from the variable because it is shared with the
 * stop, camera and accessibility marks, which set their own and must not start
 * resolving something they never set.
 */
export function routeMark(route, {glyph = true} = {}) {
    const coded = lineOf(route),
        code = routeCode(route),
        color = routeColor(route),
        label = `${modeLabel(route)} ${code}`;

    return `<span class="route-mark" style="--mark:${color}" title="${escape(label)}">${
        glyph ? `<svg class="mode-glyph" aria-hidden="true"><use href="#kf-${
            modeGlyph(route)}"></use></svg>` : ''
    }<span class="badge${coded ? ' badge-line' : ''}"${
        coded ? '' : ` style="background:${color}"`}>${escape(code)}</span></span>`;
}

/**
 * One interface icon, by name. `aria-hidden`, because every caller here sets
 * its own text beside it.
 */
export function icon(name, className = 'ui-icon') {
    return `<svg class="${className}" aria-hidden="true"><use href="#kf-${name}"></use></svg>`;
}

/**
 * What a stop is: a roadside halte, or a station you walk into.
 *
 * The finder used to badge these `H` and `ST` on a grey plate, which is two
 * letters of jargon where a picture of the thing costs the same space.
 */
export function stopMark(stop) {
    return `<span class="stop-mark" title="${stop.station ? 'Stasiun' : 'Halte'}">${
        icon(stop.station ? 'stasiun' : 'halte', 'stop-glyph')}</span>`;
}

/**
 * The sprite: every symbol the interface draws, injected once.
 *
 * One sprite rather than one per concern — four mode glyphs and the interface
 * icons live together because there is one `installSprite()`, one place to
 * look, and a `<use>` pointing at a symbol that is not in the document renders
 * nothing at all, silently. Two sprites would be two chances to forget one.
 *
 * The mode glyphs: four modes, one `<symbol>` each.
 *
 * Redrawn for this project — front-on like the pedoman's pictograms, but our
 * own geometry. Each is a single evenodd path so the windows are holes in the
 * body rather than a second shape, which keeps a glyph one fill and lets it
 * take `currentColor` straight from the line's colour.
 *
 * They have to separate at 15px, which is the size a finder row draws them:
 * the bus is the wide one and the only one with no rail under it; KRL is
 * square-shouldered with a split windscreen; MRT is the tall round-topped one
 * with a single light bar; LRT is the squat one with its lights apart.
 *
 * No pantograph on any of them. The first draft gave one to LRT, which has it
 * exactly backwards — both Jakarta LRTs take 750 V from a third rail, and it
 * is KRL and MRT that run under wire. At 15px it would have been a 1px dash
 * saying something untrue.
 */
const SPRITE = `
<svg id="kf-sprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <symbol id="kf-bus" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M7.5 3h9A3.5 3.5 0 0 1 20 6.5v10a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16.5v-10A3.5 3.5 0 0 1 7.5 3ZM6.5 6.2h11v5.6h-11Zm.1 7.4h3v1.8h-3Zm7.8 0h3v1.8h-3ZM6.5 20.4h3v1.6h-3Zm8 0h3v1.6h-3Z"/>
  </symbol>
  <symbol id="kf-krl" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M7 3h10a2.5 2.5 0 0 1 2.5 2.5v12A2.5 2.5 0 0 1 17 20H7a2.5 2.5 0 0 1-2.5-2.5v-12A2.5 2.5 0 0 1 7 3Zm-.2 3.4h4.6V12H6.8Zm5.8 0h4.6V12h-4.6Zm-5.8 7.8h3v1.6h-3Zm7.4 0h3v1.6h-3ZM5.5 21h13v1.3h-13Z"/>
  </symbol>
  <symbol id="kf-mrt" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M12 3h2a5 5 0 0 1 5 5v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a5 5 0 0 1 5-5Zm-4.6 4.2h9.2v5.4H7.4Zm0 7.4h9.2v1.6H7.4ZM6 21h12v1.3H6Z"/>
  </symbol>
  <symbol id="kf-cari" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M10.6 2.4a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4Zm0 2.3a5.9 5.9 0 1 0 0 11.8 5.9 5.9 0 0 0 0-11.8Zm5.2 11.3 1.7-1.7 4.4 4.4-1.7 1.7Z"/>
  </symbol>
  <symbol id="kf-halte" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M6.5 2.6h11a2.4 2.4 0 0 1 2.4 2.4v5.2a2.4 2.4 0 0 1-2.4 2.4h-4.6V21H16v1.6H8V21h3.1v-8.4H6.5a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm.6 2.7h9.8v1.7H7.1Zm0 3.1h6.1v1.7H7.1Z"/>
  </symbol>
  <symbol id="kf-stasiun" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M12 2.2 22 7.3v1.9L12 4.1 2 9.2V7.3Zm-1.4 8.2h2.8a4.2 4.2 0 0 1 4.2 4.2v4.7a1.7 1.7 0 0 1-1.7 1.7H8.1a1.7 1.7 0 0 1-1.7-1.7v-4.7a4.2 4.2 0 0 1 4.2-4.2Zm-2.4 3.6h7.6v3.3H8.2Zm-2.3 8.5h12.4v1.3H5.9Z"/>
  </symbol>
  <symbol id="kf-cctv" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M18.6 3h3v1.7h-3Zm-.8 1.7h1.7v6.1h-1.7ZM4 7.4h12.5a2.3 2.3 0 0 1 2.3 2.3v2.6a2.3 2.3 0 0 1-2.3 2.3H4a2.3 2.3 0 0 1-2.3-2.3V9.7A2.3 2.3 0 0 1 4 7.4Zm3.4 1.6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm1.8 5.6h1.7v3.9h-1.7Zm-3.4 3.9h8.5v1.7H5.8Z"/>
  </symbol>
  <symbol id="kf-jalur" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M5.8 16.2a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Zm12.4-14a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8ZM7.4 15.1 16.6 6.6l1.6 1.7-9.2 8.5Z"/>
  </symbol>
  <symbol id="kf-gedung" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M2.8 9.6h6.6V21H2.8Zm1.8 2.6h2.8v2.2H4.6Zm0 3.8h2.8v2.2H4.6ZM11 4.2h10.2V21H11Zm1.9 2.8h2.5v2.3h-2.5Zm3.9 0h2.5v2.3h-2.5Zm-3.9 4h2.5v2.3h-2.5Zm3.9 0h2.5v2.3h-2.5Zm-3.9 4h2.5v2.3h-2.5Zm3.9 0h2.5v2.3h-2.5Z"/>
  </symbol>
  <symbol id="kf-aksesibel" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M15.4 1.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Zm-1.7 5.5h2.3v3.6h4.2v2.2h-4.2a2.3 2.3 0 0 1-2.3-2.3Zm-2.4 2.6v2.4a4.9 4.9 0 1 0 5 6.4l2.2.6a7.2 7.2 0 1 1-7.2-9.4Zm7.3 5.3h2.3l-1.4 5.5h-2.4Z"/>
  </symbol>
  <symbol id="kf-frekuensi" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M12 2.2a9.8 9.8 0 1 1 0 19.6 9.8 9.8 0 0 1 0-19.6Zm0 2.4a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8Zm-1 2.5h2v5.2h3.7v2H11Z"/>
  </symbol>
  <symbol id="kf-terakhir" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M12 2.4a9.6 9.6 0 1 1 0 19.2 9.6 9.6 0 0 1 0-19.2Zm0 2.3a7.3 7.3 0 1 0 0 14.6 7.3 7.3 0 0 0 0-14.6Z"/>
    <path fill="currentColor" d="M11 6.6h2v6l4 2.3-1 1.7-5-2.9Z"/>
  </symbol>
  <symbol id="kf-jejak" viewBox="0 0 24 24">
    <path fill="currentColor" d="M3 14.5h6.5v2H3Z"/>
    <path fill="currentColor" d="M5.5 10.5H13v2H5.5Z"/>
    <path fill="currentColor" d="M9 6.5h8.5v2H9Z"/>
    <path fill="currentColor" d="M14.5 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm.6 7.5h6.4v2h-6.4Z"/>
  </symbol>
  <symbol id="kf-lrt" viewBox="0 0 24 24">
    <path fill="currentColor" fill-rule="evenodd" d="M10 5h4a4.5 4.5 0 0 1 4.5 4.5V18a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V9.5A4.5 4.5 0 0 1 10 5Zm-2.3 4.2h8.6v4.4H7.7Zm0 6.1h3v1.5h-3Zm5.6 0h3v1.5h-3ZM5.5 21.2h13v1.3h-13Z"/>
  </symbol>
</svg>`;

/**
 * Puts the sprite in the document. Idempotent, because it is cheaper to answer
 * "already there?" than to make every caller remember whose job this was.
 */
export function installSprite() {
    if (document.getElementById('kf-sprite')) {
        return;
    }
    document.body.insertAdjacentHTML('afterbegin', SPRITE);
}

/**
 * The line colours as a Mapbox expression: coded lines by route id, everything
 * else by category, grey for anything in neither.
 *
 * A nested `match` rather than two paint properties, because the route-lines
 * layer can only hold one `line-color` and the two axes have to resolve in one
 * pass. Built here so the layer and the fleet cannot drift apart — they were
 * two copies of the same category list before.
 */
export function lineColorExpression() {
    const coded = Object.entries(LINES).flatMap(([id, line]) => [id, line.color]);

    return ['match', ['get', 'route'],
        ...coded,
        ['match', ['get', 'category'],
            ...configs.categories.flatMap(c => [c.id, c.color]),
            '#8a94a3']];
}

/**
 * Route id to packed hex, for the instanced mesh's colour buffer.
 *
 * Keyed by route rather than by category because a line now carries its own
 * colour — and it makes the per-instance lookup one map hit instead of two,
 * in a loop that runs six thousand times whenever the fleet regenerates.
 */
export function vehicleColors(routes) {
    const map = new Map();

    for (const route of routes.values()) {
        map.set(route.id, parseInt(routeColor(route).slice(1), 16));
    }
    return map;
}

export {CATEGORY_COLOR};
