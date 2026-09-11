'use strict';

// notice-queue.js — BUG-432: our own system notices interrupt each other.
//
// THE MEASUREMENT, 2026-09-09. Fifteen of thirty-five `live.interrupted` rows
// landed within 300 ms of our own `live.text-injected`, and the boot greeting
// was cut on two boots out of two. Nothing external was interrupting MYTHOS:
// MYTHOS was interrupting itself. `onLiveTurnComplete` in live-tool-adapter.js
// can reach `sendSystemNotice` from six sites in one pass — the unheard-input
// correction, the premature-claim and retraction branches, and four
// `reportTurnAudit` calls, each of which fires once per detected row — and every
// one of them called `liveSession.sendText` synchronously. Gemini treats a
// realtimeInput text frame as a new turn, so notice two arrives while the model
// is still speaking notice one, and the model stops mid-sentence. The
// `serializeSpeech` chain in server/index.js protects only its own two callers
// and never sees this path.
//
// PURE ON PURPOSE, AND SMALL ON PURPOSE. live-session.js is at its file-size
// ratchet ceiling, and a holding rule with a timeout is worth its own test.
// Timers AND the clock are injected so a test can move them by hand rather than
// sleep — the clock is what lets a test prove an ORIGINAL deadline survived a
// rotation rather than being restarted.
//
// WHAT THIS DOES NOT DO, DELIBERATELY. It does not coalesce. Six notices become
// six turns, taken one at a time, not one merged paragraph. Coalescing means
// deciding which of six honest statements to drop or how to fuse them, and
// getting that wrong turns a true report into a summary — the failure mode the
// whole turn-audit family exists to prevent. Ordering is the cheap half and it
// is the half that was measured; merging is a separate decision with its own
// review. The adapter's header says the same thing about its own six call sites.
//
// ---------------------------------------------------------------------------
// THE 2026-09-11 CORRECTION: HOLDING A NOTICE IS NOT THE SAME AS KEEPING IT.
//
// The original queue survived a CLEAN rotation — that much was verified by
// probe: notice held, socket dropped, replacement up, one turnComplete, and the
// notice reached the new socket. Two narrower paths destroyed it silently.
//
// (1) AN UNSOLICITED DROP NEVER CALLS close(). live-session.js's ws 'close'
//     handler goes straight to setState('reconnecting') + reconnect(); close()
//     is where cancel() lived. So on the MOST COMMON rotation trigger the queue
//     was never told the transport had gone, its ceiling timer stayed armed,
//     fired mid-rotation, and release() sent into a CONNECTING socket. Probe:
//     `live.text-injected` written, `live.notice-undelivered` right after, and
//     the replacement socket's wire empty even after a completed turn.
//
// (2) A DEFERRED goAway RELEASED INTO A NULLED SOCKET. goAwayGate.turnComplete()
//     calls close('goaway', {final:false}), which nulls `ws`; release() then ran
//     in the SAME synchronous frame handler. Probe: two sockets, both wires
//     empty, one injection record and one undelivered record.
//
// In both cases release() had already `shift()`ed the item BEFORE calling send,
// so a refusal could not retain it. The notice was gone, and the one log line
// BUG-432's whole measurement is read from said it had been injected.
//
// THE SHAPE THAT FIXES IT: an explicit READY/SUSPENDED transport state, plus a
// socket GENERATION so an obsolete callback cannot mutate replacement state.
// Delivery is suspended by ANY departure from 'open' (setState is the single
// choke point, which covers the unsolicited drop, the error path and the failed
// initial open — none of which call close()) and restored ONLY after the
// replacement's setupComplete and after the operator's buffered audio has gone
// up. release() PEEKS and removes only after the send is locally accepted.
//
// DEADLINES ARE PER ITEM AND ARE NOT RESTARTED. The old code armed one flat
// `holdMaxMs` timer and re-armed a fresh full one after each release, so three
// notices held at t=0 under a 15 s ceiling came out at ~15 s, ~30 s and ~45 s.
// Each item now carries its own `deadlineAt`, fixed when it was enqueued and
// preserved across a rotation.
//
// WHAT "SENT" MEANS, AND WHAT IS LOST. 'sent' means a JSON frame was handed to
// an OPEN socket without a synchronous throw. It does NOT mean Gemini received
// it, and it does not mean the operator heard it. The Live wire protocol has no
// per-frame acknowledgement, so there is nothing to wait for and nothing to
// check. After an AMBIGUOUS disconnect — a frame accepted locally by a socket
// that then died — the notice is NOT replayed into the replacement session.
// Replaying risks the operator hearing the same correction twice, and a queue
// whose entire purpose is to stop notices stepping on each other must not
// become the thing that duplicates them. What is lost in that window is lost,
// and it is lost by choice rather than by oversight.
// ---------------------------------------------------------------------------

