'use strict';

// server/credentials.js — one place that knows what a credential is, which
// channel it may arrive on, and which combination a given deployment requires.
//
// BUG-442 (2026-09-18). This used to be four things in server/index.js
// (extractBearerChannel, extractCookieToken, extractToken, tokenOk) plus a
// cookie name repeated in server/routes/pin.js and server/routes/auth.js. Both
// routes wrote the literal `mythos_token`, and that collision was the bug: the
// PIN session and the bearer token are DIFFERENT CREDENTIALS PROVING DIFFERENT
// THINGS — local physical presence versus knowledge of a shared secret — and
// they were being carried in the same envelope.
//
// What that cost, on 2026-09-16, live: the PIN cookie was written with a hard
// 30-minute Max-Age while pin-session.js slid its own expiry forward on every
// successful check. At exactly 30 minutes the browser deleted a cookie the
// server still considered valid, the next fetch arrived bare, and the HUD asked
// the operator for their ACCESS TOKEN in the middle of a conversation. Nothing
// was wrong with the token.
//
// And the deeper one, found by reading rather than by the report: tokenOk()
// accepted a PIN session INSTEAD OF the bearer whenever PIN enforcement was
// off. The four-combination policy written directly above it says that must
// never happen. A proof of standing at the machine is not a proof of knowing
// the secret, and one must never be spendable as the other.
//
// THE POLICY, and it is the whole of it:
//
//   | bearer configured | PIN enforced | required               |
//   |-------------------|--------------|------------------------|
//   | no                | no           | nothing                |
//   | yes               | no           | valid bearer           |
//   | no                | yes          | valid PIN session      |
//   | yes               | yes          | BOTH                   |
//
// Each credential is checked on its own channels and can only ever satisfy its
// own row. There is no combination in which one substitutes for the other.

// The bearer cookie keeps its name: browsers already hold it, it is a 30-day
// cookie (routes/auth.js), and re-issuing it would log every operator out for
// no reason. The PIN session gets the new name, because it is the one whose
// lifetime was wrong anyway and whose holders must re-authenticate regardless.
const BEARER_COOKIE = 'mythos_token';
const PIN_COOKIE = 'mythos_pin';

function readCookie(req, name) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const kv = parts[i].trim().split('=');
    if (kv[0] === name) {
      try { return decodeURIComponent(kv.slice(1).join('=') || ''); } catch (_) { return kv.slice(1).join('=') || ''; }
    }
  }
  return null;
}

// Authorization: Bearer <t>, then ?token=<t>. A browser WebSocket cannot set
// headers, which is why the query channel exists at all (V2 §18.2).
function fromHeaderOrQuery(req) {
  const auth = req && req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    const value = auth.replace(/^Bearer\s+/i, '').trim();
    // An EMPTY `Authorization: Bearer ` is treated as absent, not as a supplied
    // credential. Otherwise a proxy or client that injects a blank header
    // suppresses the cookie channel entirely and the operator gets a hard 401
    // where the cookie used to work — and it would be inconsistent with the
    // query branch below, which already treats an empty ?token= as absent.
    // (Security review, 2026-09-18.) A NON-empty wrong value is still honoured
    // as an explicit attempt and still refused, which is the point of the
    // first-present-wins rule.
    if (value) return value;
  }
  try {
    const fromQuery = new URL(req.url, 'http://internal').searchParams.get('token');
    if (fromQuery) return fromQuery;
  } catch (_) { /* malformed url */ }
  return null;
}

// Header, then query, then the bearer cookie — FIRST PRESENT WINS, which is not
// the same as "first valid wins". A caller that explicitly supplies a wrong
// Authorization header is told it is wrong; it does not quietly fall through to
// a cookie that happens to be right, because that turns a stale script's bad
// credential into a silent success and hides the misconfiguration forever.
function extractBearer(req) {
  const explicit = fromHeaderOrQuery(req);
  if (explicit !== null) return explicit;
  return readCookie(req, BEARER_COOKIE);
}

// The PIN session rides its own cookie and nothing else — EXCEPT on a
// deployment with no bearer configured, where header/query stays accepted
// because that is how it behaved before this change and a non-browser client on
// a PIN-only install has no other way in. It can never satisfy a bearer
// requirement from there, because `missing` is computed per credential below.
//
// A legacy `mythos_token` value is NEVER read as a PIN session. It cannot be
// told apart from a bearer cookie, and guessing wrong in that direction would
// hand bearer-shaped input to the PIN checker.
function extractPin(req, opts) {
  const fromCookie = readCookie(req, PIN_COOKIE);
  if (fromCookie !== null) return fromCookie;
  if (opts && opts.allowHeaderQuery) return fromHeaderOrQuery(req);
  return null;
}

/**
 * The single authorization decision. Returns which credentials are MISSING
 * rather than a boolean, because the client has to choose between relocking the
 * PIN screen and opening the token prompt, and it was previously guessing —
 * net-guard.js read every /api/ 401 as "the token is wrong", which is exactly
 * how a lapsed PIN session asked the operator for their access token.
 *
 * `missing` names only credentials this deployment REQUIRES and did not get a
 * valid one of. It never names a credential the deployment does not use, and it
 * never leaks whether a presented value was absent or merely wrong.
 *
 * @returns {{ok: boolean, missing: string[], pinPresented: string|null}}
 */
function evaluate(req, policy) {
  const p = policy || {};
  const needBearer = !!p.authToken;
  const needPin = !!p.pinRequired;
  const missing = [];

  if (needBearer && !p.authTokenMatches(extractBearer(req))) missing.push('token');

  const pinPresented = needPin ? extractPin(req, { allowHeaderQuery: !needBearer }) : null;
  if (needPin && !p.pinValid(pinPresented)) missing.push('pin');

  // DISPOSITION, pinned deliberately (security review, 2026-09-18).
  //
  // In combined mode this array is a per-factor validity oracle: a caller with
  // no PIN session gets ['token'] for a wrong bearer and ['pin'] for a right
  // one, so a recovered candidate token can be CONFIRMED at the global rate
  // limit rather than at the 5/min the exchange endpoint imposes. That is real
  // and it is accepted, for two reasons.
  //
  // First, the obvious fix does not work. Suppressing 'pin' until the bearer
  // passes still answers ['token'] versus ['pin'] — distinguishable, so the
  // oracle survives. The ONLY way to close it is to return a constant list on
  // every failure, and that would tell the HUD the token is missing whenever
  // the PIN lapses — which is BUG-442's user-visible symptom, reintroduced in
  // the very change that fixes it.
  //
  // Second, the confirmation is worth little here: the bearer is boot-checked
  // for >=16 characters of real entropy, so this is not a guessing channel, and
  // in combined mode a confirmed token still opens nothing without the PIN.
  //
  // What would change this: if the token requirement ever stands alone on a
  // network-reachable deployment, revisit. A cheaper mitigation than a constant
  // list is to rate-limit the INFORMATIVE 401 to the exchange endpoint's budget
  // while leaving the bare 401 unlimited.
  return { ok: missing.length === 0, missing, pinPresented };
}

module.exports = {
  BEARER_COOKIE,
  PIN_COOKIE,
  readCookie,
  fromHeaderOrQuery,
  extractBearer,
  extractPin,
  evaluate,
};
