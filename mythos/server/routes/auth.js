'use strict';

// server/routes/auth.js — the missing half of a mechanism server/index.js has
// documented since Task 6. extractToken()'s comment there already says the
// mythos_token cookie is "set by the HUD once the operator enters the token";
// extractCookieToken() already reads it and tokenOk() already accepts it. Only
// the endpoint that SETS it was never built, so a browser tab on a deployment
// with MYTHOS_AUTH_TOKEN configured (mandatory for a non-loopback bind, which
// the phone node requires) had no way to present the credential at all: every
// /api/* fetch 401'd and the WS upgrade was refused. The static shell still
// loaded, so the HUD looked normal and simply never updated.
//
// This route is the login endpoint for that credential. It does NOT weaken the
// gate:
//   - the secret must still be presented; nothing is ever auto-issued to a
//     loopback caller (that is exactly the reverse-proxy hole verifyClient's
//     no-Origin check exists to close);
//   - the cookie carries MYTHOS_AUTH_TOKEN itself, i.e. the same credential
//     tokenOk() already accepts on the cookie channel — no new secret, no new
//     session type, nothing to keep in sync;
//   - the presented value is never logged, only the outcome.
//
// Same factory-extraction shape as routes/pin.js, and the same honest-404 when
// the feature isn't wired for this deployment (no token configured).

const { createLimiter } = require('../rate-limit');

// BUG-442: the name is owned by server/credentials.js now, together with the
// PIN session's own cookie, so the two can never silently become one again.
// Re-exported below because callers already import it from here.
const { BEARER_COOKIE: AUTH_COOKIE } = require('../credentials');

// Deliberately tight, and deliberately not a lockout. The token is boot-checked
// for >=16 chars of real entropy (server/index.js), so 5 guesses/min is not a
// viable oracle against it, while a lockout would let anyone who can reach the
// port deny the operator their own dashboard.
const EXCHANGE_WINDOW_MS = 60000;
const EXCHANGE_MAX = 5;

/**
 * @param {object} app express app
 * @param {object} deps
 * @param {string} deps.authToken            MYTHOS_AUTH_TOKEN ('' when unset)
 * @param {(presented:string)=>boolean} deps.authTokenMatches  timing-safe compare (server/index.js)
 * @param {number} deps.cookieTtlMs
 */
function mountAuthRoutes(app, deps) {
  const authToken = (deps && deps.authToken) || '';
  const authTokenMatches = (deps && deps.authTokenMatches) || (() => false);
  const cookieTtlMs = (deps && deps.cookieTtlMs) || 2592000000; // 30d

  const exchangeLimit = createLimiter({
    windowMs: EXCHANGE_WINDOW_MS,
    max: EXCHANGE_MAX,
    scope: 'auth-exchange',
  });

  // ---- POST /api/auth/session { token } — exchange the bearer secret for the
  // mythos_token cookie, so plain browser navigation (and the WS upgrade, which
  // a browser cannot attach headers to but DOES send cookies on) authenticates. ----
  app.post('/api/auth/session', exchangeLimit, (req, res) => {
    if (!authToken) {
      // Nothing to exchange for. Mirrors requirePinLock's honest 404 rather
      // than pretending the endpoint worked. Also what a default loopback
      // install sees, which is how the HUD knows not to prompt.
      return res.status(404).json({ error: 'No MYTHOS_AUTH_TOKEN is configured for this deployment.' });
    }
    // BUG-442 (2026-09-18): a 409 used to live here. Combined mode refused the
    // exchange entirely, because setting this cookie would have clobbered a live
    // PIN session — the two shared the name `mythos_token`, so writing one
    // destroyed the other and locked the operator out of the surface they had
    // just unlocked. The refusal was the right call for that shape and it left
    // combined deployments with no way to log a browser in at all.
    //
    // The collision is gone: the PIN session lives on `mythos_pin` now
    // (server/credentials.js), so both cookies coexist and a combined
    // deployment satisfies both requirements the way its policy says it should.
    const presented = req.body && req.body.token;
    if (typeof presented !== 'string' || !presented) {
      return res.status(400).json({ error: 'A token is required.' });
    }
    if (!authTokenMatches(presented)) {
      // No Set-Cookie on the failure path — a wrong guess must leave the
      // browser with exactly what it had.
      return res.status(401).json({ error: 'Incorrect token.' });
    }
    res.cookie(AUTH_COOKIE, authToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      maxAge: cookieTtlMs,
      path: '/',
    });
    res.json({ ok: true });
  });
}

module.exports = { mountAuthRoutes, AUTH_COOKIE };
