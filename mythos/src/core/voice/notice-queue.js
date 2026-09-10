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
// Timers are injected so a test can move them by hand rather than sleep.
//
// WHAT THIS DOES NOT DO, DELIBERATELY. It does not coalesce. Six notices become
// six turns, taken one at a time, not one merged paragraph. Coalescing means
// deciding which of six honest statements to drop or how to fuse them, and
// getting that wrong turns a true report into a summary — the failure mode the
// whole turn-audit family exists to prevent. Ordering is the cheap half and it
// is the half that was measured; merging is a separate decision with its own
// review. The adapter's header says the same thing about its own six call sites.

// A held notice is released when the model finishes its turn. That is normally
// within a couple of seconds, but a turn that never completes (a dropped frame,
// a model that goes quiet) must not silence a correction forever, so every held
// item carries its own deadline. 15s is well past a spoken reply and well short
// of the operator having moved on.
const DEFAULT_HOLD_MAX_MS = 15000;

function createNoticeQueue({
  inFlight,
  send,
  onUndelivered = null,
  holdMaxMs = DEFAULT_HOLD_MAX_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = null,
} = {}) {
  if (typeof inFlight !== 'function') throw new TypeError('notice-queue: inFlight must be a function');
  if (typeof send !== 'function') throw new TypeError('notice-queue: send must be a function');

  const held = [];
  let timer = null;

  function armCeiling() {
    if (timer !== null || held.length === 0) return;
    timer = setTimer(() => {
      // Null the handle BEFORE releasing: release() can enqueue nothing but it
      // does re-arm, and a stale handle would be cleared twice.
      timer = null;
      if (logger && typeof logger.info === 'function') {
        logger.info('live.notice-hold-expired', { held: held.length, holdMaxMs });
      }
      release({ reason: 'hold-expired' });
    }, holdMaxMs);
  }

  function disarmCeiling() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  // Returns 'sent' when the frame went to the wire now, 'queued' when it is
  // held for the end of the current turn, or false when send() refused it (a
  // closed socket). Three outcomes, three values: a boolean here would make
  // "held" and "failed" indistinguishable to sendSystemNotice's delivered
  // check, which is the one thing this queue must not do.
  function offer(text, meta) {
    const m = meta || {};
    // The operator's own words never wait. They are the input the model is
    // answering, so holding them would be holding up the conversation to
    // protect a notice about it.
    if (m.operator === true) return send(text, m) === false ? false : 'sent';
    if (!inFlight()) return send(text, m) === false ? false : 'sent';
    held.push({ text, meta: m });
    armCeiling();
    if (logger && typeof logger.info === 'function') {
      logger.info('live.notice-held', { site: m.site || 'unattributed', queued: held.length });
    }
    return 'queued';
  }

  // One per turn, matching the shape of the thing being protected: the model
  // speaks one turn at a time, so releasing the whole backlog at once would
  // recreate the interruption a turn later.
  function release(opts) {
    disarmCeiling();
    const next = held.shift();
    if (next) {
      const ok = send(next.text, next.meta);
      if (ok === false && typeof onUndelivered === 'function') {
        onUndelivered(next.text, next.meta, (opts && opts.reason) || 'send-refused');
      }
    }
    armCeiling();
    return !!next;
  }

  // A final close ends the session, so anything still held will never be
  // spoken through Live. Hand it back rather than dropping it: the adapter has
  // a speakWhenClosed fallback for exactly this, and a correction that vanishes
  // silently is worse than one arriving in the other voice. A NON-final close
  // is a rotation — the same session continues on a new socket, so the queue
  // survives it.
  function cancel(opts) {
    const final = !opts || opts.final !== false;
    disarmCeiling();
    if (!final) return 0;
    const drained = held.splice(0, held.length);
    if (typeof onUndelivered === 'function') {
      for (const item of drained) onUndelivered(item.text, item.meta, 'session-closed');
    }
    return drained.length;
  }

  return { offer, release, cancel, size: () => held.length, isHolding: () => held.length > 0 };
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
function injectionFields(meta, text, turnId) {
  const m = meta || {};
  return { site: m.site || 'unattributed', operator: m.operator === true, tool: m.tool || null,
    claim: m.claim || null, chars: String(text).length, turnId };
}

function createNoticeQueueFromEnv(deps) {
  if (String(process.env.VOICE_SERIALIZE_NOTICES || '').toLowerCase() !== 'true') return null;
  const ceiling = Number(process.env.LIVE_NOTICE_HOLD_MAX_MS);
  return createNoticeQueue({ ...deps, holdMaxMs: ceiling > 0 ? ceiling : DEFAULT_HOLD_MAX_MS });
}

module.exports = { createNoticeQueue, createNoticeQueueFromEnv, injectionFields, DEFAULT_HOLD_MAX_MS };
