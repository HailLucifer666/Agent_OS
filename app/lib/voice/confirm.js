// confirm.js — pending-confirmation registry for danger:true voice tools.
// In-memory only (a server restart drops all pending confirms — acceptable, they're
// short-lived by design). Single-use: accept()/reject() consume the entry so a second
// attempt on the same confirmId is a clean no-op, never a double-execution.
//
// Security note (fixed post-review): confirmIds are bound to the WS connection that
// created them. Without this, any connection that learns/guesses a confirmId (e.g. a
// hostile page that hijacked a second WS connection to this server) could accept a
// danger-tier action a different session queued. crypto.randomUUID() replaces the old
// Date.now()+Math.random() id (non-CSPRNG, low entropy) as defense in depth on top of
// the connection binding.

const crypto = require('crypto');

const TTL_MS = Number(process.env.VOICE_CONFIRM_TTL_MS) || 30000;

const pending = new Map(); // confirmId -> { summary, action, expiresAt, connectionId }

function nextId() {
  return `confirm-${crypto.randomUUID()}`;
}

// create(summary, action, connectionId) -> confirmId. `action` is caller-defined (e.g.
// {tool, args, run}) and is only ever handed back verbatim via accept() — confirm.js
// never inspects or executes it. `connectionId` scopes the confirm to whichever WS
// connection requested it; omit only for callers with no connection concept (tests).
function create(summary, action, connectionId = null) {
  const confirmId = nextId();
  pending.set(confirmId, { summary, action, expiresAt: Date.now() + TTL_MS, connectionId });
  return confirmId;
}

// accept(confirmId, connectionId) -> the stored action, or null if the id is unknown,
// expired, already consumed, or was created by a different connection. A connectionId
// mismatch returns null WITHOUT deleting the entry — a stray/hostile accept attempt from
// the wrong connection must not be able to destroy the legitimate connection's still-valid
// pending confirm (that would be a one-message denial-of-service on the real confirm flow).
// The entry is deleted only when this call is the one that actually resolves it: an expired
// entry (so it can't be probed again) or a same-connection accept (single-use).
function accept(confirmId, connectionId = null) {
  const entry = pending.get(confirmId);
  if (!entry) return null;
  if (entry.connectionId !== null && entry.connectionId !== connectionId) return null;
  pending.delete(confirmId);
  if (Date.now() > entry.expiresAt) return null;
  return entry.action;
}

// reject(confirmId, connectionId) -> true if a pending confirm belonging to this
// connection was found and removed, false otherwise (including a connectionId mismatch,
// reported the same as "not found" so as not to reveal whether the id exists elsewhere).
function reject(confirmId, connectionId = null) {
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

module.exports = { create, accept, reject, peek };
