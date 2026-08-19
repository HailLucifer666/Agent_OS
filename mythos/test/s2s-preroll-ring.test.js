'use strict';

// s2s-preroll-ring.test.js — cluster A2 of the 2026-08-14 "everything fails"
// session: the operator's speech was thrown away by a 1.2s ring buffer.
//
// WHAT WAS ACTUALLY MEASURED (mythos-server.log + vault/Episodic, 2026-08-14):
//   - live-turn-no-user-transcript x33; 76 of 287 conversation records (26%)
//     stored an EMPTY operator transcript.
//   - inputTranscription frames were PRESENT on 97 of 144 turns, so the wire is
//     healthy. (A prior recorded belief said those frames "are not arriving" and
//     recommended relaxing the automaticActivityDetection values — the log
//     disproves it, and that work would have been aimed at a working component.)
//   - every half-blind turn had inputTranscription absent AND a collapsed
//     audioIn: 6, 9, 11, 69 frames. Healthy turns carried 116..584.
//   - own-voice-hold 124, own-voice-ended 65, barge-in-eager 24,
//     ceiling-fail-open 36. So 29% of holds ended ONLY because the 8s watchdog
//     fired, and on those the ring was the only thing that survived.
//
// audioIn of 6-11 is exactly the size of a 12-frame ring. Gemini will not
// transcribe a mid-sentence tail, so inputTranscription never appeared and the
// turn was stored blind. The gate's own comment at the top of s2s-bridge.js
// already named this failure; the ring was simply never resized to cover the
// window it has to survive.
//
// WHAT THIS FILE PINS, and why it is a source-shape test. s2s-bridge.js is a
// browser ES module (no bundler — ui/CLAUDE.md) and the own-voice gate is not on
// its public surface; the frame path runs inside an AudioWorklet callback that
// has no Node double. Widening the module's exports purely to test this would
// add production surface to protect a constant. So the invariant asserted here is
// the DERIVATION — the actual defect class. PREROLL_MAX_FRAMES = 12 was a second
// hand-tuned number sitting next to a ceiling it had to match and did not; a
// literal cannot be kept in sync with a constant it is unrelated to in code.
//
// NOT claimed by this file: that the mic gate is fixed. own-voice-ended arriving
// 65 times for 124 holds means onSpeakEnd is unreliable ~29% of the time. A ring
// that spans the ceiling makes that HARMLESS; it does not explain the missing
// callback, which is deferred (Wave B #10) with instrumentation added below.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice', 's2s-bridge.js');
const src = fs.readFileSync(BRIDGE, 'utf8');

function readNumber(name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*(\\d+)'));
  return m ? Number(m[1]) : null;
}

