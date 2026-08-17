// barge-in-backstop.js — the client-side half of barge-in for the Gemini Live
// (S2S) path.
//
// The server half already works end to end: Gemini's own VAD fires `interrupted`
// -> live-session.js -> server emits `live-interrupted` -> s2s-bridge.js calls
// player.flush(). What was missing is the case the V2 spine calls out at
// MYTHOS-IRIS-Synthesis-Plan-V2-spine.md:1002-1005 — "keep decideBargeIn() as a
// client-side backstop for the case where the server's VAD misses." When
// Google's VAD misses an overlap (quiet room, operator speaking softly over a
// loud reply, a network stall on the way to the server) nothing on the desktop
// stops the audio, and the operator experiences it as MYTHOS talking over them.
//
// TWO PROPERTIES THIS MODULE MUST KEEP, both deliberate:
//
// 1. LOCAL STOP ONLY. On a verdict this stops OUR OWN scheduled playback and
//    sends NOTHING to the server. A false positive then costs a clipped
//    sentence; sending a cancel frame would instead kill a turn the server VAD
//    was correctly keeping alive, and the model would never finish answering.
//    Local-only makes the worst case recoverable and the failure audible rather
//    than silent.
//
// 2. IT DOES NOT READ voice-loop.js'S LIVE THRESHOLDS, on purpose. Those are
//    rescaled at runtime when VAD_ENGINE === 'silero' (SPEECH_RMS becomes 0.5,
//    a speech PROBABILITY, not an amplitude). This backstop measures raw RMS
//    amplitude off the outgoing PCM frames — there is no Silero model in the
//    S2S capture path — so borrowing those numbers would set an 0.8 amplitude
//    floor that can never be reached, and the backstop would be silently dead
//    for exactly the operator who tuned their VAD the most. The constants below
//    are RMS-scale numbers written out rather than
//    imported, for the same reason pcm-capture-worklet.js duplicates the
//    resample math: the alternative is a shared value that means two different
//    things depending on a flag.
//
// Pure and node-testable (no DOM, no AudioContext, no socket) — see
// test/s2s-barge-in-backstop.test.js. The browser wiring is three lines in
// s2s-bridge.js.

import { decideBargeIn } from './voice-loop.js';

// TWO TIERS, NOT ONE (2026-08-14). Until this session the module had a single
// threshold pair, and that was a design error with a measured cost: one
// threshold decided BOTH "stop MYTHOS's playback" AND "let the operator's audio
// reach Gemini" (s2s-bridge's half-duplex gate only opens on this module's
// verdict). Those two decisions have opposite failure costs. A false positive on
// the first clips a sentence MYTHOS was speaking — recoverable, audible, the
// operator asks again. A false NEGATIVE on the second silently discards what the
// operator said: the 1.2s preroll ring overflows and the sentence is gone. The
// 2026-08-14 session has two turns logged as live-turn-no-user-transcript with
// the operator talking over the reply, and this module fired zero times all
// session against 0.0875 / 6 frames.
//
// So the release tier is deliberately EAGER (operator's explicit choice, taken
// over losing sentences): it clears the ordinary speech floor for ~300ms and
// does nothing except reopen the mic path, handing the real interruption verdict
// to Gemini's own server-side VAD — which is a better detector than an RMS
// heuristic and is the thing that would have decided it anyway had the gate
// never been held. The flush tier stays higher and slightly longer, because it
// is the one that can cut MYTHOS off mid-word.
//
// BUG-271 (2026-08-17): the eager tier used to be 0.035 / 2 frames (200ms), and
// the operator's own session log proved that was wrong for this room — speaker
// bleed (MYTHOS's voice leaking through the mic despite AEC) clears 0.035, so
// every ~7s the bleed alone released the half-duplex gate and the replay handed
// MYTHOS's own words straight to Gemini. The tier is now 0.05 / 3 frames
// (300ms): above the measured bleed, still eager, and still strictly below the
// flush tier (0.056) — a release must never double as a flush. A real barge-in
// that a different room's noise floor outruns keeps the localStorage override
// (MYTHOS_BARGE_RELEASE_RMS).
//
// Both tiers are still well clear of the echo of our own voice: getUserMedia's
// AEC (mic-device.js) attenuates it, which is what makes a two-tier split
// exploit a real signal gap rather than guess at one. s2s-bridge streams 100ms
// frames, so the frame counts below are milliseconds divided by 100, and both
// pairs are overridable from localStorage there (MYTHOS_BARGE_* ) so an operator
// can walk the eagerness back without a rebuild.
export const BACKSTOP_RMS_THRESHOLD = 0.035 * 1.6;
export const BACKSTOP_HOLD_FRAMES = 3;
export const BACKSTOP_RELEASE_RMS_THRESHOLD = 0.05;
export const BACKSTOP_RELEASE_HOLD_FRAMES = 3;

