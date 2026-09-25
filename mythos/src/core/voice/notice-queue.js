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
// preserved across a rotation. [2026-09-23: the deadline, and the forced release
// it drove, are gone — see the next block. What an item keeps across a rotation
// now is `enqueuedAt`, which a notice's 60 s age is measured from.]
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
//
// [2026-09-23: that choice now holds for corrections and notices only. For an
// OUTCOME — the answer to the operator's own request — losing it is the worse
// failure, so an outcome sent and never receipted IS replayed once. Next block.]
// ---------------------------------------------------------------------------
// THE 2026-09-23 CORRECTION: THE QUEUE HELD THE ANSWER. (BUG-432, BUG-436)
//
// The measured pass (attended, flag on, 51 turns) showed the queue did its first
// job — notices stopped cutting EACH OTHER off — and then did two new harms:
//
//   * It held the answer. A web_search result carrying "Price starts at ₹52,542
//     in India" waited behind heal announcements for the full 15 s ceiling, while
//     the reply in progress told the operator "I haven't found a current Indian
//     price". Everything was one class: the answer waited like an announcement.
//   * Its ceiling turned "wait" into "interrupt". The 15 s timer released a held
//     notice whether or not the model was speaking, so 4 held notices were forced
//     into live turns — each one cut a reply off, the defect the queue exists for.
//
// And BUG-436's delivery half: sendText() refused every frame while the socket
// was rotating, BEFORE the queue saw it, so a tool result finishing mid-rotation
// was spoken by plain TTS outside Live and the resumed session never knew.
//
// THE RULES NOW. Each item has a CLASS, decided by its site (SITE_CLASSES below;
// a derived test fails when a new site has none):
//
//   outcome     the answer to the operator's request. Never waits behind a
//               correction or notice. Sent the moment the transport is ready —
//               unless another OUTCOME's turn is still being spoken, because two
//               answers sent back-to-back would cut each other off exactly as
//               notices used to; then it waits at the FRONT of the queue. While
//               the transport is down it is held, and on resume it goes first.
//               Delivered ONCE: see receipts below.
//   correction  ad4-*, turn-audit lines. Waits for the turn to end. Never expires.
//   notice      everything else (proactive speech). Waits for the turn to end,
//               and after NOTICE_MAX_AGE_MS it is DROPPED, with a log row — an
//               announcement a minute stale is noise, and noise that interrupts.
//
// NOTHING IS EVER FORCED INTO A TURN IN FLIGHT. The timer that used to be a
// ceiling is now an idle tick: it expires stale notices, and it releases one item
// only when inFlight() is false — a turn that ended without a turnComplete frame
// reaching us, say. A turn that never ends at all holds corrections until the
// session closes; that is the price of never interrupting, and it is logged.
//
// RECEIPTS, AND WHAT THEY PROVE. Live has no per-frame acknowledgement, so a
// receipt is the next best thing the wire offers: ANY server frame arriving on
// the SAME socket after the send. It proves the connection was alive after our
// frame went out; it does not prove Gemini read it (a frame already in flight
// towards us can arrive after our send and before the server reads it). An
// outcome sent and NOT receipted before its socket died is replayed ONCE on the
// replacement. A second unreceipted drop drops it with a log row rather than
// replaying forever. The trade: a replay can duplicate an answer the old socket
// did deliver. For an answer that is the better error; for a correction or an
// announcement it is not, which is why only outcomes replay.
//
// DEDUPLICATION. An outcome carrying a `receiptKey` (the tool call id it answers)
// is refused as 'duplicate' if the same key is held, unreceipted, or among the
// last DELIVERED_KEYS_MAX delivered.
//
// A FINAL CLOSE hands every held item back through onUndelivered(text, meta,
// reason, cls). The server's handler (createUndeliveredHandler, below) puts a
// held OUTCOME into the conversation history, and speaks its spoken form over
// TTS when it has one. A stale result is never replayed into a LATER session:
// the arrays are drained, so there is nothing left to replay.
// ---------------------------------------------------------------------------

