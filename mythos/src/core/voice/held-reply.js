'use strict';

// held-reply.js — hold a slow tool's reply until its real result, with a safety
// net (BUG-457, 2026-09-24).
//
// THE BUG. A call that outran the 1.5 s ack deadline was answered "started", and
// its real result was pushed in later as user-role text: Live has no system
// channel after setup (BUG-117). That text arrives as a new turn, so it cut
// whatever the model had begun (BUG-456's measured cuts), and twice on 09-24 the
// model rationalised a "user" message with no speech behind it aloud ("user
// transcription failed, but I am still responding").
//
// MEASURED ON THE CONFIGURED MODEL (gemini-3.1-flash-live-preview, 2026-09-24,
// operator's free-tier key, 13 sessions, pre-registered). Google documents that
// this model does not support asynchronous function calling and "will not start
// responding until you've sent the tool response". Holding the reply 5 s (x3)
// and 12 s (x3): one call each, no audio before the reply, no dropped session, an
// answer 765-1065 ms after it with the real value. Today's path (x3): a holding
// line, cut by the injected result, then the answer.
// EXPLORATORY, and the reason for the net below: new input during a hold makes
// Google CANCEL the pending call (toolCallCancellation, ~65 ms later, 2 of 2). The
// model then answered the new input and, once, INVENTED the pending result. The
// reply sent afterwards for the cancelled id was ignored.
//
// So, the operator's choice (2026-09-24), "hold, with a safety net":
//   - a reply is held for at most TOOL_RESULT_HOLD_MAX_MS (the tested bound), and
//     then today's path takes over;
//   - typed words release every hold BEFORE they go out, so a typed message can
//     never cancel a call (releaseAll, called from the server's three typed-text
//     sites, sends the "started" reply synchronously first);
//   - a cancellation (spoken words, which the server cannot pre-empt) ends the
//     hold, the model is told at once that the result is unknown and must not be
//     guessed, and the real result follows on today's path;
//   - the reply is sent through the session's own reply door, pinned to the
//     socket the call came from, so a rotation mid-hold refuses it rather than
//     sending an id the new socket never issued (live-session.js).
//
// Measured frequency of the risky case: the operator spoke during 0 of 17 real
// tool waits on 09-23 and 09-24. Pure: no I/O; timers and clock injectable.

const TOOL_RESULT_HOLD_MAX_MS = 12000;

function cancelledNotice(tool) {
  return `${tool} is still running. The operator's new words cancelled the wait, so its result is NOT known yet: `
    + 'do not state, guess or invent it. It will be reported when it arrives.';
}

function createHeldReplies({ now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const held = new Map(); // callId -> { settle, onRelease }

  // Resolves to { kind, heldMs, outcome?, error? }, kind one of
  // outcome | error | hold-max | cancelled | released. Never rejects.
  function hold(callId, promise, maxMs, { onRelease } = {}) {
    const id = String(callId);
    const startedAt = now();
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const settle = (r) => {
        if (done) return;
        done = true;
        if (timer) clearTimer(timer);
        held.delete(id);
        resolve(Object.assign({ heldMs: now() - startedAt }, r));
      };
      timer = setTimer(() => settle({ kind: 'hold-max' }), Math.max(0, maxMs));
      if (timer && typeof timer.unref === 'function') timer.unref();
      held.set(id, { settle, onRelease });
      Promise.resolve(promise).then((outcome) => settle({ kind: 'outcome', outcome }), (error) => settle({ kind: 'error', error }));
    });
  }

  // Google cancelled these calls: stop holding them. Returns how many were held.
  function cancel(ids) {
    let n = 0;
    for (const raw of Array.isArray(ids) ? ids : []) {
      const h = held.get(String(raw));
      if (h) { h.settle({ kind: 'cancelled' }); n += 1; }
    }
    return n;
  }

  // Operator input is about to go out: answer every held call "started" NOW,
  // synchronously, so the input cannot cancel it. Returns how many were released.
  function releaseAll() {
    let n = 0;
    for (const [, h] of [...held]) {
      try { if (typeof h.onRelease === 'function') h.onRelease(); } catch (_) { /* the settle below still runs */ }
      h.settle({ kind: 'released' });
      n += 1;
    }
    return n;
  }

  return { hold, cancel, releaseAll, get size() { return held.size; } };
}

