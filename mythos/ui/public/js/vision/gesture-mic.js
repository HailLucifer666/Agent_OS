// gesture-mic.js — the ONE decision that turns a recognised hand gesture into a
// microphone action. Extracted as a plain pure function for exactly the reason
// decideVoiceTransport() lives in its own file: app.js's GESTURE_ACTIONS map
// touches the DOM and the live voice transports, so the *decision* is the only
// part node:test can exercise — see test/gesture-mic-decision.test.js.
//
// Why this exists at all: Open_Palm used to be a ONE-WAY mute. It called stop()
// on whichever transport held the mic and there was no gesture that could bring
// the mic back — the operator had to reach for the compose-bar button, the core
// orb or Alt+Space, which defeats the point of a hands-free gesture. Reported
// 2026-08-10 ("for open palm it mutes, how to unmute?").
//
// Contract: decideGestureMic(state) -> { action, reason }
//   action  'start' | 'stop' | 'none'
//   reason  short machine-readable string, for captions/logs and for tests to
//           assert on WHY nothing happened (a bare 'none' hides bugs).
//
// Two gestures, deliberately asymmetric:
//   Open_Palm    toggles — mutes when the mic is live, unmutes when it is not.
//   Pointing_Up  only ever unmutes. It is the force-unmute escape hatch, so it
//                must never be able to silence a live session by accident.
//
// THE REFRACTORY WINDOW IS A CROSS-GESTURE GUARD, and it is the second line of
// defence, not the first. A palm held in frame is stopped from re-firing at all
// by the release rule in vision/gesture-debounce.js — one pose is one press,
// however long it is held. That had to be fixed there rather than here: no
// window on this side can survive a long hold, because a hold long enough always
// outlasts it (proven by test/gesture-mic-decision.test.js's six-second case,
// which failed against a 4000ms window).
//
// What remains for this window is the case the debouncer cannot see: two
// DIFFERENT mic gestures in quick succession (Open_Palm mutes, then a misread
// Pointing_Up immediately re-opens the mic), since each gesture carries its own
// cooldown there. When the two readings disagree this errs toward 'none' — a
// gesture that fails to open the mic is an inconvenience, a gesture that opens
// the mic unasked is a privacy event.
export const GESTURE_MIC_REFRACTORY_MS = 1500;

export function decideGestureMic(state) {
  const s = state || {};
  const gesture = s.gesture;
  const micLive = Boolean(s.batchActive) || Boolean(s.s2sActive);
  const now = Number.isFinite(s.now) ? s.now : 0;
  // No previous toggle: treat as "long ago", never as "0ms ago". A falsy
  // lastToggleAt must not block the very first gesture of a session.
  const lastToggleAt = Number.isFinite(s.lastToggleAt) ? s.lastToggleAt : -Infinity;
  const withinRefractory = (now - lastToggleAt) < GESTURE_MIC_REFRACTORY_MS;

  if (gesture === 'Open_Palm') {
    if (withinRefractory) return { action: 'none', reason: 'refractory' };
    return micLive
      ? { action: 'stop', reason: 'palm-mute' }
      : { action: 'start', reason: 'palm-unmute' };
  }

  if (gesture === 'Pointing_Up') {
    // Already live: nothing to do, and NOT a stop. Reported before the
    // refractory check so a held finger stays a silent no-op rather than
    // reading as a suppressed action.
    if (micLive) return { action: 'none', reason: 'already-live' };
    if (withinRefractory) return { action: 'none', reason: 'refractory' };
    return { action: 'start', reason: 'point-unmute' };
  }

  return { action: 'none', reason: 'not-a-mic-gesture' };
}
