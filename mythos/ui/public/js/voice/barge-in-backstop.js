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
//    are the RMS-scale defaults (SPEECH_RMS 0.035 * BARGE_IN_RMS_MULT 2.5, and
//    SPEECH_HOLD_TICKS 3 * BARGE_IN_HOLD_TICKS_MULT 2) written out rather than
//    imported, for the same reason pcm-capture-worklet.js duplicates the
//    resample math: the alternative is a shared value that means two different
//    things depending on a flag.
//
// Pure and node-testable (no DOM, no AudioContext, no socket) — see
// test/s2s-barge-in-backstop.test.js. The browser wiring is three lines in
// s2s-bridge.js.

import { decideBargeIn } from './voice-loop.js';

// RMS amplitude floor a frame must clear to count toward a barge-in, and how
// many consecutive frames must clear it. s2s-bridge streams 100ms frames, so
// 6 frames is ~600ms of sustained loud input — high and long enough that it
// does not fire on a cough, a keyboard, or the tail of MYTHOS's own audio
// bleeding back through the mic.
export const BACKSTOP_RMS_THRESHOLD = 0.035 * 2.5;
export const BACKSTOP_HOLD_FRAMES = 3 * 2;

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
export function createBargeInBackstop({ onFlush, threshold, holdFrames } = {}) {
  const rmsThreshold = typeof threshold === 'number' ? threshold : BACKSTOP_RMS_THRESHOLD;
  const ticks = typeof holdFrames === 'number' ? holdFrames : BACKSTOP_HOLD_FRAMES;
  let aboveCount = 0;

  // Idempotency with the server signal, in both directions. Whichever of the
  // two verdicts lands first stops the audio and zeroes the run; the other then
  // finds nothing scheduled and flush() is a no-op on an empty set. reset() is
  // what makes the SECOND one cheap rather than merely harmless — without it a
  // server interrupt would leave a half-accumulated local run that could tip
  // over on the first frame of the NEXT reply.
  function reset() { aboveCount = 0; }

  // Returns true iff this frame triggered a local flush. `speaking` must be the
  // player's real isSpeaking() — when nothing is playing there is nothing to
  // barge into, and decideBargeIn() is a documented pass-through no-op there.
  function observe(frame, speaking) {
    if (!speaking) { aboveCount = 0; return false; }
    const decision = decideBargeIn({
      level: rmsFromPcm16(frame),
      assistantSpeaking: true,
      bargeAboveCount: aboveCount,
      thresholds: { bargeThreshold: rmsThreshold, bargeHoldTicks: ticks },
    });
    aboveCount = decision.newBargeAboveCount;
    if (!decision.shouldBargeIn) return false;
    if (onFlush) onFlush();
    return true;
  }

  return { observe, reset, pendingFrames: () => aboveCount };
}
