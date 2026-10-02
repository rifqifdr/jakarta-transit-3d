/**
 * Every panel state on a phone, measured rather than looked at (JAKAR-65).
 *
 * Walks the app at 390x844 through each thing a rider opens — the clock, the
 * layers, a search, a stop, reachability, a line, a vehicle, following it, the
 * credits, "sekitar sini" — with real clicks and a real long press (trap 2),
 * and at each one records:
 *
 *   type      every rendered font size, counted per text node
 *   small     text under 14px, by the element carrying it
 *   targets   controls whose hit area is under 44px either way, counting the
 *             `::after` extension `.btn-sm` uses to reach it
 *   overflow  anything past the screen's left or right edge
 *   clipped   text cut off by a box that hides its overflow
 *   wrapped   something meant to be one line that broke — a time, a button
 *   covered   a control whose centre is under something else (trap 13)
 *   unstyled  a class in the page that no stylesheet rule mentions. `.sorts`
 *             lost its rules with the journey planner while three segmented
 *             controls still used it, and nothing failed for three weeks —
 *             a class with no rule is not an error, only a drawing
 *
 *   node scratchpad/mobile-audit.mjs before      # screenshots under that label
 *   node scratchpad/mobile-audit.mjs after
 *   PROBE_URL=http://localhost:4173/ node ...     # against a build
 *
 * Needs `npm run dev` (or PROBE_URL). Screenshots land in
 * scratchpad/mobile-audit/<label>/, which is ignored.
 */
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const LABEL = process.argv[2] || 'run',
    DIR = join('scratchpad', 'mobile-audit', LABEL),
    WIDTH = Number(process.env.PROBE_WIDTH || 390),
    HEIGHT = Number(process.env.PROBE_HEIGHT || 844);

mkdirSync(DIR, {recursive: true});

