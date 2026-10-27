'use strict';

// Boot-time security guards for server/index.js (BUG-337/BUG-338 home).
// Extracted from server/index.js because that file sits on the
// file-size-ratchet baseline (4680-line ceiling): new guards must land
// somewhere else, and both of these are self-contained boundary checks.

const { isAllowedLoopbackHost } = require('../net/loopback-host.js');

// H3(b) (security audit, 2026-08-08): MYTHOS_AUTH_TOKEN is the only thing
// standing between a non-loopback bind and the full effector set, so an
// obviously weak token is rejected at boot. Returns null when the token is
// acceptable, else a human-usable reason string.
const MIN_AUTH_TOKEN_LENGTH = 16;
const WEAK_AUTH_TOKEN_RE = /^(password|changeme|admin|secret|letmein|qwerty|default|token|test|12345678)/i;

function weakAuthTokenReason(token) {
  if (token.length < MIN_AUTH_TOKEN_LENGTH) return `shorter than the ${MIN_AUTH_TOKEN_LENGTH}-char minimum`;
  if (/^(.)\1*$/.test(token)) return 'a single character repeated';
  if (new Set(token.toLowerCase()).size < 4) return 'too few distinct characters (low entropy)';
  if (WEAK_AUTH_TOKEN_RE.test(token)) return 'matches a common/weak token pattern';
  return null;
}

// BUG-337 (2026-08-24): DNS-rebinding guard. A rebound page is same-origin to
// 127.0.0.1:PORT, so CORS never preflights its JSON POSTs and — with the
// tokenless loopback default — tokenOk admits them straight into the full
// effector surface (launch_app/ui_type/click_at/run_command). The WS upgrade
// already rejects foreign Origins; this is the same posture for plain HTTP.
//
// Two valid Host answers per request: the CONFIGURED port, or the port the
// server actually bound — config MYTHOS_PORT:0 means ephemeral, and tests and
// tools can only ever send a Host carrying the real local port.
function createLoopbackHostGuard({ configuredPort }) {
  return function hostHeaderGuard(req, res, next) {
    const localPort = req.socket && req.socket.localPort;
    if (isAllowedLoopbackHost(req.headers.host, configuredPort)) return next();
    if (localPort && isAllowedLoopbackHost(req.headers.host, localPort)) return next();
    res.status(403).send('Rejected: Host header is not this server\'s loopback address (DNS-rebinding guard, BUG-337).');
  };
}

// Cross-origin guard for /api (2026-09-23, with the PIN removal). The DNS-rebinding
// guard above stops a page that has become SAME-origin with 127.0.0.1. It does
// nothing about an ordinary foreign page: CORS only decides whether that page
// may READ a response, never whether the request runs. A form POST, or a fetch
// in no-cors mode, from any website still reached every handler.
//
// That was always true of an install with no PIN and no token. It was not true
// of the operator's machine, because the PIN session cookie (SameSite) never
// rode a cross-site request, so such a request was refused. Removing the PIN
// removed that accidental barrier — this is the deliberate one that replaces it.
//
// The rule, for browser-shaped requests only (a non-browser client — curl, the
// phone node, Electron's main process — sends neither header, and on a token
// deployment still needs the token):
//   - an Origin header must be this request's own ORIGIN — scheme, host and
//     port — or be on ALLOWED_ORIGINS. `Origin: null` (sandboxed frames,
//     file://, data:) never matches, so it is never allowed.
//     Until 2026-09-29 (audit, B3a) the scheme was NOT compared, so that a page
//     behind a TLS-terminating proxy (https:// outside, http:// here) passed
//     implicitly. That deployment already had to list its https:// origin on
//     ALLOWED_ORIGINS for the WebSocket, whose verifyClient compares full
//     origins (server/index.js), so the implicit pass only ever made /api
//     looser than the socket beside it. It is now the same explicit entry.
//     This server's own scheme is https only when its own socket is encrypted.
//     Not req.secure: under Express's `trust proxy` that reads X-Forwarded-Proto,
//     a header the client can send, and a header the client sends cannot vouch
//     for the client. Today the server listens on plain HTTP only
//     (server/index.js app.listen), so every request compares as http://.
//   - Sec-Fetch-Site, when present, must be 'same-origin' or 'none' (the operator
//     typed the URL). 'same-site' is refused on purpose: another port on
//     localhost is same-site, and it is exactly the local dev server or rogue
//     page this exists to stop.
// Returns null when the request may proceed, else a reason naming the header.
//
// DISPOSITIONS (security review, 2026-09-23), pinned rather than left implicit:
//   - A request with NEITHER header is allowed, whatever its method. Refusing a
//     header-less POST was proposed and rejected: Electron's main process signs
//     the desktop in with exactly that (POST /api/auth/session from Node fetch),
//     as do curl and the phone node. The residual is a browser too old to send
//     Origin on a cross-site POST (pre-2019); every current browser sends it.
//   - A reverse proxy that REWRITES Host (to an internal service name) while the
//     browser's Origin keeps the public hostname will be refused. That is the
//     deployment ALLOWED_ORIGINS exists for: list the public origin there.
// Mounted on /api and /vault/builds (server/index.js).
function crossOriginRefusal(req, allowedOrigins) {
  const h = (req && req.headers) || {};
  const origin = h.origin;
  if (origin !== undefined) {
    let ownOrigin = null;
    let theirOrigin = null;
    const tls = !!(req.socket && req.socket.encrypted);
    try { if (h.host) ownOrigin = new URL(`${tls ? 'https' : 'http'}://${h.host}`).origin; } catch (_) { /* bad Host */ }
    try { theirOrigin = new URL(origin).origin; } catch (_) { /* 'null' or garbage */ }
    const sameOrigin = !!ownOrigin && !!theirOrigin && theirOrigin !== 'null' && theirOrigin === ownOrigin;
    if (!sameOrigin && !(allowedOrigins && allowedOrigins.has(origin))) return 'origin';
  }
  const site = h['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'sec-fetch-site';
  return null;
}

function createCrossOriginGuard({ allowedOrigins, logger }) {
  return function crossOriginGuard(req, res, next) {
    const reason = crossOriginRefusal(req, allowedOrigins);
    if (!reason) return next();
    // The header NAME is logged, never its value alone without context: an
    // Origin is not a secret, and naming it is what makes a refusal diagnosable.
    if (logger) logger.warn('api.cross-origin-rejected', { reason, origin: req.headers.origin || null, site: req.headers['sec-fetch-site'] || null, path: req.path });
    res.status(403).json({ error: 'Rejected: this request came from another site. The MYTHOS API only answers its own HUD.' });
  };
}

module.exports = {
  weakAuthTokenReason: weakAuthTokenReason,
  MIN_AUTH_TOKEN_LENGTH: MIN_AUTH_TOKEN_LENGTH,
  createLoopbackHostGuard: createLoopbackHostGuard,
  crossOriginRefusal: crossOriginRefusal,
  createCrossOriginGuard: createCrossOriginGuard,
};
