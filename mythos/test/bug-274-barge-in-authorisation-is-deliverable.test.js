'use strict';

// bug-274-barge-in-authorisation-is-deliverable.test.js — the two halves of the
// barge-in path have to agree on a FRAME, and nothing ever checked that they could.
//
// WHAT THE OPERATOR REPORTED, 2026-08-19: "interruptions still fails". The live log
// from that session says the acoustics are fine and says it three ways:
//
//   micEchoCancellation: true    — read off the live track's getSettings(), 12 times,
//                                  so AEC3 IS granted. T4's prime hypothesis is dead.
//   peakRms 0.0056               — what the mic hears while MYTHOS speaks and the
//                                  operator does not. AEC3 is working.
//   bleedPeak 0.0186             — this room's measured bleed, well under the 0.05 floor.
//
// And in the same session the operator spoke at peakRms 0.0921, 0.1222 and 0.2715 —
// two to five times the floor — while one hold ran 17,565ms and ended on the ceiling
// rather than on an interruption, with 13 barge-ins vetoed across the run. Loud, clean,
// unambiguous operator speech, refused.
//
// THE DEFECT IS NOT ACOUSTIC. It is that the two mechanisms count to different numbers.
//
//   barge-in-policy.js  authorises on ONE frame: PENDING opens on the first above-floor
//                       frame and CONFIRMED arrives when 350ms have elapsed, i.e. the
//                       5th frame of a 100ms run. Every later frame returns
//                       'already-confirmed' with release:false, because the state is
//                       documented as "terminal — the release has already been issued".
//
//   barge-in-backstop.js delivers on EVERY THIRD frame: decideBargeIn() zeroes its own
//                       counter when it fires (voice-loop.js:131), so onFlush/onRelease
//                       land on frames 3, 6, 9 ... and on no others.
//
// 5 is not a multiple of 3. The policy's single frame of authorisation is handed to a
// caller that is not listening on that frame, and the moment it lapses the policy says
// release:false forever. Measured with both real modules wired exactly as
// s2s-bridge.js wires them: continuous speech at the 0.27 the operator actually reached
// produces ZERO releases and eleven vetoes.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? "A mechanism that looks like coverage and does
// nothing", the class BUG-274 was opened over. The veto shipped with tests, and those
// tests exercise the policy ALONE — where release:true is returned and believed. Nothing
// ever asked whether the caller could act on it. Five tickets have now tuned this path
// (BUG-224, 271, 272, 273 A1, 273 A2) without one of them wiring the two halves together
// in a test, which is why "it worked flawlessly before" is exactly right: before the veto
// existed the backstop's frame-3 fire went straight through.
//
// Q8 — WHAT STAYS. The 500ms protected window, the 350ms sustain requirement, both
// backstop tiers, their thresholds, their hysteresis and the dormant learned floor are
// all UNCHANGED. This is not a retune. The one thing that changes is that CONFIRMED
// keeps answering "yes" while the assistant is still speaking, because the policy is a
// VETO and its answer to "may this release proceed" does not stop being yes.
//
// THE SECOND FINDING, deliberately NOT fixed here and recorded so it is not lost: with
// 100ms dips every 400ms — ordinary syllable spacing — PENDING resets on every dip and
// 350ms is never reached, so there is no authorisation to deliver and the fix below
// cannot help. That is a tuning question about the sustain test itself, this repo has
// twice shipped opposite-direction failures by guessing at these constants, and the
// prevalence is now measurable because the policy's veto reason reaches the log. It is
// pinned below as a known-failing shape so the next session inherits the measurement
// rather than the guess.
//
// Run: cd mythos && node --test test/bug-274-barge-in-authorisation-is-deliverable.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const voiceDir = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const POLICY_URL = pathToFileURL(path.join(voiceDir, 'barge-in-policy.js')).href;
const BACKSTOP_URL = pathToFileURL(path.join(voiceDir, 'barge-in-backstop.js')).href;

// One 100ms frame at 16kHz, flat at the amplitude whose RMS is `rms`.
function frameAt(rms) {
  return new Int16Array(1600).fill(Math.round(rms * 32768));
}

// Levels the operator's own log recorded, so no constant here is invented.
const OPERATOR_LOUD = 0.27;    // peakRms on the 17.5s hold that ended at the ceiling
const OPERATOR_DIP = 0.02;     // below the 0.05 floor, as a syllable gap is
const MYTHOS_ONLY = 0.006;     // peakRms with AEC3 on and the operator silent

