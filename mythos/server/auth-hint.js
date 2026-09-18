'use strict';

// auth-hint.js — the 401 sentence, as a pure function of what this deployment
// actually has configured.
//
// EXTRACTED FROM server/index.js's requireToken() ON 2026-09-03, and the reason
// it is its own module rather than twelve more lines in there: index.js is on
// the file-size ratchet's already-oversized list, and that ratchet's rule is
// "the baseline number is a ceiling, not a suggestion — do not raise it to make
// this pass. Move the new code somewhere else." Adding the third branch took it
// 4680 -> 4692 and the gate refused. This is the extraction it asked for, not a
// raised number.
//
// It is also the better shape independently: index.js is one large closure over
// per-server state, so almost nothing in it can be unit-tested directly. This
// decision depends on exactly two booleans and no closure state at all, so
// lifting it out makes it directly drivable by node:test — see
// test/bug-400-auth-hint.test.js. The integration proof (a real server
// answering a real 401) stays in
// test/bug-400-auth-gate-no-401-listener-without-a-token.test.js; two routes,
// one answer, and they are compared there.
//
// WHY THE THIRD BRANCH EXISTS (BUG-400, 2026-09-03). There are three ways to be
// unauthorized here and there used to be two sentences. A PIN-only deployment —
// no MYTHOS_AUTH_TOKEN, a PIN configured and enforced — fell to the generic
// "set MYTHOS_AUTH_TOKEN" line, naming a secret the server does not hold. The
// operator read that message, went hunting through mythos/.env for the token,
// entered it correctly, and got a 404 from the exchange endpoint, because there
// was nothing to exchange. The error was hiding its own cause.
//
// The HUD displays these strings VERBATIM (AD-5): nothing is invented
// client-side, so whatever is wrong here is what the operator is told.

// unauthorizedHint({hasToken, pinRequired}) -> string
//
// hasToken     — MYTHOS_AUTH_TOKEN is configured (truthy), not whether one was
//                presented on this request.
// pinRequired  — pinSessionRequired(): PIN_SESSION_ENFORCE is on AND a PIN is
//                actually configured. Both halves matter; PIN_SESSION_ENFORCE
//                defaults to true, so on its own it gates nothing.
function unauthorizedHint(state) {
  const s = state || {};
  const hasToken = !!s.hasToken;
  const pinRequired = !!s.pinRequired;

  if (hasToken && pinRequired) {
    // Combined mode. The H1 fix (2026-08-08) pinned the two credentials to
    // distinct CHANNELS; BUG-442 (2026-09-18) gave them distinct COOKIES
    // instead, which is why this no longer says the bearer cannot use a cookie.
    // Naming the wrong cookie here would send an operator to look for a
    // credential under a name nothing issues any more.
    return 'Unauthorized — this deployment requires BOTH the MYTHOS_AUTH_TOKEN bearer token '
      + '(Authorization: Bearer <token>, ?token=, or the mythos_token cookie) AND an unlocked '
      + 'PIN session (the mythos_pin cookie from POST /api/pin/verify).';
  }
  if (pinRequired) {
    // PIN-only. Name the route that mints the credential, and say plainly that
    // there is no token, so nobody goes looking for one again.
    return 'Unauthorized — this deployment is PIN-locked. Unlock it with POST /api/pin/verify '
      + '(the HUD PIN screen). No MYTHOS_AUTH_TOKEN is configured, so there is no token to enter.';
  }
  // Token-only, and the fallback for a deployment that reached a 401 with
  // neither configured — which should be unreachable, since tokenOk() returns
  // true when no token is set and no PIN is required. Kept as the honest
  // default rather than throwing: a 401 handler must always produce a sentence.
  return 'Unauthorized — set MYTHOS_AUTH_TOKEN via Authorization: Bearer <token> or the '
    + 'mythos_token cookie.';
}

module.exports = { unauthorizedHint };
