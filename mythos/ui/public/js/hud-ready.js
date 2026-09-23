// hud-ready.js — can this HUD actually PLAY proactive speech right now?
//
// BUG-433. The server used to decide whether to speak by asking "has anything
// connected?". On 2026-09-16 the answer was yes and the boot greeting was still
// lost: the thing that had connected was a PIN-locked HUD, whose proactive
// handler returns before registering a playback handler, so three synthesized
// chunks arrived with nobody listening and the server logged a delivery.
//
// "Connected" is not "able to play", and only the client can answer the second
// one — it depends on the PIN state and on whether the voice configuration has
// landed. So the client computes it here, once, and reports it. One calculation
// rather than a condition re-typed at each site is the point: the two silent
// early returns in app.js's proactive handler were the two halves of this
// answer, written separately, with nothing keeping them in agreement.
//
// PURE ON PURPOSE. app.js cannot be require()d under node --test, and a
// readiness rule that can only be checked by reading it is how the original
// mismatch survived. Everything here is arguments in, verdict out.

// The lock state is a TRI-STATE, and this is the whole reason the module exists
// rather than a boolean: 'unknown' is the window before GET /api/pin/status has
// answered. `lockState !== 'locked'` admits it, and a greeting armed in that
// window is a greeting armed on a guess — the exact race pin-gate.js's
// isGateClosed() was written to close, arriving through a different door.
export function deriveHudReady(state) {
  const s = state || {};
  if (!s.voiceConfigLoaded) return { greetable: false, why: 'voice-config-not-loaded' };
  if (s.lockState !== 'unlocked') return { greetable: false, why: 'pin-' + (s.lockState || 'unknown') };
  return { greetable: true, why: null };
}

// Reporting lives here too, so the rule and the report cannot drift apart —
// a caller that recomputed the verdict on its own is precisely how app.js ended
// up with two drop branches written separately. `readState` is re-read on every
// call rather than captured, because both inputs change after construction.
//
// `send` throws while the socket is still opening. Swallowed on purpose: a lost
// hint only DELAYS a greeting (the next call re-sends the current verdict), and
// it can never arm one at a HUD that cannot play it. Failing loudly here would
// put a console error on the ordinary boot path.
export function createHudReadyReporter({ send, readState }) {
  return function publishHudReady() {
    const verdict = deriveHudReady(readState());
    try { send({ type: 'hud-ready', greetable: verdict.greetable, why: verdict.why }); } catch (_) {}
    return verdict;
  };
}
