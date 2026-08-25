'use strict';

// BUG-337 (2026-08-24): pure loopback-host logic for the DNS-rebinding guard
// in server/index.js. Kept free of express/http imports on purpose so the
// allowlist matrix is unit-testable without a server. RFC 7230: the Host
// header is case-insensitive.

function isLoopbackBind(bind) {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}

// Both with-port and bare forms: browsers always send the port for a
// non-default port, but curl/wget on the documented examples may not.
function loopbackHostAllowlist(port) {
  var p = String(port);
  var set = new Set();
  ['127.0.0.1', '[::1]', 'localhost', '::1'].forEach(function (h) {
    set.add(h + ':' + p);
    set.add(h);
  });
  return set;
}

function isAllowedLoopbackHost(host, port) {
  if (!host) return false;
  return loopbackHostAllowlist(port).has(String(host).toLowerCase());
}

module.exports = {
  isLoopbackBind: isLoopbackBind,
  loopbackHostAllowlist: loopbackHostAllowlist,
  isAllowedLoopbackHost: isAllowedLoopbackHost,
};
