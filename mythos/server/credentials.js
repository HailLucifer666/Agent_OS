'use strict';

// server/credentials.js — one place that knows what a credential is, which
// channel it may arrive on, and when a request is authorized.
//
// HISTORY, because each step here was a real incident:
//   - BUG-442 (2026-09-18): the PIN session and the bearer token shared one
//     cookie name, so a 30-minute PIN cookie expiring mid-conversation made the
//     HUD ask for the ACCESS TOKEN. The two credentials were split onto two
//     cookies.
//   - BUG-444 (filed 2026-09-18, fixed 2026-09-23): the bearer's cookie carried
//     the RAW MYTHOS_AUTH_TOKEN for 30 days. It now carries a random session id
//     (server/auth-sessions.js stores only its hash), under a NEW name.
//   - 2026-09-23, operator decision: the PIN is removed entirely. "I open the
//     app, it puts me in the HUD." There is one credential left.
//
// THE POLICY, and it is the whole of it:
//
//   | MYTHOS_AUTH_TOKEN | required                                              |
//   |-------------------|-------------------------------------------------------|
//   | unset             | nothing — the server refuses a non-loopback bind      |
//   |                   | without a token (server/index.js), so this is always  |
//   |                   | loopback, and the Origin/Host guards are what stop a  |
//   |                   | web page from driving it                              |
//   | set               | the token (Authorization header or ?token=), or a     |
//   |                   | live session id in the mythos_session cookie          |
//
// A configured token gates LOOPBACK TOO. There is deliberately no "it came from
// 127.0.0.1, let it in" exemption: a remote user behind a local reverse proxy
// arrives from 127.0.0.1 as well. The desktop app gets its session without a
// prompt because the Electron MAIN process holds the token and exchanges it
// (electron/main.js primeAuthSession) — the renderer never sees the token.

// The session cookie has a NEW name on purpose. The old `mythos_token` cookie
// held the raw token; if the new id rode under the same name, a browser still
// holding the old value would present it on the channel that now means
// "session", and every check would have to tell the two apart forever. A new
// name makes the old value structurally unreadable as a credential.
const SESSION_COOKIE = 'mythos_session';

// Cookies that were credentials once and are never read as one again. Cleared
// whenever a request carries one (server/index.js), logged by NAME only.
//   mythos_token — the raw bearer token (BUG-444)
//   mythos_pin   — the PIN session (removed 2026-09-23)
const LEGACY_COOKIES = Object.freeze(['mythos_token', 'mythos_pin']);

// The one 401 sentence, shown VERBATIM by the HUD (AD-5). It used to be three
// (server/auth-hint.js, BUG-400); with the PIN gone only the token case exists,
// and a request with no token configured is never refused.
const UNAUTHORIZED_HINT = 'Unauthorized — this deployment has a MYTHOS_AUTH_TOKEN. Sign in once with '
  + 'POST /api/auth/session {"token": ...} (the HUD asks for it), or send Authorization: Bearer <token>.';

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

function legacyCookiesPresent(req) {
  return LEGACY_COOKIES.filter((name) => readCookie(req, name) !== null);
}

// Authorization: Bearer <t>, then ?token=<t>. A browser WebSocket cannot set
// headers, which is why the query channel exists at all (V2 §18.2).
function fromHeaderOrQuery(req) {
  const auth = req && req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    const value = auth.replace(/^Bearer\s+/i, '').trim();
    // An EMPTY `Authorization: Bearer ` is treated as absent, not as a supplied
    // credential, matching the query branch below. (Security review, 2026-09-18.)
    if (value) return value;
  }
  try {
    const fromQuery = new URL(req.url, 'http://internal').searchParams.get('token');
    if (fromQuery) return fromQuery;
  } catch (_) { /* malformed url */ }
  return null;
}

// The bearer token and ONLY the bearer token: header, then query. Since BUG-444
// no cookie carries it, so there is no cookie channel to fall back to. The
// AETHER node-trust branch of verifyClient uses this directly, because a
// browser session proves nothing about being an enrolled device on the LAN.
function extractBearer(req) {
  return fromHeaderOrQuery(req);
}

/**
 * The single authorization decision.
 *
 * EXPLICIT CREDENTIAL WINS, and is not a "first valid wins": a caller that
 * supplies a wrong Authorization header is told it is wrong, even if it also
 * holds a valid session cookie. Falling through would turn a stale script's bad
 * token into a silent success and hide the misconfiguration forever.
 *
 * Sessions are resolved HERE and nowhere else (not in extractBearer), so there
 * is exactly one path by which a cookie becomes an authorization.
 *
 * @param {object} req
 * @param {{authToken: string, authTokenMatches: (s:string)=>boolean, sessionValid: (id:string)=>boolean}} policy
 * @returns {{ok: boolean, missing: string[], via: 'open'|'bearer'|'session'|null, sessionId: string|null}}
 *   `missing` keeps its pre-existing shape for the HUD's 401 routing: only ever
 *   [] or ['token'].
 */
function evaluate(req, policy) {
  const p = policy || {};
  if (!p.authToken) return { ok: true, missing: [], via: 'open', sessionId: null };

  const explicit = fromHeaderOrQuery(req);
  if (explicit !== null) {
    const ok = !!p.authTokenMatches(explicit);
    return { ok, missing: ok ? [] : ['token'], via: ok ? 'bearer' : null, sessionId: null };
  }

  const sessionId = readCookie(req, SESSION_COOKIE);
  if (sessionId !== null && typeof p.sessionValid === 'function' && p.sessionValid(sessionId)) {
    return { ok: true, missing: [], via: 'session', sessionId };
  }
  return { ok: false, missing: ['token'], via: null, sessionId: null };
}

module.exports = {
  UNAUTHORIZED_HINT,
  SESSION_COOKIE,
  LEGACY_COOKIES,
  readCookie,
  legacyCookiesPresent,
  fromHeaderOrQuery,
  extractBearer,
  evaluate,
};
