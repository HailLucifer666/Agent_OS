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

// BUG-442 (2026-09-18): a second channel, and a generation counter.
//
// THE SECOND CHANNEL existed so a lapsed PIN session relocked the PIN screen
// instead of asking for the ACCESS TOKEN. The PIN was removed on 2026-09-23,
// so the server now only ever names 'token' (server/credentials.js) and the
// channel is gone. The structured `missing` list stays, because reading the
// server's own list beats parsing its English.
//
// THE GENERATION. Several fetches are usually in flight when a credential
// lapses, so one lapse produces a burst of 401s. Without a fence, the ones
// still arriving AFTER the operator has re-authenticated re-open the prompt
// they just satisfied. Each request captures the generation at send time; a
// notification from an older generation is ignored.
//
// It is deliberately NOT ws.js's `authGeneration`. That counter increments on
// every socket open and tracks socket/probe freshness; sharing it would mean an
// ordinary reconnect silently suppressed a real, current HTTP failure. Two
// different facts, two different counters.
let recoveryGeneration = 0;

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
// while the probe was still in flight — on a deployment with no token, a 401
// is not a token signal, and leaving it set would keep "Enter token" alive.
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

// ---- BUG-442: which credential, and is this news still current? ---------------

// Read at send time by net-guard.js and handed back with the failure.
export function currentRecoveryGeneration() {
  return recoveryGeneration;
}

// Called after a credential has actually been re-established — a successful
// token exchange. Everything already in flight is
// now stale news about a problem that has been solved.
export function advanceRecoveryGeneration() {
  recoveryGeneration += 1;
}

/**
 * Route a structured authorization failure to whatever can satisfy it.
 *
 * `missing` is the server's own list, never parsed out of English prose.
 *
 * A failure whose captured generation predates the current one is DROPPED: the
 * operator has re-authenticated since that request left, and reopening the
 * prompt they just satisfied is the bug this counter exists for. Concurrent
 * failures within one generation collapse, because each channel's own flag is
 * idempotent.
 */
export function markCredentialsMissing(missing, capturedGeneration) {
  if (typeof capturedGeneration === 'number' && capturedGeneration < recoveryGeneration) return;
  const names = Array.isArray(missing) ? missing : [];
  if (names.includes('token')) markUnauthorized();
}