// BUG-457 residual 2 (2026-10-06): which SLOW_TOOLS calls still ack "started" at
// once. Before this, all of them did, so screen_look's result reached the model as
// user-role text and cut MYTHOS mid-sentence 6 of 6 times on 09-25, each 3.5-4.6 s
// after the call: inside the hold window. The list's 16 s / 63 s figures for the
// vision pair are from 2026-08-10, before vision-call.js bounded a call
// (VISION_CALL_TIMEOUT_MS, 12 s by default); launch_app's worst measured run is
// 9.86 s and spotify_play's 5-10 s. Every Live-reachable member's measured
// duration now fits the window, so the list alone cannot say "too slow to hold".
//
// THE RULE, derived rather than typed (gate D): a listed call is held like any
// other unless THIS tool's last settled run in this session took longer than the
// hold window; then it acks at once, because holding it would only add up to 12 s
// of silence before the same "started". The measurement is taken on both paths,
// so a tool that fits again is held again. With the hold switched off (window 0)
// every listed call acks at once: today's path, unchanged.
//
// ATTACK, 2026-10-06. (1) What else matches: any listed tool, including one that
// overran once by accident; its next call alone acks at once, then it re-measures.
// A tool that never settles is never measured and is held every time, bounded by
// the window. (2) Evidence: every hold still logs live.tool-held. (5) The window
// is the adapter's own deadline plus hold budget, not a second constant. (8) What
// it newly needs: a held listed call now delays later calls in its batch by up to
// the window, as BUG-457 already says of every held call. What it KILLS (gate F):
// nothing; the instant ack is reached cold only with the hold off, and warm only
// after a measured overrun. Not covered: a cold first call of a tool that really
// runs past the window (dsh_task, minutes, is not on the Live allowlist today)
// costs one silent window before "started".
function createSlowToolRoute({ holdWindowMs, now = () => Date.now() } = {}) {
  const lastRunMs = new Map(); // tool -> duration of its most recent settled run

  function acksAtOnce(tool) {
    if (!(holdWindowMs > 0)) return true;
    const ms = lastRunMs.get(String(tool));
    return ms !== undefined && ms > holdWindowMs;
  }

  // Records how long the run took, whatever its outcome; returns the SAME promise.
  function timed(tool, promise, startedAt) {
    const note = () => { lastRunMs.set(String(tool), now() - startedAt); };
    Promise.resolve(promise).then(note, note);
    return promise;
  }

  return { acksAtOnce, timed };
}

// BUG-457 residual 1 (2026-10-06): one call, one terminal outcome. At 02:12:44 on
// 09-25 Gemini issued think_deeply + use_skill and the operator's words closed the
// turn 131 ms later, with no toolCallCancellation. think_deeply was held 569 ms
// past the deadline and ended `end=outcome`, so its result went out as the tool
// response, and ALSO as a late-for-turn [SYSTEM] notice: the adapter's late branch
// only knew `entry.started`, which is false for a held reply. The notice opened an
// unprompted turn. live-tool-adapter.js commitAction now skips that notice for an
// id this batch held and answered. Its one delivery is the tool response, or, if
// the session refuses that (a rotation), reportLateOutcome: still exactly one.
//
// ATTACK, 2026-10-06. (1) What else matches: only ids in THIS batch's heldAnswered,
// which is written only on end=outcome|error. A released, cancelled or hold-max
// call is committed as a 'started' entry and was never announced here anyway.
// (2) Evidence: the live-tool-outcome-late-for-turn anomaly still fires for it,
// and live.tool-held still logs. (A, unmeasured) It assumes Gemini reads a tool
// response for a call it never cancelled after an interrupted turn. BUG-457's probe
// showed the model waits for a held reply, but never ran an interruption without
// a cancellation; the attended check must. (F) For a held reply the late-for-turn
// notice is now unreachable, on purpose. NOT changed: a call answered INSIDE the
// deadline whose turn closed (use_skill at 02:12:46.793) still gets both, the
// notice per G3/BUG-297; pinned by bug-457-residuals (c), an operator decision.
function answeredByHeldReply(heldAnswered, traceId) {
  return Array.isArray(heldAnswered) && heldAnswered.some((a) => a && a.id === traceId);
}

module.exports = { createHeldReplies, TOOL_RESULT_HOLD_MAX_MS, cancelledNotice, createSlowToolRoute, answeredByHeldReply };