// Installed into the page once. Kept as a string because it runs there, not
// here.
const INSTALL = `
window.__audit = label => {
    const vw = innerWidth,
        skip = el => el.closest('.mapboxgl-ctrl-attrib, .mapboxgl-ctrl-logo, style, script'),
        name = el => (el.className && typeof el.className === 'string' ?
            '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName.toLowerCase()),
        shown = el => {
            const r = el.getBoundingClientRect();

            if (r.width < 1 || r.height < 1) {
                return null;
            }
            const cs = getComputedStyle(el);

            return cs.visibility === 'hidden' || +cs.opacity === 0 ? null : r;
        },
        type = {},
        small = {},
        targets = new Set(),
        overflow = new Set(),
        clipped = new Set(),
        wrapped = new Set(),
        covered = new Set(),
        unstyled = new Set();

    // Every class any rule mentions, from every stylesheet the page can read.
    if (!window.__styled) {
        const styled = window.__styled = new Set(),
            walk = rules => {
                for (const rule of rules) {
                    if (rule.selectorText) {
                        for (const m of rule.selectorText.matchAll(/\\.([\\w-]+)/g)) {
                            styled.add(m[1]);
                        }
                    }
                    if (rule.cssRules) {
                        walk(rule.cssRules);
                    }
                }
            };

        for (const sheet of document.styleSheets) {
            try {
                walk(sheet.cssRules);
            } catch {
                // Cross-origin; not ours.
            }
        }
    }
    for (const el of document.querySelectorAll('body *')) {
        if (skip(el) || !shown(el) || el.closest('svg')) {
            continue;
        }
        for (const cls of el.classList) {
            if (!cls.startsWith('js-') && !cls.startsWith('mapboxgl-') && !window.__styled.has(cls)) {
                unstyled.add('.' + cls);
            }
        }
    }

    // Below the fold still counts: a panel scrolls, and what is down there is
    // read on a phone too. Folded and closed things have no box and drop out.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
        const node = walker.currentNode,
            el = node.parentElement;

        if (!node.textContent.trim() || !el || skip(el) || !shown(el)) {
            continue;
        }
        const size = Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10;

        type[size] = (type[size] || 0) + 1;
        if (size < 14) {
            const key = size + 'px ' + name(el);

            small[key] = (small[key] || 0) + 1;
        }
    }

    for (const el of document.querySelectorAll(
            'button, input, select, a[href], [role=button], .result, label.toggle, .cat, .mode-head')) {
        if (skip(el)) {
            continue;
        }
        const r = shown(el);

        // A visually hidden input inside a .toggle is reached through its
        // label, which is measured on its own.
        if (!r || (el.matches('input') && r.width <= 2)) {
            continue;
        }
        const after = getComputedStyle(el, '::after'),
            grow = v => Math.max(0, -(parseFloat(v) || 0));
        let w = r.width,
            h = r.height;

        if (after.content !== 'none' && after.position === 'absolute') {
            w += grow(after.left) + grow(after.right);
            h += grow(after.top) + grow(after.bottom);
        }
        // Present, visible and unreachable is trap 13's whole shape: ask what
        // a finger at the control's centre would actually land on.
        const cx = r.left + r.width / 2,
            cy = r.top + r.height / 2;

        // Three coverings are the design rather than the bug, and reporting
        // them buries the one that is: a modal's scrim covers everything; an
        // opened header panel lies over the map's own buttons and the credits
        // control, which sit just under the header on a phone; and a row
        // scrolled below its panel's fold "lands" on whatever is behind it.
        let scroller = el.parentElement;

        while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
            scroller = scroller.parentElement;
        }
        const port = scroller?.getBoundingClientRect(),
            scrolledOut = port && (cy < port.top || cy > port.bottom);

        if (!scrolledOut && cy > 0 && cy < innerHeight && cx > 0 && cx < vw) {
            const hit = document.elementFromPoint(cx, cy),
                expected = hit && (hit.closest('.credits-scrim') ||
                    (el.closest('.mapboxgl-ctrl') && hit.closest('#right-rail')));

            if (hit && !expected && !el.contains(hit) && !hit.contains(el) &&
                    !el.closest('label')?.contains(hit)) {
                covered.add(name(el) + ' under ' + name(hit));
            }
        }
        if (w < 44 || h < 44) {
            const text = (el.textContent || el.title || el.getAttribute('aria-label') || '')
                .trim().replace(/\\s+/g, ' ').slice(0, 18);

            targets.add(name(el) + (text ? ' "' + text + '"' : '') + ' ' +
                Math.round(w) + 'x' + Math.round(h));
        }
    }

    for (const el of document.querySelectorAll('body *')) {
        if (skip(el) || el.closest('.mapboxgl-canvas-container')) {
            continue;
        }
        const r = shown(el);

        if (!r) {
            continue;
        }
        // Mapbox tilts the compass needle with the map's pitch, and at
        // Navigasi's 78 degrees it is nearly edge-on: its box measures 122px
        // wide while painting about 30. Not something a rider sees.
        if ((r.right > vw + 0.5 || r.left < -0.5) &&
                !el.matches('.mapboxgl-ctrl-compass .mapboxgl-ctrl-icon')) {
            overflow.add(name(el) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
        }
        const cs = getComputedStyle(el);

        // Only where the box actually cuts its content off. Content that
        // spills past a box with visible overflow is not hidden — and an
        // absolutely positioned hit-area extension spills by design.
        // A 1px box is visually hidden on purpose — a label kept for screen
        // readers, like the phone's icon-only Suara — not text cut off.
        if (el.scrollWidth > el.clientWidth + 1 && r.width > 2 &&
                (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.textContent.trim()) {
            clipped.add(name(el) + ' "' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24) + '"');
        }
    }

    // One line means one line. Counted from the text's own line boxes, because
    // a wrapped label inside a 44px button does not make the button taller.
    for (const el of document.querySelectorAll('.t, .btn, .badge, output, .n, .near-wait, .fold-title, .map-style-name')) {
        if (skip(el) || !shown(el)) {
            continue;
        }
        const range = document.createRange();

        range.selectNodeContents(el);
        // A glyph and a word on one line do not share a top to the pixel, so
        // a second line is a jump of most of a line height, not any jump.
        // Only boxes tall enough to be text: the timelapse button carries a
        // 2px progress bar along its bottom edge, which is not a second line.
        const size0 = parseFloat(getComputedStyle(el).fontSize),
            tops = [...range.getClientRects()].filter(q => q.width > 1 && q.height > size0 * 0.6)
                .map(q => q.top),
            size = parseFloat(getComputedStyle(el).fontSize);

        if (tops.length && Math.max(...tops) - Math.min(...tops) > size * 0.8) {
            wrapped.add(name(el) + ' "' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24) + '"');
        }
    }

    return {label, type, small, targets: [...targets], overflow: [...overflow],
        clipped: [...clipped], wrapped: [...wrapped], covered: [...covered],
        unstyled: [...unstyled]};
};

// Scrolled into view first, as a thumb would: on a phone the action a card is
// for can sit below the card's own fold, and a click aimed at its centre
// then lands outside the viewport and does nothing at all.
window.__center = selector => {
    const el = document.querySelector(selector);

    if (!el) {
        return null;
    }
    el.scrollIntoView({block: 'nearest'});

    const r = el.getBoundingClientRect();

    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
};

window.__type = text => {
    const input = document.querySelector('#search input');

    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', {bubbles: true}));
};
return 'installed';
`;

