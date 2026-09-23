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
// Sliding expiry: the window extends by ttlMs while the operator is active, so
// nobody is kicked out mid-session; genuine inactivity past ttlMs re-locks.
//
// THE COMMENT THAT USED TO BE HERE WAS WRONG, AND IT COST A LIVE SESSION
// (BUG-442, 2026-09-16). It said the cookie's own Max-Age "does not need to
// slide in step — this store is the real authority, and an expired-but-still-
// sent cookie is simply rejected." That reasoning only covers the direction
// where the COOKIE outlives the SESSION. The damage came from the other
// direction, which it never considered: the cookie was written with a hard
// 30-minute Max-Age while this store kept sliding, so at 30 minutes the browser
// DELETED a credential the server still considered valid. The next request
// arrived with nothing, and the HUD asked the operator for their access token
// mid-conversation. An expired-but-still-sent cookie is indeed harmless. A
// still-valid-but-no-longer-sent one is the bug.
//
// So the two clocks are now derived from ONE expiry value, and renewal is
// explicit rather than a side effect of asking a question:
//
//   isValidNoSlide(t)  pure check, changes nothing. Every authorization path
//                      uses this — a WebSocket upgrade, an artifact fetch and a
//                      background poll must not silently extend a human
//                      presence claim.
//   renew()            slides the window AND returns the expiry, so the caller
//                      re-issues the cookie from the same number in the same
//                      step. Called only after a complete authorization has
//                      already succeeded.
//   isValid(t)         the original sliding check, kept for compatibility with
//                      existing callers and tests. New code should not use it.
//
// It remains possible for a response carrying Set-Cookie to be lost in flight,
// leaving a server-valid session whose cookie the browser never received. That
// is handled honestly on the client by relocking, not by pretending two clocks
// on two machines cannot drift.

const crypto = require('crypto');

const TOKEN_BYTES = 32; // 256 bits — brute force is not a realistic path
const DEFAULT_TTL_MS = 1800000; // 30 min
const DEFAULT_MAX_MS = 43200000; // 12 h — the absolute ceiling, see createPinSessionStore

function createPinSessionStore(opts) {
  const ttlMs = (opts && opts.ttlMs) || DEFAULT_TTL_MS;
  // The absolute ceiling. Sliding alone has no upper bound, and the security
  // review of BUG-442 (2026-09-18) established that the only thing which had
  // ever bounded a session was the bug itself — the cookie's hard Max-Age made
  // the browser drop a credential the server still honoured. Making the two
  // clocks agree removed that accident, and since the HUD polls /api/system
  // every 2 s, nothing a poll can reach would ever have expired again.
  //
  // This does NOT claim to measure human presence. It claims only that a
  // session cannot live forever. Whether a background poll should count as
  // activity at all is a separate, open product question.
  const maxMs = (opts && opts.maxMs) || DEFAULT_MAX_MS;

  let currentToken = null;
  let expiresAt = 0;
  let hardExpiresAt = 0;

  // Mint a new session, discarding any previous one (see header — single
  // active session by design). Never logged, never returned in an error.
  function issue() {
    currentToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    expiresAt = now + ttlMs;
    // Set ONCE, at issue. Nothing slides it; that is what makes it absolute.
    hardExpiresAt = now + maxMs;
    return currentToken;
  }

  function revoke() {
    currentToken = null;
    expiresAt = 0;
    hardExpiresAt = 0;
  }

  // One place that decides whether there is a live session at all, so the
  // sliding window and the absolute ceiling cannot be checked in one path and
  // forgotten in another.
  function live(now) {
    return !!currentToken && now <= expiresAt && now <= hardExpiresAt;
  }

  // The pure check. Timing-safe against the current token only — there is
  // exactly one to compare against (see header). Changes nothing: asking
  // whether a session is valid must not be what keeps it alive.
  function isValidNoSlide(presented) {
    if (!live(Date.now())) return false;
    const a = Buffer.from(String(presented || ''));
    const b = Buffer.from(currentToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Slide the window and hand back the single expiry value both clocks derive
  // from, so the caller re-issues the cookie from the same number rather than
  // computing a second one that can drift from it. Returns null when there is
  // no live session to renew — callers must not re-issue a cookie for one.
  function renew() {
    const now = Date.now();
    if (!live(now)) return null;
    // Never past the ceiling. The cookie's Max-Age is derived from the SAME
    // number, so as the hard expiry approaches the browser's copy shortens with
    // the server's rather than promising time the server will not honour —
    // which is the exact disagreement BUG-442 was.
    expiresAt = Math.min(now + ttlMs, hardExpiresAt);
    return { expiresAt, maxAgeMs: Math.max(0, expiresAt - now) };
  }

  // The original sliding check. Kept because existing callers and tests depend
  // on its exact behaviour; every authorization path moved to isValidNoSlide()
  // plus an explicit renew() (BUG-442). Do not reach for this in new code.
  function isValid(presented) {
    const match = isValidNoSlide(presented);
    if (match) expiresAt = Date.now() + ttlMs; // slide the window forward
    return match;
  }

  return { issue, revoke, isValid, isValidNoSlide, renew, ttlMs };
}

module.exports = { createPinSessionStore };
