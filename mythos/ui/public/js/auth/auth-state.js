// auth-state.js — a small store so "something 401'd" can be announced
// without the layer that noticed knowing anything about the layer that reacts.
// net-guard.js (the fetch wrapper) calls markUnauthorized(); auth-gate.js and
// status-banner.js listen. Neither imports the other.
//
// BUG-400 (2026-09-03): a 401 is only a TOKEN signal on a deployment that has a
// token. On one that has none — /health says authRequired:false — the same 401
// means a PIN session is missing, and every subscriber that reacted to it
// offered the operator a token prompt that could not be satisfied (the exchange
// endpoint answers 404: "nothing to enter"). Both subscribers had the bug, for
// the same reason: they read the store, and the store said "unauthorized".
//
// So the fact lives HERE, once, and the bad state is made unrepresentable
// rather than guarded in each subscriber: once auth-gate.js's probe has learned
// that no token is configured, markUnauthorized() cannot raise the flag at all.
// A subscriber added next month cannot get this wrong, because there is nothing
// for it to get wrong.

const listeners = new Set();
let unauthorized = false;
// null = not yet learned (behave as before: a 401 is a credential problem);
// true = a token is configured; false = no token, so a 401 is never a token
// signal. Set from auth-gate.js's /health probe, nowhere else.
let tokenRequired = null;

export function markUnauthorized() {
  if (tokenRequired === false) return;
  unauthorized = true;
  listeners.forEach((fn) => { try { fn(); } catch (_) { /* one bad listener must not stop the rest */ } });
}

// Called once the operator successfully exchanges a token, so a banner raised
// by the 401 that prompted them clears instead of lingering forever.
export function clearUnauthorized() {
  unauthorized = false;
}

// Learned from GET /health. Passing false also clears any flag a 401 raised
// while the probe was still in flight — that 401 was a PIN 401, not a token
// one, and leaving it set would keep the banner's "Enter token" alive.
// Listeners are deliberately NOT notified on clear: their contract is "became
// unauthorized", and auth-gate.js's listener opens the prompt on notify.
export function setTokenRequired(value) {
  tokenRequired = value === null || value === undefined ? null : Boolean(value);
  if (tokenRequired === false) unauthorized = false;
}

export function isTokenRequired() {
  return tokenRequired;
}

export function isUnauthorized() {
  return unauthorized;
}

export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
