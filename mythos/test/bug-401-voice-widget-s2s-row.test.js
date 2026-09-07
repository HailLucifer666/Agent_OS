'use strict';

// BUG-401 — the VOICE widget wrote the live-S2S result into the browser-TTS row.
//
// MEASURED, 2026-09-03. The operator's HUD screenshot at 03:00:54 showed:
//
//     browser tts   enabled
//     live s2s      checking…
//
// while the server log recorded a completed Gemini Live turn 14 seconds later
// (`live.turn-parts turnId:1 audioParts:27`) and a Live tool call. So S2S was
// demonstrably ON, `live s2s` claimed it was still being checked, and the value
// that belonged to it was displayed under `browser tts`.
//
// THE MECHANISM. `rows` is built in this order:
//   0 wakeword · 1 recognition (browser stt) · 2 synthesis (browser tts) · 3 s2s
// and the `/api/config/s2s` handler assigned `rows[2].value` in both its
// success and its failure path. `rows[3]` was therefore never written and kept
// its initial 'checking…' forever, and `browser tts` — a browser capability
// read from window.speechSynthesis — was overwritten with a server setting.
//
// TWO WRONG READINGS FROM ONE OFF-BY-ONE, which is why this is not cosmetic:
// an operator debugging voice sees "S2S: still checking" (it is running) and
// "browser TTS: enabled" (that is not what was measured). This is the BUG-175
// class inverted — false discouragement instead of false reassurance — in the
// file whose own header is about BUG-175.
//
// WHY THE FIX IS A KEY, NOT A CORRECTED INDEX. `rows[3]` would be right today
// and wrong the moment a row is inserted, and an index cannot be checked by
// reading it. `applyS2sResult` selects on `key === 's2s'` (derive the target
// from a property in the code, never from a position), and is pure and exported
// so node:test can drive it with no DOM — ui/public is a no-build ES-module
// tree with no jsdom in the repo (see ui/CLAUDE.md), so a DOM-mounted assertion
// is not available here.
//
// NOT A SOURCE-SHAPE TEST, DELIBERATELY. A grep for `rows[2]` would fail on the
// explanatory COMMENT the fix added, which still contains that string — the
// exact false-anchor failure this repo has already had (a guard matched its own
// comment). Behaviour, not text.
//
// Run: cd mythos && node --test test/bug-401-voice-widget-s2s-row.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let importSeq = 0;
function voiceModule() {
  const p = path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'voice.js')
    .replace(/\\/g, '/');
  importSeq += 1;
  return import('file:///' + p.replace(/^\/+/, '') + '?bug401=' + importSeq);
}

// The real row set, in the real order, with the real initial values — built
// from what mountVoice actually constructs rather than a shape convenient for
// the assertion. A fixture more generous than the wire hides the bug.
function realRows() {
  return [
    { key: 'wakeword', label: 'wake word', value: 'unavailable' },
    { key: 'recognition', label: 'browser stt', value: 'available' },
    { key: 'synthesis', label: 'browser tts', value: 'available' },
    { key: 's2s', label: 'live s2s', value: 'checking…' },
  ];
}
const byKey = (rows, key) => rows.find((r) => r.key === key);

describe('BUG-401 — the s2s result lands on the s2s row and nowhere else', () => {
  it('enabled:true writes the s2s row, and leaves browser tts untouched', async () => {
    const { applyS2sResult } = await voiceModule();
    const rows = realRows();
    applyS2sResult(rows, { enabled: true });
    assert.equal(byKey(rows, 's2s').value, 'enabled',
      'live s2s must report the setting — it stayed on its initial value, which is the bug');
    assert.equal(byKey(rows, 'synthesis').value, 'available',
      'browser tts is a BROWSER capability (window.speechSynthesis) and must not be '
      + 'overwritten with a server setting — this is the half that showed a wrong value '
      + 'under a correct label');
  });

  it('enabled:false writes disabled, still only on the s2s row', async () => {
    const { applyS2sResult } = await voiceModule();
    const rows = realRows();
    applyS2sResult(rows, { enabled: false });
    assert.equal(byKey(rows, 's2s').value, 'disabled');
    assert.equal(byKey(rows, 'synthesis').value, 'available');
  });

  it('an unreachable route reports unavailable, NOT disabled', async () => {
    // AD-5 honesty: we never learned the setting. Reporting "disabled" would be
    // a fact the server never sent. This is the .catch() path, and it had the
    // same off-by-one as the success path.
    const { applyS2sResult } = await voiceModule();
    const rows = realRows();
    applyS2sResult(rows, null);
    assert.equal(byKey(rows, 's2s').value, 'unavailable');
    assert.equal(byKey(rows, 'synthesis').value, 'available');
  });

  it('BOUND: no other row is touched, whatever the answer', async () => {
    // The true-positive tests above would all pass if the function wrote every
    // row. This is the false-positive half.
    const { applyS2sResult } = await voiceModule();
    for (const cfg of [{ enabled: true }, { enabled: false }, null]) {
      const rows = realRows();
      const before = realRows();
      applyS2sResult(rows, cfg);
      for (const key of ['wakeword', 'recognition', 'synthesis']) {
        assert.equal(byKey(rows, key).value, byKey(before, key).value,
          `${key} changed while applying the s2s result (cfg=${JSON.stringify(cfg)})`);
      }
    }
  });

  it('addresses by key, not position: a reordered row set still resolves', async () => {
    // Proves the fix is a derived selector rather than a corrected index. With
    // `rows[3]` this fails; with `key === 's2s'` it cannot.
    const { applyS2sResult } = await voiceModule();
    const rows = realRows().reverse();
    applyS2sResult(rows, { enabled: true });
    assert.equal(byKey(rows, 's2s').value, 'enabled');
    assert.equal(byKey(rows, 'synthesis').value, 'available');
  });

  it('a row set with no s2s row is a no-op, not a crash', async () => {
    const { applyS2sResult } = await voiceModule();
    const rows = realRows().filter((r) => r.key !== 's2s');
    assert.doesNotThrow(() => applyS2sResult(rows, { enabled: true }));
    assert.equal(byKey(rows, 'synthesis').value, 'available');
  });
});

// MUTATION PROOF, run 2026-09-03; mutation verified applied by re-reading the
// mutated line, file restored by full-path copy and the restore verified by
// re-running this file green.
//
//   (a) Reinstate the shipped bug — replace the body of applyS2sResult's
//       assignment with `rows[2].value = cfg && cfg.enabled ? 'enabled' :
//       'disabled'` -> reds "enabled:true writes the s2s row…" on BOTH of its
//       assertions (s2s still 'checking…', synthesis clobbered to 'enabled'),
//       plus the BOUND case and the reorder case. FIVE of six red — the
//       predicted count in an earlier draft of this note was four, and the
//       run is the record, not the prediction: the null branch reds too,
//       because rows[2] is written on that path as well.
//   (b) Change the null branch to write 'disabled' instead of UNAVAILABLE ->
//       reds only "an unreachable route reports unavailable, NOT disabled",
//       confirming that case watches its own statement.
//   (c) Change the selector from `r.key === 's2s'` to `rows[3]` -> the four
//       ordered cases stay GREEN and only "addresses by key, not position"
//       reds. That contrast is the point of that case: it is the one assertion
//       that can tell a corrected index from a derived selector.
