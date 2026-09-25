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

module.exports = { createHeldReplies, TOOL_RESULT_HOLD_MAX_MS, cancelledNotice };
