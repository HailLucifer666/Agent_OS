// barge-in-policy.js — PURE playback-aware barge-in decision machine (BUG-272
// V1+V2+V5). No DOM, no audio, no timers: every input is passed in and the clock
// is injectable, so this is the one piece of the barge-in path that node:test can
// exercise directly (s2s-bridge.js needs a real browser and says so in its own
// header).
//
// WHY THIS EXISTS — and why "raise the threshold" is not the fix.
//
// The 2026-08-17 session interrupted itself on 45 of 72 turns (63%). BUG-271 had
// already raised the eager release tier from 0.035 to 0.05 for exactly this
// reason, and it did not help, because the operator's room bleeds speaker audio
// into the mic at 0.09-0.38 RMS — measured, over 46 eager releases. That is
// 2-7x above the raised eager tier and ALSO above the flush tier (0.056). Both
// static tiers are underwater.
//
// The same session held REAL barge-ins for 10-13 seconds (16 ceiling-fail-open
// events). Those two failures are not independent bugs; they are the same
// RMS-only policy failing in opposite directions. In this room, bleed overlaps
// the operator's own speech band, so NO scalar threshold separates them and any
// value chosen for one failure makes the other worse. That is the whole argument
// for a state machine over a constant.
//
// WHAT REPLACES THE THRESHOLD, in order of how much work each does:
//
//  1. A PROTECTED window at the start of assistant speech. Self-interruption
//     clusters at sentence onset, when MYTHOS's own first syllables are the
//     loudest thing in the room and no operator has had time to react. During
//     this window nothing releases, whatever the level. This is the cheapest and
//     largest win, and it needs no measurement at all.
//  2. PENDING before CONFIRMED. A loud frame no longer releases the gate; it
//     opens a candidacy that must SUSTAIN. Bleed tracks the assistant's own
//     amplitude envelope and decays with it, so it fails a sustain test that
//     continuous human speech passes.
//  3. An ADAPTIVE floor learned from this room's own measured bleed, rather than
//     a constant shipped from another room.
//
// Q5 — IS THIS CONSTANT ACTUALLY CORRECT? A correction to BUG-272's own spec,
// which asked for the adaptive floor to be "clamped below the flush tier
// (0.056)". Against this room's numbers that clamp is not merely useless, it is
// inverted: bleed at 0.09-0.38 is ABOVE 0.056, so a floor pinned below it would
// be crossed by bleed on essentially every frame and would reproduce V1 exactly.
// The floor here is therefore allowed to rise above the flush tier, and is
// bounded instead by MAX_BLEED_FLOOR — a pathological measurement must not be
// able to make MYTHOS permanently deaf to a real interruption. Deafness and
// self-interruption are both failures; this picks the bound that fails toward
// hearing the operator.

// Assistant speech is protected for this long after it starts. 500ms sits inside
// BUG-272's 400-700ms range: long enough to cover the onset where bleed peaks,
// short enough that a genuine immediate interruption still lands well under the
// 700ms target for real barge-in latency.
export const PROTECTED_MS = 500;

