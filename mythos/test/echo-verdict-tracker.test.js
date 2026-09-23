'use strict';
// BUG-428, 2026-09-10: a verdict proves a transcript exists even when its
// ratio is zero. No-verdict and accepted-transcript are different states.
// Mutations 2026-09-10: collapse transcriptSeen into ratio; remove reset.
// Both red; absolute-path file copy restored each, SHA256 matched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const url = name => pathToFileURL(path.join(__dirname, '../ui/public/js/voice', name)).href;

test('verdict matrix preserves unseen, accepted, and matched states across ceilings', async () => {
  const { createEchoVerdictTracker } = await import(url('echo-verdict.js'));
  const { createBargeInPolicy } = await import(url('barge-in-policy.js'));
  for (const reached of [false, true]) {
    for (const [verdict, ratio, seen, reason, release] of [
      [null, null, false, 'ceiling-no-evidence-of-echo', true],
      [{ ratio: 0.2, matched: false }, 0, true, 'ceiling-user-like', true],
      [{ ratio: 0.9, matched: true }, 0.9, true, 'ceiling-echo-like', false],
      [{ ratio: 0.9, matched: false }, 0, true, 'ceiling-user-like', true],
    ]) {
      const tracker = createEchoVerdictTracker();
      if (verdict) tracker.accept(verdict);
      assert.equal(tracker.echoRatio, ratio);
      assert.equal(tracker.transcriptSeen, seen);
      if (reached) assert.deepEqual(createBargeInPolicy().ceilingDecision({
        echoRatio: tracker.echoRatio, hasTranscript: tracker.transcriptSeen, peakRms: 0,
      }), { release, reason });
      tracker.reset();
      assert.equal(tracker.echoRatio, null);
      assert.equal(tracker.transcriptSeen, false);
    }
  }
});

test('unseen transcript retains the current high-energy branch; invalid wire data is ignored', async () => {
  const { createEchoVerdictTracker } = await import(url('echo-verdict.js'));
  const { createBargeInPolicy } = await import(url('barge-in-policy.js'));
  const tracker = createEchoVerdictTracker();
  for (const bad of [null, {}, { ratio: NaN, matched: true }, { ratio: 2, matched: true }, { ratio: 0.9, matched: 'true' }]) tracker.accept(bad);
  assert.equal(tracker.transcriptSeen, false);
  assert.deepEqual(createBargeInPolicy().ceilingDecision({ echoRatio: tracker.echoRatio,
    hasTranscript: tracker.transcriptSeen, peakRms: 0.2 }), { release: true, reason: 'ceiling-near-field-energy' });
});