// A held notice is released when the model finishes its turn. That is normally
// within a couple of seconds, but a turn that never completes (a dropped frame,
// a model that goes quiet) must not silence a correction forever, so every held
// item carries its own deadline. 15s is well past a spoken reply and well short
// of the operator having moved on.
const DEFAULT_HOLD_MAX_MS = 15000;
// An expired backlog must NOT drain in one callback. With per-item deadlines,
// three notices enqueued together expire together, and a zero-length timer would
// fire three sends back-to-back — recreating the exact interruption this file
// exists to prevent, one tick later. The floor forces each subsequent notice to
// wait for either a real turn or another gap.
const MIN_RELEASE_GAP_MS = 1000;
// After a rotation the operator's buffered speech has just gone up and the turn
// it provokes owns the floor. Never release synchronously from resume(): arm the
// timer instead, so the ordinary turnComplete release wins the race whenever a
// turn actually arrives, and an already-expired notice still gets out if none
// does. This is the contract's "wait for that turn, or the existing hold ceiling".
const POST_RESUME_GRACE_MS = 2000;

function createNoticeQueue({
  inFlight,
  send,
  onUndelivered = null,
  holdMaxMs = DEFAULT_HOLD_MAX_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  logger = null,
} = {}) {
  if (typeof inFlight !== 'function') throw new TypeError('notice-queue: inFlight must be a function');
  if (typeof send !== 'function') throw new TypeError('notice-queue: send must be a function');

  const held = [];
  let timer = null;
  // READY, not SUSPENDED, is the default: the pure-queue tests construct this
  // with no live session at all and expect offer() to reach the wire.
  let suspended = false;
  let currentGeneration = null;

  function info(msg, fields) {
    if (logger && typeof logger.info === 'function') logger.info(msg, fields);
  }

  function armCeiling(extraGraceMs) {
    if (timer !== null || suspended || held.length === 0) return;
    const wait = Math.max(held[0].deadlineAt - now(), extraGraceMs || MIN_RELEASE_GAP_MS);
    timer = setTimer(() => {
      // Null the handle BEFORE releasing: release() can enqueue nothing but it
      // does re-arm, and a stale handle would be cleared twice.
      timer = null;
      info('live.notice-hold-expired', { held: held.length, holdMaxMs });
      release({ reason: 'hold-expired' });
    }, wait);
  }

  function disarmCeiling() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  // The transport went away. Idempotent, because several paths can report the
  // same departure (setState('reconnecting'), the error branch, close()) and a
  // second report must not re-log or re-arm anything.
  function suspend(reason) {
    if (suspended) return false;
    disarmCeiling();
    suspended = true;
    info('live.notice-suspended', { reason: String(reason || 'unknown'), queued: held.length });
    return true;
  }

  // The REPLACEMENT socket has reported setupComplete and any buffered operator
  // audio is already on the wire. Nothing is released here; the ceiling is armed
  // and the ordinary turnComplete path is given first refusal.
  function resume(opts) {
    const o = opts || {};
    currentGeneration = o.generation === undefined ? null : o.generation;
    suspended = false;
    info('live.notice-resumed', { generation: currentGeneration, queued: held.length, audioFlushed: o.audioFlushed === true });
    armCeiling(o.audioFlushed === true ? POST_RESUME_GRACE_MS : MIN_RELEASE_GAP_MS);
    return held.length;
  }

  // Returns 'sent' when the frame went to the wire now, 'queued' when it is
  // held for the end of the current turn (or for the transport to come back),
  // or false when send() refused it. Three outcomes, three values: a boolean
  // here would make "held" and "failed" indistinguishable to sendSystemNotice's
  // delivered check, which is the one thing this queue must not do.
  function offer(text, meta) {
    const m = meta || {};
    // The operator's own words never wait. They are the input the model is
    // answering, so holding them would be holding up the conversation to
    // protect a notice about it. They are NOT held while suspended either:
    // pretending the operator's text was queued when the socket is down would
    // be a worse lie than an honest false.
    if (m.operator === true) return send(text, m) === false ? false : 'sent';
    // Suspended is the fix for "nothing stops delivery while the socket is
    // down". Hold WITHOUT attempting a send, so no frame is handed to a dead
    // socket and no injection record is written for one.
    if (suspended || inFlight()) {
      held.push({ text, meta: m, deadlineAt: now() + holdMaxMs });
      armCeiling();
      info('live.notice-held', { site: m.site || 'unattributed', queued: held.length, suspended });
      return 'queued';
    }
    return send(text, m) === false ? false : 'sent';
  }

  // One per turn, matching the shape of the thing being protected: the model
  // speaks one turn at a time, so releasing the whole backlog at once would
  // recreate the interruption a turn later.
  function release(opts) {
    const o = opts || {};
    // An obsolete socket's callback must not mutate replacement state. Skipped
    // when no generation is supplied, so the pure-queue tests can still drive
    // release() directly; a source-shape test pins that live-session always
    // passes one, so the seam cannot quietly become a hole.
    if (o.generation !== undefined && o.generation !== currentGeneration) return false;
    // A down transport releases nothing. This is what makes the deferred-goAway
    // path safe: close() has already suspended us by the time turnComplete's
    // release lands in the same synchronous frame handler.
    if (suspended) return false;
    disarmCeiling();
    const next = held[0];
    if (!next) { armCeiling(); return false; }
    // PEEK, then send, then remove. The old order shifted first, so a refusal
    // destroyed the item it had just failed to deliver.
    const ok = send(next.text, next.meta);
    if (ok === false) {
      // RETAIN, suspend, and do NOT re-arm: an immediate retry loop against a
      // dead socket would burn the deadline and fill the log. Delivery waits for
      // the next readiness transition, which is the only thing that can change
      // the outcome.
      suspend('send-refused');
      info('live.notice-retained', { site: (next.meta && next.meta.site) || 'unattributed', queued: held.length });
      return false;
    }
    held.shift();
    armCeiling();
    return true;
  }

  // A final close ends the session, so anything still held will never be
  // spoken through Live. Hand it back rather than dropping it: the adapter has
  // a speakWhenClosed fallback for exactly this, and a correction that vanishes
  // silently is worse than one arriving in the other voice.
  //
  // A NON-final close is a rotation — the same session continues on a new
  // socket — so the queue survives it and merely SUSPENDS. Rotation and the
  // unsolicited drop therefore converge on one state machine rather than two.
  //
  // Replay into a later session is prevented by DRAINING, not by a check: the
  // array is emptied, so there is structurally nothing left to replay. Suspending
  // as well means no timer can survive either.
  function cancel(opts) {
    const final = !opts || opts.final !== false;
    if (!final) { suspend('rotation'); return 0; }
    disarmCeiling();
    suspended = true;
    const drained = held.splice(0, held.length);
    if (typeof onUndelivered === 'function') {
      for (const item of drained) onUndelivered(item.text, item.meta, 'session-closed');
    }
    return drained.length;
  }

  return {
    offer,
    release,
    cancel,
    suspend,
    resume,
    size: () => held.length,
    isHolding: () => held.length > 0,
    isSuspended: () => suspended,
  };
}

