'use strict';

// server/routes/auth.js — sign a browser in to a deployment that has a
// MYTHOS_AUTH_TOKEN, and sign it out again.
//
// A token is only ever configured when the server is bound off loopback (phone
// node, remote browser); server/index.js refuses that bind without one. A plain
// browser tab cannot set an Authorization header on its own navigation or on a
// WebSocket upgrade, so it presents the token ONCE here and gets a session
// cookie back.
//
// BUG-444 (fixed 2026-09-23): this route used to set the cookie to the TOKEN
// ITSELF, for 30 days. It now mints a random session id (server/auth-sessions.js
// keeps only its hash), and the token never leaves the request body it arrived
// in. The desktop app never sees this prompt: the Electron main process holds
// the token and calls this route itself (electron/main.js primeAuthSession).
//
// Unchanged from before: the presented value is never logged; a wrong guess
// leaves the browser with exactly what it had (no Set-Cookie on failure); and a
// deployment with no token gets an honest 404, which is how the HUD knows not
// to prompt.

const { createLimiter } = require('../rate-limit');
const { SESSION_COOKIE, LEGACY_COOKIES, readCookie } = require('../credentials');

// Deliberately tight, and deliberately not a lockout. The token is boot-checked
// for >=16 chars of real entropy (boot-guards.js), so 5 guesses/min is not a
// viable oracle against it, while a lockout would let anyone who can reach the
// port deny the operator their own dashboard.
const EXCHANGE_WINDOW_MS = 60000;
const EXCHANGE_MAX = 5;

function sessionCookieOptions(req, maxAgeMs) {
  return { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: maxAgeMs, path: '/' };
}

/**
 * @param {object} app express app
 * @param {object} deps
 * @param {string} deps.authToken                         MYTHOS_AUTH_TOKEN ('' when unset)
 * @param {(presented:string)=>boolean} deps.authTokenMatches  timing-safe compare
 * @param {object} deps.sessions                          createAuthSessionStore()
 * @param {(hash:string)=>void} [deps.onSessionRevoked]   close that session's sockets
 * @param {object} [deps.logger]
 */
function mountAuthRoutes(app, deps) {
  const d = deps || {};
  const authToken = d.authToken || '';
  const authTokenMatches = d.authTokenMatches || (() => false);
  const sessions = d.sessions;
  const onSessionRevoked = typeof d.onSessionRevoked === 'function' ? d.onSessionRevoked : () => {};
  const logger = d.logger || { info() {}, warn() {} };

  const exchangeLimit = createLimiter({ windowMs: EXCHANGE_WINDOW_MS, max: EXCHANGE_MAX, scope: 'auth-exchange' });

  function revokePresented(req) {
    const hash = sessions ? sessions.revoke(readCookie(req, SESSION_COOKIE)) : null;
    if (hash) onSessionRevoked(hash);
    return !!hash;
  }

  // ---- POST /api/auth/session { token } — exempt from the /api gate (it IS
  // the way in), rate-limited on its own. ----
  app.post('/api/auth/session', exchangeLimit, (req, res) => {
    if (!authToken || !sessions) {
      return res.status(404).json({ error: 'No MYTHOS_AUTH_TOKEN is configured for this deployment.' });
    }
    const presented = req.body && req.body.token;
    if (typeof presented !== 'string' || !presented) {
      return res.status(400).json({ error: 'A token is required.' });
    }
    if (!authTokenMatches(presented)) {
      return res.status(401).json({ error: 'Incorrect token.' });
    }
    // Signing in again from the same browser replaces its session rather than
    // leaving the old one live until it expires.
    revokePresented(req);
    const issued = sessions.issue();
    res.setHeader('Cache-Control', 'no-store');
    for (const name of LEGACY_COOKIES) res.clearCookie(name, { path: '/' });
    res.cookie(SESSION_COOKIE, issued.id, sessionCookieOptions(req, issued.maxAgeMs));
    logger.info('auth.session-issued', { persisted: issued.persisted });
    res.json({ ok: true });
  });

  // ---- POST /api/auth/logout — behind the /api gate like everything else.
  // Revokes THIS browser's session and closes the sockets it opened; other
  // browsers stay signed in. Signing everyone out is rotating the token. ----
  app.post('/api/auth/logout', (req, res) => {
    const revoked = revokePresented(req);
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    logger.info('auth.session-revoked', { revoked });
    res.json({ ok: true, revoked });
  });
}

module.exports = { mountAuthRoutes, SESSION_COOKIE };
