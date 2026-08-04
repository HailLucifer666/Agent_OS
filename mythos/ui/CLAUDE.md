# mythos/ui/ — repo rules for AI sessions

Scope: the HUD (`mythos/ui/public/`). Root `CLAUDE.md` still applies here —
this file adds what's specific to the frontend.

## No build step

This is plain ES modules served directly — there is no bundler, no
transpile step, no `webpack`/`vite`/`rollup`/`esbuild` config anywhere in
this directory. `index.html` loads the entry point directly as
`<script type="module" src="/js/app.js">`. Every `import` you write is the
exact path the browser fetches at runtime — no path aliasing, no
bare-specifier resolution. If a new file needs to be reachable, it needs a
real, browser-resolvable relative or absolute-from-`/js` import path; there
is no build to catch a typo before it ships.

## Audio worklets

Mic/voice audio processing (`js/voice/*-worklet.js`, e.g.
`pcm-capture-worklet.js`, `wakeword-worklet.js`, `preroll-worklet.js`) runs
in `AudioWorkletGlobalScope`, not the main JS context — worklets are
registered via `audioCtx.audioWorklet.addModule('/js/voice/....js')` and
**cannot use `import`**. Because of that isolation, math shared between a
worklet and the main thread (e.g. the 48k→16k linear-interpolation resample
in `pcm-capture-worklet.js`) is deliberately **duplicated**, not imported,
into a plain module (`js/voice/pcm-resample.js`) that `node:test` can
exercise directly. If you change the resample math in one, mirror the change
in the other — there is no shared source of truth to keep them in sync
automatically.

## Canvas (the HUD neural map)

`js/neural-map/hud-canvas.js` is a plain 2D canvas — no WebGL, no
dependencies, capped particle counts (a visual richness pass, not a
simulation). Positions/data come from the pure `graph-model.js` /
`graph-layout.js` modules; `hud-canvas.js` owns only drawing + interaction.

Verifying canvas output without a visible browser pane is unreliable:
a hidden Browser/devtools pane can kill both compositing and
`requestAnimationFrame`, so a screenshot taken that way can show a stale or
blank frame even when the code is correct. Drive `frame()` by hand and
measure actual pixels (luminance, delta, RGB) instead of trusting a
screenshot taken with the pane hidden.