// An ordinary notice older than this is dropped rather than spoken. Long past a
// spoken reply (seconds), and long enough that the operator has moved on.
const NOTICE_MAX_AGE_MS = 60000;
// The idle tick's interval, and the gap between two idle releases. Without the
// floor a backlog could drain in one burst the moment the model went quiet —
// the back-to-back interruption this file exists to prevent, one tick later.
const MIN_RELEASE_GAP_MS = 1000;
// After a rotation the operator's buffered speech has just gone up and the turn
// it provokes owns the floor, so held corrections and notices wait out this
// grace (or that turn's end). Outcomes do not: they are the answer.
const POST_RESUME_GRACE_MS = 2000;
// How many delivered outcome keys are remembered for deduplication. Bounded, so
// a long session cannot grow it without limit; the oldest is forgotten first.
const DELIVERED_KEYS_MAX = 500;
// How many times an unreceipted outcome is replayed across drops.
const REPLAY_LIMIT = 1;

// Every site that names itself, and its class. A site missing from here is a
// droppable notice, which is why test/bug-432-outcome-outbox.test.js (c1)
// derives the list of sites from the source and fails on an unclassed one.
const SITE_CLASSES = Object.freeze({
  'late-outcome': 'outcome',
  'late-for-turn': 'outcome',
  'confirm-resolved': 'outcome',
  'confirm-rejected-by-voice': 'outcome',
  'ask-answer-to-live': 'outcome',
  'reply-routed-to-live': 'outcome',
  'ad4-correction-premature': 'correction',
  'ad4-correction-retract': 'correction',
  'ad4-correction-unheard': 'correction',
  'bug275-h2-defended-challenge': 'correction',
  'bug275-h3-unsourced-ranking': 'correction',
  'bug398-d1-unscheduled-commitment': 'correction',
  'bug398-row7-false-retraction': 'correction',
  'spoken-go-ahead-no-dispatch': 'correction',
  'operator-typed': 'operator',
  'operator-completed-transcript': 'operator',
  'proactive-speak': 'notice',
});

function noticeClass(meta) {
  const m = meta || {};
  if (m.operator === true) return 'operator';
  return SITE_CLASSES[m.site] || 'notice';
}

