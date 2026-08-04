'use strict';

// src/core/security/pin-session.js — Track B1: the server-verified session
// issued after a successful PIN unlock (pin-lock.js's verifyPin()). Closes
// the gap recorded in the roadmap and in pin-lock-screen.js's own header: the
// PIN lock screen was a client-side visual/pointer deterrent only — nothing
// server-side ever checked it, so `curl 127.0.0.1/api/...` bypassed it
// entirely. This module is the missing server-side half.
//
// Single active session, deliberately — matching pin-lock.js's own
// single-process, single-operator lockout state (failCount/lockedUntil are
// plain closure variables there, not a per-client map). This is a local
// desktop assistant with one PIN and one operator, not a multi-tenant
// service; a session-id-keyed store would be unneeded complexity for a
// threat model that has exactly one legitimate holder at a time. Issuing a
// new session simply invalidates whatever the previous one was — correct
// for "the operator just re-proved presence," not a bug.
//
// Token: crypto.randomBytes (CSPRNG), NEVER Math.random. Compared with the
// exact crypto.timingSafeEqual pattern server/index.js's tokenOk() already
// uses for MYTHOS_AUTH_TOKEN, so the one secret-comparison convention in this
// codebase stays the only one.
//
// Sliding expiry: every successful isValid() call extends the window by
// ttlMs. An operator actively using the HUD is never kicked out mid-session;
// genuine inactivity past ttlMs re-locks. The cookie's own Max-Age (set by
// server/routes/pin.js) does not need to slide in step — this store is the
// real authority, and an expired-but-still-sent cookie is simply rejected.

const crypto = require('crypto');

const TOKEN_BYTES = 32; // 256 bits — brute force is not a realistic path
const DEFAULT_TTL_MS = 1800000; // 30 min

function createPinSessionStore(opts) {
  const ttlMs = (opts && opts.ttlMs) || DEFAULT_TTL_MS;

  let currentToken = null;
  let expiresAt = 0;

  // Mint a new session, discarding any previous one (see header — single
  // active session by design). Never logged, never returned in an error.
  function issue() {
    currentToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    expiresAt = Date.now() + ttlMs;
    return currentToken;
  }

  function revoke() {
    currentToken = null;
    expiresAt = 0;
  }

  // isValid(presented) -> boolean. Timing-safe against the current token
  // only — there is exactly one to compare against (see header).
  function isValid(presented) {
    if (!currentToken || Date.now() > expiresAt) return false;
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(currentToken);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (match) expiresAt = Date.now() + ttlMs; // slide the window forward
    return match;
  }

  return { issue, revoke, isValid, ttlMs };
}

module.exports = { createPinSessionStore };
