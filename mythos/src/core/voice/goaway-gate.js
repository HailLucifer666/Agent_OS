'use strict';
// goaway-gate.js — BUG-436: do not hang up on Gemini while it is mid-sentence.
//
// PURE ON PURPOSE. No ws, no bus, no config: live-session.js sits on its
// file-size ceiling (test/file-size-ratchet.test.js), and the decision here is
// the kind that needs its own small test rather than a fake socket dance.
//
// THE INCIDENT, mythos-server.log 2026-09-10 (all UTC):
//   09:47:39.110  live.tool-call-batch  screen_read_text
//   09:47:39.948  pc-child response     screen_read_text ok, 836 ms   <- the tool
//                                        result WENT BACK; the ticket's stated cause
//                                        ("no session to return to") is wrong
//   09:47:41.183  own-voice hold        <- the model was speaking its answer
//   09:47:42.508  live.goaway timeLeft:"50s"
//   09:47:42.5    close('goaway')       <- WE hung up, with 50 s of grace unused
//   09:47:44.485  live-tools declared   <- reconnected in ~2 s
//   ...silence...
//   09:47:59.703  screen_read_text again, only after the operator spoke
//
// Google's contract (ai.google.dev/api/live, read 2026-09-10): GoAway is "a
// notice that the server will soon disconnect", and timeLeft is "the remaining
// time before the connection will be terminated as ABORTED" which "lets you take
// further action before" that happens. The old code treated the notice as the
// hang-up and closed at once, so a reply that was streaming out of the speaker
// was cut mid-turn and, with session resumption, the new connection sat there
// holding the context and waiting for someone to speak.
//
// THE RULE. On goAway: if a turn is in flight (the model has produced audio or
// text this turn, or is waiting on our toolResponse), hold the close until that
// turn completes — or until timeLeft minus a safety margin, whichever first. If
// no turn is in flight, close now, exactly as before. Either way the close is the
// same non-final close() the caller already uses, so the reconnect path stays
// single (live-session.js's ws.on('close')) and resumeHandle is carried across.
//
// FAILURE DIRECTION. An unparseable timeLeft closes immediately — the old
// behaviour — rather than holding for an unknown time. A held close that the
// server pre-empts by aborting the connection is harmless: the ws 'close' event
// fires with closedByUs false and reconnects, which is what happened before too.
// Resumption tokens are valid for two hours after termination (session guide),
// so an ABORT is not a lost session.
//
// GUARD ATTACKED BEFORE SHIPPING (2026-09-10): (1) goAway with NOTHING in
// flight still closes synchronously — pinned, because deferring an idle rotation
// would leave the operator's next utterance streaming into a doomed socket for
// up to timeLeft; (2) the hold expires and closes on its own when turnComplete
// never comes, so a stuck turn cannot pin the socket past Google's deadline;
// (3) cancel() on a final close disarms the timer, so a stale hold cannot fire a
// non-final close on the REPLACEMENT session (the same class as the stale
// 'error' listener note in live-session.js's close()).

const GOAWAY_CLOSE_MARGIN_MS = 2000;

// "50s" | "50.5s" | "0.5s" -> milliseconds. Google's Duration JSON form is a
// decimal count of seconds with an "s" suffix. Anything else -> null.
function parseTimeLeft(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value * 1000);
  const m = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(String(value == null ? '' : value));
  if (!m) return null;
  return Math.round(Number(m[1]) * 1000);
}

// closeNow(reason)      the caller's non-final close
// isTurnInFlight()      true while the model owes or is producing a reply
// logger                { info }
// setTimer/clearTimer   injectable for tests; default to the real ones
function createGoAwayGate({ closeNow, isTurnInFlight, logger, setTimer, clearTimer, marginMs }) {
  const schedule = setTimer || setTimeout;
  const unschedule = clearTimer || clearTimeout;
  const margin = Number.isFinite(marginMs) ? marginMs : GOAWAY_CLOSE_MARGIN_MS;
  let holdTimer = null;
  let heldSince = 0;

  function fire(why) {
    if (holdTimer) { unschedule(holdTimer); holdTimer = null; }
    logger.info('live.goaway-close', { why, heldMs: heldSince ? Date.now() - heldSince : 0 });
    heldSince = 0;
    closeNow('goaway');
  }

  return {
    arrive(timeLeft) {
      const budgetMs = parseTimeLeft(timeLeft);
      const inFlight = !!isTurnInFlight();
      if (!inFlight || budgetMs == null) {
        logger.info('live.goaway', { timeLeft: timeLeft == null ? null : String(timeLeft), deferred: false,
          reason: inFlight ? 'unparseable-time-left' : 'no-turn-in-flight' });
        if (holdTimer) { unschedule(holdTimer); holdTimer = null; }
        heldSince = 0;
        closeNow('goaway');
        return false;
      }
      const holdMs = Math.max(0, budgetMs - margin);
      logger.info('live.goaway', { timeLeft: String(timeLeft), deferred: true, holdMs });
      if (holdTimer) unschedule(holdTimer);
      heldSince = Date.now();
      // Null the handle BEFORE firing: a timer that has already run must not be
      // cleared again (harmless on real timers, but it double-counts in any
      // accounting and hides whether cancel() did its own work).
      holdTimer = schedule(() => { holdTimer = null; fire('hold-expired'); }, holdMs);
      if (holdTimer && typeof holdTimer.unref === 'function') holdTimer.unref();
      return true;
    },
    // The turn the hold was waiting for has landed: close now, reconnect now.
    turnComplete() {
      if (!holdTimer) return false;
      fire('turn-complete');
      return true;
    },
    // The session is closing for some other reason (final close, ws-closed,
    // client request): a pending hold must not fire into the replacement.
    cancel() {
      if (holdTimer) { unschedule(holdTimer); holdTimer = null; }
      heldSince = 0;
    },
    isHolding: () => holdTimer !== null,
  };
}

module.exports = { createGoAwayGate, parseTimeLeft, GOAWAY_CLOSE_MARGIN_MS };
