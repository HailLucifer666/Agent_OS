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

function createConfirmRegistry({ config }) {
  const ttlMs = config.LEASH_CONFIRM_TTL_MS;   // exact key, do not paraphrase
  const pending = new Map(); // confirmId -> { summary, action, expiresAt, connectionId }

  function nextId() {
    return 'confirm-' + crypto.randomUUID();
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
    if (pending.size > 0) {
      const now = Date.now();
      for (const [id, entry] of pending) {
        if (now > entry.expiresAt) pending.delete(id);
      }
    }
    connectionId = connectionId === undefined ? null : connectionId;
    const confirmId = nextId();
    pending.set(confirmId, { summary: summary, action: action, expiresAt: Date.now() + ttlMs, connectionId: connectionId });
    return confirmId;
  }

  // accept(confirmId, connectionId) -> the stored action, or null if unknown,
  // expired, already consumed, or created by a different connection.
  function accept(confirmId, connectionId) {
    connectionId = connectionId === undefined ? null : connectionId;
    const entry = pending.get(confirmId);
    if (!entry) return null;
    if (entry.connectionId !== null && entry.connectionId !== connectionId) return null;
    pending.delete(confirmId);
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
