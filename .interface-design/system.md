# Jakarta Transit 3D — interface system

Paper panels over a 3D map whose light follows the clock. Vanilla JS,
hand-written CSS in `src/css/style.css`.
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
| `--here-fill` | `#f5c518` | The platform-edge yellow itself: the tick on the current stop, and on a line tour the stretch to the next stop and the "here" mark. |
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
  **Tracked caps only means only**: eleven rules had drifted onto 11px for
  times, notes and sentence-case labels, departure times among them.
- **On a phone** (≤700px) the bottom four steps move up one — 12 / 14 / 15 /
  16, Material's own label and body sizes — and the top three stay. 16 is also
  where iOS stops zooming into an input. Measured, not eyeballed: 58% of the
  text on a 390px screen was under 14px; it is 12%, all of it tracked caps.
- **Space** — 4px grid, `--s1` 4 … `--s6` 24. No value off the grid.
- **Controls** — `--ctl-sm` 36, `--ctl` 40, `--ctl-lg` 48. 44px is the floor;
  a 36px control keeps its paint and extends its hit area with `::after`. On a
  phone `--ctl-sm` is 40 and `--ctl` 44, and every control a thumb needs
  reaches 44 in paint or in reach — the clock's fold, LIVE and play, both
  sliders (a 44px band round a 4px track), the card's close, *Sumber data*,
  Mapbox's own buttons, filter rows. The zoom buttons stay: they are the
  single-pointer alternative to a pinch.
- **Radius** — `--r-btn` 10, `--r-card` 14 (12 on `.itin`, kept concentric with
  the 16px panel padding), `--r-panel` 18.

## Components worth remembering

- `.btn` — 40px h · 0 16px pad · 10px radius · 14px/600 · neutral fill
- `.btn-accent` — same box, `--brand` fill, white ink. The one action a card is
  for. **One per card.**
- `.btn-lg` — 48px h · 0 20px pad · 12px radius · 15px. Primary actions.
- `.btn-sm` — 36px h · 0 12px pad · 8px radius · 13px, hit area extended
- `.sorts` — the segmented control: one inset `--sink` track, 4px padding, the
  choice filled inside it. The reach budget and the follow framings (*Navigasi*
  / *Dari dalam* — two, and still a segmented control, because a toggle names
  only one state). It lost its rules once with the journey planner while three
  controls still used it, and nothing failed — see `unstyled` in
  `scratchpad/mobile-audit.mjs`.
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
  real `<input>` is visually hidden inside it, never removed — so a toggle
  without its `.switch` shows no state at all, which is what *Hanya rute
  gratis* did until JAKAR-65.
- `.switch` — 38x22 pill, 18px knob, `--track` off and `--brand` on.
- `.step` — two rows: `.step-top` (mark, then time at 15px mono) over
  `.step-body`.
- **The card is a sheet** — `.detail-head`, then `.detail-body`, which
  scrolls, then `.detail-actions`, which holds the filled action and does not.
  The whole card used to scroll as one, and on a phone that put the action a
  card exists for below the fold of every card long enough to matter.
- `.fold-head` (`src/ui/fold-head.js`) — the header of both folding panels,
  Layanan and *Lapisan peta*: a `<button>` with `aria-expanded` — glyph, name
  at `--text-md`/600, a summary at the trailing edge (*249 rute*, *151 dari
  249 rute* when a filter is on, *3 aktif*), chevron. It spans the panel's
  padding, so folded it is the whole 48px bar. On a phone the two folded bars
  sit side by side and stack the summary under the name.
- `.map-style` — *Tampilan peta*, a Mapbox control in the bottom-left corner:
  a 64px thumbnail of the map as it is, labelled with its style, opening
  Warna / Pudar / Mono beside it, each a `.map-swatch` drawn in CSS (a sea, a
  park, two roads) in that style's colours. Closes on a choice, a press
  elsewhere or Escape, and gives focus back to the thumbnail.
- `.credit-strip` — one line in the bottom-right corner: Mapbox's attribution
  control, wrapped rather than rewritten, then `Sumber data` in weight 600.
  Pinned to the bottom strip on a phone, where Mapbox folds its part behind an
  `(i)`.
- `.credits-scrim` / `.credits` — the data-source panel, opened from
  `Sumber data`. Scrim closes, panel does not; Escape closes; the close control
  takes focus on open.
- `#detail.riding` — the vehicle card while it is being followed: only the
  progress bar and the run of stops (one behind, the current with its yellow
  tick, four ahead, with times). Every other kind of card clears the class,
  because `#detail` is one element reused for all of them.
- **A line tour as progress** — the toured line grey behind the camera,
  `--here-fill` to the next stop, the line's own colour ahead; stops grey once
  passed, the next one larger in yellow. `.tour-here` is the mark at the
  camera's point: `--here-fill` in a `--here` collar, pulsing, still under
  reduced motion.
- `.fh-sound` — *Suara* in the follow HUD: the speaker struck through until on,
  then filled like any toggle that is on. Icon-only on a phone, its name kept
  for a screen reader.
- `.btn-danger:hover` — `--danger` on a faint red wash, 4.8:1. It was the dark
  theme's pale pink on white (~1.6:1), and a phone keeps hover where the finger
  last was — which is where the tour's *Berhenti* appears.
- `.field` in `#search` — one search over stops and lines; the row's mark
  says which kind it is, so there are no tabs to choose first

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

For a measurement of every panel state at once:

```
node scratchpad/mobile-audit.mjs <label>    # needs npm run dev; 390×844
```

It records every rendered type size, controls under 44px, overflow, clipping,
anything meant to be one line that wrapped, controls whose centre is covered
(trap 13), and classes no stylesheet rule mentions. Screenshots land in
`scratchpad/mobile-audit/<label>/`, which is ignored.
