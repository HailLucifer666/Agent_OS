'use strict';

// BUG-388 — the protected window learned the OPERATOR'S voice and reported it as
// the room's bleed, and a verification script turned that number into a verdict
// about the echo canceller.
//
// Diagnosed 2026-08-19 and deliberately deferred (BUGS.md, "Two findings from this
// session recorded and deliberately NOT fixed"), on the stated grounds that the
// learned floor is dormant so the consequence today is nil. The premise was wrong:
// scripts/verify-voice-session.js reads bleedPeak, calls it "the ungagged oracle",
// and concludes "Echo cancellation is not removing it, whatever the constraint
// reports as granted". That is a hardware verdict derived from the operator's own
// voice, and it is the conclusion that put an acoustic rework into the plan.
//
// Run: cd mythos && node --test test/bug-388-bleed-peak-attribution.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const voiceDir = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const POLICY_URL = pathToFileURL(path.join(voiceDir, 'barge-in-policy.js')).href;
const VERIFIER = path.join(__dirname, '..', 'scripts', 'verify-voice-session.js');

// --- MEASURED 2026-08-28 from %APPDATA%/MYTHOS/mythos-server.log ------------------
//
// 20 sessions of voice.capture-suspend records, grouped into monotonic runs of
// bleedPeak (a drop means a new process). Two populations fall straight out.
//
// What every session OPENS at, before any contamination — this is the real room,
// and it agrees with the independent acoustic probe (scripts/probe-aec-routes.js
// measured the Gemini Live route attenuating 15-20dB to a 0.0069-0.0141 residual).
const SESSION_OPENING_BLEED = [
  0.0043, 0.0049, 0.0071, 0.008, 0.0081, 0.0121, 0.0144,
  0.0214, 0.0218, 0.0253, 0.0309, 0.0332, 0.0337, 0.0347,
];

// What bleedPeak RATCHETED to. 31 upward moves above 0.05 were recorded; in 22 of
// them the new bleedPeak equals that hold's own peakRms EXACTLY — the loudest mic
// frame of the hold, which is the operator. These are that population.
const CONTAMINATED_PEAKS = [
  0.0532, 0.0597, 0.0707, 0.0754, 0.0841, 0.087, 0.0944, 0.1041, 0.1159, 0.1189,
  0.1193, 0.1228, 0.1236, 0.1253, 0.1295, 0.1307, 0.1309, 0.1335, 0.1395, 0.1455,
  0.15, 0.1525, 0.1593, 0.1606, 0.1641, 0.1873, 0.2031, 0.2154, 0.3324,
];

// The uncontaminated control: 2026-08-26, 11 holds, ended at 0.0313 while the
// operator peaked at 0.1402 in the same session. The room does not bleed 0.13.
const CONTROL_SESSION_FINAL_BLEED = 0.0313;
const CONTROL_SESSION_OPERATOR_PEAK = 0.1402;

