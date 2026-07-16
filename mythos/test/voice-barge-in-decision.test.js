'use strict';
// Item 8 (barge-in): pure node:test coverage for decideBargeIn(), extracted
// from ui/public/js/voice/voice-loop.js's assistantSpeaking VAD gate. This is
// the only practical unit-test surface for voice-loop.js (everything else in
// that file touches window/MediaRecorder/AudioContext). decideBargeIn has no
// DOM/window/audio dependency, so it's imported directly via dynamic import()
// (the file is authored as an ES module for the browser; Node's built-in
// ES-module-syntax detection lets a plain node:test file import it without
// any bundler or "type": "module" in package.json).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const VOICE_LOOP_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js')
).href;

// Mirrors the real defaults in voice-loop.js: SPEECH_RMS=0.035 * BARGE_IN_RMS_MULT=2.5,
// SPEECH_HOLD_TICKS=3 * BARGE_IN_HOLD_TICKS_MULT=2.
const THRESHOLDS = { bargeThreshold: 0.0875, bargeHoldTicks: 6 };

describe('decideBargeIn (Item 8 barge-in, pure VAD-level decision)', () => {
  it('below-threshold level while assistant speaking never triggers, and resets the counter', async () => {
    const { decideBargeIn } = await import(VOICE_LOOP_URL);
    const result = decideBargeIn({
      level: 0.05, // below THRESHOLDS.bargeThreshold (0.0875)
      assistantSpeaking: true,
      bargeAboveCount: 2,
      thresholds: THRESHOLDS,
    });
    assert.equal(result.shouldBargeIn, false);
    assert.equal(result.newBargeAboveCount, 0);
  });

  it('sustained loud level accumulates across ticks and triggers once the hold-ticks threshold is met', async () => {
    const { decideBargeIn } = await import(VOICE_LOOP_URL);
    let bargeAboveCount = 0;
    let lastResult;
    // Feed bargeHoldTicks (6) consecutive loud ticks — should NOT trigger before
    // the last one, and MUST trigger exactly on the tick that reaches the threshold.
    for (let i = 0; i < THRESHOLDS.bargeHoldTicks; i++) {
      lastResult = decideBargeIn({
        level: 0.2, // well above bargeThreshold
        assistantSpeaking: true,
        bargeAboveCount,
        thresholds: THRESHOLDS,
      });
      if (i < THRESHOLDS.bargeHoldTicks - 1) {
        assert.equal(lastResult.shouldBargeIn, false, `should not trigger on tick ${i + 1}`);
      }
      bargeAboveCount = lastResult.newBargeAboveCount;
    }
    assert.equal(lastResult.shouldBargeIn, true, 'should trigger on the tick that reaches bargeHoldTicks');
    assert.equal(lastResult.newBargeAboveCount, 0, 'counter resets once a barge-in fires');
  });

  it('a quiet tick in between resets the counter — loud runs do not accumulate across a dip', async () => {
    const { decideBargeIn } = await import(VOICE_LOOP_URL);
    let bargeAboveCount = 0;

    // Two loud ticks (not yet enough to trigger)...
    bargeAboveCount = decideBargeIn({
      level: 0.2, assistantSpeaking: true, bargeAboveCount, thresholds: THRESHOLDS,
    }).newBargeAboveCount;
    bargeAboveCount = decideBargeIn({
      level: 0.2, assistantSpeaking: true, bargeAboveCount, thresholds: THRESHOLDS,
    }).newBargeAboveCount;
    assert.equal(bargeAboveCount, 2);

    // ...then a quiet dip resets the count...
    const dip = decideBargeIn({
      level: 0.01, assistantSpeaking: true, bargeAboveCount, thresholds: THRESHOLDS,
    });
    assert.equal(dip.shouldBargeIn, false);
    assert.equal(dip.newBargeAboveCount, 0);
    bargeAboveCount = dip.newBargeAboveCount;

    // ...so a subsequent run of loud ticks must start over from zero: feeding only
    // (bargeHoldTicks - 1) more ticks after the dip must NOT trigger.
    let result;
    for (let i = 0; i < THRESHOLDS.bargeHoldTicks - 1; i++) {
      result = decideBargeIn({
        level: 0.2, assistantSpeaking: true, bargeAboveCount, thresholds: THRESHOLDS,
      });
      bargeAboveCount = result.newBargeAboveCount;
    }
    assert.equal(result.shouldBargeIn, false, 'the dip must have reset progress toward the hold-ticks threshold');
  });

  it('BUG-020 regression guard: assistantSpeaking:false is a complete pass-through no-op', async () => {
    const { decideBargeIn } = await import(VOICE_LOOP_URL);
    // Any level, any bargeAboveCount — normal (non-barge-in) VAD behavior must be
    // totally untouched: never triggers, and the counter passed in comes back unchanged.
    const cases = [
      { level: 0, bargeAboveCount: 0 },
      { level: 0.2, bargeAboveCount: 0 },
      { level: 0.2, bargeAboveCount: 5 },
      { level: 1, bargeAboveCount: 99 },
    ];
    for (const c of cases) {
      const result = decideBargeIn({
        level: c.level,
        assistantSpeaking: false,
        bargeAboveCount: c.bargeAboveCount,
        thresholds: THRESHOLDS,
      });
      assert.equal(result.shouldBargeIn, false);
      assert.equal(result.newBargeAboveCount, c.bargeAboveCount, 'must pass bargeAboveCount through unchanged');
    }
  });
});
