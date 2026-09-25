// hud-ready.js — can this HUD actually PLAY proactive speech right now?
//
// BUG-433. The server used to decide whether to speak by asking "has anything
// connected?". On 2026-09-16 the answer was yes and the boot greeting was still
// lost: the thing that had connected was a PIN-locked HUD, whose proactive
// handler returned before registering a playback handler, so three synthesized
// chunks arrived with nobody listening and the server logged a delivery.
//
// "Connected" is not "able to play", and only the client can answer the second
// one. So the client computes it here, once, and reports it. One calculation
// rather than a condition re-typed at each site is the point: the two silent
// early returns in app.js's proactive handler were the two halves of this
// answer, written separately, with nothing keeping them in agreement.
//
// 2026-09-23: the PIN was removed (operator decision), so the lock half of the
// answer is gone and the voice configuration is what remains. That was the other
// half all along — app.js's proactive handler still drops a message that arrives
// before the configuration lands (it would build a mistuned voice loop), so a
// greeting armed before then would be synthesized for nobody, which is exactly
// BUG-433's shape. test/bug-433-greeting-waits-for-a-hud-that-can-hear-it.test.js
// pins both halves: never before the configuration, once after.
//
// PURE ON PURPOSE. app.js cannot be require()d under node --test, and a
// readiness rule that can only be checked by reading it is how the original
// mismatch survived. Everything here is arguments in, verdict out.
export function deriveHudReady(state) {
  const s = state || {};
  if (!s.voiceConfigLoaded) return { greetable: false, why: 'voice-config-not-loaded' };
  return { greetable: true, why: null };
}

// Reporting lives here too, so the rule and the report cannot drift apart —
// a caller that recomputed the verdict on its own is precisely how app.js ended
// up with two drop branches written separately. `readState` is re-read on every
// call rather than captured, because its input changes after construction.
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
