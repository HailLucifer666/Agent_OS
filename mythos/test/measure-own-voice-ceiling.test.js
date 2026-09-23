'use strict';
// BUG-428, 2026-09-10: synthetic measurement guard before real-log replay.
// Mutation 2026-09-10: collapse reason grouping -> red. Restored by absolute
// file copy; SHA256 matched. This check cannot label microphone audio.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measure } = require('../scripts/measure-own-voice-ceiling');

test('group releases and correlate unique anomalies at the inclusive ±2s boundary', () => {
  const release = (ts, reason, heldMs, framesZeroed) => ({ ts, msg: 'voice.capture-suspend', ownVoiceGate: false, reason, heldMs, framesZeroed });
  const anomaly = (ts, eventId, outcome = 'anomaly') => ({ ts, kind: 'anomaly', outcome, detail: { kind: 'live-turn-no-user-transcript', eventId } });
  const result = measure([
    release(10000, 'own-voice-ended', 4000, 7),
    release(20000, 'own-voice-ceiling-no-evidence-of-echo', 8000, 19),
    release(21000, 'own-voice-ceiling-user-like', 8000, 21),
    anomaly(18000, 'one'), anomaly(18020, 'one', 'acknowledged'),
    anomaly(23000, 'two'), anomaly(23001, 'three'),
    { ts: 20000, msg: 'voice.capture-suspend', reason: 'own-voice-hold', ownVoiceGate: true },
  ]);
  assert.deepEqual(result.byReason, {
    'own-voice-ended': { releases: 1, heldMs: 4000, framesZeroedSnapshotSum: 7 },
    'own-voice-ceiling-no-evidence-of-echo': { releases: 1, heldMs: 8000, framesZeroedSnapshotSum: 19 },
    'own-voice-ceiling-user-like': { releases: 1, heldMs: 8000, framesZeroedSnapshotSum: 21 },
  });
  assert.equal(result.ceilingReleases, 2);
  assert.equal(result.ceilingHeldMs, 16000);
  assert.equal(result.noUserTranscript, 3);
  assert.equal(result.anomaliesNearCeiling, 2);
  assert.equal(result.ceilingsNearAnomaly, 2);
});
