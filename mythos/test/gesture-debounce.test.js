'use strict';
// test/gesture-debounce.test.js — pure node:test coverage for
// createGestureDebouncer(), the state machine that turns MediaPipe's per-frame
// top-1 result into discrete gesture presses for vision/camera.js.
//
// It was extracted out of camera.js (browser + webcam + WASM bundle at import
// time, so untestable in place) when Open_Palm became a mic toggle on
// 2026-08-10 and exposed the defect below.
//
// THE PROPERTY THIS FILE GUARDS: one pose is one press, however long it is
// held. The old code applied only a 2000ms per-gesture cooldown, so a hand left
// in frame re-fired the same gesture every ~2s forever. That was invisible while
// every action was idempotent (re-clicking an already-clicked confirm button)
// and became a real bug the moment a gesture toggled state: a palm held for six
// seconds muted, unmuted, then muted the microphone again.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const DEBOUNCE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'vision', 'gesture-debounce.js')
).href;

const TICK_MS = 150; // camera.js's DETECT_INTERVAL_MS
const T0 = 1_000_000;

// Feed a script of per-frame gesture names at camera.js's real tick rate and
// collect the presses that came out.
function replay(debouncer, frames, startAt) {
  const fired = [];
  let t = Number.isFinite(startAt) ? startAt : T0;
  for (const name of frames) {
    const out = debouncer.observe(name, t);
    if (out) fired.push({ name: out, at: t });
    t += TICK_MS;
  }
  return fired;
}

function repeat(name, n) { return new Array(n).fill(name); }

describe('createGestureDebouncer — hold before firing', () => {
  it('does not fire on a single frame (a misread must not act)', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    assert.deepEqual(replay(d, ['Open_Palm', null, 'Open_Palm', null]).map((f) => f.name), []);
  });

  it('fires once the pose has been held for holdTicks frames', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    assert.deepEqual(replay(d, repeat('Victory', 3)).map((f) => f.name), ['Victory']);
  });

  it("treats 'None' and a missing hand as no gesture, and resets the hold", async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    // Two frames of palm, interrupted, then two more: never three in a row.
    assert.deepEqual(
      replay(d, ['Open_Palm', 'Open_Palm', 'None', 'Open_Palm', null, 'Open_Palm', 'Open_Palm']).map((f) => f.name),
      [],
    );
  });
});

describe('createGestureDebouncer — release rule (the regression guard)', () => {
  it('a pose held for 6 seconds fires EXACTLY ONCE', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    // 40 frames x 150ms = 6s of unbroken Open_Palm. The old cooldown-only logic
    // produced three presses here (t=0, ~2s, ~4s).
    const fired = replay(d, repeat('Open_Palm', 40));
    assert.equal(fired.length, 1, `held pose fired ${fired.length} times, must be 1`);
    assert.equal(fired[0].name, 'Open_Palm');
  });

  it('fires again after the hand leaves the pose and makes it again', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    // Hold, drop the hand long enough to clear the anti-flicker cooldown, hold again.
    const frames = [...repeat('Open_Palm', 5), ...repeat(null, 15), ...repeat('Open_Palm', 5)];
    assert.deepEqual(replay(d, frames).map((f) => f.name), ['Open_Palm', 'Open_Palm']);
  });

  it('a DIFFERENT pose counts as a release, so gestures can be chained', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 0 });
    const frames = [...repeat('Open_Palm', 4), ...repeat('Pointing_Up', 4), ...repeat('Open_Palm', 4)];
    assert.deepEqual(
      replay(d, frames).map((f) => f.name),
      ['Open_Palm', 'Pointing_Up', 'Open_Palm'],
    );
  });

  it('the anti-flicker cooldown still blocks a pose that only briefly wobbles', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    // Fire, then one dropped frame (a misread, not a real release), then hold
    // again — inside 2000ms, so it is the same press, not a second one.
    const frames = [...repeat('Open_Palm', 3), null, ...repeat('Open_Palm', 4)];
    assert.deepEqual(replay(d, frames).map((f) => f.name), ['Open_Palm']);
  });
});

describe('createGestureDebouncer — reset()', () => {
  it('forgets the pose in progress but keeps the cooldown across a camera restart', async () => {
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const d = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });
    const first = replay(d, repeat('Open_Palm', 3), T0);
    assert.equal(first.length, 1);
    d.reset();
    // Immediately after a stop/start the cooldown must still apply — otherwise
    // toggling the camera is a way to bypass it.
    assert.deepEqual(replay(d, repeat('Open_Palm', 4), T0 + 500).map((f) => f.name), []);
    // ...and past the cooldown it works normally again.
    assert.deepEqual(replay(d, repeat('Open_Palm', 4), T0 + 5000).map((f) => f.name), ['Open_Palm']);
  });
});

describe('createGestureDebouncer — defaults', () => {
  it('defaults match camera.js (3 hold ticks, 2000ms cooldown)', async () => {
    const { createGestureDebouncer, DEFAULT_HOLD_TICKS, DEFAULT_COOLDOWN_MS } = await import(DEBOUNCE_URL);
    assert.equal(DEFAULT_HOLD_TICKS, 3);
    assert.equal(DEFAULT_COOLDOWN_MS, 2000);
    const d = createGestureDebouncer();
    assert.deepEqual(replay(d, repeat('Thumb_Up', 2)).map((f) => f.name), []);
    assert.deepEqual(replay(d, repeat('Thumb_Up', 3), T0).map((f) => f.name), ['Thumb_Up']);
  });
});
