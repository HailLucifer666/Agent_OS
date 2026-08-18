'use strict';
// bug-273-release-flush-measurement.test.js — BUG-273 A2, measurement only.
//
// THE QUESTION A2 ASKS. 26 of 61 turns (43%) were cut short by Gemini on
// 2026-08-18 while bargeVetoed hit 49 — the local policy was vetoing almost
// everything, so the interruptions came from Gemini's own server-side VAD
// reacting to audio that had already reached it. Which audio?
//
// The plan assumed bleed the noise gate passed DURING a hold. Reading
// s2s-bridge.js closes that off: the capture handler `return`s before
// sendMessage while ownVoiceGate is set, so during a hold there is nothing on
// the wire at all. That leaves exactly one candidate — the replay at
// releaseOwnVoiceGate(), which pushes the whole preroll ring (up to
// PREROLL_MAX_FRAMES, 133 frames observed = 13.3 seconds) onto the wire in one
// burst, through the noise gate.
//
// The comment on that loop asserts the reassuring answer: "the gate turns the
// bleed into silence at the wire level while the operator's real interruption
// passes raw." This file tests the gate against the room's real numbers instead
// of trusting that sentence, because the numbers make it doubtful:
// LIVE_NOISE_GATE_FLOOR_RMS is 0.02 and measured bleed was 0.123 — about 6x above
// the floor — and the gate's hysteresis holds it open for 800ms of quiet once any
// frame has cleared it.
//
// Q5, and the reason nothing acoustic changes in this pass: the honest fix is not
// another scalar. Raising the gate floor toward 0.123 walks straight back into the
// overlap A1 just backed out of, because operator speech measured 0.0395-0.069 —
// BELOW the bleed. So this pass proves what the gate does, adds the per-release
// counters that let a live session confirm it, and stops there.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const GATE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'live-noise-gate.js')
).href;
// The gate takes its rms function by INJECTION and ships no default, and
// s2s-bridge passes this one. Using it here keeps the levels below on the same
// scale the session measured them on rather than a scale the test invented.
const BACKSTOP_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 'barge-in-backstop.js')
).href;

async function makeGate(overrides) {
  const [{ createLiveNoiseGate }, { rmsFromPcm16 }] = await Promise.all([
    import(GATE_URL), import(BACKSTOP_URL),
  ]);
  return createLiveNoiseGate(Object.assign({ rms: rmsFromPcm16 }, overrides || {}));
}

// Measured 2026-08-18, in the operator's room.
const BLEED_RMS = 0.123;
const OPERATOR_LOUD = 0.069;
const OPERATOR_QUIET = 0.0395;
const OBSERVED_MAX_PREROLL = 133; // frames, i.e. 13.3s at 100ms per frame

// A 100ms 16k mono PCM16 frame at a given RMS. A constant-magnitude signal has
// RMS equal to that magnitude, so this is exact rather than approximate.
function frameAtRms(rms) {
  const samples = 1600;
  const buf = new ArrayBuffer(samples * 2);
  const view = new Int16Array(buf);
  const amplitude = Math.round(rms * 32767);
  for (let i = 0; i < samples; i++) view[i] = i % 2 === 0 ? amplitude : -amplitude;
  return buf;
}

