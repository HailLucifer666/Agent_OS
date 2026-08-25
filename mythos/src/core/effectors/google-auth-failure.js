'use strict';

// google-auth-failure.js — one classifier and one remedy for a dead Google
// OAuth grant, shared by every adapter that authenticates with the refresh
// token in GOOGLE_REFRESH_TOKEN.
//
// WHY IT EXISTS (BUG-296, 2026-08-21). All of this lived inside from-gmail.js,
// so only Gmail got it. Gmail and Calendar hold the SAME token: when it dies
// they fail together, in the same way, at the same moment. Gmail said
//
//   "...this is NOT a network problem and will not recover on its own... Do not
//    retry."   (terminal: true, breaker stops)
//
// and Calendar, in the same session, said
//
//   "Calendar fetch failed: invalid_grant: Token has been expired or revoked."
//
// with no classification, no remedy and no terminal flag — so it read like a
// transient fault and was retried forever. One invariant with two
// implementations, one of which was missing; the same defect class net-address.js
// was extracted to remove.
//
// Kept deliberately narrow: only the two OAuth grant signatures, never a blanket
// 4xx rule, so a rate limit or a transient 401 stays retryable. Widening this is
// how a recoverable fault gets permanently written off.

var { reasonText } = require('../util/reason-text');

function fail(msg) { return { ok: false, result: { error: msg } }; }

// BUG-273 C2 — PRECEDENCE, preserved verbatim from from-gmail.js because it was
// wrong once already. This used to read `!!(err && (err.isAuthError || RE.test(reason)))`,
// so the leading `err &&` short-circuited the WHOLE expression and the
// reason-regex fallback could never fire without an error object — the fallback
// existed exactly for the case where there is no flag to read, which is the case
// it could not serve. gmail-sensor.js reaches for this helper with only a string,
// and a dead fallback there silently stops a revoked token being announced.
function isTerminalAuthError(err, reason) {
  return !!((err && err.isAuthError) || /invalid_grant|unauthorized_client/.test(String(reason)));
}

// The remedy. `prefix` names the surface that broke ("Gmail fetch failed",
// "Calendar fetch failed") — one shared remedy, but collapsing the prefix would
// send the operator to the wrong adapter's logs.
//
// BUG-291: everything after the re-auth instruction is there because the message
// was ALREADY correct and still cost the same session twice. Following it exactly
// reproduces the fault a week later, so the remedy was a loop with no exit.
// Google's OAuth documentation: a project whose consent screen is external user
// type with publishing status "Testing" is issued refresh tokens that EXPIRE IN
// 7 DAYS. This project requests gmail.readonly/compose/send and
// calendar.readonly, so it is squarely in that rule.
//
// The ORDER is load-bearing: publish first, THEN re-authorise. The other way
// round mints another 7-day token and files the same incident next week.
function googleAuthFailureText(prefix, err) {
  var reason = reasonText(err);
  if (isTerminalAuthError(err, reason)) {
    return prefix + ': ' + reason
      + ' — this is NOT a network problem and will not recover on its own: the Google refresh token is '
      + 'expired or revoked. Tell the operator it needs re-authorising by running '
      + '`node scripts/google-auth.js` and putting the new GOOGLE_REFRESH_TOKEN in mythos/.env. '
      + 'If this recurs roughly every 7 days, re-authorising alone will NOT fix it: an OAuth consent '
      + 'screen with external user type and publishing status "Testing" is issued refresh tokens that '
      + 'expire in 7 days. Publish the app first (Google Cloud Console -> APIs & Services -> OAuth '
      + 'consent screen -> Publish app), and only then re-authorise, or the new token expires the same '
      + 'way. Do not retry.';
  }
  return prefix + ': ' + reason;
}

function googleAuthFailure(prefix, err) {
  var out = fail(googleAuthFailureText(prefix, err));
  // `terminal` travels BESIDE ok/result, never folded into either — the evidence
  // contract in src/core/CLAUDE.md has been flattened before and it cost a
  // ui_type action being audited as delivered. hub.js reads it as
  // `result.ok === false && result.terminal === true`.
  if (isTerminalAuthError(err, reasonText(err))) out.terminal = true;
  return out;
}

module.exports = { isTerminalAuthError, googleAuthFailureText, googleAuthFailure };