// A candidate must stay above the floor this long before it is believed. Bleed
// follows the assistant's amplitude envelope and dips between its own syllables;
// sustained human speech does not.
//
// 350 -> 200 on 2026-08-20: the staged plan's Stage 3, pulled because a live session
// finally said the 350 was insufficient, and said it with numbers rather than by feel.
// Over 89 turns the policy vetoed 26 barge-ins, TWELVE of them 'pending-sustaining',
// at 13 recorded levels: 0.0537 0.0623 0.0706 0.0746 0.0826 0.0955 | 0.1414 0.1482
// 0.1685 0.1709 0.1724 0.1983 0.2144. SEVEN of the thirteen sit ABOVE the room's own
// measured bleed peak (0.1193), so they are unambiguously the operator — refused not
// for being too quiet but for not lasting long enough. A one- or two-word interruption
// ("stop", "wait, no") is 200-400ms of speech; at a 350ms sustain plus the backstop's
// 3-frame cadence it was over before it could be believed. The operator scored the
// result 7-8/10: "sometimes it still is talking and it's not stopping immediately."
//
// The counting was read as bearing that out (11 stops, ONE cut audio). CORRECTED 2026-09-26
// (B1b): it counted only audio arriving AFTER each stop, not the queued speech the stop
// discarded, so the other ten were unmeasured, not "after the reply had already finished".
//
// THE RISK, STATED, because this weakens the thing that was doing the discriminating.
// The comment below still holds: this sustain is the PRIMARY bleed discriminator, and
// the room measured worse on 2026-08-20 than when that was written — bleed peaked at
// 0.1193 against a 0.035 floor, where the design assumed a clean peak of ~0.0309 BELOW
// the floor. So bleed now opens PENDING routinely and only the sustain test rejects it.
// 200ms should still clear it, because bleed dips between MYTHOS's own syllables at
// roughly 4-5 per second (~200-250ms apart) while human speech does not — but that
// margin is thinner than it was, and SELF-INTERRUPTION IS THE COUNTER-FAILURE TO WATCH.
// It already ran at 26/89 turns (at most 16.9% genuinely self-caused) BEFORE this change.
// If it rises, the honest response is to raise INITIAL_BLEED_FLOOR back toward 0.04,
// NOT to lengthen this again — that re-breaks exactly what this fixes.
//
// The real cure is upstream and is not a threshold: echo cancellation is not removing
// MYTHOS's voice at all (bleed 0.1193 with micEchoCancellation reporting true), which
// is BUG-274 T4. Every number here is a compensation for that.
export const PENDING_HOLD_MS = 200;

// How much captured audio one mic frame carries. NOT a tuning knob: it must match
// the frameMs the capture worklet is constructed with, which is s2s-bridge.js's own
// FRAME_MS. The two are separate declarations and a guard test asserts they are
// equal — test/bug-322 'the frame size the policy counts with matches the frame size
// the microphone is chopped into'. Drift between them mis-counts the sustain below,
// so it fails a test rather than passing silently.
//
// WHY A GUARD RATHER THAN ONE SHARED CONSTANT, since one definition is normally
// better than two agreeing. It was tried: importing FRAME_MS from here into
// s2s-bridge.js and deleting its local copy. That breaks s2s-preroll-ring.test.js,
// which reads the bridge as TEXT and matches `FRAME_MS = <digits>` to prove the
// preroll ring is derived from the frame size rather than hand-tuned — a real
// invariant, and a more valuable one than removing a duplicated literal. The bridge
// is a browser ES module with no Node double, so source-shape assertions are the
// only tool available there and moving a constant out of the file blinds them.
// The guard keeps both invariants and leaves s2s-bridge.js untouched.
//
// BUG-322, 2026-08-22 — WHY THE SUSTAIN NEEDS THIS AT ALL. The check below used to
// be wall-clock only: `t - pendingSince >= pendingHoldMs`. That is correct exactly
// while frames reach this module as fast as the microphone produces them, and
// nothing guarantees they do. pcm-capture-worklet.js fills a 100ms buffer on the
// audio thread and postMessage()s it; the main thread runs the handler when it next
// gets a turn, and while MYTHOS is speaking that thread is also decoding and playing
// audio. A backlog is delivered as a burst — every frame carrying a real 100ms of
// the operator's voice, and now() barely moving between them.
//
// The candidacy then sits in PENDING while the speech runs past it, and the
// frame-counting backstop fires on its 3rd, 6th and 9th frame into a policy that
// keeps answering 'pending-sustaining'. Measured in the operator's own session
// (2026-08-22): thirteen refusals, not one of them 'below-bleed-floor', seven of
// them 'pending-sustaining' at levels up to 0.3942 — ten times the floor, and more
// than double the loudest bleed the room produced all day (0.1641). Those were the
// operator shouting.
//
// Q6 — WHAT CLASS IS THIS? The same as BUG-274, from the other end: two counters
// required to agree, one in frames and one in milliseconds. BUG-274 fixed delivery;
// this fixes measurement. It was predicted at the time — see the known-failing shape
// recorded in bug-274-barge-in-authorisation-is-deliverable.test.js, deferred with an
// instruction to bring a measurement instead of a guess. The measurement is above.
export const FRAME_MS = 100;