// Wires the two real modules the way s2s-bridge.js does — policy first, because its
// verdict is what the backstop's synchronous callbacks read — and reports what the
// operator would actually experience.
async function driveBargeIn(levels) {
  const { createBargeInPolicy } = await import(POLICY_URL);
  const { createBargeInBackstop } = await import(BACKSTOP_URL);

  let t = 0;
  const policy = createBargeInPolicy({ now: () => t });
  let policyAllowsRelease = false;
  let released = 0;
  let vetoed = 0;
  let authorised = 0;

  const backstop = createBargeInBackstop({
    onFlush: () => { if (!policyAllowsRelease) { vetoed += 1; return; } released += 1; },
    onRelease: () => { if (!policyAllowsRelease) { vetoed += 1; return; } released += 1; },
  });

  policy.assistantSpeakingStarted();
  for (const level of levels) {
    const decision = policy.observe({ rms: level, echoRatio: null });
    policyAllowsRelease = decision.release;
    if (decision.release) authorised += 1;
    backstop.observe(frameAt(level), true);
    t += 100;
  }
  return { released, vetoed, authorised };
}

// 500ms of the protected window, then the operator talks over MYTHOS.
function afterProtectedWindow(rest) {
  return [MYTHOS_ONLY, MYTHOS_ONLY, MYTHOS_ONLY, MYTHOS_ONLY, MYTHOS_ONLY, ...rest];
}

describe('BUG-274 — a barge-in the policy authorises must actually be deliverable', () => {
  it('releases on continuous loud operator speech (this FAILED before the fix: 0 releases, 11 vetoes)', async () => {
    const result = await driveBargeIn(afterProtectedWindow(Array(30).fill(OPERATOR_LOUD)));
    assert.ok(
      result.authorised > 0,
      'the policy never authorised a release at all, so the sustain test is the fault and not the handoff',
    );
    assert.ok(
      result.released > 0,
      `the policy authorised ${result.authorised} time(s) and the operator was still never let in: `
      + `${result.released} release(s), ${result.vetoed} veto(es). The authorisation is not deliverable.`,
    );
  });

  it('keeps authorising while the assistant is still speaking, rather than latching to a single frame', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    let t = 0;
    const policy = createBargeInPolicy({ now: () => t });
    policy.assistantSpeakingStarted();

    // Walk out of the protected window, then hold above the floor until CONFIRMED.
    const step = (rms) => { const d = policy.observe({ rms, echoRatio: null }); t += 100; return d; };
    for (let i = 0; i < 5; i++) step(MYTHOS_ONLY);
    let confirmedAt = -1;
    for (let i = 0; i < 10 && confirmedAt < 0; i++) {
      if (step(OPERATOR_LOUD).release) confirmedAt = i;
    }
    assert.ok(confirmedAt >= 0, 'never confirmed on sustained loud speech');

    // The frames after confirmation are the ones the backstop is actually able to
    // fire on. If they answer "no", the interruption is lost.
    for (let i = 0; i < 6; i++) {
      const d = step(OPERATOR_LOUD);
      assert.equal(
        d.release,
        true,
        `frame ${i + 1} after confirmation answered release:false (${d.reason}) — `
        + 'the veto revokes an interruption it already granted, and the backstop only '
        + 'fires on every third frame, so this is where the operator is lost',
      );
    }
  });

  it('stops authorising the moment assistant speech ends', async () => {
    const { createBargeInPolicy } = await import(POLICY_URL);
    let t = 0;
    const policy = createBargeInPolicy({ now: () => t });
    policy.assistantSpeakingStarted();
    const step = (rms) => { const d = policy.observe({ rms, echoRatio: null }); t += 100; return d; };
    for (let i = 0; i < 5; i++) step(MYTHOS_ONLY);
    for (let i = 0; i < 8; i++) step(OPERATOR_LOUD);

    policy.assistantSpeakingEnded();
    const after = step(OPERATOR_LOUD);
    assert.equal(after.release, false, 'a release was still authorised with nothing playing');
    assert.equal(after.reason, 'not-speaking');
  });

  it('the sustain test still rejects bleed that decays with the assistant envelope', async () => {
    // Bleed follows MYTHOS's own amplitude and dips between its syllables. That is the
    // signature the 350ms sustain requirement exists to catch, and the fix must not
    // weaken it — otherwise self-interruption comes straight back.
    const bleed = [];
    for (let i = 0; i < 24; i++) bleed.push(i % 2 === 0 ? 0.06 : 0.01);
    const result = await driveBargeIn(afterProtectedWindow(bleed));
    assert.equal(result.released, 0, 'decaying bleed was treated as an interruption');
  });

  it('KNOWN FAILING SHAPE, recorded not fixed: 100ms dips reset the sustain timer', async () => {
    // Ordinary syllable spacing inside genuinely loud speech. PENDING resets on each
    // dip, 350ms is never reached, and no authorisation is ever issued — so this is a
    // second and independent defect that the handoff fix cannot reach. Asserted as it
    // stands so that a session which changes the sustain test sees this flip, rather
    // than a constant being guessed at for the third time.
    const dipped = [];
    for (let i = 0; i < 32; i++) dipped.push(i % 4 === 3 ? OPERATOR_DIP : OPERATOR_LOUD);
    const result = await driveBargeIn(afterProtectedWindow(dipped));
    assert.equal(
      result.authorised,
      0,
      'the sustain test now tolerates a 100ms dip. That may well be correct — if it was '
      + 'deliberate, update this test and say which session measured it.',
    );
  });
});
