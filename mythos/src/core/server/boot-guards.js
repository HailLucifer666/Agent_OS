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

module.exports = {
  weakAuthTokenReason: weakAuthTokenReason,
  MIN_AUTH_TOKEN_LENGTH: MIN_AUTH_TOKEN_LENGTH,
  createLoopbackHostGuard: createLoopbackHostGuard,
};
