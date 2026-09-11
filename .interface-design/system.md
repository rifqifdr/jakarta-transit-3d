# Jakarta Transit 3D — interface system

Panels over a dark 3D map. Vanilla JS, hand-written CSS in `src/css/style.css`.
No framework, no utility classes.

## Direction and feel

Jakarta transit signage: confident, legible at arm's length, unfussy. Reference
points are Google Maps and Moovit — both large and generous, because both are
read one-handed on a street. Not "glass dashboard": the blur and the translucent
panel stay, but they are the ground, not the point.

The person is standing at a halte with a phone in one hand, or at a desk
exploring the network. The verb is *find out when the next thing leaves, and how
to get there*.

## Typeface

**Plus Jakarta Sans**, self-hosted at `public/fonts/plus-jakarta-sans-var-latin.woff2`
(27 KB, variable 200–800, latin only — Indonesian needs no more). It was
commissioned as the city's own typeface, which is the whole reason it is here.
`--mono` stays for times: departure boards are monospaced.

## Palette

Paper, not night. The panels were dark when the basemap was a private dark
style and the fleet was the only colour on it; the basemap is stock Standard in
full colour now, and the case to design for is a rider reading a halte card in
Jakarta daylight. One palette, at the token level — a dark theme would be a
second token block, not a second stylesheet.

Colours come from `src/configs.js` `categories` and from `src/kodefikasi.js`
— the real operator liveries and the city's own line colours — not from a
second palette invented for the UI.

| Token | Value | Means |
| --- | --- | --- |
| `--brand` | `#0d5eaf` | Transjakarta enamel blue. A **fill**, white type on it. |
| `--brand-lift` | `#0d5eaf` | The readable tint — text, edges, focus rings. On paper the enamel blue already is it. |
| `--live` | `#0f9d57` | The clock is on real time. Nothing else. |
| `--here` | `#b8860b` | You are here, now. The ink-dark collar. |
| `--here-fill` | `#f5c518` | The platform-edge yellow itself, for the tick. |
| `--danger` | `#c92a2a` | Hover-only warning on `.btn-danger`. |

Ink is four levels: `--text`, `--text-2`, `--text-3`, `--text-4`. Two is flat.
Surfaces are one hue, lightness only: `--bg` → `--panel` → `--raise`, with
`--sink` for inputs, which are inset because they receive content. Troughs — a
progress bar, a ride segment, a scrollbar — are `--track`, `--track-done` and
`--press`: ink at low alpha, where a dark panel used white.

## Scale

- **Type** — 15px base, ratio ~1.2: `--text-2xs` 11 (tracked caps only),
  `--text-xs` 13, `--text-sm` 14, `--text-md` 15, `--text-lg` 18, `--text-xl` 22,
  `--text-2xl` 28. Hierarchy from size **and** weight **and** ink level.
- **Space** — 4px grid, `--s1` 4 … `--s6` 24. No value off the grid.
- **Controls** — `--ctl-sm` 36, `--ctl` 40, `--ctl-lg` 48. 44px is the floor;
  a 36px control keeps its paint and extends its hit area with `::after`.
- **Radius** — `--r-btn` 10, `--r-card` 14 (12 on `.itin`, kept concentric with
  the 16px panel padding), `--r-panel` 18.

## Components worth remembering

- `.btn` — 40px h · 0 16px pad · 10px radius · 14px/600 · neutral fill
- `.btn-accent` — same box, `--brand` fill, white ink. The one action a card is
  for. **One per card.**
- `.btn-lg` — 48px h · 0 20px pad · 12px radius · 15px. Primary actions.
- `.btn-sm` — 36px h · 0 12px pad · 8px radius · 13px, hit area extended
- `.field` — 48px h, `--sink` fill, `--brand-lift` border + 3px tint ring on
  focus-within
- `.result` — 52px min, 15px/500. The most-tapped row in the app.
- `.badge` — 26px h · 38px min-w · 13px/800 tabular. The corridor number, set
  like the enamel plate it comes from.
- `.badge-line` — 26px disc, 2.5px collar, no fill. A coded rail line, as the
  pedoman draws it. Collar and letter both from `--mark`.
- `.route-mark` — the glyph and the badge as **one** inline-flex object with a
  6px gap of its own. Never space these from the parent's gap.
- `.mode-glyph` — 1.35em, one `<symbol>` per mode from the sprite in
  `src/kodefikasi.js`, coloured through `--mark`.
- `.stop-mark` — 38x26 well holding a halte or stasiun glyph. The finder's
  stop row.
- `.toggle` — 40px row: icon, label, then `.switch` at the trailing edge. The
  real `<input>` is visually hidden inside it, never removed.
- `.switch` — 38x22 pill, 18px knob, `--track` off and `--brand` on.
- `.step` — two rows: `.step-top` (mark, then time at 15px mono) over
  `.step-body`.
- `.sorts` — a segmented control: one inset track, the choice filled inside it
- `.finder-tab` — 48px h, 2px bottom border in `--brand-lift` when on

## Identity

The line's colour is carried by `.badge` and nothing else. A coloured stripe
down the card's leading edge was tried and removed — `#detail` is one element
reused for every kind of card, so a treatment there lands on all of them, and on
the route preview it fought the stop list beside it. One element per job.

The basemap theme is a user choice: Warna / Pudar / Mono → Standard's
`default` / `faded` / `monochrome`, in `localStorage`, applied before the layers
so `applyStopTheme` sees it.

## Depth and motion

One strategy: **borders plus surface-colour shift**. Shadows are for the panel
lifting off the map, nothing else — they do not read on dark. Borders live at
`rgba(255,255,255,.06–.18)` and should be findable, never the first thing seen.

Motion is 140ms on `cubic-bezier(0.23, 1, 0.32, 1)`, named properties only —
never `transition: all`, which animates layout and drops frames on a phone.
`scale(0.97)` on press. Everything degrades to colour-only under
`prefers-reduced-motion`.

## Verifying

`scratchpad/probe.mjs` drives real Chrome with real mouse events — `.click()`
passes on buttons a person cannot operate (trap 2). Always check both arms:

```
node scratchpad/probe.mjs                                  # 1440×900
PROBE_WIDTH=390 PROBE_HEIGHT=844 node scratchpad/probe.mjs # the one-column layout
```

A size change is a layout change on a phone, and the desktop arm will not show it.
