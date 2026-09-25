'use strict';

// server/auth-sessions.js — sign-in sessions for a deployment that has a
// MYTHOS_AUTH_TOKEN (i.e. one bound off loopback for a phone node or a remote
// browser). BUG-444, 2026-09-23.
//
// THE BUG. POST /api/auth/session answered a correct token by writing the TOKEN
// ITSELF into a 30-day cookie. The shared secret the phone node also uses then
// lived in every browser the operator had ever logged in from, and one browser
// could not be signed out without rotating the secret for all of them.
//
// THE SHAPE THAT REPLACES IT. A login mints 32 random bytes and hands them to the
// browser. This store keeps only their SHA-256, so a copy of the file is not a
// copy of anyone's cookie, and never the token — only a short fingerprint of it,
// so that rotating MYTHOS_AUTH_TOKEN invalidates every session minted under the
// old one without keeping the old one anywhere.
//
// Decisions it encodes (plan rev 5, D6 and the BUG-444 section):
//   - sessions SURVIVE A RESTART, so the file is written on every change;
//   - expiry is FIXED at issue (30 days), never sliding — the sliding PIN session
//     is what BUG-442 was, and nothing here claims to measure presence;
//   - a corrupt file FAILS CLOSED: nothing in it is honoured, the failure is
//     logged at error, and the file is set aside rather than overwritten so the
//     evidence survives. A fresh login still works, so this is never a lockout;
//   - the file lives beside config.json (outside the vault), so the vault's own
//     git push can never carry it. The caller derives the path; see main.js.
//
// What this store deliberately does NOT do: decide whether a request is
// authorized. That is server/credentials.js's evaluate(), and only there — a
// second place that resolves sessions is how two credential paths drift apart.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_ID_BYTES = 32;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes as base64url, no padding
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_VERSION = 1;
// A ceiling on how many live sessions the file may hold. One operator, a few
// browsers; a login loop from a script must not grow the file without bound.
// When full, the oldest session is dropped to make room.
const MAX_SESSIONS = 32;
const HASH_RE = /^[0-9a-f]{64}$/;

function hashSessionId(id) {
  return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex');
}

// Domain-separated so the fingerprint can never be mistaken for, or compared
// against, a hash computed for some other purpose over the same token.
function tokenFingerprint(token) {
  if (!token) return '';
  return crypto.createHash('sha256').update('mythos-auth-session-fp:' + token, 'utf8').digest('hex').slice(0, 16);
}

function isRecord(r) {
  return !!r && typeof r === 'object'
    && typeof r.h === 'string' && HASH_RE.test(r.h)
    && typeof r.fp === 'string'
    && Number.isFinite(r.createdAt) && Number.isFinite(r.expiresAt);
}

/**
 * @param {object} opts
 * @param {string} opts.authToken   MYTHOS_AUTH_TOKEN ('' => the store honours nothing)
 * @param {string} [opts.file]      absolute path; omitted => memory only, logged once
 * @param {object} opts.logger
 * @param {number} [opts.ttlMs]      fixed lifetime; AUTH_SESSION_COOKIE_TTL_MS, default 30 days
 * @param {() => number} [opts.now]
 * @param {object} [opts.fsImpl]
 */