describe('BUG-273 A2 — what the noise gate does to a flushed ring, at real levels', () => {
  it('does NOT silence this room\'s bleed — the floor sits 6x below it', async () => {
    const { LIVE_NOISE_GATE_FLOOR_RMS } = await import(GATE_URL);
    assert.equal(LIVE_NOISE_GATE_FLOOR_RMS, 0.02,
      'if this moves, every number in this file was measured against a different gate');
    assert.ok(BLEED_RMS > LIVE_NOISE_GATE_FLOOR_RMS * 5,
      'the premise: measured bleed is not marginally above the floor, it is far above it');

    const gate = await makeGate();
    let zeroed = 0;
    for (let i = 0; i < OBSERVED_MAX_PREROLL; i++) {
      if (gate.process(frameAtRms(BLEED_RMS)).zero) zeroed += 1;
    }
    assert.equal(zeroed, 0,
      'the release-flush comment claims the gate turns bleed into silence at the wire level. '
      + 'At 0.123 against a 0.02 floor it silences none of it, so a full ring is 13.3 seconds '
      + "of assistant-dominated audio delivered to Gemini's VAD in one burst");
  });

  it('cannot be fixed by raising the floor: operator speech is BELOW the bleed', async () => {
    // Q1/Q5 pinned as a test rather than a comment, because "raise the floor toward
    // measured bleed" is the first thing the fix plan lists and it cannot work here.
    // A floor set high enough to zero 0.123 bleed zeroes the operator too.
    const floor = BLEED_RMS;
    for (const level of [OPERATOR_LOUD, OPERATOR_QUIET]) {
      const gate = await makeGate({ floorRms: floor });
      assert.equal(gate.process(frameAtRms(level)).zero, true,
        `a floor high enough to reject bleed also rejects operator speech at ${level} — the same `
        + 'overlap that made the learned bleed floor deaf in A1');
    }
  });

  it('hysteresis keeps the gate open across the flush once one frame clears it', async () => {
    const gate = await makeGate();
    // One loud frame opens it; genuinely quiet frames then pass RAW until the
    // quiet run closes it again. So a ring holding bleed plus a real interruption
    // does not gate frame-by-frame the way the comment implies.
    assert.equal(gate.process(frameAtRms(BLEED_RMS)).zero, false, 'the loud frame opens the gate');
    assert.equal(gate.process(frameAtRms(0.001)).zero, false,
      'and the frame right after it passes raw despite being far below the floor — this is why '
      + 'per-frame reasoning about the flush is wrong');
  });
});

describe('BUG-273 A2 — the release reports what it put on the wire', () => {
  const src = () => fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it('nothing is sent during a hold — which is what leaves the flush as the only carrier', () => {
    const s = src();
    const start = s.indexOf('if (ownVoiceGate) {', s.indexOf('captureNode.port.onmessage'));
    assert.notEqual(start, -1, 'the hold branch must still exist inside the capture handler');
    // Deliberately an ORDER assertion over a fixed source window: this file's own
    // sibling tests have been broken before by a comment shifting a slice boundary,
    // and the invariant is "return comes before send", not "these bytes are here".
    const after = s.slice(start);
    const returnAt = after.indexOf('return;');
    const sendAt = after.indexOf("sendMessage({ type: 'live-audio'");
    assert.ok(returnAt !== -1 && sendAt !== -1, 'both the return and the send must be present');
    assert.ok(returnAt < sendAt,
      'the handler must return BEFORE the send — that is what makes a hold silent on the wire. '
      + "If this order ever flips, A2's conclusion changes and the plan's original "
      + 'during-the-hold hypothesis revives');
    assert.match(after.slice(0, returnAt), /preroll\.push/, 'a held frame is buffered, not dropped');
  });

  it('counts and reports zeroed vs raw across the flush', () => {
    const s = src();
    const rel = s.slice(s.indexOf('function releaseOwnVoiceGate'));
    assert.match(rel, /let flushedZeroed = 0;/, 'the count has to happen where the gate runs');
    assert.match(rel, /if \(gated && gated\.zero\) flushedZeroed \+= 1;/,
      "process() already returns the verdict — nothing new is computed, it was simply thrown away");
    for (const field of [/flushedFrames: held\.length/, /flushedZeroed: flushedZeroed/, /flushedRaw: held\.length - flushedZeroed/]) {
      assert.match(rel, field, 'all three go on the transition line — a ratio alone hides a zero denominator');
    }
  });

  it('the flush still sends every frame — measuring must not drop audio', () => {
    // Q2/Q8: framesDropped has been 0 across two sessions and that must not change
    // because a counter was added. The send stays inside the loop, once per frame.
    const s = src();
    const rel = s.slice(s.indexOf('function releaseOwnVoiceGate'), s.indexOf('function ', s.indexOf('function releaseOwnVoiceGate') + 10));
    const sends = rel.match(/send\(\{ type: 'live-audio'/g) || [];
    assert.equal(sends.length, 1, 'exactly one send per flushed frame, inside the loop');
    assert.match(rel, /arrayBufferToBase64\(gated\.buffer\)/,
      'and it must send the GATED buffer, not the raw frame — the gate decision still goes on the wire');
  });
});
