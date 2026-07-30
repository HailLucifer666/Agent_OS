'use strict';

// immune/breakers.js — per-target circuit breaker FSM.
// CLOSED -> (>= failThreshold fails within windowMs) -> OPEN -> (resetMs, x2 backoff,
// cap maxResetMs) -> HALF_OPEN -> success -> CLOSED.
//
// One instance per effector or per provider; the *caller* owns the Map of instances
// (Phase 7's effector hub owns per-effector breakers; immune/probes.js does not keep
// its own breaker instances in Phase 6 — see Spec Ambiguities Resolved #4 for why
// providers are monitored via probes.js's health.anomaly emission instead).
//
// bus and config are REQUIRED — the given architecture-doc code calls bus.emit()
// inside recordFailure() without ever taking `bus` as a parameter, which is a
// guaranteed ReferenceError. Do not construct a breaker without both.

const BREAKER_STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

function createBreaker({ name, bus, config, failThreshold, windowMs, resetMs, maxResetMs }) {
  if (!bus) throw new Error('createBreaker requires bus');
  if (!name) throw new Error('createBreaker requires name');

  // Config is read, not re-defaulted (BREAKER_FAIL_THRESHOLD / BREAKER_WINDOW_MS /
  // BREAKER_RESET_MS are real schema.js keys). maxResetMs has no schema key — see
  // Spec Ambiguities Resolved #18 — so it stays a literal default.
  const FAIL_THRESHOLD = failThreshold || (config && config.BREAKER_FAIL_THRESHOLD) || 3;
  const WINDOW_MS = windowMs || (config && config.BREAKER_WINDOW_MS) || 30000;
  const RESET_MS = resetMs || (config && config.BREAKER_RESET_MS) || 15000;
  const MAX_RESET_MS = maxResetMs || 300000;

  let state = BREAKER_STATES.CLOSED;
  let failCount = 0;
  let lastFailAt = 0;
  let resetAt = 0;
  let currentResetMs = RESET_MS;
  let halfOpenAttempts = 0;

  function allow() {
    const now = Date.now();
    if (state === BREAKER_STATES.CLOSED) return true;

    if (state === BREAKER_STATES.OPEN) {
      if (now >= resetAt) {
        state = BREAKER_STATES.HALF_OPEN;
        halfOpenAttempts = 0;
        return true; // allow exactly one probe
      }
      return false; // caller must synthesize { ok:false, result:'circuit-open' } itself
    }

    if (state === BREAKER_STATES.HALF_OPEN) {
      halfOpenAttempts++;
      return halfOpenAttempts <= 1; // only one probe in half-open
    }
    return false;
  }

  function recordSuccess() {
    if (state === BREAKER_STATES.HALF_OPEN) {
      state = BREAKER_STATES.CLOSED; // recovered
      currentResetMs = RESET_MS;     // backoff resets on real recovery
    }
    failCount = 0;
  }

  // Force CLOSED from any state, regardless of the HALF_OPEN-only gate in
  // recordSuccess(). Used when the immune healer decides a tool is healthy
  // (tool-restore after suppression cooldown) — without it the breaker stays
  // OPEN/HALF_OPEN because the suppressed tool is never dispatched again, so
  // recordSuccess() is never called and the HUD keeps showing "degraded" even
  // after the tool is logically restored. This is the missing state transition.
  function reset() {
    state = BREAKER_STATES.CLOSED;
    failCount = 0;
    lastFailAt = 0;
    resetAt = 0;
    currentResetMs = RESET_MS;
    halfOpenAttempts = 0;
  }

  function recordFailure() {
    const now = Date.now();
    if (now - lastFailAt > WINDOW_MS) failCount = 0;
    lastFailAt = now;
    failCount++;

    if (state === BREAKER_STATES.HALF_OPEN) {
      // Probe failed -> back to OPEN with exponential backoff on the DELAY, not the
      // absolute timestamp (see Spec Ambiguities Resolved #3).
      currentResetMs = Math.min(currentResetMs * 2, MAX_RESET_MS);
      resetAt = now + currentResetMs;
      state = BREAKER_STATES.OPEN;
      return;
    }

    if (failCount >= FAIL_THRESHOLD) {
      currentResetMs = RESET_MS; // fresh trip restarts backoff at the base delay
      state = BREAKER_STATES.OPEN;
      resetAt = now + currentResetMs;
      // 'health.anomaly' — exact string, do not paraphrase.
      bus.emit('health.anomaly', { kind: 'effector-flapping', target: name, failCount: failCount, state: state });
    }
  }

  return {
    get state() { return state; },
    get stats() { return { name: name, state: state, failCount: failCount, resetAt: resetAt }; },
    allow: allow,
    recordSuccess: recordSuccess,
    recordFailure: recordFailure,
    reset: reset
  };
}

module.exports = { createBreaker: createBreaker, BREAKER_STATES: BREAKER_STATES };
