'use strict';

// server/sanitize-error.js — the one place that decides what an error is
// allowed to say to a client.
//
// sanitizeErrorForClient() lived as a closure inside server/index.js and was
// therefore reachable ONLY from the WebSocket result path. Every extracted REST
// route (routes/*.js) answered failures with a raw `err.message`, so the same
// server disclosed local filesystem layout over HTTP that it carefully withheld
// over WS: an ENOENT carrying an absolute vault path went straight into a JSON
// body. The function is moved here VERBATIM (it never used any closure state)
// so both transports share one policy and one leak detector.
// A4 FIX: sanitize error messages before sending to WS clients.
// Prevents leaking internal paths, dependency details, stack fragments.
//
// 2026-08-02: this was flattening EVERY non-matching message to the generic
// fallback, including an effector's own honest fail() text (e.g. app_reply's
// "whatsapp is not open, so there is no conversation to reply to"), which the
// model then received as "An internal error occurred." — a real, spoken-safe
// answer thrown away. live-tool-adapter.js's sanitizeResultError routes EVERY
// effector failure through this same function, and now tags those values
// effectorReason:true — set at the origin, the only place that knows a value is
// a fail() string rather than a thrown exception. Everything untagged is still
// generalized, so this stays deny-by-default. Tagged text is still scanned for
// accidental path/stack/secret leakage (e.g. run_command's raw stderr) before
// being allowed through unmodified.
function looksLikeUnsafeLeak(msg) {
  return /[a-zA-Z]:\\|(?:^|[\s(])\/(?:home|Users|root|var|etc|tmp)\//.test(msg) ||
    /\bat\s+.+\(.+:\d+:\d+\)/.test(msg) ||
    /\b(?:api[_-]?key|secret|token|password|bearer)\b\s*[:=]/i.test(msg);
}
function sanitizeErrorForClient(err) {
  const msg = (err && err.message) || 'Unknown error';
  // Map common internal errors to safe user-facing strings
  if (/EACCES|EPERM/.test(msg)) return 'Permission denied — check file permissions.';
  if (/ENOSPC/.test(msg)) return 'Disk full — unable to write data.';
  if (/ENOENT/.test(msg)) return 'File not found.';
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return 'Network request failed.';
  if (/all models failed/.test(msg)) return 'All AI providers are currently unavailable.';
  // An effector's own honest failure reason, EXPLICITLY tagged as such by
  // live-tool-adapter.js's sanitizeResultError — the one call site that knows
  // the value is a fail() string and not a thrown exception. Let it through so
  // the operator hears what actually went wrong, still scanned for accidental
  // path/stack/secret leakage (run_command hands back raw stderr) and still
  // capped so a pathological effector cannot ship an unbounded string.
  //
  // Deliberately gated on the tag rather than on "this has no .stack": that
  // inference would flip this whole function from deny-by-default to
  // allow-by-default for every hand-built error object anywhere in the server,
  // which is not a trade a WS-facing sanitizer should make.
  const isEffectorReason = typeof err === 'object' && err !== null && err.effectorReason === true;
  if (isEffectorReason && !looksLikeUnsafeLeak(msg)) {
    return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
  }
  // Generic fallback — strip any paths or technical details
  return 'An internal error occurred. Check server logs for details.';
}

// The REST policy. A route's thrown message is usually its OWN validation text
// ("title is required"), which is the useful answer and has to survive — the WS
// deny-by-default policy would flatten it into a useless 400. So REST asks the
// same function the same question with the effector-reason tag set: internal
// error codes are still mapped first, anything that looks like a path, a stack
// frame or a secret is still replaced with the generic fallback, and what is
// left passes through capped. Deliberately expressed as a call rather than a
// second copy of the rules, so widening the leak detector covers both at once.
function sanitizeRestError(err) {
  const message = (err && err.message) || 'Unknown error';
  return sanitizeErrorForClient({ message, effectorReason: true });
}

module.exports = { sanitizeErrorForClient, sanitizeRestError, looksLikeUnsafeLeak };
