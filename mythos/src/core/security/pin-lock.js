'use strict';

// src/core/security/pin-lock.js — §7.3 local PIN lock: a gate before the HUD
// unlocks, separate from and in addition to Task 6's MYTHOS_AUTH_TOKEN
// (that gates the network/remote surface; this gates local physical
// presence — the two are independent layers, not a replacement for each
// other). Salted hash in the vault, NEVER plaintext.
//
// Windows Hello is deliberately NOT implemented this session. V2's framing:
// IRIS's "multi-face biometric locking" is an 8-byte stub in a decoy
// directory — ours ships as a real gate or not at all. A real Hello
// integration needs a live human completing an interactive Windows
// biometric/PIN prompt (WinRT UserConsentVerifier), which cannot be
// triggered or verified in this non-interactive environment. Rather than
// half-build it, this module always degrades to PIN-only, honestly — not
// because a hardware probe ran and found no sensor, but because the Hello
// path was never built. hasWindowsHello() below reflects that plainly.

const crypto = require('crypto');

const FILE = 'Identity/pin.json';
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const PIN_RE = /^\d{4,12}$/;

// Brute-force friction: a 4-digit PIN is only 10,000 combinations. This is a
// local convenience gate, not the primary security boundary (that's Task 6's
// bearer token) — but a free-standing verify() with no rate limit at all
// would still be a real weakness worth closing. Lockout is in-memory (per
// process) and intentionally simple: N consecutive failures -> a cooldown
// window during which verify() refuses even a correct PIN, unconditionally.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60000;

function createPinLock({ fs }) {
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function') {
    throw new Error('createPinLock requires a vault fs-store with readJSON/writeJSON');
  }

  let failCount = 0;
  let lockedUntil = 0;

  function load() {
    return fs.readJSON(FILE, null);
  }

  function isConfigured() {
    const rec = load();
    return !!(rec && rec.hash && rec.salt);
  }

  // Windows Hello was never built this session (see file header) — this
  // always reports false, honestly, not a probe result.
  function hasWindowsHello() {
    return false;
  }

  // security-reviewer finding (MEDIUM, fixed before commit): a caller who can
  // reach this route at all could previously overwrite an existing PIN with
  // no knowledge of the old one, bypassing verifyPin()'s lockout entirely —
  // the PIN's whole purpose (an extra local factor beyond the bearer token)
  // was a no-op the moment an attacker could set:instead-of-guess. Changing
  // an ALREADY-configured PIN now requires proving the current one first
  // (through the real verifyPin() path, so its lockout still applies to
  // change-attempts too, not just verify-attempts). First-time setup (no
  // PIN configured yet) has no prior PIN to prove and is unaffected.
  function setPin(pin, currentPin) {
    const pinStr = String(pin == null ? '' : pin);
    if (!PIN_RE.test(pinStr)) {
      return { ok: false, error: 'PIN must be 4-12 digits.' };
    }
    if (isConfigured()) {
      const check = verifyPin(currentPin);
      if (!check.ok) return check; // propagates 'Incorrect PIN.' / lockout, unchanged
    }
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = crypto.scryptSync(pinStr, salt, SCRYPT_KEYLEN);
    fs.writeJSON(FILE, {
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      algorithm: 'scrypt',
      createdAt: Date.now(),
    });
    // A newly-set PIN clears any standing lockout from attempts against the
    // previous one.
    failCount = 0;
    lockedUntil = 0;
    return { ok: true };
  }

  function verifyPin(pin) {
    const now = Date.now();
    if (now < lockedUntil) {
      return { ok: false, error: `Too many attempts — locked for ${Math.ceil((lockedUntil - now) / 1000)}s.`, lockedOut: true };
    }
    const rec = load();
    if (!rec || !rec.hash || !rec.salt) return { ok: false, error: 'No PIN configured.' };

    const pinStr = String(pin == null ? '' : pin);
    const salt = Buffer.from(rec.salt, 'hex');
    const expected = Buffer.from(rec.hash, 'hex');
    const actual = crypto.scryptSync(pinStr, salt, expected.length);
    const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

    if (match) {
      failCount = 0;
      lockedUntil = 0;
      return { ok: true };
    }
    failCount++;
    if (failCount >= MAX_ATTEMPTS) {
      lockedUntil = now + LOCKOUT_MS;
      failCount = 0; // the lockout itself is the penalty; don't compound it on top
      return { ok: false, error: `Too many attempts — locked for ${Math.ceil(LOCKOUT_MS / 1000)}s.`, lockedOut: true };
    }
    return { ok: false, error: 'Incorrect PIN.' };
  }

  function clearPin() {
    fs.writeJSON(FILE, null);
    failCount = 0;
    lockedUntil = 0;
    return { ok: true };
  }

  return { isConfigured, hasWindowsHello, setPin, verifyPin, clearPin };
}

module.exports = { createPinLock };
