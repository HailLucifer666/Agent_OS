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
const fs = require('node:fs');
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
async function driveBargeIn(levels, opts = {}) {
  const { createBargeInPolicy } = await import(POLICY_URL);
  const { createBargeInBackstop } = await import(BACKSTOP_URL);
  const deferred = opts.deferred !== false;   // s2s-bridge's behaviour; false = the old wiring

  let t = 0;
  const policy = createBargeInPolicy({ now: () => t, ...(opts.policy || {}) });
  let policyAllowsRelease = false;
  let released = 0;
  let vetoed = 0;
  let authorised = 0;
  let gateHeld = true;                        // stands in for ownVoiceGate
  let attemptedThisHold = false;
  let lastReason = null;
  // BUG-274 step 5: the fake pcm-player. Counting flush() separately from the gate
  // release is the whole point — until 2026-08-19 the eager tier released the gate
  // and never touched the player, so a "landed" barge-in could reopen the mic while
  // MYTHOS carried on talking, and every counter in this harness said success.
  let playbackStops = 0;
  const player = { flush: () => { playbackStops += 1; } };

  const veto = () => {
    vetoed += 1;
    // Mirrors noteBargeVetoed(): only a candidacy that was building counts.
    if (lastReason === 'pending-sustaining' || lastReason === 'pending-opened') attemptedThisHold = true;
  };
  // Mirrors s2s-bridge.js's stopAssistantSpeech(): flush FIRST and unconditionally
  // (releaseOwnVoiceGate early-returns when the gate is already open, so the two
  // counts are deliberately allowed to differ), then release.
  // eagerFlush:false is the pre-2026-08-19 wiring, kept so the case below can show
  // the old shape failing rather than asserting against a harness written to pass.
  const eagerFlush = opts.eagerFlush !== false;
  const stopAssistantSpeech = (flushes = true) => {
    if (flushes) player.flush();
    if (gateHeld) { released += 1; gateHeld = false; }
  };
  const backstop = createBargeInBackstop({
    onFlush: () => { if (!policyAllowsRelease) return veto(); stopAssistantSpeech(); },
    onRelease: () => { if (!policyAllowsRelease) return veto(); stopAssistantSpeech(eagerFlush); },
  });

  policy.assistantSpeakingStarted();
  for (const level of levels) {
    const decision = policy.observe({ rms: level, echoRatio: null });
    policyAllowsRelease = decision.release;
    lastReason = decision.reason;
    // Mirrors s2s-bridge: a dead candidacy cannot leave a live attempt behind.
    if (decision.reason === 'pending-decayed'
      || decision.reason === 'below-bleed-floor'
      || decision.reason === 'echo-transcript') {
      attemptedThisHold = false;
    }
    if (decision.release) authorised += 1;
    backstop.observe(frameAt(level), true);
    // The deferred delivery, wired exactly as s2s-bridge.js wires it: AFTER the
    // backstop, so a tier firing on this frame takes the normal path first.
    if (deferred && policyAllowsRelease && attemptedThisHold && gateHeld) {
      stopAssistantSpeech();
    }
    t += 100;
  }
  return { released, vetoed, authorised, attemptedThisHold, playbackStops };
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

  // --- second pass, from the 2026-08-19 LIVE session -------------------------
  //
  // The first fix landed one real interruption (`barge-in-confirmed`, held 8132ms,
  // peak 0.1344) — the first in this repo's recorded history. But the same session
  // showed the handoff failing one step EARLIER, three times, and the telemetry
  // added in the same commit named it outright:
  //
  //   held= 9426ms peak=0.1101 vetoed=7 why=pending-sustaining at=0.1077
  //   held= 8128ms peak=0.1246 vetoed=4 why=pending-sustaining at=0.0883
  //   held=12603ms peak=0.1057 vetoed=1 why=pending-sustaining at=0.0814
  //
  // Never 'below-bleed-floor' (so the 0.05 floor is right and no threshold needed
  // changing) and never 'already-confirmed' (so the first fix held). Always
  // 'pending-sustaining': the backstop fires after 3 frames = 300ms, the policy
  // confirms at 350ms, so the backstop is ALWAYS early, is refused, and spends its
  // shot — the eager tier latches on releasedThisRun and the flush tier zeroes its
  // counter, putting the next chance at frame 6.
  describe('an attempt refused only for being early is still delivered when the policy catches up', () => {
    // Five frames is the shortest run that can confirm at all: PENDING opens on
    // frame 1 and 350ms has elapsed by frame 5. The backstop fires on frame 3 and
    // is refused; its next chance would be frame 6, which never comes.
    const FIVE_FRAME_RUN = afterProtectedWindow([...Array(5).fill(OPERATOR_LOUD), OPERATOR_DIP, OPERATOR_DIP]);

    it('the old wiring loses it — the backstop asks at 300ms and never asks again', async () => {
      const result = await driveBargeIn(FIVE_FRAME_RUN, { deferred: false });
      // >= 1 rather than == 1: CONFIRMED keeps answering yes (the first fix), so the
      // trailing frames of the run answer yes too. In production the gate is already
      // released by then; here nothing releases it, which is the point of this case.
      assert.ok(result.authorised >= 1, 'the policy should have confirmed on frame 5');
      assert.equal(result.released, 0,
        'this is the live failure: authorised once, refused, and never delivered');
      assert.ok(result.vetoed > 0, 'the backstop must have tried and been refused');
    });

    it('the deferred delivery lands it on the frame the policy confirms', async () => {
      const result = await driveBargeIn(FIVE_FRAME_RUN);
      assert.equal(result.released, 1,
        `expected the refused attempt to be delivered once the policy caught up: `
        + `${result.released} release(s), ${result.vetoed} veto(es), authorised ${result.authorised}`);
    });

    it('is NOT a bypass: without a refused attempt, nothing is delivered early', async () => {
      // Bleed that never clears a backstop tier can never set the attempt flag, so
      // the deferred path cannot fire for it however the policy is feeling.
      const belowTiers = Array(20).fill(0.04);   // above nothing: under floor and under both tiers
      const result = await driveBargeIn(afterProtectedWindow(belowTiers));
      assert.equal(result.attemptedThisHold, false, 'no backstop tier was cleared, so no attempt exists');
      assert.equal(result.released, 0, 'a release was delivered with no level ever qualifying');
    });

    it('still requires the full sustain test — an early attempt does not shortcut it', async () => {
      // Two loud frames then a dip, repeatedly: enough to clear a tier eventually
      // but never enough to satisfy the policy. Nothing may be delivered.
      const stuttered = [];
      for (let i = 0; i < 30; i++) stuttered.push(i % 3 === 2 ? OPERATOR_DIP : OPERATOR_LOUD);
      const result = await driveBargeIn(afterProtectedWindow(stuttered));
      assert.equal(result.authorised, 0, 'the policy must not have confirmed on this shape');
      assert.equal(result.released, 0, 'delivered a release the policy never authorised');
    });

    it('Q1: a candidacy that dies takes its attempt with it', async () => {
      // Three loud frames clear a backstop tier and are refused for being early, so
      // an attempt exists. Then the sound stops. Without clearing, that attempt would
      // sit armed for the rest of the utterance, waiting for ANY later confirmation —
      // a television, a second person, a door — to cash it in. The level condition was
      // never widened; the window it could be met in would have been.
      const shortRunThenSilence = afterProtectedWindow([
        OPERATOR_LOUD, OPERATOR_LOUD, OPERATOR_LOUD,
        OPERATOR_DIP, OPERATOR_DIP, OPERATOR_DIP, OPERATOR_DIP,
      ]);
      const result = await driveBargeIn(shortRunThenSilence);
      assert.ok(result.vetoed > 0, 'the backstop must have fired and been refused, or this proves nothing');
      assert.equal(result.attemptedThisHold, false,
        'the attempt outlived the candidacy that created it — a later unrelated sound could cash it in');
      assert.equal(result.released, 0, 'a run too short to confirm must not release');
    });

    it('s2s-bridge.js clears the attempt when the candidacy dies, not only per hold', async () => {
      const src = fs.readFileSync(path.join(voiceDir, 's2s-bridge.js'), 'utf8');
      assert.ok(/pending-decayed/.test(src) && /below-bleed-floor/.test(src),
        'the decay/below-floor reasons must clear bargeAttemptedThisHold in s2s-bridge.js');
    });

    it('s2s-bridge.js actually contains the deferred delivery, after the backstop', async () => {
      // The rule above is exercised against a copy of the wiring, so this pins that
      // the real file has it — and has it in the right ORDER, since running it
      // before bargeBackstop.observe() would decide on the previous frame's verdict.
      const src = fs.readFileSync(path.join(voiceDir, 's2s-bridge.js'), 'utf8');
      const observeAt = src.indexOf('bargeBackstop.observe(e.data');
      const deferredAt = src.indexOf('bargeAttemptedThisHold && ownVoiceGate');
      assert.ok(observeAt > 0, 'bargeBackstop.observe(e.data ...) not found');
      assert.ok(deferredAt > 0, 'the deferred delivery is missing from s2s-bridge.js');
      assert.ok(deferredAt > observeAt,
        'the deferred delivery must run AFTER bargeBackstop.observe, or it acts on a stale verdict');
      assert.ok(/bargeAttemptedThisHold = false;/.test(src),
        'the attempt flag must be cleared per hold, or a stale candidacy releases the next utterance');
    });
  });

  // --- step 5, 2026-08-19: an authorised barge-in must STOP THE SPEECH ---------
  //
  // The tier that reopens the microphone was not the tier that stopped the speech.
  // Before this, s2s-bridge.js read:
  //
  //   onFlush:   if (policyAllowsRelease) { player.flush(); releaseOwnVoiceGate('barge-in'); }
  //   onRelease: if (policyAllowsRelease) { releaseOwnVoiceGate('barge-in-confirmed'); }
  //
  // and releaseOwnVoiceGate() never touches the player (every "flush" inside it
  // refers to the preroll ring). So an eager-tier release opened the mic and MYTHOS
  // carried on talking — which is the operator's complaint, and it was counted as a
  // landing by both this file's harness and verify-voice-session.js.
  //
  // HOW NARROW THIS IS, stated rather than overclaimed. Both tiers count 3 frames,
  // so on a run above BACKSTOP_RMS_THRESHOLD they fire on the SAME frame and the
  // flush tier stops playback anyway. The eager tier is alone only while the level
  // sits in the band between the two thresholds — quiet-but-real speech. That band
  // is what this describe block drives, and it is the only thing this change fixes.
  // The reason MYTHOS keeps talking on LOUD attempts is a different defect entirely:
  // see test/bug-274-local-flush-does-not-stop-the-turn.test.js.
  describe('every authorised barge-in route stops playback, not only the mic gate', () => {
    it('an eager-tier-only release stops playback', async () => {
      const { INITIAL_BLEED_FLOOR } = await import(POLICY_URL);
      const { BACKSTOP_RELEASE_RMS_THRESHOLD, BACKSTOP_RMS_THRESHOLD } = await import(BACKSTOP_URL);
      // Derived, so Stage 2 (aligning the eager tier to the policy floor) cannot make
      // this test silently vacuous by collapsing the band it drives.
      assert.ok(INITIAL_BLEED_FLOOR < BACKSTOP_RELEASE_RMS_THRESHOLD,
        'the policy floor must sit below the eager tier, or there is no level that '
        + 'confirms the policy without also firing a backstop tier');
      assert.ok(BACKSTOP_RELEASE_RMS_THRESHOLD < BACKSTOP_RMS_THRESHOLD,
        'the two backstop tiers are equal, so an eager-only fire is unreachable and '
        + 'this test proves nothing — say so in the commit that collapsed them');
      // Above the policy floor, below BOTH backstop tiers: confirms the policy while
      // no tier fires, so no veto happens and the deferred route stays disarmed.
      const QUIET_CONFIRM = (INITIAL_BLEED_FLOOR + BACKSTOP_RELEASE_RMS_THRESHOLD) / 2;
      // Above the eager tier, below the flush tier: only onRelease can fire.
      const EAGER_ONLY = (BACKSTOP_RELEASE_RMS_THRESHOLD + BACKSTOP_RMS_THRESHOLD) / 2;

      const sequence = afterProtectedWindow([
        ...Array(6).fill(QUIET_CONFIRM),   // policy reaches CONFIRMED here
        ...Array(4).fill(EAGER_ONLY),      // eager tier fires on the 3rd of these
      ]);

      // The old wiring, so this case cannot pass vacuously: the gate opens, the
      // operator is heard, and MYTHOS is never told to stop.
      const before = await driveBargeIn(sequence, { eagerFlush: false });
      assert.equal(before.released, 1, 'the eager tier should have released the gate once');
      assert.equal(before.playbackStops, 0,
        'the old wiring is supposed to be the defect: mic reopened, speech untouched');

      const result = await driveBargeIn(sequence);
      assert.equal(result.vetoed, 0,
        'this sequence must not veto anything, or the deferred route could be what '
        + 'delivered the release and the eager tier would be untested');
      assert.equal(result.released, 1, 'the eager tier should have released the gate once');
      assert.ok(result.playbackStops > 0,
        'the gate was reopened and MYTHOS was never told to stop talking — this is '
        + 'exactly what the operator hears, and every other counter here calls it a landing');
    });

    it('s2s-bridge.js routes all three barge-in reasons through one door that flushes', () => {
      // Q6/one-door: three call sites had to remember to flush and one did not. The
      // assertion is the SHAPE — a single helper — not three separate window scans,
      // because a fourth tier would otherwise be free to forget again.
      const src = fs.readFileSync(path.join(voiceDir, 's2s-bridge.js'), 'utf8');
      const door = /function stopAssistantSpeech\([\s\S]{0,600}?\n {2}}/.exec(src);
      assert.ok(door, 'stopAssistantSpeech() is missing from s2s-bridge.js');
      assert.ok(/player\.flush\(\)/.test(door[0]),
        'the single stop-speech door does not flush the player, so releasing the gate '
        + 'reopens the mic while MYTHOS keeps talking');
      assert.ok(/releaseOwnVoiceGate\(/.test(door[0]),
        'the door must also release the half-duplex gate');
      for (const reason of ['barge-in', 'barge-in-confirmed', 'barge-in-deferred']) {
        assert.ok(
          src.includes(`stopAssistantSpeech('${reason}')`),
          `'${reason}' does not go through stopAssistantSpeech(), so it can reopen the `
          + 'mic without stopping the speech',
        );
        assert.ok(
          !src.includes(`releaseOwnVoiceGate('${reason}')`),
          `'${reason}' still calls releaseOwnVoiceGate() directly, bypassing the flush`,
        );
      }
    });
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
