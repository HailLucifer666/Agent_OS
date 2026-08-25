'use strict';

// test/hud-fx-buffers-bounded.test.js — every HUD effect buffer is capped where
// it is FILLED, not where it is drained.
//
// The HUD's FX arrays are drained inside frame(), and frame() stops being
// scheduled the moment document.hidden goes true (hud-canvas.js's
// visibilitychange handler cancels the rAF). The WS subscription does not stop:
// a 'tick' arrives every second and a 'perception' whenever one happens. So any
// buffer whose only bound lives in the draw loop grows without limit for as long
// as the tab stays in the background — which is the normal state of a HUD.
//
// bursts (hud-canvas.js) and sparks (core-orb.js) were already capped at push
// time. ripples was not: it was the one FX array with no guard anywhere except
// the alpha-decay splice inside frame().
//
// CEILING, stated plainly: this is a source-shape guard, in the same spirit as
// ui-wiring-smoke.test.js's declared ceilings. These modules need a real canvas
// and a real rAF, so node cannot execute them; what is asserted is that the cap
// exists at the push site and that no path bypasses the helper that owns it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NEURAL_MAP = path.join(__dirname, '..', 'ui', 'public', 'js', 'neural-map');

function read(file) {
  return fs.readFileSync(path.join(NEURAL_MAP, file), 'utf8');
}

test('hud-canvas ripples are capped at the push site, not only in the draw loop', () => {
  const src = read('hud-canvas.js');

  assert.match(src, /function spawnRipple\(alpha\) \{/,
    'ripples must be pushed through one helper that owns the cap');
  assert.match(src, /if \(ripples\.length > MAX_RIPPLES\) ripples\.shift\(\);/,
    'the helper must enforce the cap immediately after pushing');

  // No caller may bypass the helper. The only legitimate `ripples.push` is the
  // one inside spawnRipple itself.
  const pushes = src.split(/\r?\n/).filter((l) => /ripples\.push\(/.test(l));
  assert.equal(pushes.length, 1,
    'exactly one ripples.push should exist (inside spawnRipple); found:\n' + pushes.join('\n'));

  // And the drain must still be there — a cap is not a substitute for the
  // alpha-decay splice that actually retires finished ripples.
  assert.match(src, /if \(r\.alpha <= 0\) \{ ripples\.splice\(i, 1\); continue; \}/,
    'the draw loop must still retire finished ripples');
});

test('the sibling FX buffers that were already bounded still are', () => {
  // Regression cover for the two guards that made ripples look like an
  // oversight rather than a design choice. If one of these is ever removed, the
  // same background-tab leak returns in a different array.
  assert.match(read('hud-canvas.js'), /if \(bursts\.length > 80\) bursts\.shift\(\);/,
    'hud-canvas bursts must stay capped at push time');
  assert.match(read('core-orb.js'), /sparks\.(?:shift|splice)\(/,
    'core-orb sparks must stay bounded');
});

test('the draw loop really is the only drain, so the push-time cap is load-bearing', () => {
  // If a second drain ever appears outside frame() this test should be
  // revisited rather than silently kept — the reasoning above depends on there
  // being exactly one, and on it living inside the rAF loop.
  const src = read('hud-canvas.js');
  const drains = src.split(/\r?\n/).filter((l) => /ripples\.(splice|shift|length\s*=)/.test(l));
  assert.equal(drains.length, 2,
    'expected exactly two: the cap shift in spawnRipple and the decay splice in frame(); found:\n'
    + drains.join('\n'));
  assert.match(src, /if \(document\.hidden\) \{ if \(raf\) \{ cancelAnimationFrame\(raf\); raf = null; \} \}/,
    'the hidden-tab rAF cancellation is the reason a draw-loop-only bound is not a bound');
});