// Learned floor = observed bleed peak x this.
//
// BUG-273 A1 — was 1.45, chosen from BUG-272's 1.4-1.5 band on the assumption
// that a raised human voice sits above this room's bleed. The 2026-08-18 session
// measured the opposite and the margin is now 1.0, i.e. the reported would-be
// floor is the raw measured bleed peak with no headroom added. With the learned
// term dormant (LEARNED_FLOOR_ENABLED below) this changes no behaviour — it only
// changes what learnedFloor() REPORTS, and the raw peak is the number the next
// session needs in order to decide whether the mechanism is salvageable.
export const BLEED_MARGIN = 1.0;

// Absolute bound on the learned floor (see the Q5 note above). Above this the
// gate would be rejecting real speech, so a measurement implying it is treated
// as the measurement being wrong rather than the room being that loud.
export const MAX_BLEED_FLOOR = 0.45;

// Floor before anything has been measured. Matches BUG-271's eager tier so a
// fresh session is never LESS willing to hear an interruption than it was
// before this module existed.
//
// BUG-273 A1 — Q5, IS THIS CONSTANT ACTUALLY CORRECT? Partly, and the honest
// answer is written here rather than implied. 0.05 is now the floor in every
// session (see LEARNED_FLOOR_ENABLED), and the 2026-08-18 session measured
// operator speech peaking at 0.0395-0.069. So 0.05 clears the loud end and sits
// ABOVE the quiet end: a turn peaking at 0.0395 still cannot open a candidacy.
// It is deliberately NOT lowered in this pass. Bleed in that room measured 0.123,
// so any floor under it depends entirely on the 350ms sustain test to reject
// bleed, and whether that holds is exactly what BUG-273 A2 exists to measure —
// what actually reaches Gemini during a hold. Lowering it blind is how V1 comes
// back, which is the pair of opposite failures BUG-272 already walked into once.
// BUG-274, 2026-08-19 — LOWERED 0.05 -> 0.035 ON MEASUREMENT, not on a hunch. This is
// the one constant this ticket changes, and the argument is a live measurement of both
// populations rather than a preference about sensitivity.
//
// THE FINDING: THIS REPO HAS TWO FLOORS 2.5x APART, ANSWERING THE SAME QUESTION.
//   live-noise-gate.js  LIVE_NOISE_GATE_FLOOR_RMS = 0.02  "the operator is speaking, so
//                                                          send this to Gemini"
//   here                INITIAL_BLEED_FLOOR       = 0.05  "the operator is speaking, so
//                                                          stop talking"
// Nobody reconciled them, so a 0.02-0.05 band existed where the operator was audible,
// transmitted, transcribed and answered — and completely invisible to barge-in. MYTHOS
// heard the interruption and kept talking. That is not a perception failure; it is two
// thresholds inside one codebase disagreeing about the same judgement.
//
// THE MEASUREMENT (live session 2026-08-19, `why=` telemetry added the same day):
//   room bleed, AEC3 on, operator silent   0.0031 - 0.0309   (clean readings only)
//   operator's QUIET interruptions         0.0398, 0.0480    (both produced NOTHING)
//   operator's normal interruptions        0.1006 - 0.2717   (vetoed, see below)
// The decisive hold: peak 0.0480 against a 0.05 floor — refused by 0.002 — while `raw`
// showed 34 frames (3.4s) of the operator's speech passing the noise gate and reaching
// the model. An 8.2-second interruption attempt that the barge-in path never considered.
//
// WHY 0.035. It is the only value that separates the two measured populations: above
// every clean bleed reading (max 0.0309) and below every level the operator actually
// interrupted at (min 0.0398). It is deliberately NOT the noise gate's 0.02 — that sits
// *inside* the bleed range, would open a candidacy on essentially every frame of
// MYTHOS's own speech, and is how BUG-272's V1 (63% self-interruption) comes back.
//
// Q1 — WHAT ELSE MATCHES THIS? Anything in the room above 0.035 while MYTHOS speaks: a
// television, a second person, a cough. That was already true at 0.05; the band widens
// by 0.015 and the SUSTAIN TEST is what still has to be satisfied. Which is exactly why:
//
// Q8 — PENDING_HOLD_MS IS DELIBERATELY *NOT* LOWERED IN THE SAME CHANGE. One lever at a
// time, because this ticket's predecessors twice made things worse by moving two. More
// importantly the 350ms sustain is now the PRIMARY bleed discriminator rather than a
// backup: at 0.05 nothing ever reached it, so it has never actually been exercised in
// this room. Bleed follows MYTHOS's own amplitude envelope and dips between its
// syllables; sustained human speech does not. If self-interruption rises next session,
// the honest response is to raise this floor back toward 0.04 — NOT to lengthen the
// sustain, which would re-break interruption in the way just fixed.
//
// Q5/Q7 — THE RISK, STATED. The margin over bleed is thin: 0.035 vs a 0.0309 clean peak.
// Self-interruption is the OPPOSITE failure and it is the one to watch — the release
// gate wants both. `verify-voice-session.js` reports the landed count and the veto
// reasons, so the next session can tell which direction it moved instead of guessing.
// Pinned by test/bug-274-barge-in-floor-separates-populations.test.js, which asserts
// against the measured numbers above rather than against this constant.
export const INITIAL_BLEED_FLOOR = 0.035;

