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
  it('PREROLL_MAX_FRAMES is computed from OWN_VOICE_IDLE_CEILING_MS and FRAME_MS', () => {
    const m = src.match(/const PREROLL_MAX_FRAMES\s*=\s*([^;]+);/);
    assert.ok(m, 'PREROLL_MAX_FRAMES must still exist — it is the bound on the ring');
    const expr = m[1];
    assert.doesNotMatch(expr, /^\s*\d+\s*$/,
      'a bare literal is the bug: 12 frames (1.2s) sat next to an 8000ms ceiling it had to cover '
      + 'and did not, and nothing in code related the two. Got: ' + expr);
    assert.match(expr, /OWN_VOICE_IDLE_CEILING_MS/,
      'the ring must be derived from the ceiling it has to survive, so a future change to the '
      + 'ceiling cannot silently re-open this bug');
    assert.match(expr, /FRAME_MS/,
      'and from the frame duration, so a change to the 100ms frame size stays consistent too');
  });

  it('the derivation is declared AFTER the ceiling it reads (const has no hoisting)', () => {
    const ceilingAt = src.indexOf('const OWN_VOICE_IDLE_CEILING_MS');
    const ringAt = src.indexOf('const PREROLL_MAX_FRAMES');
    assert.ok(ceilingAt !== -1 && ringAt !== -1);
    assert.ok(ceilingAt < ringAt,
      'a const read before its declaration throws a TDZ ReferenceError at module evaluation — '
      + 'which would take the entire HUD voice path down, not just the ring');
  });

  it('the computed cap actually spans the full ceiling', () => {
    const ceilingMs = readNumber('OWN_VOICE_IDLE_CEILING_MS');
    const frameMs = readNumber('FRAME_MS');
    assert.ok(ceilingMs && frameMs, 'both constants must be readable literals');
    const cap = Math.ceil(ceilingMs / frameMs);
    assert.equal(cap, 80, 'with the values as committed: 8000ms / 100ms = 80 frames');
    assert.ok(cap * frameMs >= ceilingMs,
      'the ring must cover at least the whole window the gate can be held for, or the operator '
      + 'can still speak into a gap the ring cannot hold — got ' + (cap * frameMs) + 'ms of coverage '
      + 'for a ' + ceilingMs + 'ms hold');
    // Bounded, per the original constant's stated purpose. 80 frames of 16kHz
    // mono 16-bit at 100ms each is ~256KB — two orders of magnitude below
    // anything that matters in a renderer, and the ring only fills while MYTHOS
    // is audibly speaking.
    const bytes = cap * (16000 / 1000) * frameMs * 2;
    assert.ok(bytes < 1024 * 1024,
      'the ring is still bounded memory, not an unbounded buffer; got ' + bytes + ' bytes');
  });

  it('the ring is still a ring — the oldest frame is dropped, not the newest', () => {
    const handler = src.indexOf('captureNode.port.onmessage');
    const body = src.slice(src.indexOf('if (ownVoiceGate) {', handler), handler + 2000);
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
