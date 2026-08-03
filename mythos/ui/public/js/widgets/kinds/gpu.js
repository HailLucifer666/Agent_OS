// gpu.js — the GPU the browser is actually rendering on, via the
// WEBGL_debug_renderer_info extension.
//
// SCOPE, deliberately narrow: this reports the renderer and vendor STRINGS and
// nothing else. design/mythos-living-core.html's "GPU" panel also showed a
// utilization percentage and a draw-call count — both invented (its draw-call
// figure is a formula over the open-widget count). No browser API exposes GPU
// utilization, and MYTHOS has no server-side GPU source either, so those two
// rows are dropped rather than faked.
//
// The extension is privacy-gated: Firefox hides it behind a pref, and Chromium
// can withhold it under a permissions policy. Absent -> "unavailable". We do
// not fall back to the unmasked-off VENDOR/RENDERER strings ("WebKit
// WebGL" / "ANGLE"), because those name the abstraction layer rather than the
// hardware and would read as a real answer while telling you nothing.
//
// The context created here is a throwaway used for exactly one query and then
// released via WEBGL_lose_context — the HUD's own canvases (hud-canvas.js,
// core-orb.js) are both 2D, so there is no existing WebGL context to borrow,
// and holding a second live one for the lifetime of the widget would cost a
// real GPU allocation for no reason.

import { h } from '../../dom.js';

const UNAVAILABLE = 'unavailable';

// Pure: given a gl context (or null) return {renderer, vendor}. Exported so the
// no-context and no-extension branches are node-testable with a stub.
export function readRenderer(gl) {
  if (!gl || typeof gl.getExtension !== 'function') {
    return { renderer: UNAVAILABLE, vendor: UNAVAILABLE, reason: 'no webgl context' };
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (!dbg) {
    return { renderer: UNAVAILABLE, vendor: UNAVAILABLE, reason: 'renderer info withheld by browser' };
  }
  const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  const vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
  return {
    renderer: renderer || UNAVAILABLE,
    vendor: vendor || UNAVAILABLE,
    reason: null,
  };
}

function probe() {
  let canvas = null;
  let gl = null;
  try {
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return readRenderer(gl);
  } catch {
    return { renderer: UNAVAILABLE, vendor: UNAVAILABLE, reason: 'webgl unavailable' };
  } finally {
    try {
      const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch { /* releasing a throwaway context must never break the widget */ }
  }
}

export function mountGpu(el, ctx) {
  const info = probe();
  const known = info.renderer !== UNAVAILABLE;

  el.replaceChildren(
    h('div', {
      class: known ? 'widget-value-text mono' : 'widget-value-text mono text-faint',
      title: known ? info.renderer : '',
    }, info.renderer),
    h('div', { class: 'widget-sub mono' }, known ? info.vendor : (info.reason || UNAVAILABLE)),
  );

  // One-shot read: the GPU does not change under a running page. Nothing to
  // poll, nothing to subscribe to, nothing to tear down.
  return undefined;
}