// BUG-273 A1 — THE ADAPTIVE FLOOR IS DORMANT BY DEFAULT, AND THIS IS WHY.
//
// The 2026-08-18 session is the first real measurement of the mechanism, and it
// says the mechanism is actively harmful in this room. Learned bleedFloor settled
// at 0.1781, roughly 3x the operator's own 0.069 peak. Consequences, all measured:
// bargeVetoed 49, framesDropped 0, max own-voice hold 13,396ms. Nothing was lost —
// it all arrived 11-13 seconds late. That is V2, the exact failure BUG-272 set out
// to fix, reached from the other direction: BUG-272 argued (correctly) that no
// static threshold separates bleed from speech when the bands overlap, then shipped
// a LEARNED threshold, which has the same problem the moment bleed is the louder of
// the two. The header above claims bleed at 0.09-0.38 is "above a raised human
// voice"; in this room bleed is above the operator's NORMAL voice, and the floor
// derived from it can only be deaf.
//
// Q8 — WHY DORMANT RATHER THAN DELETED. One room is not a sample. The two parts
// of slice 3 with evidence behind them (the 500ms protected window and the 350ms
// sustain test) do the work; the learned floor was the speculative part, and a
// speculative part that measures badly once is not proven wrong everywhere. So the
// code stays, keeps measuring, and keeps REPORTING through learnedFloor() — the
// telemetry is the whole reason not to delete it — while contributing nothing to
// any decision. Re-enable per session with MYTHOS_BARGE_LEARNED_FLOOR=1 in
// localStorage, or per call with { learnedFloorEnabled: true }. If this constant is
// ever flipped back to true, the commit doing it should be able to name the room
// and the numbers that justify it.
//
// Q2 — DOES THIS HIDE EVIDENCE? It would have. bleedFloor() is the only
// barge-in number on the suspend/release log line, and pinning it at 0.05 would
// have made every future log read "floor 0.05" while saying nothing about what the
// room actually bleeds. s2s-bridge.js therefore reports bleedPeak and learnedFloor
// alongside it, and scripts/verify-voice-session.js prints all three.
export const LEARNED_FLOOR_ENABLED = false;

export const STATES = {
  IDLE: 'IDLE',
  PROTECTED: 'ASSISTANT_SPEAKING_PROTECTED',
  INTERRUPTIBLE: 'ASSISTANT_SPEAKING_INTERRUPTIBLE',
  PENDING: 'BARGE_IN_PENDING',
  CONFIRMED: 'BARGE_IN_CONFIRMED',
};