function createNoticeQueue({
  inFlight,
  send,
  onUndelivered = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  logger = null,
} = {}) {
  if (typeof inFlight !== 'function') throw new TypeError('notice-queue: inFlight must be a function');
  if (typeof send !== 'function') throw new TypeError('notice-queue: send must be a function');

  // Held items, outcomes first (an outcome is inserted after the last held
  // outcome), then corrections and notices in arrival order.
  const held = [];
  // Outcomes sent and not yet receipted: {..., generation}.
  const unreceipted = [];
  const deliveredKeys = new Set();
  let timer = null;
  // READY, not SUSPENDED, is the default: the pure-queue tests construct this
  // with no live session at all and expect offer() to reach the wire.
  let suspended = false;
  let currentGeneration = null;
  // An outcome's own turn is being spoken: a second outcome waits for its end.
  let outcomeTurnOpen = false;

  function info(msg, fields) {
    if (logger && typeof logger.info === 'function') logger.info(msg, fields);
  }
  const siteOf = (item) => (item.meta && item.meta.site) || 'unattributed';

  function keyPending(key) {
    return held.some((i) => i.key === key) || unreceipted.some((i) => i.key === key);
  }

  function rememberDelivered(key) {
    if (!key) return;
    deliveredKeys.add(key);
    if (deliveredKeys.size > DELIVERED_KEYS_MAX) deliveredKeys.delete(deliveredKeys.values().next().value);
  }

  // One frame to the wire. An outcome that goes out is tracked until a receipt.
  function transmit(item) {
    if (send(item.text, item.meta) === false) return false;
    if (item.cls === 'outcome') {
      unreceipted.push({ ...item, generation: currentGeneration });
      outcomeTurnOpen = true;
    }
    return true;
  }

  function holdItem(item) {
    if (item.cls === 'outcome') {
      let at = 0;
      while (at < held.length && held[at].cls === 'outcome') at += 1;
      held.splice(at, 0, item);
    } else {
      held.push(item);
    }
  }

  function expireNotices() {
    const t = now();
    for (let i = held.length - 1; i >= 0; i -= 1) {
      const item = held[i];
      const ageMs = t - item.enqueuedAt;
      if (item.cls !== 'notice' || ageMs < NOTICE_MAX_AGE_MS) continue;
      held.splice(i, 1);
      info('live.notice-expired', { site: siteOf(item), ageMs, dropped: true, queued: held.length });
    }
  }

  function armTick(waitMs) {
    if (timer !== null || suspended || held.length === 0) return;
    timer = setTimer(tick, Math.max(waitMs || 0, MIN_RELEASE_GAP_MS));
  }

  function disarmTick() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  // The idle tick. It never sends into a turn in flight: that is the whole
  // difference from the ceiling it replaced.
  function tick() {
    timer = null;
    expireNotices();
    if (!suspended && held.length > 0 && !inFlight()) { releaseOne(); return; }
    armTick(MIN_RELEASE_GAP_MS);
  }

  // PEEK, then send, then remove: the pre-2026-09-11 order shifted first, so a
  // refusal destroyed the item it had just failed to deliver.
  function releaseOne() {
    const next = held[0];
    if (!next) return false;
    if (!transmit(next)) {
      // RETAIN, suspend, and do NOT re-arm: a retry loop against a dead socket
      // would only fill the log. The next readiness transition is the only thing
      // that can change the outcome.
      suspend('send-refused');
      info('live.notice-retained', { site: siteOf(next), queued: held.length });
      return false;
    }
    held.shift();
    armTick(MIN_RELEASE_GAP_MS);
    return true;
  }

  // The transport went away. Idempotent, because several paths can report the
  // same departure (setState('reconnecting'), the error branch, close()) and a
  // second report must not re-log or re-arm anything. The socket's turn went
  // with it, so no outcome turn is open any more.
  function suspend(reason) {
    if (suspended) return false;
    disarmTick();
    suspended = true;
    outcomeTurnOpen = false;
    info('live.notice-suspended', { reason: String(reason || 'unknown'), queued: held.length, unreceipted: unreceipted.length });
    return true;
  }

  // The REPLACEMENT socket has reported setupComplete and any buffered operator
  // audio is already on the wire. Unreceipted outcomes from an older socket are
  // replayed (once), then the first held outcome goes now; everything else waits
  // for a turn to end, or the grace.
  function resume(opts) {
    const o = opts || {};
    currentGeneration = o.generation === undefined ? null : o.generation;
    suspended = false;
    const orphaned = [];
    for (let i = unreceipted.length - 1; i >= 0; i -= 1) {
      if (unreceipted[i].generation === currentGeneration) continue;
      orphaned.unshift(unreceipted.splice(i, 1)[0]);
    }
    for (let i = orphaned.length - 1; i >= 0; i -= 1) {
      const item = orphaned[i];
      if (item.replays >= REPLAY_LIMIT) {
        info('live.outcome-unconfirmed', { site: siteOf(item), replays: item.replays, dropped: true });
        continue;
      }
      held.unshift({ ...item, replays: item.replays + 1 });
    }
    info('live.notice-resumed', { generation: currentGeneration, queued: held.length, audioFlushed: o.audioFlushed === true });
    if (held.length > 0 && held[0].cls === 'outcome') releaseOne();
    armTick(o.audioFlushed === true ? POST_RESUME_GRACE_MS : MIN_RELEASE_GAP_MS);
    return held.length;
  }

  // Returns 'sent' when the frame went to the wire now, 'queued' when it is
  // held, 'duplicate' when an outcome with that receiptKey is already on its way
  // or delivered, or false when send() refused a correction or notice. Distinct
  // values, because sendSystemNotice must be able to tell "held" from "failed".
  function offer(text, meta) {
    const m = meta || {};
    const cls = noticeClass(m);
    // The operator's own words never wait, and are NOT held while suspended:
    // pretending the operator's text was queued when the socket is down would be
    // a worse lie than an honest false.
    if (cls === 'operator') return send(text, m) === false ? false : 'sent';
    const key = cls === 'outcome' && m.receiptKey ? String(m.receiptKey) : null;
    if (key && (deliveredKeys.has(key) || keyPending(key))) {
      info('live.notice-duplicate', { site: m.site || 'unattributed', queued: held.length });
      return 'duplicate';
    }
    const item = { text, meta: m, cls, key, enqueuedAt: now(), replays: 0 };
    if (cls === 'outcome' && !suspended && !outcomeTurnOpen) {
      if (transmit(item)) return 'sent';
      // Refused at the wire: the socket is dying under an 'open' state. Keep
      // the answer for the replacement rather than returning false.
      suspend('send-refused');
    }
    // Suspended: hold WITHOUT attempting a send, so no frame is handed to a
    // dead socket and no injection record is written for one.
    if (cls === 'outcome' || suspended || inFlight()) {
      holdItem(item);
      armTick(MIN_RELEASE_GAP_MS);
      info('live.notice-held', { site: m.site || 'unattributed', cls, queued: held.length, suspended });
      return 'queued';
    }
    return transmit(item) ? 'sent' : false;
  }

  // A server frame arrived on the socket of `generation`: everything sent on it
  // before that frame is receipted. See RECEIPTS above for what that proves.
  function ack(opts) {
    const o = opts || {};
    for (let i = unreceipted.length - 1; i >= 0; i -= 1) {
      const item = unreceipted[i];
      if (o.generation !== undefined && item.generation !== o.generation) continue;
      unreceipted.splice(i, 1);
      rememberDelivered(item.key);
      info('live.outcome-receipted', { site: siteOf(item), generation: item.generation, replays: item.replays });
    }
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
    outcomeTurnOpen = false;
    disarmTick();
    expireNotices();
    return releaseOne();
  }

  // A NON-final close is a rotation — the same session continues on a new
  // socket — so the queue survives it and merely SUSPENDS. Rotation and the
  // unsolicited drop therefore converge on one state machine rather than two.
  //
  // A FINAL close drains: held items are handed back (see the header), and
  // unreceipted ones are forgotten — they were sent, and a hand-back would speak
  // an answer the operator may already have heard. Replay into a later session is
  // prevented by DRAINING, not by a check: nothing is left to replay.
  function cancel(opts) {
    const final = !opts || opts.final !== false;
    if (!final) { suspend('rotation'); return 0; }
    disarmTick();
    suspended = true;
    outcomeTurnOpen = false;
    const drained = held.splice(0, held.length);
    const unconfirmed = unreceipted.splice(0, unreceipted.length).length;
    if (drained.length || unconfirmed) info('live.notice-drained', { handedBack: drained.length, unconfirmed });
    if (typeof onUndelivered === 'function') {
      for (const item of drained) onUndelivered(item.text, item.meta, 'session-closed', item.cls);
    }
    return drained.length;
  }

  return {
    offer,
    release,
    ack,
    cancel,
    suspend,
    resume,
    size: () => held.length,
    isHolding: () => held.length > 0,
    isSuspended: () => suspended,
  };
}