function clock(start) {
  const c = { t: start || 1000 };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

function feed(policy, c, level, frames) {
  for (let i = 0; i < frames; i++) {
    policy.observe({ rms: level });
    c.advance(100);
  }
}

// The conversational shape that does the damage, and the whole point of the fix:
// the operator is ALREADY talking when MYTHOS begins its next utterance, so their
// voice is what the 500ms protected window hears.
function operatorAlreadyTalking(p, c, level) {
  feed(p, c, level, 3);          // IDLE — MYTHOS is silent, this is the operator
  p.assistantSpeakingStarted();  // MYTHOS starts over them
  feed(p, c, level, 5);          // 500ms == PROTECTED_MS, they are still going
}

// The clean shape: a quiet room, then MYTHOS speaks and the mic hears its bleed.
function quietRoomThenBleed(p, c, bleed) {
  feed(p, c, 0.001, 3);
  p.assistantSpeakingStarted();
  feed(p, c, bleed, 5);
}

describe('BUG-388 — bleedPeak must not learn the operator', () => {
  it('refuses to learn a protected window the operator was already speaking into', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    operatorAlreadyTalking(p, c, 0.2031);

    assert.equal(p.bleedPeak(), 0,
      'the operator was audible before MYTHOS opened its mouth, so nothing in the '
      + 'protected window is attributable to MYTHOS and bleedPeak must stay unset');
    assert.equal(p.bleedAttributable(), false, 'the window must report itself unattributable');
    assert.equal(p.bleedWindowsSkipped(), 1, 'and the refusal must be countable');
  });

  it('still learns real bleed from a quiet room — the fix is not just a mute button', async () => {
    // The positive control. A guard that refuses everything passes the test above
    // vacuously while destroying the measurement it exists to protect.
    const { createBargeInPolicy } = await import(POLICY_URL);
    for (const bleed of SESSION_OPENING_BLEED) {
      const c = clock();
      const p = createBargeInPolicy({ now: c.now });
      quietRoomThenBleed(p, c, bleed);
      assert.ok(Math.abs(p.bleedPeak() - bleed) < 1e-9,
        `a quiet room followed by ${bleed} of real bleed must still be learned, `
        + `got ${p.bleedPeak()}`);
      assert.equal(p.bleedWindowsSkipped(), 0, 'an attributable window is not a refusal');
    }
  });

  it('rejects every level bleedPeak was actually poisoned to in the live log', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    for (const level of CONTAMINATED_PEAKS) {
      const c = clock();
      const p = createBargeInPolicy({ now: c.now });
      operatorAlreadyTalking(p, c, level);
      assert.equal(p.bleedPeak(), 0,
        `${level} was recorded as this room's bleed and is the operator; it must not be learned`);
    }
  });

  it('reproduces the control session: the operator at 0.1402 cannot raise a 0.0313 room', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    quietRoomThenBleed(p, c, CONTROL_SESSION_FINAL_BLEED);
    feed(p, c, 0.001, 2);                 // out of the window
    p.assistantSpeakingEnded();
    operatorAlreadyTalking(p, c, CONTROL_SESSION_OPERATOR_PEAK);

    assert.ok(Math.abs(p.bleedPeak() - CONTROL_SESSION_FINAL_BLEED) < 1e-9,
      `bleedPeak must still read ${CONTROL_SESSION_FINAL_BLEED}, not the operator's `
      + `${CONTROL_SESSION_OPERATOR_PEAK}; got ${p.bleedPeak()}`);
  });

  it('one contaminated frame must not survive the rest of the process', async () => {
    // Why this matters beyond one hold: bleedPeak is a running max that never
    // decays and deliberately survives reset(). 2026-08-24 reported 0.1606 for 110
    // consecutive holds off a single frame at 20:28:19.
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    operatorAlreadyTalking(p, c, 0.1606);
    p.assistantSpeakingEnded();
    for (let turn = 0; turn < 10; turn++) {
      quietRoomThenBleed(p, c, 0.0142);
      p.assistantSpeakingEnded();
    }

    assert.ok(p.bleedPeak() < 0.05,
      `after the contaminated hold, ten clean turns must leave bleedPeak in the room's `
      + `own band; got ${p.bleedPeak()}`);
  });

  it('a poisoned learned floor cannot raise the bar for calling a window contaminated', async () => {
    // Non-circularity. If the contamination test compared against bleedFloor()
    // rather than the static INITIAL_BLEED_FLOOR, an already-poisoned peak would
    // make the next contaminated window look attributable — poison protecting
    // itself, and the failure would grow rather than stop.
    const { createBargeInPolicy, INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now, learnedFloorEnabled: true });

    quietRoomThenBleed(p, c, 0.12);        // a genuinely loud room: floor learns 0.12
    p.assistantSpeakingEnded();
    assert.ok(p.bleedFloor() > INITIAL_BLEED_FLOOR, 'precondition: the floor really did learn');

    operatorAlreadyTalking(p, c, 0.09);    // operator BELOW that floor, above the static one
    assert.ok(Math.abs(p.bleedPeak() - 0.12) < 1e-9,
      `the operator at 0.09 sits under the learned floor but over the static one, and `
      + `must still be refused; bleedPeak is ${p.bleedPeak()}`);
    assert.equal(p.bleedWindowsSkipped(), 1);
  });

  it('a mid-utterance chunk does not re-decide attributability', async () => {
    // assistantSpeakingStarted() is re-entrant by design — audio arrives in chunks.
    // Only a transition out of IDLE may set the verdict, or a contaminated window
    // would be laundered clean by the next chunk of the same sentence.
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    feed(p, c, 0.2031, 3);
    p.assistantSpeakingStarted();
    p.assistantSpeakingStarted();          // another chunk of the same utterance
    feed(p, c, 0.2031, 4);

    assert.equal(p.bleedPeak(), 0, 'the second chunk must not clear the verdict');
    assert.equal(p.bleedWindowsSkipped(), 1, 'nor count a second refusal');
  });

  it('forgetRoom clears the refusal state with the room', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    const c = clock();
    const p = createBargeInPolicy({ now: c.now });

    operatorAlreadyTalking(p, c, 0.2031);
    assert.equal(p.bleedWindowsSkipped(), 1);
    p.forgetRoom();
    assert.equal(p.bleedWindowsSkipped(), 0, 'a new session is a new room and a new count');
    assert.equal(p.bleedAttributable(), true);
  });
});

describe('BUG-388 — the verifier must not turn bleedPeak into a hardware verdict', () => {
  it('no longer claims echo cancellation is failing on the strength of bleedPeak', () => {
    const src = fs.readFileSync(VERIFIER, 'utf8');
    assert.ok(!/Echo cancellation is not removing it/.test(src),
      'verify-voice-session.js concluded "Echo cancellation is not removing it" from '
      + 'bleedPeak alone. bleedPeak cannot name a source, so this verdict was reachable '
      + 'from the operator\'s own voice and is how an acoustic rework entered the plan');
    assert.ok(!/ungagged oracle/.test(src),
      'and it must not call bleedPeak an ungagged oracle: it is gagged in exactly the '
      + 'way that matters, by being unable to say who made the sound');
  });

  it('still reports the measured numbers rather than going silent about them', () => {
    // Q2 — DOES THIS HIDE EVIDENCE? Deleting the verdict must not delete the data:
    // the peak and the floor are the two numbers a future session needs.
    const src = fs.readFileSync(VERIFIER, 'utf8');
    assert.ok(/room bleed peaked at/i.test(src), 'the measurement must still be printed');
    assert.ok(/attribut/i.test(src),
      'and it must say what would be needed to attribute it to a source');
  });
});