describe('A2 the preroll ring is DERIVED from the gate ceiling, not hand-tuned', () => {
  it('PREROLL_MAX_FRAMES is computed from OWN_VOICE_MAX_HOLD_MS and FRAME_MS', () => {
    const m = src.match(/const PREROLL_MAX_FRAMES\s*=\s*([^;]+);/);
    assert.ok(m, 'PREROLL_MAX_FRAMES must still exist — it is the bound on the ring');
    const expr = m[1];
    assert.doesNotMatch(expr, /^\s*\d+\s*$/,
      'a bare literal is the bug: 12 frames (1.2s) sat next to an 8000ms ceiling it had to cover '
      + 'and did not, and nothing in code related the two. Got: ' + expr);
    // F3 (2026-08-15): CORRECTED. The original assertion demanded derivation
    // from OWN_VOICE_IDLE_CEILING_MS, and that was the wrong constant — it is an
    // IDLE window that refreshes on every arriving audio chunk, so the total
    // hold is not bounded by it at all. A hold of 17941ms was measured against
    // the 8000ms ring the derivation produced. The ring must span the longest
    // hold that can OCCUR, which is the absolute cap.
    assert.match(expr, /OWN_VOICE_MAX_HOLD_MS/,
      'the ring must be derived from the ABSOLUTE cap on the hold, not from the idle '
      + 'ceiling — the idle ceiling refreshes, so a hold can outrun a ring derived from it');
    assert.match(expr, /FRAME_MS/,
      'and from the frame duration, so a change to the 100ms frame size stays consistent too');
  });

  it('the absolute cap is enforced, not merely declared', () => {
    // Deriving the ring from a cap nothing enforces would be the same defect in
    // a new costume: the number would look right and the hold would still run
    // past it. The cap's timer must be armed once at hold time and NOT be the
    // one the audio-out refresh re-arms.
    assert.match(src, /function armOwnVoiceMaxHold\(\)/,
      'OWN_VOICE_MAX_HOLD_MS needs a timer, or it is a comment');
    // BUG-274: bounded by the NEXT FUNCTION rather than a character count. Widened
    // once already (500 -> 1200, BUG-272) and broken again by BUG-274's comments,
    // while the invariant — the cap is armed inside holdOwnVoiceGate — never moved.
    const holdAt = src.indexOf('function holdOwnVoiceGate');
    const nextFn = src.indexOf('function releaseOwnVoiceGate', holdAt);
    assert.ok(holdAt !== -1 && nextFn !== -1, 'both gate functions must exist');
    const hold = src.slice(holdAt, nextFn);
    assert.match(hold, /armOwnVoiceMaxHold\(\)/,
      'the cap must be armed when the gate is taken');
    const refresh = src.slice(src.indexOf('function refreshOwnVoiceCeiling'));
    assert.doesNotMatch(refresh.slice(0, 300), /armOwnVoiceMaxHold/,
      'the absolute cap must NOT be refreshed by arriving audio — refreshing it is '
      + 'exactly what made the idle ceiling unusable as the ring\'s basis');
  });

  it('the derivation is declared AFTER the constants it reads (const has no hoisting)', () => {
    const capAt = src.indexOf('const OWN_VOICE_MAX_HOLD_MS');
    const ringAt = src.indexOf('const PREROLL_MAX_FRAMES');
    assert.ok(capAt !== -1 && ringAt !== -1);
    assert.ok(capAt < ringAt,
      'a const read before its declaration throws a TDZ ReferenceError at module evaluation — '
      + 'which would take the entire HUD voice path down, not just the ring');
  });

  it('the computed cap actually spans the longest possible hold', () => {
    const maxHoldMs = readNumber('OWN_VOICE_MAX_HOLD_MS');
    const idleMs = readNumber('OWN_VOICE_IDLE_CEILING_MS');
    const frameMs = readNumber('FRAME_MS');
    assert.ok(maxHoldMs && frameMs && idleMs, 'all three constants must be readable literals');
    assert.ok(maxHoldMs > idleMs,
      'the absolute cap must exceed the idle window, or the idle window can never refresh at all');
    // 17941ms is the longest hold in the 2026-08-14 measurement. A cap at or
    // below it would start cutting off real answers.
    assert.ok(maxHoldMs > 17941,
      'the cap must sit above the longest hold ever observed (17941ms), or it becomes a cap on '
      + 'how long MYTHOS may speak — the same mistake the 20s flat ceiling made');
    const cap = Math.ceil(maxHoldMs / frameMs);
    assert.ok(cap * frameMs >= maxHoldMs,
      'the ring must cover the whole window the gate can be held for, or the operator '
      + 'can still speak into a gap the ring cannot hold — got ' + (cap * frameMs) + 'ms of coverage '
      + 'for a ' + maxHoldMs + 'ms hold');
    // Bounded, per the original constant's stated purpose. 300 frames of 16kHz
    // mono 16-bit at 100ms each is ~960KB — still far below anything that
    // matters in a renderer, and the ring only fills while MYTHOS is speaking.
    const bytes = cap * (16000 / 1000) * frameMs * 2;
    assert.ok(bytes < 2 * 1024 * 1024,
      'the ring is still bounded memory, not an unbounded buffer; got ' + bytes + ' bytes');
  });

  it('the ring is still a ring — the oldest frame is dropped, not the newest', () => {
    const handler = src.indexOf('captureNode.port.onmessage');
    // BUG-274: this window was not merely too small, it was MALFORMED — the start was
    // found relative to the handler while the end was a fixed handler+N, so once the
    // handler grew past N the slice inverted and returned the empty string, and an
    // empty string fails every match with no hint that the extraction was the fault.
    // Both ends are now code sentinels: the gate block, to the send that follows it.
    const gateAt = src.indexOf('if (ownVoiceGate) {', handler);
    const sendAt = src.indexOf("sendMessage({ type: 'live-audio'", gateAt);
    assert.ok(gateAt !== -1 && sendAt !== -1, 'the gate block and the send after it must both exist');
    const body = src.slice(gateAt, sendAt);
    assert.match(body, /preroll\.shift\(\)/,
      'overflow must drop the OLDEST frame. Dropping the newest would keep the beginning of a '
      + 'sentence and lose the end, which is worse: the end is what the operator just said.');
  });
});

describe('A2 the drop depth is now observable, instead of computed and discarded', () => {
  // The 2026-08-14 analysis could only INFER the overflow, from Gemini's audioIn
  // counts read out of a server log a day later. prerollFrames existed; the cap
  // and the hold duration did not, so "was the ring full?" was unanswerable.
  it('the release log carries prerollFrames, prerollCap and heldMs', () => {
    const release = src.slice(src.indexOf('function releaseOwnVoiceGate'));
    const body = release.slice(0, release.indexOf('\n  }') + 1);
    assert.match(body, /prerollFrames/, 'how many frames were replayed');
    assert.match(body, /prerollCap/,
      'and what the cap was — prerollFrames === prerollCap is the only way to tell from a log '
      + 'that frames WERE dropped rather than that the operator happened to say little');
    assert.match(body, /heldMs/,
      'and how long the gate was held to earn that, so a watchdog release is distinguishable '
      + 'from a normal one by duration and not just by its reason string');
    // F3: prerollCap tells you the ring was full; framesDropped tells you how
    // much was actually lost. Without the second number, "ring too small" and
    // "the audio Gemini heard was our own voice" are indistinguishable — which
    // is exactly where the 2026-08-14 analysis had to stop and guess.
    assert.match(body, /framesDropped/,
      'and how many frames the ring evicted, which is the only direct measure of speech lost');
  });

  it('heldMs is measured from the hold, not invented at release time', () => {
    const hold = src.slice(src.indexOf('function holdOwnVoiceGate'), src.indexOf('function releaseOwnVoiceGate'));
    assert.match(hold, /ownVoiceHeldAt\s*=\s*Date\.now\(\)/,
      'the start timestamp must be stamped when the gate is taken');
  });

  it('a release still logs exactly one line per hold, not one per frame', () => {
    const release = src.slice(src.indexOf('function releaseOwnVoiceGate'));
    const body = release.slice(0, release.indexOf('\n  }') + 1);
    const calls = body.match(/logSuspendTransition\(/g) || [];
    assert.equal(calls.length, 1,
      'per-frame logging would be 10 lines a second and would bury the measurement');
  });
});
