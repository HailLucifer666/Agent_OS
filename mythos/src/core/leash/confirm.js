'use strict';

// confirm.js — pending-confirmation registry for Leash T3/T4 gates.
// CA from NOVA app/lib/voice/confirm.js (65 lines). Adapted from a module-level
// singleton Map into a DI factory (createConfirmRegistry) so tests get a fresh
// registry per call instead of sharing global state across test files, and so
// TTL comes from config.LEASH_CONFIRM_TTL_MS (schema key, see config/schema.js)
// instead of reading process.env directly — Lesson #6: config must be read, not
// re-defaulted. Everything else is verbatim NOVA logic: crypto.randomUUID() ids,
// single-use accept()/reject() (consumed on first resolution), connection-scoped
// binding (a stray accept from the wrong connectionId returns null WITHOUT
// deleting the entry, so it can't DoS the legitimate connection's pending confirm).

const crypto = require('crypto');

function createConfirmRegistry({ config, onExpire }) {
  const ttlMs = config.LEASH_CONFIRM_TTL_MS;   // exact key, do not paraphrase
  const pending = new Map(); // confirmId -> { summary, action, expiresAt, connectionId, timer }

  function nextId() {
    return 'confirm-' + crypto.randomUUID();
  }

  // Wave 1 (2026-08-13): an expired confirm used to be swept SILENTLY — only
  // ever discovered by the next create() call's opportunistic sweep, with no
  // record anywhere that it happened. The 2026-08-12/13 session's
  // gmail_send confirm (1 created, 0 completed) is exactly that: the operator
  // never saw a decline, MYTHOS never learned the send didn't happen, and
  // nothing in the audit trail distinguishes "operator said no" from "nobody
  // ever answered". A per-entry timer makes expiry an EVENT, not an absence.
  function armExpiry(confirmId, entry) {
    const timer = setTimeout(() => {
      if (pending.get(confirmId) !== entry) return; // already accepted/rejected
      pending.delete(confirmId);
      if (typeof onExpire === 'function') {
        try { onExpire(confirmId, entry); } catch (_) { /* caller's problem, never ours */ }
      }
    }, ttlMs);
    if (typeof timer.unref === 'function') timer.unref(); // never keeps the process alive
    return timer;
  }

  // create(summary, action, connectionId) -> confirmId. `action` is caller-defined
  // (Leash callers pass the {tool, args} decision) and is only ever handed back
  // verbatim via accept() — this registry never inspects or executes it.
  function create(summary, action, connectionId) {
    // Sweep expired entries on every create — piggybacks on the common path so
    // we need no new setInterval. Without this, confirms leak forever when the
    // client disconnects before replying: accept()/reject() are the only
    // deletion paths, and they only fire on a reply. A disconnected client
    // leaves orphaned {summary, action, expiresAt, connectionId} entries that
    // never get swept — unbounded memory growth over a long-running session
    // with reconnects. The Map is typically <10 entries so this scan is cheap.
    // Still needed alongside armExpiry's timer below: this catches any entry
    // created before onExpire existed in a long-lived process (a stale timer
    // reference is harmless, just redundant with this sweep firing first).
    if (pending.size > 0) {
      const now = Date.now();
      for (const [id, entry] of pending) {
        if (now > entry.expiresAt) pending.delete(id);
      }
    }
    connectionId = connectionId === undefined ? null : connectionId;
    const confirmId = nextId();
    const entry = { summary: summary, action: action, expiresAt: Date.now() + ttlMs, connectionId: connectionId, timer: null };
    entry.timer = armExpiry(confirmId, entry);
    pending.set(confirmId, entry);
    return confirmId;
  }

  function clearExpiry(entry) {
    if (entry && entry.timer) clearTimeout(entry.timer);
  }

  // accept(confirmId, connectionId) -> the stored action, or null if unknown,
  // expired, already consumed, or created by a different connection.
  function accept(confirmId, connectionId) {
    connectionId = connectionId === undefined ? null : connectionId;
    const entry = pending.get(confirmId);
    if (!entry) return null;
    if (entry.connectionId !== null && entry.connectionId !== connectionId) return null;
    pending.delete(confirmId);
    clearExpiry(entry);
    if (Date.now() > entry.expiresAt) return null;
    return entry.action;
  }

  // reject(confirmId, connectionId) -> true if a pending confirm belonging to
  // this connection was found and removed, false otherwise (including a
  // connectionId mismatch, reported identically to "not found").
  function reject(confirmId, connectionId) {
    connectionId = connectionId === undefined ? null : connectionId;
    const entry = pending.get(confirmId);
    if (!entry) return false;
    if (entry.connectionId !== null && entry.connectionId !== connectionId) return false;
    clearExpiry(entry);
    return pending.delete(confirmId);
  }

  function peek(confirmId) {
    const entry = pending.get(confirmId);
    if (!entry) return null;
    return { summary: entry.summary, expired: Date.now() > entry.expiresAt };
  }

  // A3: non-consuming read of the tier level for scope-gating decisions.
  function peekTier(confirmId) {
    const entry = pending.get(confirmId);
    if (!entry || !entry.action) return null;
    return entry.action.tier || 0;
  }

  function stats() {
    return { pending: pending.size, ttlMs: ttlMs };
  }

  return { create: create, accept: accept, reject: reject, peek: peek, peekTier: peekTier, stats: stats };
}

module.exports = { createConfirmRegistry };
