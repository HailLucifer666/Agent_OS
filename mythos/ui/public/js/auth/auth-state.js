// auth-state.js — a two-function store so "something 401'd" can be announced
// without the layer that noticed knowing anything about the layer that reacts.
// net-guard.js (the fetch wrapper) calls markUnauthorized(); auth-gate.js and
// status-banner.js listen. Neither imports the other.

const listeners = new Set();
let unauthorized = false;

export function markUnauthorized() {
  unauthorized = true;
  listeners.forEach((fn) => { try { fn(); } catch (_) { /* one bad listener must not stop the rest */ } });
}

// Called once the operator successfully exchanges a token, so a banner raised
// by the 401 that prompted them clears instead of lingering forever.
export function clearUnauthorized() {
  unauthorized = false;
}

export function isUnauthorized() {
  return unauthorized;
}

export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