// The env-driven constructor lives here rather than in live-session.js, which is
// at its file-size ratchet ceiling — the ratchet exists to push new code out of
// oversized files rather than let a number be raised, so the flag reading, the
// defaults and this whole explanation live on this side of the seam.
//
// WHY THE ENVIRONMENT AND NOT THE SCHEMA. config/schema.js is at its own ceiling
// (870). Same constraint, same precedent as LOOP_LAG_TRACE (BUG-436) and
// GOOGLE_API_KEY: a value read once at construction, documented in .env.example.
//
// DEFAULT OFF until the measured pass recorded in the BUG-432 entry. With it off
// this returns null and sendText takes exactly the path it took before the change,
// which is what makes the flag a real kill switch rather than a second code path
// nobody has compared.
// The live.text-injected payload. It lives here, next to the queue that decides
// WHEN a frame goes out, for two reasons: live-session.js is at its ratchet
// ceiling, and the fields are the evidence the BUG-432 measurement was read from
// (interruptions within 300ms of our own injection), so the shape and the timing
// belong to one owner. Q2 still holds: the TEXT is never logged. These strings
// carry tool results, message bodies and whatever the operator typed; a site and
// a length attribute a turn, and the content lives in the audit vault under its
// own rules.
//
// `accepted` was added 2026-09-11. This row used to be written BEFORE the frame
// reached the wire, so a refused frame was recorded as injected — in the very
// field BUG-432's own measurement is counted from.
function injectionFields(meta, text, turnId, accepted) {
  const m = meta || {};
  return { site: m.site || 'unattributed', operator: m.operator === true, tool: m.tool || null,
    claim: m.claim || null, chars: String(text).length, turnId, accepted: accepted !== false };
}

function createNoticeQueueFromEnv(deps) {
  if (String(process.env.VOICE_SERIALIZE_NOTICES || '').toLowerCase() !== 'true') return null;
  const ceiling = Number(process.env.LIVE_NOTICE_HOLD_MAX_MS);
  return createNoticeQueue({ ...deps, holdMaxMs: ceiling > 0 ? ceiling : DEFAULT_HOLD_MAX_MS });
}

module.exports = {
  createNoticeQueue,
  createNoticeQueueFromEnv,
  injectionFields,
  DEFAULT_HOLD_MAX_MS,
  MIN_RELEASE_GAP_MS,
  POST_RESUME_GRACE_MS,
};