function createAuthSessionStore(opts) {
  const o = opts || {};
  const authToken = o.authToken || '';
  const file = o.file || null;
  const logger = o.logger || { info() {}, warn() {}, error() {} };
  const now = o.now || Date.now;
  const fsi = o.fsImpl || fs;
  const ttlMs = Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : SESSION_TTL_MS;
  const fp = tokenFingerprint(authToken);
  const sessions = new Map(); // hash -> { fp, createdAt, expiresAt }

  function load() {
    if (!file) {
      if (authToken) logger.warn('auth.sessions-memory-only', { reason: 'no sessions file configured; sign-ins end at restart' });
      return;
    }
    let text;
    try {
      text = fsi.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return; // first run
      logger.error('auth.sessions-store-corrupt', { file, reason: 'unreadable', code: err && err.code });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
    const valid = parsed && parsed.version === STORE_VERSION && Array.isArray(parsed.sessions) && parsed.sessions.every(isRecord);
    if (!valid) {
      logger.error('auth.sessions-store-corrupt', { file, reason: 'unparseable or wrong shape; no stored session is honoured' });
      setAside();
      return;
    }
    for (const r of parsed.sessions) sessions.set(r.h, { fp: r.fp, createdAt: r.createdAt, expiresAt: r.expiresAt });
  }

  function setAside() {
    try {
      fsi.renameSync(file, `${file}.corrupt-${now()}`);
    } catch (err) {
      logger.warn('auth.sessions-store-set-aside-failed', { file, code: err && err.code });
    }
  }

  function prune(t) {
    for (const [h, r] of sessions) {
      if (r.fp !== fp || t > r.expiresAt) sessions.delete(h);
    }
    while (sessions.size > MAX_SESSIONS) {
      let oldest = null;
      for (const [h, r] of sessions) if (!oldest || r.createdAt < oldest[1].createdAt) oldest = [h, r];
      sessions.delete(oldest[0]);
    }
  }

  // Temp file in the SAME directory, then rename: a crash mid-write leaves the
  // previous file intact rather than a torn one. On Windows a rename can fail
  // with EPERM while another process holds the target; that loses THIS write
  // (logged), it does not tear the file.
  function persist() {
    if (!file) return true;
    const body = JSON.stringify({
      version: STORE_VERSION,
      sessions: Array.from(sessions, ([h, r]) => ({ h, fp: r.fp, createdAt: r.createdAt, expiresAt: r.expiresAt })),
    });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsi.mkdirSync(path.dirname(file), { recursive: true });
      fsi.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fsi.renameSync(tmp, file);
      return true;
    } catch (err) {
      try { fsi.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
      logger.error('auth.sessions-store-write-failed', { file, code: err && err.code });
      return false;
    }
  }

  // No fingerprint comparison here, deliberately (gate F, probe 2026-09-23). The
  // token is frozen for the life of the process, so the only records that can
  // carry another fingerprint are ones LOADED from disk — and the load-time
  // prune below drops every one of those before anything can ask. A check here
  // was unreachable by construction: removing it failed no test. The prune is
  // the enforcement, and its own probe (drop the fp condition from prune) is
  // what reddens the rotation test.
  function isValid(id) {
    if (!authToken || typeof id !== 'string' || !SESSION_ID_RE.test(id)) return false;
    const r = sessions.get(hashSessionId(id));
    return !!r && now() <= r.expiresAt;
  }

  function issue() {
    if (!authToken) throw new Error('auth-sessions: cannot issue a session with no MYTHOS_AUTH_TOKEN configured');
    const t = now();
    const id = crypto.randomBytes(SESSION_ID_BYTES).toString('base64url');
    sessions.set(hashSessionId(id), { fp, createdAt: t, expiresAt: t + ttlMs });
    prune(t);
    const persisted = persist();
    return { id, hash: hashSessionId(id), maxAgeMs: ttlMs, persisted };
  }

  // Returns the revoked hash (so the caller can close that session's sockets),
  // or null when there was nothing to revoke.
  function revoke(id) {
    if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) return null;
    const h = hashSessionId(id);
    if (!sessions.delete(h)) return null;
    persist();
    return h;
  }

  load();
  // Drop what the load found expired or minted under another token, so the file
  // on disk converges on what is actually honoured.
  if (file && sessions.size) {
    const before = sessions.size;
    prune(now());
    if (sessions.size !== before) persist();
  }

  return { isValid, issue, revoke, hashOf: hashSessionId, size: () => sessions.size };
}

module.exports = {
  createAuthSessionStore,
  hashSessionId,
  tokenFingerprint,
  SESSION_TTL_MS,
  SESSION_ID_RE,
  MAX_SESSIONS,
};
