'use strict';

// BUG-020 — the VAD thresholds were hardcoded `const`, so the phantom-noise
// problem could not be tuned without editing source. The fix made the four
// `let` and had `createVoiceLoop` accept a `vad` option to override them.
//
// THAT CLAIM WAS UNTESTED until now. Measured 2026-08-28: six test files cover
// BUG-027's `assistantSpeaking` gate in the same module, and five mention the
// threshold names, but **no test drives the `vad` override at all** — grep for
// `vad: {` across `test/` returns nothing. So the ticket's entire deliverable,
// "these are tunable per instance", rested on reading the diff.
//
// WHY SOURCE-SHAPE, which this repo has good reason to distrust: `voice-loop.js`
// is a browser ES module that imports `./mic-device.js`, `./silero-vad.js` and
// friends and touches `navigator.mediaDevices` at call time. It cannot be
// `require`d under `node --test` — the same constraint recorded for `app.js` in
// BUG-346. `test/bug-270-clip-drop-observability.test.js` already reads this file
// as text for exactly that reason, and this follows it.
//
// WHAT THIS DOES NOT CLAIM. It does not verify that any particular threshold
// value stops phantom noise — that is TUNING against a specific microphone and
// room, which is an operator activity and not a verification gap. What it pins is
// that tuning is POSSIBLE without a source edit, which is what BUG-020 shipped.
//
// Run: cd mythos && node --test test/bug-020-vad-thresholds-are-overridable.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const VOICE_LOOP = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'voice-loop.js');
const SRC = fs.readFileSync(VOICE_LOOP, 'utf8');

// The four the ticket names, with the option key each is driven by.
const THRESHOLDS = [
  { name: 'SPEECH_RMS', option: 'speechRms' },
  { name: 'MIN_PEAK_RMS', option: 'minPeakRms' },
  { name: 'SPEECH_HOLD_TICKS', option: 'holdTicks' },
  { name: 'SILENCE_MS', option: 'silenceMs' },
];

describe('BUG-020 — the VAD thresholds can be tuned without editing source', () => {
  it('all four are declared `let`, never `const`', () => {
    for (const { name } of THRESHOLDS) {
      const declared = new RegExp('^\\s*let\\s+' + name + '\\s*=', 'm');
      const frozen = new RegExp('^\\s*const\\s+' + name + '\\s*=', 'm');
      assert.match(SRC, declared, `${name} must be \`let\` so the vad option can override it`);
      assert.doesNotMatch(SRC, frozen, `${name} is \`const\` again — BUG-020 regressed`);
    }
  });

  it('createVoiceLoop accepts a `vad` option', () => {
    // Destructured in the signature, not read off a wrapper object, because that
    // is the shape the HUD calls it with.
    const sig = SRC.match(/export\s+function\s+createVoiceLoop\s*\(\s*\{([^}]*)\}/);
    assert.ok(sig, 'createVoiceLoop must still destructure its options');
    assert.match(sig[1], /\bvad\b/, 'the `vad` option must be part of the signature');
  });

  it('each threshold is actually assigned from its option, guarded by a type check', () => {
    // The assignment is the deliverable. A `vad` option that is accepted and then
    // ignored is the inert-mechanism failure this repo keeps hitting, and it would
    // pass both assertions above.
    for (const { name, option } of THRESHOLDS) {
      const assigned = new RegExp(
        'typeof\\s+vad\\.' + option + "\\s*===\\s*'number'[\\s\\S]{0,80}?"
        + name + '\\s*=\\s*vad\\.' + option,
      );
      assert.match(SRC, assigned,
        `${name} must be assigned from vad.${option} behind a typeof check — `
        + 'without the check a missing option would overwrite the default with undefined');
    }
  });

  it('the override block is inside createVoiceLoop, not at module scope', () => {
    // At module scope it would run once per page load with no options and could
    // not be per-instance, which is the whole point of the ticket.
    const at = SRC.indexOf('export function createVoiceLoop(');
    assert.notEqual(at, -1);
    const guard = SRC.indexOf('if (vad) {');
    assert.notEqual(guard, -1, 'the `if (vad)` override block must exist');
    assert.ok(guard > at,
      'the override block must sit inside createVoiceLoop, after its declaration');
  });

  it('the defaults are still the tuned values the ticket settled on', () => {
    // Pinned as a DISPOSITION: these were raised deliberately (SPEECH_RMS 0.02 ->
    // 0.035, holdTicks 2 -> 3, MIN_PEAK_RMS 0.035 -> 0.06) because fans, AC and
    // passing bikes cleared the old floor. A silent revert to the old numbers
    // would reintroduce BUG-020 while every assertion above still passed.
    assert.match(SRC, /^\s*let\s+SPEECH_RMS\s*=\s*0\.035\b/m);
    assert.match(SRC, /^\s*let\s+MIN_PEAK_RMS\s*=\s*0\.06\b/m);
    assert.match(SRC, /^\s*let\s+SPEECH_HOLD_TICKS\s*=\s*3\b/m);
    assert.match(SRC, /^\s*let\s+SILENCE_MS\s*=\s*1800\b/m);
  });
});
