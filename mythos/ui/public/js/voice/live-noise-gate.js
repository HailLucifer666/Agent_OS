// live-noise-gate.js — BUG-271: noise gate for the Gemini Live audio SEND path.
//
// The Live path streamed EVERY 100ms mic frame to Gemini with no gate — the
// batch path (voice-loop.js) gates at its SPEECH_RMS floor before sending
// anything, but s2s-bridge.js never did. Gemini's VAD is configured
// START_SENSITIVITY_HIGH (live-session.js, deliberately kept — see the comment
// there), so room noise fired it and its STT fabricated words the operator
// never said.
//
// ZERO, NEVER DROP. A below-floor frame is replaced with digital silence of the
// SAME byteLength; frame count, size, and rate on the wire are unchanged, so
// Gemini's VAD timeline is untouched and the wire format is exactly what it was
// before this gate existed. Dropping frames instead would shift that timeline
// and change the frozen `live-audio` shape.
//
// Hysteresis: once a frame clears the floor the gate opens and raw frames pass
// — including the dips between words — until quietFrames CONSECUTIVE
// below-floor frames (800ms at the defaults: 8 x 100ms) close it again.
//
// Pure and node-testable (no DOM, no socket) — see test/live-noise-gate.test.js.
// The browser wiring is in s2s-bridge.js, which applies the decision at BOTH
// live-audio send points: the capture path and the own-voice gate-release
// replay (replayed speaker bleed arrives at Gemini as silence, defanging the
// echo at the wire level too). The rms function is injected — s2s-bridge passes
// barge-in-backstop.js's rmsFromPcm16, so both measurements use one scale.

export const LIVE_NOISE_GATE_FLOOR_RMS = 0.02;
// 8 x 100ms frames = 800ms of continuous quiet before re-zeroing.
export const LIVE_NOISE_GATE_QUIET_FRAMES = 8;

// process(buffer) -> { zero, buffer }. `buffer` is what must go on the wire:
// the ORIGINAL ArrayBuffer when the frame passes (voice is never re-encoded),
// a fresh zeroed copy of the same byteLength when it does not. The original is
// never mutated — s2s-bridge's preroll ring holds references to captured
// frames, and zeroing one in place would silence the operator's held speech.
// A floorRms of 0 or below disables the gate entirely (the localStorage
// escape hatch: MYTHOS_LIVE_NOISE_GATE_FLOOR=0 restores the raw stream).
export function createLiveNoiseGate({ floorRms, quietFrames, rms } = {}) {
  const floor = typeof floorRms === 'number' ? floorRms : LIVE_NOISE_GATE_FLOOR_RMS;
  const quietNeeded = typeof quietFrames === 'number' ? quietFrames : LIVE_NOISE_GATE_QUIET_FRAMES;
  let open = false;          // voice has cleared the floor at least once
  let quietRun = 0;          // consecutive below-floor frames since the last loud one
  let zeroed = 0;            // frames replaced with silence — what Gemini never heard

  function process(buffer) {
    if (floor <= 0) return { zero: false, buffer };
    const level = rms(buffer);
    if (level >= floor) {
      open = true;
      quietRun = 0;
      return { zero: false, buffer };
    }
    if (open) {
      quietRun += 1;
      if (quietRun < quietNeeded) return { zero: false, buffer };   // dip between words
    }
    zeroed += 1;
    return { zero: true, buffer: new ArrayBuffer(buffer.byteLength) };
  }

  function reset() { open = false; quietRun = 0; }

  return { process, reset, framesZeroed: () => zeroed };
}
