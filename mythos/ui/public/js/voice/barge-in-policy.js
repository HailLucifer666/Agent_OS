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
export const PENDING_HOLD_MS = 350;

// Learned floor = observed bleed peak x this. 1.45 sits in BUG-272's 1.4-1.5
// band: above the bleed that produced it, below a raised human voice.
export const BLEED_MARGIN = 1.45;

// Absolute bound on the learned floor (see the Q5 note above). Above this the
// gate would be rejecting real speech, so a measurement implying it is treated
// as the measurement being wrong rather than the room being that loud.
export const MAX_BLEED_FLOOR = 0.45;

// Floor before anything has been measured. Matches BUG-271's eager tier so a
// fresh session is never LESS willing to hear an interruption than it was
// before this module existed.
export const INITIAL_BLEED_FLOOR = 0.05;

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

  let state = STATES.IDLE;
  let speakingSince = 0;
  let pendingSince = 0;
  let pendingFrames = 0;
  let bleedPeak = 0;       // loudest level seen while MYTHOS was provably speaking
  let lastFloor = initialFloor;

  // The floor this room has earned. Learned from bleed observed during assistant
  // speech, never below the pre-existing eager tier (so this is not a
  // sensitivity regression) and never above MAX_BLEED_FLOOR (so it cannot go
  // deaf).
  function bleedFloor() {
    const learned = bleedPeak * bleedMargin;
    lastFloor = Math.min(maxBleedFloor, Math.max(initialFloor, learned));
    return lastFloor;
  }

  function assistantSpeakingStarted() {
    // Re-entrant on purpose: audio arrives as a stream of chunks and the caller
    // should not have to track whether this is the first one. Only a transition
    // OUT of not-speaking restarts the protection window, so a mid-sentence
    // chunk cannot silently re-protect and make MYTHOS uninterruptible for as
    // long as it keeps talking — which would be V2 rebuilt on purpose.
    if (state !== STATES.IDLE) return state;
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
    const inProtectedWindow = state === STATES.PROTECTED && t - speakingSince < protectedMs;
    if (inProtectedWindow && rms > bleedPeak) bleedPeak = rms;

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
      if (t - pendingSince >= pendingHoldMs) {
        state = STATES.CONFIRMED;
        return decision(true, 'confirmed-sustained');
      }
      return decision(false, 'pending-sustaining');
    }

    // CONFIRMED is terminal until the caller resets or assistant speech ends —
    // the release has already been issued and must not be issued twice.
    return decision(false, 'already-confirmed');
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
  function forgetRoom() { bleedPeak = 0; lastFloor = initialFloor; }

  return {
    observe,
    ceilingDecision,
    assistantSpeakingStarted,
    assistantSpeakingEnded,
    bleedFloor,
    reset,
    forgetRoom,
    state: () => state,
    bleedPeak: () => bleedPeak,
  };
}

function numberOr(v, fallback) {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}
