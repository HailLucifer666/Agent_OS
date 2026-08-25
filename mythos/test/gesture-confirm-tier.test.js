'use strict';
// test/gesture-confirm-tier.test.js — the tier ceiling on gesture-driven leash
// approvals (operator decision, 2026-08-12).
//
// Before this, app.js's Thumb_Up handler called .confirm-accept.click() for ANY
// pending confirm. Confirms exist only at tier >= 3 (AUTONOMOUS_MAX_TIER
// defaults to 2, so T0-T2 auto-allow and never render a modal), which means the
// ONLY thing a thumbs-up could ever approve was a tier 3 or 4 action — sending,
// deleting, running a command. The gesture pipeline's existing guards are
// anti-flicker, not anti-false-positive: score >= 0.6, three consecutive ~150ms
// detections, one-pose-one-press (vision/gesture-debounce.js). A sustained
// misread still approved. Audit attribution (surface: 'gesture') records which
// surface approved; it does not prevent the approval.
//
// Same extraction pattern as gesture-mic-decision.test.js: the decision lives
// in a plain ES module Node dynamic-imports, the DOM shell stays in app.js. The
// source-shape assertions at the bottom are the only automated guard that the
// shell actually consults the decision — the same reasoning as
// test/electron-cursor-overlay.test.js, where green unit tests coexisted with a
// feature that did not work at all.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const UI_JS = path.join(__dirname, '..', 'ui', 'public', 'js');
const MODULE_URL = pathToFileURL(path.join(UI_JS, 'vision', 'gesture-confirm.js')).href;

let canGestureAccept;
let MAX_GESTURE_ACCEPT_TIER;

before(async () => {
  const mod = await import(MODULE_URL);
  canGestureAccept = mod.canGestureAccept;
  MAX_GESTURE_ACCEPT_TIER = mod.MAX_GESTURE_ACCEPT_TIER;
});

describe('canGestureAccept — the tier ceiling', () => {
  it('allows the low tiers', () => {
    assert.equal(canGestureAccept(0), true);
    assert.equal(canGestureAccept(1), true);
    assert.equal(canGestureAccept(2), true);
  });

  it('refuses tier 3 and 4 — the destructive tiers a confirm actually gates', () => {
    assert.equal(canGestureAccept(3), false);
    assert.equal(canGestureAccept(4), false);
  });

  it('accepts the string form, because it arrives from a dataset attribute', () => {
    // b.dataset.mythosTier is always a string — a numeric-only check would
    // refuse every real call and silently disable the gesture entirely.
    assert.equal(canGestureAccept('2'), true);
    assert.equal(canGestureAccept('3'), false);
  });

  it('fails closed on an absent or unparseable tier', () => {
    // The modal renders 'TIER ?' in exactly this case, so it is a real state.
    for (const bad of [undefined, null, '', ' ', 'high', NaN, {}, [], Infinity, -Infinity]) {
      assert.equal(canGestureAccept(bad), false, `must refuse ${JSON.stringify(String(bad))}`);
    }
  });

  it('the ceiling is 2 — matching AUTONOMOUS_MAX_TIER, not an independent number', () => {
    assert.equal(MAX_GESTURE_ACCEPT_TIER, 2);
  });
});

describe('the DOM shell consults the decision (source shape — no jsdom available)', () => {
  it('app.js imports canGestureAccept and gates Thumb_Up on it', () => {
    const src = fs.readFileSync(path.join(UI_JS, 'app.js'), 'utf8');
    assert.match(src, /import \{ canGestureAccept \} from '\.\/vision\/gesture-confirm\.js'/);
    const handler = src.slice(src.indexOf('Thumb_Up:'), src.indexOf('Closed_Fist:'));
    assert.match(handler, /canGestureAccept\(/, 'Thumb_Up must consult the ceiling');
    // Order matters: a refusal must not leave data-mythos-surface='gesture' on
    // the button for a later real human click to inherit as a gesture accept.
    assert.ok(
      handler.indexOf('canGestureAccept(') < handler.indexOf('mythosSurface'),
      'the ceiling must be checked BEFORE the surface tag is written',
    );
    assert.ok(
      handler.indexOf('canGestureAccept(') < handler.indexOf('.click()'),
      'the ceiling must be checked BEFORE the click is dispatched',
    );
  });

  it('confirm-modal.js publishes the tier on the Approve button', () => {
    const src = fs.readFileSync(path.join(UI_JS, 'confirm', 'confirm-modal.js'), 'utf8');
    assert.match(src, /dataset\.mythosTier = String\(payload\.tier\)/);
    // Guarded, so an absent tier stays absent rather than becoming the string
    // 'undefined' — which Number() turns into NaN, which fails closed anyway,
    // but only by accident. Keep it honest at the source.
    assert.match(src, /payload\.tier !== undefined && payload\.tier !== null/);
  });
});
