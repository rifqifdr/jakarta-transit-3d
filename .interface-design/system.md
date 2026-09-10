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

Colours come from `src/configs.js` `categories` — the real operator liveries —
not from a second palette invented for the UI.

| Token | Value | Means |
| --- | --- | --- |
| `--brand` | `#0d5eaf` | Transjakarta enamel blue. A **fill**, white type on it. |
| `--brand-lift` | `#56a8ee` | The readable tint — text, edges, focus rings. |
| `--live` | `#2fd07a` | The clock is on real time. Nothing else. |
| `--here` | `#f5c518` | You are here, now. Platform-edge yellow. Nothing else. |
| `--danger` | `#ff6a6a` | Hover-only warning on `.btn-danger`. |

Ink is four levels: `--text`, `--text-2`, `--text-3`, `--text-4`. Two is flat.
Surfaces are one hue, lightness only: `--bg` → `--panel` → `--raise`, with
`--sink` for inputs, which are inset because they receive content.

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