// Int16 little-endian PCM (what pcm-capture-worklet.js emits) -> RMS in the
// same -1..1 scale voice-loop.js's rms() produces from its Uint8 analyser data,
// so the thresholds above mean the same thing in both paths.
export function rmsFromPcm16(buffer) {
  if (!buffer) return 0;
  const samples = new Int16Array(
    buffer.buffer ? buffer.buffer : buffer,
    buffer.byteOffset || 0,
    Math.floor((buffer.byteLength != null ? buffer.byteLength : buffer.length) / 2)
  );
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

// onFlush is called at most once per sustained-loud run. It is the caller's
// player.flush() — which carries its own TAIL_GUARD_SEC, so a near-finished
// sentence still gets to finish rather than losing its last word (BUG-061).
//
// onRelease is the eager tier: also at most once per run, and it must NOT stop
// playback. Its only job is to open s2s-bridge's half-duplex gate so the
// operator's audio starts flowing to Gemini immediately. It fires before onFlush
// on a run loud enough to reach both, and on its own on a run that never does.
export function createBargeInBackstop({
  onFlush, onRelease, threshold, holdFrames, releaseThreshold, releaseHoldFrames,
} = {}) {
  const rmsThreshold = typeof threshold === 'number' ? threshold : BACKSTOP_RMS_THRESHOLD;
  const ticks = typeof holdFrames === 'number' ? holdFrames : BACKSTOP_HOLD_FRAMES;
  const releaseRms = typeof releaseThreshold === 'number'
    ? releaseThreshold : BACKSTOP_RELEASE_RMS_THRESHOLD;
  const releaseTicks = typeof releaseHoldFrames === 'number'
    ? releaseHoldFrames : BACKSTOP_RELEASE_HOLD_FRAMES;
  let aboveCount = 0;
  let releaseCount = 0;
  let releasedThisRun = false;
  // The RMS of the most recently observed frame. Exposed because it was NEVER
  // MEASURED ANYWHERE: after the 2026-08-14 session "the threshold is too high"
  // could only be inferred from the absence of flushes, never read off a number.
  // s2s-bridge tracks the peak of this across each held gate and logs one line
  // per hold, so the next session yields the figure instead of another inference.
  let lastLevel = 0;

  // Idempotency with the server signal, in both directions. Whichever of the
  // two verdicts lands first stops the audio and zeroes the run; the other then
  // finds nothing scheduled and flush() is a no-op on an empty set. reset() is
  // what makes the SECOND one cheap rather than merely harmless — without it a
  // server interrupt would leave a half-accumulated local run that could tip
  // over on the first frame of the NEXT reply.
  function reset() { aboveCount = 0; releaseCount = 0; releasedThisRun = false; }

  // Returns true iff this frame triggered a local FLUSH. The eager release is
  // reported through onRelease, not through the return value, so the existing
  // "did we cut MYTHOS off?" contract every caller and test already relies on is
  // unchanged. `speaking` must be the player's real isSpeaking() — when nothing
  // is playing there is nothing to barge into, and decideBargeIn() is a
  // documented pass-through no-op there.
  function observe(frame, speaking) {
    // Measured before the speaking gate so the instrumentation is honest even in
    // the states that take no decision — a peak of 0 must mean silence, never
    // "we did not look".
    lastLevel = rmsFromPcm16(frame);
    if (!speaking) { reset(); return false; }

    // Eager tier first: on a run loud enough for both, the mic must reopen no
    // later than the moment playback stops, never a frame after it.
    const releaseDecision = decideBargeIn({
      level: lastLevel,
      assistantSpeaking: true,
      bargeAboveCount: releaseCount,
      thresholds: { bargeThreshold: releaseRms, bargeHoldTicks: releaseTicks },
    });
    releaseCount = releaseDecision.newBargeAboveCount;
    // A quiet frame ends the run for BOTH tiers (decideBargeIn zeroes the count
    // on any level at or below its threshold, and the release threshold is the
    // lower of the two), so this is where the once-per-run latch clears.
    if (lastLevel <= releaseRms) releasedThisRun = false;
    if (releaseDecision.shouldBargeIn && !releasedThisRun) {
      releasedThisRun = true;
      if (onRelease) onRelease(lastLevel);
    }

    const decision = decideBargeIn({
      level: lastLevel,
      assistantSpeaking: true,
      bargeAboveCount: aboveCount,
      thresholds: { bargeThreshold: rmsThreshold, bargeHoldTicks: ticks },
    });
    aboveCount = decision.newBargeAboveCount;
    if (!decision.shouldBargeIn) return false;
    if (onFlush) onFlush(lastLevel);
    return true;
  }

  return {
    observe,
    reset,
    pendingFrames: () => aboveCount,
    pendingReleaseFrames: () => releaseCount,
    lastLevel: () => lastLevel,
  };
}
