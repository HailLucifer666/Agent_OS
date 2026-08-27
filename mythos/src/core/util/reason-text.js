'use strict';

// util/reason-text.js — shared error-to-string normalizer, extracted from
// effectors/dispatch-action.js's reasonText() (REMEDIATION P2-12).
//
// Some effectors' failure shape is an object, not an Error (e.g.
// {error: m, ...extra}), or `err.message` is undefined for a non-Error thrown
// value. `(err.message || err)` string-concatenation then falls through to
// String(err) -> the useless literal "[object Object]" in the audit trail
// (confirmed in the 2026-07-29 audit's own Audit/2026-07-29.jsonl). Extract a
// real message when there is one, falling back to a truncated JSON dump
// instead of toString's default.
// B5 (2026-08-14) — THE THIRD INSTANCE OF "A FAILURE PATH THAT DISCARDS ITS
// REASON", so this one gets the fix at the shared helper plus an assertion,
// rather than a third patch at a third call site (BUG-101 was the first,
// scripts/google-auth.js the second).
//
// Measured: of 11 Gmail failures that day, ten said `invalid_grant` and the one
// at 12:29:39 said "Gmail fetch failed: " — nothing after the colon. The cause is
// exactly the branch below: an Error whose `.message` is the empty string passes
// `typeof raw.message === 'string'` and returns ''. The operator was told a tool
// failed and given no reason at all, which is strictly worse than a bad reason
// because there is nothing to act on or even to search for.
//
// null/undefined still map to '' — that means "no argument was passed", and
// callers concatenate it into their own sentence. Anything that IS present but
// renders empty now names its own shape instead, so the message can never trail
// off after a colon.
const NO_MESSAGE = 'no reason given';

// BUG-378 follow-up (2026-08-27). The strings that ARE a string, and are still
// not a reason. This module owns the question "did we extract any information?",
// so the answer lives here rather than being re-typed by each consumer — the
// test for this and effectors/adapter.js both read THIS set, so they cannot
// drift apart and quietly disagree about what counts as a reason.
//
// Found by a hostile-input probe rather than by reading: `reasonText(NaN)`
// returns the string 'NaN', which is truthy, so it sailed through
// adapter.js's `reason || noReasonGiven(...)` and became the operator's whole
// explanation. `{ok:false, error: NaN}` is a plausible product of
// `error: someCount - other` or a failed parse. Three of fifteen probed shapes
// landed here (error:NaN, reason:NaN, throw NaN).
//
// Deliberately NOT in this set: '0' and 'false'. They are equally useless as
// prose, but they are indistinguishable from a legitimate numeric error code or
// flag, and discarding real information is worse than passing along a terse
// value. Pinned by a test so the next reader does not "finish the job".
const DEAD_REASON_TEXT = new Set(['[object Object]', '{}', '[]', 'undefined', 'null', 'NaN']);

// True when reasonText() produced something, but that something carries no
// information a person could act on. Callers that STORE a reason as a standalone
// field should treat this as "no reason given" and substitute their own context;
// callers that CONCATENATE into their own sentence can ignore it.
function isDeadReasonText(text) {
  return typeof text !== 'string' || !text.trim() || DEAD_REASON_TEXT.has(text.trim());
}

function describeEmpty(raw) {
  if (raw instanceof Error) {
    const name = raw.name && raw.name !== 'Error' ? raw.name : 'Error';
    return name + ' with no message';
  }
  if (typeof raw === 'object') return 'an empty ' + (Array.isArray(raw) ? 'array' : 'object');
  return NO_MESSAGE;
}

function reasonText(raw) {
  if (raw == null) return '';
  let out;
  if (typeof raw === 'string') {
    out = raw;
  } else if (typeof raw === 'object') {
    if (typeof raw.error === 'string') out = raw.error;
    else if (typeof raw.message === 'string') out = raw.message;
    else {
      try { out = JSON.stringify(raw); } catch (_) { out = String(raw); }
    }
  } else {
    out = String(raw);
  }
  // The empty-reason guard. `{}` stringifies to "{}" and an empty Error message
  // to "" — neither tells anyone anything.
  if (!String(out == null ? '' : out).trim() || out === '{}' || out === '[]') return describeEmpty(raw);
  return out;
}

module.exports = { reasonText, NO_MESSAGE, DEAD_REASON_TEXT, isDeadReasonText };
