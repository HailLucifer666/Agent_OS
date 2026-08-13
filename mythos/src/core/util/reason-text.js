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
function reasonText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    if (typeof raw.error === 'string') return raw.error;
    if (typeof raw.message === 'string') return raw.message;
    try { return JSON.stringify(raw); } catch (_) { /* fall through */ }
  }
  return String(raw);
}

module.exports = { reasonText };
