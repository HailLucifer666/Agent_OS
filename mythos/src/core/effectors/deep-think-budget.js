'use strict';

// effectors/deep-think-budget.js — the think_deeply rate limiter.
//
// Extracted from from-computer.js by BUG-398 row 13 (2026-09-02) because that
// file is on the file-size ratchet at a recorded ceiling of 997 lines and was
// exactly at it. The guard's instruction is to move code out rather than raise
// the number. This is a cohesive unit — one clock, one interval, one refusal —
// and separating it also makes the shared-clock behaviour testable without a
// brain wired up.
//
// The whole history below is carried over verbatim from BUG-287; only the
// logger and config, which are module state over there, are passed in.

// BUG-287 (2026-08-20): think_deeply had no rate limit, and the reasoning lane
// is slow and rate-limited upstream, so nothing stopped it being called in a
// tight loop.
//
// Measured from that day's audit: eight calls, all actor:"cortex", with gaps of
// 61s, 12s, 17s, 153s, 416s and 22s — four of them inside 91 seconds, each
// restating the same browser-offline diagnosis. The operator said "Why are you
// repeating yourself? You just told me that" and "why are you thinking deeply
// for everything?", then told it to log the bug, which is incident
// inc-1787170098385-1. The loop is legible in the arguments: at 20:07:59 it
// asked the reasoning lane why it had repeated itself, and at 20:08:16 it asked
// the reasoning lane why it kept calling the reasoning lane — each call adding
// the latency that produced the next repetition.
//
// A CONTENT DIFF-GATE WOULD NOT HAVE CAUGHT THIS, and diff-gate.js already
// exists for a neighbouring problem (mull() speaks only when its thought
// changed), so that was the obvious first idea. All eight questions are
// textually different — different questions about the same stuck situation. The
// only thing they share is being seconds apart, so the gate has to be time.
//
// 60s is not a round number chosen for looking sensible: it is the cut that
// blocks the three rapid calls (12s, 17s, 22s) and allows the four spaced ones
// (61s, 153s, 416s). Change the reasoning if you change the number.
//
// The tool description already says "DEFAULT TO ANSWERING IT YOURSELF... this
// call is expensive". It is still there, still right, and it lost — the third
// time prose guidance has lost to a tool call in this codebase.
const DEEP_THINK_MIN_INTERVAL_DEFAULT_MS = 60000;
let lastDeepThinkAt = 0;
// BUG-398 row 13 (2026-09-02). WHO consumed the budget, not just when.
//
// `lastDeepThinkAt` is MODULE state, so one clock is shared by every caller:
// the cortex autonomous loop, the batch voice path and every Live voice
// session. A background tick can therefore rate-limit the operator's
// conversation, and the refusal then told that conversation "Deep reasoning was
// used 2s ago" — true of the process, false of the reader, and the reader is
// the one being asked to act on it.
//
// The BUDGET is deliberately unchanged: splitting it per surface doubles what
// an expensive lane can spend, and that is a cost decision for the operator,
// not one to make quietly inside a bug fix. What changes is that the refusal
// stops implying the caller spent it.
let lastDeepThinkBy = null;

function deepThinkMinIntervalMs(deepThinkConfig, deepThinkLogger) {
  const raw = deepThinkConfig && deepThinkConfig.DEEP_THINK_MIN_INTERVAL_MS;
  if (raw === undefined || raw === null || raw === '') return DEEP_THINK_MIN_INTERVAL_DEFAULT_MS;
  const n = Number(raw);
  // A threshold that parses to NaN makes every comparison below false, which
  // switches the guard OFF while leaving it looking on — the exact shape this
  // repo has been bitten by before. Fall back to the DEFAULT, never to zero:
  // a broken value must leave the guard standing, and it says so out loud.
  // An explicit 0 is different and is honoured — that is the deliberate opt-out.
  if (!Number.isFinite(n) || n < 0) {
    if (deepThinkLogger && typeof deepThinkLogger.warn === 'function') {
      try {
        deepThinkLogger.warn('DEEP_THINK_MIN_INTERVAL_MS is not a non-negative number — using the default',
          { value: raw, usingMs: DEEP_THINK_MIN_INTERVAL_DEFAULT_MS });
      } catch (_) { /* logging must never take the tool down */ }
    }
    return DEEP_THINK_MIN_INTERVAL_DEFAULT_MS;
  }
  return n;
}


// BUG-398 row 13: the refusal, with the CONSUMER named when it was not the
// caller. "You used this 2s ago" and "the background loop did" are different
// claims and only one is true; the model reading it has no other way to tell.
function cooldownRefusal(sinceLast, minIntervalMs, caller) {
  const waitS = Math.ceil((minIntervalMs - sinceLast) / 1000);
  const by = (lastDeepThinkBy && caller && lastDeepThinkBy !== caller)
    ? ' It was used by ' + lastDeepThinkBy + ', not by this conversation — one budget is shared '
      + 'across the voice surfaces and the background loop.'
    : '';
  return 'Deep reasoning was used ' + Math.round(sinceLast / 1000) + 's ago and is rate-limited '
    + 'for another ' + waitS + 's.' + by + ' Nothing is wrong. Answer this yourself now, from what you '
    + 'already know — you are capable of it, and a fast good answer beats a slow better one.';
}

function stampDeepThink(caller) {
  lastDeepThinkAt = Date.now();
  lastDeepThinkBy = caller || 'the background loop';
}

function deepThinkState() { return { lastDeepThinkAt: lastDeepThinkAt, lastDeepThinkBy: lastDeepThinkBy }; }

// Test seam only: the clock is module state by design (one budget per process).
function resetDeepThinkBudget() { lastDeepThinkAt = 0; lastDeepThinkBy = null; }

module.exports = {
  DEEP_THINK_MIN_INTERVAL_DEFAULT_MS,
  deepThinkMinIntervalMs,
  cooldownRefusal,
  stampDeepThink,
  deepThinkState,
  resetDeepThinkBudget,
};
