'use strict';

// Backlog M5, 2026-08-19, and the record of a fix that was WRONG and got backed
// out — which is most of the value in this file.
//
// The audit filed M5 as "three unreconciled RMS thresholds — collapse them into
// one source of truth". Collapsing them would be wrong, and BUG-274 (earlier the
// same day) is why: they answer different questions against different measured
// populations.
//
//   live-noise-gate.js  LIVE_NOISE_GATE_FLOOR_RMS      0.02   "worth transmitting to Gemini"
//   barge-in-policy.js  INITIAL_BLEED_FLOOR            0.035  "MYTHOS should stop talking"
//   here                BACKSTOP_RELEASE_RMS_THRESHOLD 0.05   "reopen the mic path"
//   here                BACKSTOP_RMS_THRESHOLD         0.056  "cut MYTHOS off mid-word"
//
// BUG-274 already reconciled the pair genuinely in conflict (0.05 -> 0.035, on a
// live measurement of both populations) and recorded why the noise gate's 0.02
// stays put. One constant per question is the design, not an oversight.
//
// WHAT WAS TRIED AND REVERTED. barge-in-backstop.js says "a release must never
// double as a flush", enforced nowhere, and s2s-bridge.js's bargeTuning() passes
// MYTHOS_BARGE_RMS / MYTHOS_BARGE_RELEASE_RMS through from localStorage with no
// ordering check. That looked like a gap, so a clamp was added: a release
// threshold at or above the flush threshold got pulled back under it. The stated
// justification was that observe()'s once-per-run latch depends on the release
// tier being the lower of the two.
//
// That justification was false, and a probe against this module refuted it before
// the change shipped. The latch clears on `lastLevel <= releaseRms` and fires on
// `lastLevel > releaseRms` — mutually exclusive on any one frame, whatever the
// FLUSH threshold is. And the clamp cost a real capability: MYTHOS_BARGE_RELEASE_RMS
// exists so an operator can walk the eager tier back, and setting it unreachable
// (0.9) is how you switch it off. The clamp rewrote that to ~0.02 and made it fire
// on nearly every frame.
//
// So the tests below pin the facts instead of a mechanism: the shipped defaults
// are ordered, an inverted override merely makes the release unreachable (harmless
// and intended), and onRelease is latched once per run regardless.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const BACKSTOP_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-backstop.js')
).href;

let createBargeInBackstop, BACKSTOP_RMS_THRESHOLD, BACKSTOP_RELEASE_RMS_THRESHOLD;
let BACKSTOP_HOLD_FRAMES, BACKSTOP_RELEASE_TO_FLUSH_RATIO;
before(async () => {
  ({
    createBargeInBackstop, BACKSTOP_RMS_THRESHOLD, BACKSTOP_RELEASE_RMS_THRESHOLD,
    BACKSTOP_HOLD_FRAMES, BACKSTOP_RELEASE_TO_FLUSH_RATIO,
  } = await import(BACKSTOP_URL));
});

// A 100ms 16kHz mono frame at a given amplitude, the shape
// pcm-capture-worklet.js emits. Same helper as s2s-barge-in-backstop.test.js.
function frame(amplitude) {
  const samples = new Int16Array(1600);
  const peak = Math.round(amplitude * 32768);
  for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? peak : -peak;
  return samples.buffer;
}

function observeRun(opts, amplitude, frames) {
  const releases = [];
  const flushes = [];
  const backstop = createBargeInBackstop(Object.assign({
    onRelease: (l) => releases.push(l),
    onFlush: (l) => flushes.push(l),
  }, opts));
  const f = frame(amplitude);
  for (let i = 0; i < frames; i++) backstop.observe(f, true);
  return { backstop, releases, flushes };
}