const shot = name => ({_shot: join(DIR, `${name}.png`)}),
    audit = name => ({_eval: `return window.__audit(${JSON.stringify(name)});`}),
    click = selector => ({_eval: `const el = document.querySelector(${JSON.stringify(selector)}),
            below = el && el.getBoundingClientRect().top > innerHeight,
            c = window.__center(${JSON.stringify(selector)});
        return c ? [...(below ? [{belowFold: ${JSON.stringify(selector)}}] : []), {_click: c}] :
            {missing: ${JSON.stringify(selector)}};`}),
    state = (name, ...before) => [...before, {_wait: 1200}, shot(name), audit(name)];

const STEPS = [
    {_eval: INSTALL},
    {_wait: 1500},
    ...state('01-initial'),

    ...state('02-clock', click('#clock .clock-fold')),
    click('#clock .clock-fold'),

    ...state('03-layers', click('#layers .js-fold')),

    // The folded bar has to say a filter is on: hide Mikrotrans, fold, look,
    // then put it back.
    click('#layers .cat[data-cat="Mikrotrans"]'),
    click('#layers .js-fold'),
    ...state('03b-filtered', {_eval: `return {summary: document.querySelector('#layers .js-summary').textContent,
        expanded: document.querySelector('#layers .js-fold').getAttribute('aria-expanded')};`}),
    click('#layers .js-fold'),
    click('#layers .cat[data-cat="Mikrotrans"]'),
    click('#layers .js-fold'),

    // Lapisan peta, split out of Layanan: open, look, fold again.
    ...state('03c-map-layers', click('#map-layers .js-fold')),
    click('#map-layers .js-fold'),

    // Tampilan peta, the corner thumbnail: open the picker, look, close it.
    ...state('03d-map-style', click('.js-style-toggle')),
    click('.js-style-toggle'),

    ...state('04-search', {_eval: "window.__type('Blok M'); return 'typed';"}),

    ...state('05-stop', click('#search .result[data-kind="stop"]'), {_wait: 1800}),

    // The stop card's one filled action.
    ...state('06-reach', click('#detail .js-reach'), {_wait: 6500}),
    click('#detail .detail-close'),

    ...state('07-line', {_eval: "window.__type('Blok M - Kota'); return 'typed';"},
        {_wait: 600}, click('#search .result[data-kind="route"]'), {_wait: 2000}),
    click('#detail .detail-close'),
    {_eval: "window.__type(''); document.activeElement.blur(); return 'cleared';"},

    // A moving vehicle cannot be aimed at reliably on a software rasteriser,
    // so it is selected the way a click would select it, and everything after
    // that is clicked for real.
    ...state('08-vehicle', {_eval: `
        const app = window.__tj, f = app.fleet;
        for (let s = 0; s < f.activeCount; s++) {
            const run = f.active[s], trip = app.network.trips[f.runTrip[run]];
            if (app.network.routes.get(trip.route)?.shortName === '1' && !f.standing[s]) {
                app.selectedRun = run;
                return {selected: run};
            }
        }
        return {selected: null};`}, {_wait: 1500}),

    ...state('09-follow', click('#detail .js-track'), {_wait: 2500}),
    click('#follow-hud .btn-danger'),
    {_wait: 800},
    click('#detail .detail-close'),

    ...state('10-credits', click('.js-credits')),
    click('.credits-close'),

    // "Sekitar sini" is a press on a touch screen (JAKAR-66).
    ...state('11-nearby', {_press: [195, 560, 700]}, {_wait: 1200})
];

