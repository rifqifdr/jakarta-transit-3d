# Third-party notices

The code in this repository is MIT (see `LICENSE`). What ships to a browser
also contains the components below, each under its own terms. This file exists
because MIT and Apache-2.0 both require their notice to travel with the copies
they cover, and a bundled `index-*.js` is a copy.

Nothing here is a dependency of the *data*; for the feeds, the cameras and the
OSM geometry see **Data sources and their terms** in `README.md`.

---

## Bundled into the browser build

### Mapbox GL JS 3.x — Mapbox Terms of Service (not open source)

Copyright © Mapbox, Inc. All rights reserved.

Licensed under the Mapbox TOS for use only with Mapbox products, and the
licence "terminates automatically if a developer no longer has a Mapbox account
in good standing". <https://www.mapbox.com/legal/tos/>

Two obligations follow and both are met: the deployed build carries its own
public access token tied to an active account, and the Mapbox wordmark and the
attribution control are shown and are never covered — which is why the phone
layout reserves a strip along the bottom that no panel may enter.

### three.js 0.185 — MIT

Copyright © 2010-2025 three.js authors. <https://github.com/mrdoob/three.js>

### hls.js 1.7 — Apache License 2.0

Copyright © Dailymotion. <https://github.com/video-dev/hls.js>

Loaded as a dynamic import, so it reaches only visitors who open the camera
layer. Apache-2.0 §4 requires this notice and the licence text to accompany
redistribution; the full text ships in `node_modules/hls.js/LICENSE` and is at
<https://www.apache.org/licenses/LICENSE-2.0>.

### Plus Jakarta Sans — SIL Open Font License 1.1

Copyright 2020 The Plus Jakarta Sans Project Authors.
<https://github.com/tokotype/PlusJakartaSans>

Self-hosted at `public/fonts/plus-jakarta-sans-var-latin.woff2`, which is
redistribution of the Font Software, so the licence travels beside it in
`public/fonts/OFL.txt`. The font is not sold, is not renamed, and the reserved
name is untouched.

Designed by Gumpita Rahayu for Tokotype, commissioned for the Jakarta
Provincial Government's *+Jakarta City of Collaboration* programme — which is
the reason it is the typeface here rather than a default.

---

## Build-time only, not redistributed

Vite (MIT) and Wrangler (MIT OR Apache-2.0) run the build and the deploy. No
part of either reaches a browser, so no notice is owed for them; they are
listed so the register is complete.
