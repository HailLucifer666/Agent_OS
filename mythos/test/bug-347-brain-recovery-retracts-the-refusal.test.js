'use strict';

// BUG-347 — the voice loop said "voice processing unavailable" and never took
// it back.
//
// THE TICKET'S PREMISE IS TOO STRONG, and the fix is narrower because of it. It
// says there is "no signal when it flips back". There IS one: core-orb.js
// subscribes to the same 'entity-state' broadcast (:823), maps it through the
// same vocabulary (`entityStatus !== 'alive'` -> 'booting', :141-142), repaints
// the orb, and pushes STATE_LINE into the #hud-status-live aria-live region on
// transition — deliberately on transition only, never per frame. So the HUD
// does announce recovery.
//
// WHAT IS ACTUALLY BROKEN is narrower and worse: the voice loop emits
// 'Brain is offline — voice processing unavailable.' (voice-loop.js, the
// _brainOnline() pre-flight) and NOTHING EVER RETRACTS IT. Verified by reading
// the paths out: setState() calls onState only, and app.js's onVoiceState()
// forwards to compose.setVoiceState / orb / hud and never touches the caption —
// so finishTurn()'s return to 'listening' leaves the refusal on screen. The
// operator is then looking at two indicators that disagree: an orb that says
// the entity is alive and listening, and a line of text, in words, about voice
// specifically, that says voice does not work. The text is the one they read,
// and it tells them not to bother trying again.
//
// THE THREE RULES THIS PINS, each of which is a way to get the fix wrong:
//   1. Retract ONLY after a real refusal. A brain that blips while nobody is
//      speaking leaves no stale caption, and announcing a recovery from a
//      problem the operator never saw is noise that overwrites whatever useful
//      caption was there.
//   2. Fire ONCE per outage. The check runs on the VAD tick (100ms); a rule
//      that only tested `refused && online` would repaint ten times a second.
//   3. Never fire at boot. _brainOnline starts true in app.js, so the first
//      broadcast can flip false->true with no refusal in between.
//
// CAPTION, NOT SPEECH. The ticket says "Speak/caption one line", so either
// satisfies it, and caption is the right half: MYTHOS's own TTS is transcribed
// back as the operator on the Live path, so unprompted speech manufactures a
// spurious turn — and a recovery lands exactly where the operator is already
// looking, on the line that is currently wrong.
//
// Run: cd mythos && node --test test/bug-347-brain-recovery-retracts-the-refusal.test.js

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui', 'public', 'js');
const LOOP = fs.readFileSync(path.join(UI, 'voice', 'voice-loop.js'), 'utf8');

// voice-loop.js imports cleanly under bare node (no DOM at module scope), which
// is why these are real behavioural tests and not source-shape assertions.
let createBrainRecoveryNotice;
let encodeWav;
before(async () => {
  ({ createBrainRecoveryNotice } = await import('../ui/public/js/voice/voice-loop.js'));
  ({ encodeWav } = await import('../ui/public/js/voice/wav.js'));
});

describe('BUG-347 — the refusal is retracted, once, and only when it was made', () => {
  it('says nothing when the brain was never refused', () => {
    const n = createBrainRecoveryNotice();
    assert.equal(n.check(true), null,
      'rule 3: _brainOnline starts true, so a boot-time flip to online must not announce a '
      + 'recovery from an outage that never happened');
    assert.equal(n.check(true), null);
  });

  it('says nothing while the brain is still down', () => {
    const n = createBrainRecoveryNotice();
    n.refused();
    assert.equal(n.check(false), null);
  });

  it('retracts on the first tick that sees the brain back', () => {
    const n = createBrainRecoveryNotice();
    n.refused();
    const line = n.check(true);
    assert.ok(line, 'the operator was told voice does not work; something must take that back');
    assert.match(line, /back/i, 'the retraction must be legible as a retraction');
  });

  it('fires exactly once, not on every tick', () => {
    // rule 2. The check runs on the 100ms VAD tick. A rule that tested only
    // `refused && online` would repaint this ten times a second for as long as
    // the mic stayed open.
    const n = createBrainRecoveryNotice();
    n.refused();
    assert.ok(n.check(true));
    assert.equal(n.check(true), null);
    assert.equal(n.check(true), null);
  });

  it('arms again for the next outage', () => {
    // A single-shot latch that never re-arms would fix the first outage of a
    // session and silently stop working for every one after it.
    const n = createBrainRecoveryNotice();
    n.refused();
    assert.ok(n.check(true));
    n.refused();
    assert.ok(n.check(true), 'the second outage deserves the same retraction as the first');
  });

  it('a refusal during an outage does not queue a second announcement', () => {
    // The operator may speak several times while the brain is down — each one
    // is refused. That is ONE outage and deserves ONE retraction.
    const n = createBrainRecoveryNotice();
    n.refused();
    n.refused();
    n.refused();
    assert.ok(n.check(true));
    assert.equal(n.check(true), null);
  });

  it('the retraction tells the operator what to do next', () => {
    // "The brain is back" is a status. The operator's actual question is
    // whether the thing they said is lost — it is, so say so.
    const n = createBrainRecoveryNotice();
    n.refused();
    assert.match(n.check(true), /again/i);
  });
});

