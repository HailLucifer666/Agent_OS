'use strict';

// consent.js — the operator's consent to ONE exact call, as a value the model
// cannot make (BUG-464, 2026-09-24).
//
// `remember` used to write permanent memory for any caller, and labelled every
// line `voice-explicit` whether or not the operator had asked. On 2026-09-24
// 14:53:37 it saved "User has not been feeling well" in a turn whose transcript
// was "November". A rule in the prompt (the MEMORY RULE) was the only lock.
//
// A token is minted server-side, only after the operator's own words have been
// judged (voice/operator-authority.js) or a proposal read back to them was
// approved (voice/authority-gate.js). It rides in the dispatch CONTEXT, which the
// model never writes — never in the tool's arguments, which the model does. It is
// bound to the tool and the exact arguments, used once, and short-lived. A plain
// object with the same fields is not a token: membership of a module-private
// WeakSet is the proof, so nothing parsed from JSON can ever pass.

const TOKEN_TTL_MS = 30000; // mint-to-invoke is one dispatch; 30 s is the dispatch budget
const BASES = new Set(['operator-request', 'approved-proposal']);

const minted = new WeakSet();
const spent = new WeakSet();

// Canonical form: key order must not decide whether two calls are the same call.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function signatureOf(tool, args) {
  return String(tool) + ':' + canonical(args || {});
}

function mintConsent({ tool, args, basis, now = Date.now() }) {
  if (!BASES.has(basis)) throw new Error('mintConsent: unknown basis ' + JSON.stringify(basis));
  const token = Object.freeze({ tool: String(tool), signature: signatureOf(tool, args), basis, mintedAt: now });
  minted.add(token);
  return token;
}

// { ok:true, basis } exactly once per token, for exactly the call it was minted
// for. Every refusal names its reason, so a failed save is never a mystery.
function verifyConsent(token, tool, args, now = Date.now()) {
  if (!token || typeof token !== 'object' || !minted.has(token)) return { ok: false, reason: 'no-consent' };
  if (spent.has(token)) return { ok: false, reason: 'consent-already-used' };
  if (token.tool !== tool || token.signature !== signatureOf(tool, args)) return { ok: false, reason: 'consent-for-another-call' };
  if (now - token.mintedAt > TOKEN_TTL_MS) return { ok: false, reason: 'consent-expired' };
  spent.add(token);
  return { ok: true, basis: token.basis };
}

module.exports = { mintConsent, verifyConsent, signatureOf, canonical, TOKEN_TTL_MS };