describe('M5 — the backstop tier constants', () => {
  it('ships with the release tier strictly below the flush tier', () => {
    // The one ordering claim that IS load-bearing: at the shipped values a run
    // loud enough to flush has already reopened the mic, so the operator's audio
    // is flowing to Gemini no later than the moment playback stops.
    assert.ok(BACKSTOP_RELEASE_RMS_THRESHOLD < BACKSTOP_RMS_THRESHOLD,
      'defaults must satisfy the invariant they document: '
      + BACKSTOP_RELEASE_RMS_THRESHOLD + ' < ' + BACKSTOP_RMS_THRESHOLD);
    assert.ok(BACKSTOP_RELEASE_TO_FLUSH_RATIO < 1,
      'the documented ratio must stay consistent with the two constants');
    assert.ok(Math.abs(BACKSTOP_RELEASE_TO_FLUSH_RATIO
      - (BACKSTOP_RELEASE_RMS_THRESHOLD / BACKSTOP_RMS_THRESHOLD)) < 1e-12);
  });

  it('reports the thresholds actually in force', () => {
    // Same reasoning as lastLevel(): after the 2026-08-14 session "the threshold
    // is too high" could only be INFERRED from the absence of flushes. Which
    // values a session ran with must be readable, not reconstructed from which
    // localStorage keys happened to be set.
    const { backstop } = observeRun({}, 0, 0);
    assert.deepEqual(backstop.thresholds(), {
      flushRms: BACKSTOP_RMS_THRESHOLD,
      flushHoldFrames: BACKSTOP_HOLD_FRAMES,
      releaseRms: BACKSTOP_RELEASE_RMS_THRESHOLD,
      releaseHoldFrames: 3,
    });

    const { backstop: tuned } = observeRun({ threshold: 0.2, releaseThreshold: 0.1 }, 0, 0);
    assert.equal(tuned.thresholds().flushRms, 0.2);
    assert.equal(tuned.thresholds().releaseRms, 0.1,
      'an override must be reported as applied, never silently adjusted');
  });
});

describe('M5 — an override is honoured exactly as given', () => {
  it('a release threshold set unreachably high switches the eager tier off', () => {
    // This is a supported operator action, not a misconfiguration to correct:
    // the tier comment names MYTHOS_BARGE_RELEASE_RMS as the way to walk eager
    // barge-in back for a room whose noise floor outruns it. The rejected clamp
    // would have turned this into a release on nearly every frame.
    const { releases, flushes, backstop } = observeRun(
      { threshold: 0.025, releaseThreshold: 0.9, holdFrames: 1, releaseHoldFrames: 1 },
      0.053, 6,
    );
    assert.equal(backstop.thresholds().releaseRms, 0.9, 'the value must survive untouched');
    assert.equal(releases.length, 0, 'the eager tier must be genuinely off');
    assert.ok(flushes.length > 0, 'while the flush tier still works');
  });

  it('an inverted ordering makes the release unreachable — it corrupts nothing', () => {
    // The concrete refutation of the reverted fix. Release above flush, level
    // above BOTH: if the latch depended on the tier ordering this is where it
    // would break.
    const above = observeRun({ threshold: 0.056, releaseThreshold: 0.10 }, 0.2, 12);
    assert.equal(above.releases.length, 1,
      'onRelease stays latched to once per run even with the tiers inverted');

    // And with the level between them, the release simply never fires.
    const between = observeRun({ threshold: 0.056, releaseThreshold: 0.10 }, 0.08, 12);
    assert.equal(between.releases.length, 0);
    assert.ok(between.flushes.length > 0, 'the flush tier is unaffected');
  });
});

describe('M5 — what each tier actually promises', () => {
  it('onRelease fires at most once per sustained run', () => {
    const { releases } = observeRun({}, 0.2, 12);
    assert.equal(releases.length, 1,
      'the eager tier reopens the mic path; firing repeatedly would re-trigger it '
      + 'mid-run for no reason');
  });

  it('onFlush RE-ARMS every holdFrames — it is not once per run', () => {
    // The module comment claimed "at most once per sustained-loud run" and was
    // wrong: decideBargeIn() returns newBargeAboveCount:0 when it fires, so the
    // counter restarts. Measured, not assumed. Pinned here because a false
    // contract in a comment is what the next change gets built on.
    const { flushes } = observeRun({}, 0.2, 12);
    assert.equal(flushes.length, Math.floor(12 / BACKSTOP_HOLD_FRAMES),
      'expected one flush per ' + BACKSTOP_HOLD_FRAMES + ' loud frames, got ' + flushes.length);
    assert.ok(flushes.length > 1,
      'this is the assertion the old comment would have failed');
  });

  it('a quiet frame ends the run and re-arms the eager tier', () => {
    const releases = [];
    const backstop = createBargeInBackstop({ onFlush() {}, onRelease: (l) => releases.push(l) });
    const loud = frame(0.2);
    const quiet = frame(BACKSTOP_RELEASE_RMS_THRESHOLD / 2);

    for (let i = 0; i < 6; i++) backstop.observe(loud, true);
    assert.equal(releases.length, 1);
    backstop.observe(quiet, true);      // the run ends here
    for (let i = 0; i < 6; i++) backstop.observe(loud, true);
    assert.equal(releases.length, 2, 'a genuinely new run gets its own release');
  });
});
