'use strict';

// effectors/artifact-token.js — BUG-317: a short-lived signed URL for a built
// artifact, so the URL handed to the browser is one the browser can load.
//
// THE BUG THIS EXISTS FOR IS TOCTOU, in its purest form: the process that
// CHECKS is not the process that USES. open_artifact preflighted the artifact
// URL with `Authorization: Bearer ${MYTHOS_AUTH_TOKEN}` and, on a 200, reported
// opened:true. The OS browser then requested the same URL with no header, and
// /vault/builds sits behind requireToken, so it 401'd. On 2026-08-22 the
// operator read the failure out loud — "It says error unauthorized set mythos
// auth token via authorized bearer token" — while the audit recorded
// open_artifact returning ok:true, twice.
//
// The comment above that preflight says it was added because "configuring a
// token silently made every artifact unopenable". It made the CHECK pass. It was
// asking a question the browser would never ask.
//
// ---------------------------------------------------------------------------
// SECURITY PROPERTIES. This is new authenticated surface, so they are listed,
// and every one of them has a test.
//
//   * HMAC-SHA256 keyed on MYTHOS_AUTH_TOKEN. No new secret to manage, rotate
//     or leak: rotating the token invalidates every outstanding artifact URL,
//     which is the correct coupling.
//   * EXPIRY IS CHECKED FIRST, before the signature is trusted for anything. A
//     caller that verifies the signature first has already used an unvalidated
//     value to decide what to compare against.
//   * Scoped to ONE EXACT PATH. A token for a.html cannot open b.html.
//   * Traversal is refused outright — '..' in a path is never signed and never
//     verified. express.static normalises, but this must not be the layer that
//     waves a '..' through on the way there.
//   * Constant-time comparison (crypto.timingSafeEqual, length-guarded).
//   * IT DOES NOT BYPASS THE PIN LAYER. When PIN_SESSION_ENFORCE is on, the
//     server requires the bearer token AND an unlocked PIN session, on
//     deliberately separate channels. A signature substitutes for the BEARER
//     TOKEN only. A signed URL that skipped both would be a downgrade dressed
//     as a convenience.
//   * No secret configured (loopback-only mode) means no signature is ever
//     minted and the middleware is a pass-through — behaviour identical to
//     before this file existed. Absence of a secret must never become an
//     unsigned pass.
//
// WHAT RIDES IN THE URL, deliberately: the artifact's vault-relative path and an
// expiry. That is the artifact's own name, which the operator asked to open, and
// it is the minimum needed for the browser to make the request. No credential
// and no personal data goes in the query string.
// ---------------------------------------------------------------------------

var crypto = require('crypto');

// Five minutes. Long enough for the OS to hand the URL to a browser that may
// still be starting up, short enough that a URL leaked into shell history or a
// browser's session restore is not a standing key.
var DEFAULT_TTL_MS = 5 * 60 * 1000;

function isSafeRelPath(rel) {
  var s = String(rel == null ? '' : rel);
  if (!s) return false;
  if (s.indexOf('\0') !== -1) return false;
  // Reject traversal in either separator form, and any absolute/UNC shape.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return false;
  if (/^([a-zA-Z]:|[\\/])/.test(s)) return false;
  return true;
}

function hmac(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');
}

// Canonical signing payload. Separator cannot appear in a hex expiry, so the
// path and the expiry cannot be shuffled between each other.
function payloadFor(rel, exp) {
  return String(rel).replace(/\\/g, '/') + '\n' + String(exp);
}

// Returns { exp, sig } or null. null means "cannot sign" — no secret, or a path
// this module refuses to vouch for — and callers must treat that as "no signed
// URL is available", never as "no signature needed".
function signArtifactPath(rel, secret, ttlMs) {
  if (!secret) return null;
  if (!isSafeRelPath(rel)) return null;
  var ttl = typeof ttlMs === 'number' ? ttlMs : DEFAULT_TTL_MS;
  var exp = Date.now() + ttl;
  return { exp: exp, sig: hmac(secret, payloadFor(rel, exp)) };
}

function safeEqualHex(a, b) {
  var x = String(a || '');
  var y = String(b || '');
  if (x.length !== y.length || !x.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
  } catch (_) {
    return false;
  }
}

// Returns { ok: true } or { ok: false, reason }. The reason names the failure
// class for the log without ever echoing the expected signature.
function verifyArtifactSignature(rel, exp, sig, secret) {
  if (!secret) return { ok: false, reason: 'no artifact signing secret configured' };
  if (!isSafeRelPath(rel)) return { ok: false, reason: 'unsafe artifact path' };
  var expNum = Number(exp);
  if (!exp || !Number.isFinite(expNum)) return { ok: false, reason: 'missing or malformed expiry' };
  // BEFORE the signature: see the header.
  if (expNum <= Date.now()) return { ok: false, reason: 'artifact link expired' };
  if (!sig) return { ok: false, reason: 'missing signature' };
  if (!safeEqualHex(sig, hmac(secret, payloadFor(rel, expNum)))) {
    return { ok: false, reason: 'signature does not match this artifact' };
  }
  return { ok: true };
}

// Express middleware for /vault/builds. Admits a correctly signed request;
// otherwise hands the request to the existing token check unchanged.
//
// deps.requireToken       — the server's own middleware, called on fall-through
// deps.pinSessionRequired — () => boolean
// deps.pinSessionValid    — (req) => boolean
// deps.secret             — MYTHOS_AUTH_TOKEN, or falsy for loopback-only mode
function createArtifactAccess(deps) {
  var d = deps || {};
  return function artifactAccess(req, res, next) {
    var q = req.query || {};
    if (d.secret && q.sig && q.exp) {
      // req.path here is relative to the mount point ('/vault/builds'), so the
      // signed value is rebuilt the same way vault-url.js constructs it.
      var rel = 'builds' + String(req.path || '').replace(/\\/g, '/');
      var v = verifyArtifactSignature(rel, q.exp, q.sig, d.secret);
      if (v.ok) {
        // The signature stands in for the bearer token. It does NOT stand in for
        // the PIN session — when both layers are enforced, both are still
        // required.
        var pinNeeded = typeof d.pinSessionRequired === 'function' ? d.pinSessionRequired() : false;
        if (!pinNeeded) return next();
        if (typeof d.pinSessionValid === 'function' && d.pinSessionValid(req)) return next();
      }
    }
    return d.requireToken(req, res, next);
  };
}

module.exports = {
  signArtifactPath: signArtifactPath,
  verifyArtifactSignature: verifyArtifactSignature,
  createArtifactAccess: createArtifactAccess,
  _isSafeRelPath: isSafeRelPath,
  _DEFAULT_TTL_MS: DEFAULT_TTL_MS,
};
