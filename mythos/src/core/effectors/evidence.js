'use strict';

// evidence.js — the effector evidence contract.
//
// NOT evidence-validator.js (same directory, unrelated): that one gates BUILD
// delivery on pipeline phases (artifact/review/visual). This module is about a
// single effector result — did the world actually change, and what says so?
//
// THE DEFECT THIS EXISTS TO CLOSE. Every effector here returned "the API call
// succeeded" and the voice layer spoke it as "the thing happened". Those are
// different claims:
//
//   * SendInput accepting 46 events is not text in Notepad. On 2026-07-31 at
//     11:28:09 ui_type returned typed:true, length:23, against a confirmed
//     foreground "Untitled - Notepad" — and the screenshot MYTHOS took 28s
//     later shows an empty document. Nothing anywhere read the text back.
//   * A cua click landing is not the right song playing. Four spotify_play
//     calls for "Slow It Down" each returned verified:true with
//     nowPlaying:"...BACK 2 LOVE" in the same object — verified:true meant the
//     CLICK verified, and nothing compared nowPlaying to the request.
//   * A vision model producing prose is not what is on the screen. screen_look
//     returned a bare imgur URL once and a generic Notepad tutorial paragraph
//     another time; MYTHOS relayed the latter as visual confirmation.
//
// Fixing tools one at a time whacks one symptom and the next session surfaces
// the sibling. So the contract lives here, once:
//
//   A world-changing effector may return ok:true ONLY with an `evidence` field
//   naming an oracle OTHER THAN THE CALL ITSELF. Anything else returns
//   ok:true + unverified:true + reason, which the voice layer must speak as
//   attempted, not confirmed.
//
// "Unverified" is deliberately NOT a failure. The keystrokes may well have
// landed; we simply cannot prove it. Collapsing that into ok:false would make
// MYTHOS deny things it actually did, which is its own kind of lying.

// Oracles that count as independent confirmation. The call's own return value
// is conspicuously absent — that is the entire point of the list.
var ORACLES = [
  'read-back',      // text read back out of the target control (UIA Value/TextPattern)
  'ocr',            // OCR of a fresh screenshot contains the expected string
  'foreground-pid', // the OS reports the intended window as foreground
  'media-status',   // the player itself reports the requested track as playing
  'window-title',   // the target window's title reflects the change
];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asText(v) {
  return v === null || v === undefined ? '' : String(v);
}

// ---------------------------------------------------------------------------
// verifiedOk — ok:true WITH proof. Throws on a malformed claim rather than
// silently downgrading: a caller that passes an unknown oracle or an empty
// observation has a bug, and quietly turning that into "unverified" would hide
// the very thing this module is for.
// ---------------------------------------------------------------------------
function verifiedOk(result, proof) {
  var base = isPlainObject(result) ? result : {};
  var p = isPlainObject(proof) ? proof : {};
  var oracle = asText(p.oracle);

  if (ORACLES.indexOf(oracle) === -1) {
    throw new Error(
      'verifiedOk: unknown oracle ' + JSON.stringify(oracle) +
      ' — evidence must name one of: ' + ORACLES.join(', ')
    );
  }
  var observed = asText(p.observed);
  if (!observed.trim()) {
    throw new Error(
      'verifiedOk: oracle ' + oracle + ' produced no observation — an oracle ' +
      'that saw nothing is not evidence; use unverified() instead'
    );
  }

  var evidence = { oracle: oracle, observed: observed };
  if (p.expected !== undefined && p.expected !== null) evidence.expected = asText(p.expected);

  return Object.assign({}, base, { ok: true, unverified: false, evidence: evidence });
}

// ---------------------------------------------------------------------------
// unverified — ok:true, but say so honestly. `reason` is operator-facing: it
// becomes part of what MYTHOS says out loud, so write it as a phrase that can
// be spoken ("no readable text pattern"), not an error code.
// ---------------------------------------------------------------------------
function unverified(result, reason) {
  var base = isPlainObject(result) ? result : {};
  var why = asText(reason).trim() || 'no oracle available to confirm this landed';
  return Object.assign({}, base, { ok: true, unverified: true, reason: why });
}

// ---------------------------------------------------------------------------
// mismatch — the oracle spoke and CONTRADICTED the request. This is a real
// failure, and it must carry both strings: "typed Hi Alex, control reads
// Hi Alexx" is actionable, "type failed" is not.
// ---------------------------------------------------------------------------
function mismatch(result, proof) {
  var base = isPlainObject(result) ? result : {};
  var p = isPlainObject(proof) ? proof : {};
  var expected = asText(p.expected);
  var observed = asText(p.observed);
  var oracle = asText(p.oracle) || 'oracle';
  return Object.assign({}, base, {
    ok: false,
    unverified: false,
    expected: expected,
    observed: observed,
    error: asText(p.error) ||
      (oracle + ' disagrees: expected ' + JSON.stringify(expected) +
       ', found ' + JSON.stringify(observed)),
  });
}

// ---------------------------------------------------------------------------
// Predicates. isVerified() is the one the HUD and the voice layer ask: a tick
// means PROVEN, not merely "the call returned".
// ---------------------------------------------------------------------------
function hasEvidence(result) {
  return isPlainObject(result) &&
    isPlainObject(result.evidence) &&
    ORACLES.indexOf(asText(result.evidence.oracle)) !== -1 &&
    asText(result.evidence.observed).trim() !== '';
}

function isVerified(result) {
  return isPlainObject(result) && result.ok === true &&
    result.unverified !== true && hasEvidence(result);
}

// Spoken shape for an unverified outcome — kept here so every surface phrases
// it the same way instead of each inventing its own euphemism.
function attemptedPhrase(action, reason) {
  return asText(action) + ' — could not confirm it landed (' +
    (asText(reason).trim() || 'no oracle available') + ')';
}

module.exports = {
  ORACLES: ORACLES,
  verifiedOk: verifiedOk,
  unverified: unverified,
  mismatch: mismatch,
  hasEvidence: hasEvidence,
  isVerified: isVerified,
  attemptedPhrase: attemptedPhrase,
};