describe('BUG-347 — the loop is wired to the notice', () => {
  it('the refusal branch records that it refused', () => {
    const at = LOOP.indexOf('if (!_brainOnline()) {');
    assert.notStrictEqual(at, -1, 'the pre-flight refusal must still exist');
    const body = LOOP.slice(at, at + 300);
    assert.match(body, /brainRecovery\.refused\(\)/,
      'without this the retraction can never fire, because nothing knows a refusal happened');
  });

  it('the VAD tick asks whether to retract', () => {
    // Polled on the tick the loop ALREADY runs rather than pushed from app.js:
    // the module that made the claim is the one that should take it back, and
    // it already reads _brainOnline(). finishTurn() returns the loop to
    // 'listening', so the tick keeps running after a refusal.
    const at = LOOP.indexOf('function vadTick()');
    assert.notStrictEqual(at, -1);
    const body = LOOP.slice(at, at + 400);
    assert.match(body, /brainRecovery\.check\(_brainOnline\(\)\)/);
    assert.match(body, /caption\(/, 'the decision is worth nothing unless it reaches the screen');
  });
});

describe('BUG-347 — the WAV encoder moved out intact', () => {
  // encodeWav left voice-loop.js because that file sits EXACTLY on its
  // file-size ratchet ceiling (1075) and the fix could not otherwise be added.
  // It is pure byte manipulation with no closure dependencies, and moving it
  // made it testable for the first time — every transcription in the pre-roll
  // path goes through it and nothing has ever asserted on its output.
  it('writes a 44-byte RIFF/WAVE header', () => {
    const buf = encodeWav(new Float32Array([0, 0, 0, 0]), 16000);
    const view = new DataView(buf);
    const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
    assert.equal(str(0, 4), 'RIFF');
    assert.equal(str(8, 4), 'WAVE');
    assert.equal(str(12, 4), 'fmt ');
    assert.equal(str(36, 4), 'data');
    assert.equal(buf.byteLength, 44 + 4 * 2, '16-bit mono: two bytes per sample after the header');
    assert.equal(view.getUint32(40, true), 8, 'the data chunk must declare its own real size');
  });

  it('declares mono 16-bit PCM at the sample rate it was given', () => {
    const view = new DataView(encodeWav(new Float32Array(10), 48000));
    assert.equal(view.getUint16(20, true), 1, 'format 1 = uncompressed PCM');
    assert.equal(view.getUint16(22, true), 1, 'one channel');
    assert.equal(view.getUint32(24, true), 48000);
    assert.equal(view.getUint32(28, true), 48000 * 2, 'byte rate = rate * channels * bytes/sample');
    assert.equal(view.getUint16(34, true), 16);
  });

  it('clamps out-of-range samples instead of wrapping them', () => {
    // A float outside [-1,1] that is scaled and truncated without clamping wraps
    // to the OPPOSITE sign — full-scale positive audio becomes full-scale
    // negative, which is audible as a hard click and can defeat transcription.
    const view = new DataView(encodeWav(new Float32Array([2, -2]), 16000));
    assert.equal(view.getInt16(44, true), 32767);
    assert.equal(view.getInt16(46, true), -32768);
  });

  it('maps silence to zero and full scale to the right sign', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1]), 16000));
    assert.equal(view.getInt16(44, true), 0);
    assert.equal(view.getInt16(46, true), 32767);
    assert.equal(view.getInt16(48, true), -32768);
  });
});