// What the server does with an item a FINAL close could not deliver. Only an
// OUTCOME is worth anything once its conversation is over: it goes into the
// conversation history, so the next session knows it happened, and its spoken
// form (a 30 s+ late outcome has one) is spoken over TTS — the fallback the
// adapter used to take on every rotation. Corrections and notices about a closed
// conversation are logged by the session and nothing more. Pure, so it is tested
// without a server; server/index.js wires it with its own historyAppend and
// proactiveSpeak.
function createUndeliveredHandler({ historyAppend, speak, logger } = {}) {
  const warn = (msg, fields) => { if (logger && typeof logger.warn === 'function') logger.warn(msg, fields); };
  return function onNoticeUndelivered(text, meta, reason, cls) {
    if (cls !== 'outcome') return false;
    const m = meta || {};
    try {
      if (typeof historyAppend === 'function') historyAppend('system', String(text));
    } catch (err) {
      warn('live.outcome-handback-failed', { site: m.site || 'unattributed', step: 'history', error: String((err && err.message) || err) });
    }
    if (m.speech && typeof speak === 'function') {
      Promise.resolve().then(() => speak(m.speech)).catch((err) =>
        warn('live.outcome-handback-failed', { site: m.site || 'unattributed', step: 'speech', error: String((err && err.message) || err) }));
    }
    return true;
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

// LIVE_NOTICE_HOLD_MAX_MS was read here until 2026-09-23. It set the ceiling
// that forced held notices into live turns, and that ceiling is gone.
function createNoticeQueueFromEnv(deps) {
  if (String(process.env.VOICE_SERIALIZE_NOTICES || '').toLowerCase() !== 'true') return null;
  return createNoticeQueue(deps);
}

module.exports = {
  createNoticeQueue,
  createNoticeQueueFromEnv,
  createUndeliveredHandler,
  injectionFields,
  noticeClass,
  SITE_CLASSES,
  NOTICE_MAX_AGE_MS,
  MIN_RELEASE_GAP_MS,
  POST_RESUME_GRACE_MS,
  DELIVERED_KEYS_MAX,
  REPLAY_LIMIT,
};