export function createBargeInPolicy(opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const protectedMs = numberOr(o.protectedMs, PROTECTED_MS);
  const pendingHoldMs = numberOr(o.pendingHoldMs, PENDING_HOLD_MS);
  const bleedMargin = numberOr(o.bleedMargin, BLEED_MARGIN);
  const maxBleedFloor = numberOr(o.maxBleedFloor, MAX_BLEED_FLOOR);
  const initialFloor = numberOr(o.initialBleedFloor, INITIAL_BLEED_FLOOR);
  // BUG-322: how much audio one frame carries. See FRAME_MS.
  const frameMs = numberOr(o.frameMs, FRAME_MS);
  // BUG-273 A1: opt-in, default off. See LEARNED_FLOOR_ENABLED.
  const learnedFloorEnabled = typeof o.learnedFloorEnabled === 'boolean'
    ? o.learnedFloorEnabled : LEARNED_FLOOR_ENABLED;

  let state = STATES.IDLE;
  let speakingSince = 0;
  let pendingSince = 0;
  let pendingFrames = 0;
  let bleedPeak = 0;       // loudest level seen while MYTHOS was provably speaking
  let lastFloor = initialFloor;
  // BUG-388: the level of the last frame heard while MYTHOS was SILENT. This is the
  // only evidence the client has about who was already talking when the assistant
  // opened its mouth, and it is what decides whether the protected window below is
  // allowed to attribute anything to MYTHOS at all.
  let lastIdleRms = 0;
  let windowAttributable = true;
  let bleedWindowsSkipped = 0;

  // What this room WOULD have earned: bleed observed during assistant speech,
  // clamped below by the pre-existing eager tier (so it is never a sensitivity
  // regression) and above by MAX_BLEED_FLOOR (so it cannot go deaf).
  //
  // BUG-273 A1: computed and reported unconditionally, applied only when the
  // learned floor is enabled. Keeping the measurement running while it decides
  // nothing is the point — it is what a future session will be judged on.
  function learnedFloor() {
    return Math.min(maxBleedFloor, Math.max(initialFloor, bleedPeak * bleedMargin));
  }

  // The floor actually in force. Dormant by default (BUG-273 A1): 0.1781 learned
  // against a 0.069 operator peak held real barge-ins for 13.4 seconds.
  function bleedFloor() {
    lastFloor = learnedFloorEnabled ? learnedFloor() : initialFloor;
    return lastFloor;
  }

  function assistantSpeakingStarted() {
    // Re-entrant on purpose: audio arrives as a stream of chunks and the caller
    // should not have to track whether this is the first one. Only a transition
    // OUT of not-speaking restarts the protection window, so a mid-sentence
    // chunk cannot silently re-protect and make MYTHOS uninterruptible for as
    // long as it keeps talking — which would be V2 rebuilt on purpose.
    if (state !== STATES.IDLE) return state;
    // BUG-388 — WHETHER THIS WINDOW MAY TEACH THE FLOOR ANYTHING, decided here and
    // once, on the last thing heard before MYTHOS started. If the operator was
    // already above the floor, every frame of the coming window is theirs as much
    // as MYTHOS's and nothing downstream can separate them.
    //
    // Compared against `initialFloor` and DELIBERATELY NOT against bleedFloor():
    // bleedFloor() is the learned value, so a peak that has already been poisoned
    // would raise the bar for calling the next window contaminated. Poison must not
    // be allowed to protect itself. The static floor is a fixed, measured constant
    // (see INITIAL_BLEED_FLOOR) and cannot drift with the thing it is judging.
    windowAttributable = lastIdleRms <= initialFloor;
    if (!windowAttributable) bleedWindowsSkipped += 1;
    state = STATES.PROTECTED;
    speakingSince = now();
    pendingSince = 0;
    pendingFrames = 0;
    return state;
  }

  function assistantSpeakingEnded() {
    state = STATES.IDLE;
    speakingSince = 0;
    pendingSince = 0;
    pendingFrames = 0;
    return state;
  }

  // One 100ms mic frame. `rms` is the measured level; `echoRatio` is the echo
  // filter's verdict if a transcript exists for this speech yet (null when it
  // does not, which is the common case — Gemini's VAD reacts to audio well
  // before any transcript). Returns the decision for THIS frame.
  function observe(input) {
    const i = input || {};
    const rms = numberOr(i.rms, 0);
    const echoRatio = typeof i.echoRatio === 'number' ? i.echoRatio : null;
    const t = now();

    if (state === STATES.IDLE) {
      // BUG-388: recorded, not acted on. MYTHOS is silent, so whatever this level
      // is, it is not bleed — which is exactly what makes it usable as the test of
      // whether the NEXT protected window can attribute its frames to MYTHOS.
      lastIdleRms = rms;
      return decision(false, 'not-speaking');
    }

    // WHERE THE FLOOR IS ALLOWED TO LEARN — and the trap that is easy to walk
    // into here. The first version of this module updated bleedPeak from EVERY
    // frame heard while MYTHOS was speaking, on the reasoning that biasing the
    // floor upward is the safe direction. It is not: the operator's own voice is
    // one of those frames, so their speech raised the floor above itself and
    // nothing could ever confirm. A self-poisoning detector — the adaptive
    // mechanism destroyed by the very signal it exists to distinguish. Caught by
    // the sustained-speech test, which released 0 times.
    //
    // So learning is restricted to frames we can attribute to MYTHOS without
    // circular reasoning:
    //   * the PROTECTED window, where no release is possible anyway and the
    //     assistant's own onset is by construction the loudest thing present;
    //   * frames the echo filter has positively identified as MYTHOS's words.
    // Known limit, stated rather than hidden: if bleed later in a sentence is
    // louder than at its onset, the floor under-measures it. Under-measuring
    // costs a PENDING that has to decay, which the sustain test already handles;
    // over-measuring costs a deaf assistant, which nothing recovers.
    // BUG-388 — AND THE ASSUMPTION ABOVE IS FALSE, MEASURED. "the assistant's own
    // onset is by construction the loudest thing present" was written as reasoning,
    // never checked, and 20 live sessions in mythos-server.log disprove it: across
    // 31 upward moves of bleedPeak above 0.05, TWENTY-TWO landed on a value exactly
    // equal to that hold's own peakRms -- the loudest mic frame of the hold, i.e.
    // the operator. It is not a coincidence that it can be: MYTHOS's voice reaches
    // the mic through the speakers and is then attenuated 15-20dB by AEC (measured,
    // scripts/probe-aec-routes.js), while the operator's arrives direct. Whenever
    // both are present the operator is by construction the LOUDER one, which is the
    // exact opposite of what this window assumed.
    //
    // Every session in that log opens between 0.0043 and 0.0347 -- the real room,
    // agreeing with the acoustic probe -- and then ratchets to 0.10-0.33 the first
    // time the operator speaks into a protected window. bleedPeak is a running max
    // that never decays, so ONE such frame poisons the whole process: 2026-08-24
    // read 0.1606 for 110 consecutive holds off a single frame. The uncontaminated
    // control is 2026-08-26, which ended at 0.0313 while the operator peaked 0.1402.
    //
    // Diagnosed 2026-08-19 and deliberately deferred then, on the grounds that the
    // learned floor is dormant so "consequence today is nil". That premise was
    // wrong, and finding the consumer is what reopened this: verify-voice-session.js
    // called bleedPeak "the ungagged oracle" and concluded from it that "echo
    // cancellation is not removing it" -- a hardware verdict, from the operator's
    // own voice. See BUG-388.
    const inProtectedWindow = state === STATES.PROTECTED && t - speakingSince < protectedMs;
    if (inProtectedWindow && windowAttributable && rms > bleedPeak) bleedPeak = rms;

    if (state === STATES.PROTECTED) {
      if (inProtectedWindow) return decision(false, 'protected-window');
      state = STATES.INTERRUPTIBLE;
    }

    const floor = bleedFloor();

    // A transcript that the echo filter recognises as MYTHOS's own words is
    // positive evidence of bleed, and it outranks the level entirely — this is
    // the one signal that can tell the two apart on amplitude alone.
    if (echoRatio !== null && echoRatio >= 0.6) {
      // Positively attributed to MYTHOS, so this frame is a legitimate bleed
      // measurement even outside the protected window (see the learning note).
      if (rms > bleedPeak) bleedPeak = rms;
      if (state === STATES.PENDING) { state = STATES.INTERRUPTIBLE; pendingSince = 0; pendingFrames = 0; }
      return decision(false, 'echo-transcript');
    }

    if (state === STATES.INTERRUPTIBLE) {
      if (rms <= floor) return decision(false, 'below-bleed-floor');
      state = STATES.PENDING;
      pendingSince = t;
      pendingFrames = 1;
      return decision(false, 'pending-opened');
    }

    if (state === STATES.PENDING) {
      if (rms <= floor) {
        // Decayed. Bleed follows the assistant's own envelope, so this is the
        // signature that separates it from speech.
        state = STATES.INTERRUPTIBLE;
        pendingSince = 0;
        pendingFrames = 0;
        return decision(false, 'pending-decayed');
      }
      pendingFrames += 1;
      // BUG-322: 200ms of SPEECH, measured the way the audio actually arrives.
      //
      // pendingHoldMs is unchanged and still means 200ms. What changed is that the
      // clock is no longer the only witness to it: each frame in PENDING is a known
      // quantity of captured audio, so the frames themselves measure the same span.
      // Whichever has seen more of the utterance wins. Under healthy real-time
      // delivery the two are arithmetically identical — frame N lands at
      // pendingSince + (N-1)*frameMs — so this changes nothing about a normal turn,
      // which test 2 of bug-322 pins frame-for-frame.
      //
      // The candidacy opens on frame 1 having sustained nothing yet, so elapsed
      // audio is (pendingFrames - 1) * frameMs: the third frame is the one carrying
      // the 200th millisecond, exactly as the clock version confirmed on it.
      //
      // Q1 — WHAT ELSE MATCHES THIS? Only frames already in PENDING, which means
      // already past the protected window and already above the floor on every frame
      // since the candidacy opened. Nothing here widens what gets in; the decay rule
      // above is untouched, so a single below-floor frame still resets the count to
      // zero and bleed cannot accumulate across its own syllable gaps.
      // Q5 — IS THIS CONSTANT CORRECT? frameMs is not a chosen threshold. It is a
      // property of the capture worklet, passed in from the one place that builds it.
      // If they ever disagree this under- or over-counts, which is why it is wired
      // through rather than duplicated as a literal.
      const sustainedMs = Math.max(t - pendingSince, (pendingFrames - 1) * frameMs);
      if (sustainedMs >= pendingHoldMs) {
        state = STATES.CONFIRMED;
        return decision(true, 'confirmed-sustained');
      }
      return decision(false, 'pending-sustaining');
    }

    // CONFIRMED holds its answer for as long as MYTHOS is still speaking.
    //
    // BUG-274, 2026-08-19 — THIS LINE USED TO RETURN false, AND THAT IS WHY
    // INTERRUPTION FAILED. The old comment read "the release has already been issued
    // and must not be issued twice", which assumed the caller acted on the frame that
    // authorised it. It does not, and it cannot:
    //
    //   this module confirms on ONE frame — PENDING opens on the first above-floor
    //   frame and CONFIRMED lands when pendingHoldMs (350ms) has elapsed, i.e. the 5th
    //   frame of a 100ms run;
    //
    //   barge-in-backstop.js delivers on EVERY THIRD frame, because
    //   decideBargeIn() zeroes its own counter when it fires (voice-loop.js:131), so
    //   onFlush/onRelease reach s2s-bridge.js on frames 3, 6, 9 ... and no others.
    //
    // 5 is not a multiple of 3. The single authorised frame was handed to a caller that
    // was not listening on it, and from the next frame this line answered "no" for the
    // rest of the utterance. Measured with both real modules wired as s2s-bridge.js
    // wires them: continuous speech at 0.27 RMS — the level the operator's own
    // 2026-08-19 log recorded, against a 0.05 floor and 0.0186 measured bleed —
    // produced ZERO releases and eleven vetoes. Not intermittent. Impossible.
    //
    // Q1 — WHAT ELSE MATCHES THIS? Only frames while state === CONFIRMED, which is
    // reachable only through the protected window, the floor and the full sustain test.
    // Nothing here widens what gets in; it stops revoking what already got in.
    //
    // Q3 — WHO READS THIS, and is issuing twice safe? Both consumers are idempotent
    // and were already written that way: releaseOwnVoiceGate() early-returns on
    // `if (!ownVoiceGate) return`, player.flush() is a documented no-op on an empty
    // queue, and the backstop's own releasedThisRun latch bounds onRelease to once per
    // loud run. In practice the window is one frame wide anyway — the first delivered
    // release calls releaseOwnVoiceGate(), which calls assistantSpeakingEnded() and
    // sends this machine back to IDLE, where the next frame answers 'not-speaking'.
    //
    // Q8 — WHAT IS DELIBERATELY UNCHANGED: PROTECTED_MS, PENDING_HOLD_MS, the
    // dormant learned floor, INITIAL_BLEED_FLOOR, and both backstop tiers with their
    // thresholds and hysteresis. This is not a retune, and the next session must not
    // read it as permission to become one. Pinned by
    // test/bug-274-barge-in-authorisation-is-deliverable.test.js, which also keeps the
    // sustain test's rejection of decaying bleed asserted alongside this.
    return decision(true, 'already-confirmed');
  }

  // The decision to make when a hold has run out of time. Replaces a bare
  // fail-open: at the ceiling we still know things, and dropping the buffered
  // audio versus interrupting are very different mistakes.
  //
  // Bias: with no evidence of echo, INTERRUPT. A wrongly-interrupted MYTHOS is
  // recoverable in one sentence; a swallowed operator utterance is not, and
  // "a deaf assistant is the worse failure" is already this codebase's stated
  // position at the other fail-open.
  function ceilingDecision(input) {
    const i = input || {};
    const echoRatio = typeof i.echoRatio === 'number' ? i.echoRatio : null;
    const hasTranscript = Boolean(i.hasTranscript);
    const peakRms = numberOr(i.peakRms, 0);
    if (echoRatio !== null && echoRatio >= 0.6) return { release: false, reason: 'ceiling-echo-like' };
    if (hasTranscript) return { release: true, reason: 'ceiling-user-like' };
    if (peakRms >= bleedFloor()) return { release: true, reason: 'ceiling-near-field-energy' };
    return { release: true, reason: 'ceiling-no-evidence-of-echo' };
  }

  function decision(release, reason) {
    return { release, reason, state, bleedFloor: lastFloor, pendingFrames };
  }

  function reset() {
    state = STATES.IDLE;
    speakingSince = 0;
    pendingSince = 0;
    pendingFrames = 0;
    // bleedPeak deliberately SURVIVES a reset: it is a property of the room and
    // the speaker volume, not of one turn. Re-learning it from zero on every
    // turn would put the floor back at the static tier for the first frames of
    // every reply — which is precisely when self-interruption happens.
  }

  // Session teardown, where the room genuinely may have changed.
  function forgetRoom() {
    bleedPeak = 0;
    lastFloor = initialFloor;
    // BUG-388: the refusal count is a property of the session too, not of the room.
    bleedWindowsSkipped = 0;
    windowAttributable = true;
    lastIdleRms = 0;
  }

  return {
    observe,
    ceilingDecision,
    assistantSpeakingStarted,
    assistantSpeakingEnded,
    bleedFloor,
    // BUG-273 A1: the dormant measurement, exposed so the telemetry can carry it.
    learnedFloor,
    reset,
    forgetRoom,
    state: () => state,
    bleedPeak: () => bleedPeak,
    // BUG-388 — Q2, DOES THIS HIDE EVIDENCE? It would have. Refusing to learn is
    // indistinguishable, in bleedPeak alone, from a room that simply never bled,
    // and "the floor learned nothing" is a very different fact from "the room is
    // quiet". These two say which happened. Not added to the suspend log line only
    // because s2s-bridge.js sits exactly on its file-size ratchet ceiling; the fix
    // does not need them, because bleedPeak is now trustworthy by construction
    // rather than needing a caveat field travelling beside it.
    bleedWindowsSkipped: () => bleedWindowsSkipped,
    bleedAttributable: () => windowAttributable,
  };
}

function numberOr(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}
