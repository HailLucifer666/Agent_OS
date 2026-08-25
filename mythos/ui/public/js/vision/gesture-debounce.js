// gesture-debounce.js — the pure state machine that turns a stream of per-frame
// MediaPipe top-1 results into discrete gesture EVENTS. Extracted out of
// camera.js (which needs a browser, a webcam and the MediaPipe WASM bundle to
// import at all) so this logic can be tested in node:test — same reason
// voice/pcm-resample.js exists, see mythos/ui/CLAUDE.md.
//
// Two rules, and the second one is why this file exists:
//
//   1. HOLD — a gesture must be the top result for holdTicks consecutive frames
//      before it fires, so a single misread frame cannot trigger an action.
//      (Same principle as voice-loop's SPEECH_HOLD_TICKS.)
//
//   2. RELEASE — once a gesture fires it CANNOT fire again until the hand stops
//      making it. A pose is one press, however long it is held.
//
// Rule 2 replaced a plain 2000ms per-gesture cooldown, which re-fired the same
// pose every ~2s for as long as it stayed in frame. That was survivable while
// every gesture was idempotent (clicking an already-clicked confirm button,
// re-describing the same scene) and became a real defect the moment Open_Palm
// became a mic TOGGLE on 2026-08-10: a palm held up for six seconds read as
// mute -> unmute -> mute, and no refractory window on the consuming side can fix
// that, because a long enough hold always outlasts it. The hand leaving the pose
// is the only signal that means "the operator is done asking".
//
// The cooldown is kept as a secondary guard, now covering only the flicker case
// (pose -> misread frame -> same pose again) that release-tracking alone would
// let through as two presses.

export const DEFAULT_HOLD_TICKS = 3;      // ~450ms at camera.js's 150ms tick
export const DEFAULT_COOLDOWN_MS = 2000;  // anti-flicker only — see above

export function createGestureDebouncer(opts) {
  const holdTicks = (opts && opts.holdTicks) || DEFAULT_HOLD_TICKS;
  const cooldownMs = (opts && Number.isFinite(opts.cooldownMs)) ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;

  let holdGesture = null;   // gesture currently accumulating hold ticks
  let holdCount = 0;
  let heldSinceFire = null; // gesture that fired and has NOT been released yet
  const lastFired = new Map();

  // Feed one frame's top-1 gesture name (null / 'None' when no confident hand).
  // Returns the gesture name when this frame completes a press, else null.
  function observe(name, now) {
    const at = Number.isFinite(now) ? now : 0;
    const seen = (!name || name === 'None') ? null : name;

    // Anything other than the still-held gesture means the operator released
    // it — including no hand at all, and including a DIFFERENT pose. Re-arm.
    if (heldSinceFire && seen !== heldSinceFire) heldSinceFire = null;

    if (!seen) { holdGesture = null; holdCount = 0; return null; }
    if (seen !== holdGesture) { holdGesture = seen; holdCount = 1; return null; }

    holdCount++;
    if (holdCount < holdTicks) return null;
    // Still holding the pose that already fired: not a new press. Do NOT reset
    // holdCount here — it must keep counting so the pose stays recognised as
    // "the same one" rather than re-accumulating a fresh press every holdTicks.
    if (heldSinceFire === seen) return null;
    if (at - (lastFired.get(seen) || -Infinity) < cooldownMs) return null;

    lastFired.set(seen, at);
    heldSinceFire = seen;
    holdGesture = null;
    holdCount = 0;
    return seen;
  }

  // Called when the camera stops: forget the pose in progress, but keep
  // lastFired so a stop/start cycle cannot be used to bypass the cooldown.
  function reset() {
    holdGesture = null;
    holdCount = 0;
    heldSinceFire = null;
  }

  return { observe, reset };
}