const probe = spawn('node', ['scratchpad/probe.mjs'], {
    env: {
        ...process.env,
        PROBE_WIDTH: String(WIDTH),
        PROBE_HEIGHT: String(HEIGHT),
        PROBE_JS: `return ${JSON.stringify(STEPS)};`
    },
    stdio: ['ignore', 'pipe', 'inherit']
});

let out = '';

probe.stdout.on('data', chunk => {
    out += chunk;
});
await new Promise(resolve => probe.on('close', resolve));

const {result, consoleErrors} = JSON.parse(out),
    audits = result.filter(r => r && r.label),
    misses = result.filter(r => r && r.missing),
    belowFold = result.filter(r => r && r.belowFold).map(r => r.belowFold),
    total = {};

writeFileSync(join(DIR, 'audit.json'),
    `${JSON.stringify({audits, misses, belowFold, consoleErrors}, null, 2)}\n`);

for (const a of audits) {
    for (const [size, n] of Object.entries(a.type)) {
        total[size] = (total[size] || 0) + n;
    }
    const sizes = Object.entries(a.type).sort((x, y) => x[0] - y[0])
        .map(([s, n]) => `${s}:${n}`).join(' ');

    console.log(`\n${a.label}   ${sizes}`);
    for (const t of a.targets) {
        console.log(`  target   ${t}`);
    }
    for (const o of a.overflow) {
        console.log(`  OVERFLOW ${o}`);
    }
    for (const c of a.clipped) {
        console.log(`  clipped  ${c}`);
    }
    for (const w of a.wrapped) {
        console.log(`  WRAPPED  ${w}`);
    }
    for (const c of a.covered) {
        console.log(`  COVERED  ${c}`);
    }
    if (a.unstyled.length) {
        console.log(`  unstyled ${a.unstyled.join(' ')}`);
    }
}

const all = Object.values(total).reduce((x, y) => x + y, 0),
    under14 = Object.entries(total).filter(([s]) => +s < 14).reduce((x, [, n]) => x + n, 0);

console.log(`\ntype, all states: ${Object.entries(total).sort((x, y) => x[0] - y[0])
    .map(([s, n]) => `${s}px ${n}`).join(' · ')}`);
console.log(`under 14px: ${under14} of ${all} text nodes (${Math.round(100 * under14 / all)}%)`);
for (const r of result.filter(x => x && x.summary)) {
    console.log(`Layanan header while filtered: "${r.summary}", aria-expanded=${r.expanded}`);
}
if (belowFold.length) {
    console.log('had to scroll to reach:', belowFold);
}
if (misses.length) {
    console.log('selectors not found:', misses.map(m => m.missing));
}
if (consoleErrors.length) {
    console.log('console errors:', consoleErrors);
}
console.log(`screenshots and audit.json in ${DIR}/`);
