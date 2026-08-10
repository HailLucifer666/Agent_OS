'use strict';
// test/gesture-mic-decision.test.js — pure node:test coverage for
// decideGestureMic(), the hand-gesture -> microphone decision behind
// ui/public/js/app.js's GESTURE_ACTIONS map.
//
// Same extraction pattern as test/voice-transport-decision.test.js: the DOM /
// MediaPipe / getUserMedia shell stays in app.js and vision/camera.js, the
// decision lives in a plain ES module Node can dynamic-import with no bundler
// and no jsdom.
//
// Two properties this file exists to guard:
//
//   1. Open_Palm is a TOGGLE, and Pointing_Up is unmute-only. Before
//      2026-08-10 the palm could only ever mute and no gesture could undo it —
//      the operator-reported bug ("for open palm it mutes, how to unmute?").
//   2. A hand HELD in frame changes the mic state exactly ONCE. camera.js
//      re-fires the same gesture every GESTURE_COOLDOWN_MS (2000ms) for as long
//      as the pose is visible, so without the refractory window a five-second
//      palm reads as mute -> unmute -> mute and leaves the mic live when the
//      operator asked for silence. That direction of failure is the reason the
//      window errs toward doing nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const GESTURE_MIC_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'vision', 'gesture-mic.js')
).href;
const DEBOUNCE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'vision', 'gesture-debounce.js')
).href;

// A time far past any refractory window, so cases that are not ABOUT the
// refractory window are not accidentally testing it.
const T0 = 1_000_000;

describe('decideGestureMic — Open_Palm toggles', () => {
  it('mutes when the batch loop holds the mic', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    assert.deepEqual(
      decideGestureMic({ gesture: 'Open_Palm', batchActive: true, s2sActive: false, now: T0, lastToggleAt: 0 }),
      { action: 'stop', reason: 'palm-mute' },
    );
  });

  it('mutes when the S2S bridge holds the mic (not just the batch loop)', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    assert.deepEqual(
      decideGestureMic({ gesture: 'Open_Palm', batchActive: false, s2sActive: true, now: T0, lastToggleAt: 0 }),
      { action: 'stop', reason: 'palm-mute' },
    );
  });

  it('UNMUTES when nothing holds the mic — the whole point of the change', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    assert.deepEqual(
      decideGestureMic({ gesture: 'Open_Palm', batchActive: false, s2sActive: false, now: T0, lastToggleAt: 0 }),
      { action: 'start', reason: 'palm-unmute' },
    );
  });

  it('fires on the first gesture of a session, when there is no previous toggle at all', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    // lastToggleAt absent entirely: must read as "long ago", never as "now".
    assert.equal(
      decideGestureMic({ gesture: 'Open_Palm', batchActive: true, now: T0 }).action,
      'stop',
    );
    // ...including when the clock itself is near zero.
    assert.equal(
      decideGestureMic({ gesture: 'Open_Palm', batchActive: true, now: 5 }).action,
      'stop',
    );
  });
});

describe('decideGestureMic — Pointing_Up only ever unmutes', () => {
  it('starts the mic when idle', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    assert.deepEqual(
      decideGestureMic({ gesture: 'Pointing_Up', batchActive: false, s2sActive: false, now: T0, lastToggleAt: 0 }),
      { action: 'start', reason: 'point-unmute' },
    );
  });

  it('is a NO-OP on a live session — the force-unmute gesture must never mute', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    assert.deepEqual(
      decideGestureMic({ gesture: 'Pointing_Up', batchActive: true, s2sActive: false, now: T0, lastToggleAt: 0 }),
      { action: 'none', reason: 'already-live' },
    );
    assert.deepEqual(
      decideGestureMic({ gesture: 'Pointing_Up', batchActive: false, s2sActive: true, now: T0, lastToggleAt: 0 }),
      { action: 'none', reason: 'already-live' },
    );
  });
});

describe('decideGestureMic — refractory window (cross-gesture guard)', () => {
  it('refuses a second mic action inside the window', async () => {
    const { decideGestureMic, GESTURE_MIC_REFRACTORY_MS } = await import(GESTURE_MIC_URL);
    // The case this exists for: a palm mutes, and a misread Pointing_Up
    // immediately re-opens the mic. Each gesture carries its own cooldown in
    // gesture-debounce.js, so only this window sees the pair.
    assert.deepEqual(
      decideGestureMic({
        gesture: 'Pointing_Up', batchActive: false, s2sActive: false,
        now: T0 + 200, lastToggleAt: T0,
      }),
      { action: 'none', reason: 'refractory' },
    );
    // Still refused right up to the boundary.
    assert.equal(
      decideGestureMic({
        gesture: 'Open_Palm', batchActive: false,
        now: T0 + GESTURE_MIC_REFRACTORY_MS - 1, lastToggleAt: T0,
      }).action,
      'none',
    );
  });

  it('allows a deliberate re-toggle once the window has passed', async () => {
    const { decideGestureMic, GESTURE_MIC_REFRACTORY_MS } = await import(GESTURE_MIC_URL);
    assert.deepEqual(
      decideGestureMic({
        gesture: 'Open_Palm', batchActive: false, s2sActive: false,
        now: T0 + GESTURE_MIC_REFRACTORY_MS, lastToggleAt: T0,
      }),
      { action: 'start', reason: 'palm-unmute' },
    );
  });

  it('a palm HELD in frame produces exactly one mic change, end to end', async () => {
    // The real defence is upstream, so exercise the two modules together the
    // way camera.js does: the debouncer decides IF a held pose is a new press,
    // decideGestureMic decides what that press means. A held palm must mute
    // once and stay muted — this is the case a refractory window alone could
    // not fix (a 4000ms window let the 4s re-fire through and re-opened the mic).
    const { createGestureDebouncer } = await import(DEBOUNCE_URL);
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    const debouncer = createGestureDebouncer({ holdTicks: 3, cooldownMs: 2000 });

    let micLive = true;
    let lastToggleAt = -Infinity;
    const changes = [];
    // 6 seconds of an unbroken Open_Palm at camera.js's 150ms tick.
    for (let i = 0; i < 40; i++) {
      const now = T0 + i * 150;
      const fired = debouncer.observe('Open_Palm', now);
      if (!fired) continue;
      const plan = decideGestureMic({ gesture: fired, batchActive: micLive, now, lastToggleAt });
      if (plan.action === 'none') continue;
      lastToggleAt = now;
      micLive = plan.action === 'start';
      changes.push(plan.action);
    }
    assert.deepEqual(changes, ['stop'], 'a sustained palm is ONE press, not a mute/unmute flip-flop');
    assert.equal(micLive, false, 'the mic must still be OFF after a six-second mute palm');
  });
});

describe('decideGestureMic — everything else is left alone', () => {
  it('ignores the confirm gestures and the vision gesture', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    for (const gesture of ['Thumb_Up', 'Closed_Fist', 'Victory', 'ILoveYou', 'Thumb_Down', 'None']) {
      assert.deepEqual(
        decideGestureMic({ gesture, batchActive: true, now: T0, lastToggleAt: 0 }),
        { action: 'none', reason: 'not-a-mic-gesture' },
        `${gesture} must not touch the mic`,
      );
    }
  });

  it('treats missing/garbage input as "do nothing", never as a mic action', async () => {
    const { decideGestureMic } = await import(GESTURE_MIC_URL);
    for (const state of [undefined, null, {}, { gesture: null }, { gesture: 'open_palm' }]) {
      assert.equal(decideGestureMic(state).action, 'none');
    }
  });
});
