'use strict';

// server/routes/pin.js — §7.3 local PIN lock routes. Same factory-extraction
// pattern as every other server/routes/*.js file (see routes/memory.js).
// These sit behind the existing /api requireToken gate like every other
// /api/* route (server/index.js) — that gates network/remote access; the
// PIN itself gates local physical presence, an independent layer.
//
// Degrades honestly when pinLock isn't wired (e.g. a test harness with a
// minimal deps object): 404s rather than throwing, matching the existing
// convention other extracted route files already use (routes/forge.js,
// routes/checkpoints.js) for an unwired optional dependency.
//
// Track B1: a successful /api/pin/verify now issues a real server-side
// session (src/core/security/pin-session.js) and hands it back as the
// mythos_token cookie — the SAME cookie name server/index.js's
// extractToken()/tokenOk() already check, so this is the PIN screen
// becoming actual access control rather than a new parallel mechanism.
// pinSession is optional here too (mirrors pinLock): if it's ever absent,
// verify still works exactly as before, just without issuing a session.

const PIN_SESSION_COOKIE = 'mythos_token';

function mountPinRoutes(app, deps) {
  const pinLock = deps && deps.pinLock;
  const pinSession = deps && deps.pinSession;

  function requirePinLock(res) {
    if (!pinLock) {
      res.status(404).json({ error: 'PIN lock is not available in this deployment.' });
      return false;
    }
    return true;
  }

  // ---- GET /api/pin/status — whether a PIN is configured; never reveals the PIN itself ----
  app.get('/api/pin/status', (req, res) => {
    if (!requirePinLock(res)) return;
    res.json({ configured: pinLock.isConfigured(), hasWindowsHello: pinLock.hasWindowsHello() });
  });

  // ---- POST /api/pin/set { pin, currentPin? } — sets/replaces the PIN.
  // First-time setup (nothing configured yet) needs no currentPin. Changing
  // an ALREADY-configured PIN requires currentPin to verify correctly first
  // (enforced inside pinLock.setPin() via the real verifyPin() path, lockout
  // included) — security-reviewer finding, fixed before commit: without
  // this, anyone who could reach this route at all could overwrite the PIN
  // with no knowledge of the old one, bypassing the whole feature. ----
  app.post('/api/pin/set', (req, res) => {
    if (!requirePinLock(res)) return;
    const pin = req.body && req.body.pin;
    const currentPin = req.body && req.body.currentPin;
    const result = pinLock.setPin(pin, currentPin);
    if (!result.ok) return res.status(result.lockedOut ? 429 : 400).json({ error: result.error });
    res.json({ ok: true });
  });

  // ---- POST /api/pin/verify { pin } — the actual local unlock check.
  // On success, mint a real server-side session (Track B1) and hand it back
  // as the mythos_token cookie so tokenOk() (server/index.js) has something
  // to check on every later /api/* request and WS upgrade — this is what
  // makes the correct PIN actually mean something server-side instead of
  // only painting an overlay away. A wrong PIN never reaches this and never
  // gets a cookie. ----
  app.post('/api/pin/verify', (req, res) => {
    if (!requirePinLock(res)) return;
    const pin = req.body && req.body.pin;
    const result = pinLock.verifyPin(pin);
    if (!result.ok) {
      return res.status(result.lockedOut ? 429 : 401).json({ error: result.error });
    }
    if (pinSession && typeof pinSession.issue === 'function') {
      const token = pinSession.issue();
      res.cookie(PIN_SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.secure,
        maxAge: pinSession.ttlMs,
        path: '/',
      });
    }
    res.json({ ok: true });
  });
}

module.exports = { mountPinRoutes };
