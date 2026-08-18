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
  // A live process whose PROCESS NAME matches the request and which owns a real
  // top-level window. Independent of the launch call: it is an enumeration of
  // what actually exists afterwards. Deliberately NOT satisfied by a window
  // TITLE match — that is what targeted the operator's IDE for a launch of
  // "notepad" on 2026-07-31 (ps-automation.ps1, Resolve-WindowedProcessByName).
  'process-window',
  // §7.5 RAG citations (from-documents.js document_answer): a cited chunk ref
  // resolves to a real Documents/chunks/<ref>.json file on disk. Independent
  // of the retrieval call's own say-so — a stale/forged vector-index entry
  // would not resolve, so this is a real enumeration of what actually exists,
  // same spirit as process-window above.
  'chunk-file',
  // Browser snapshot-and-refs (2026-08-06): the page itself, re-read AFTER the
  // action — URL, title, which element now has focus, whether the acted-on ref
  // still exists, and for a media element whether it is actually playing.
  // Independent of the click's own return value in the way that matters: a
  // Playwright click resolving proves the click was DELIVERED, this proves the
  // page changed. Deliberately cheap (no full re-snapshot) so it can ride every
  // ref action without making each click cost a second tree.
  'page-state',
  // BUG-273 B3: the HUD, asked after the fact whether the widget it was sent
  // actually mounted — the card is in the document and its kind module did not
  // throw. Independent of the call in the way that matters: composing a widget
  // descriptor and handing it to a socket proves nothing about what rendered,
  // which is exactly what the three "did not display" incidents on 2026-08-18
  // were. The HUD is a separate page reporting on its own DOM, same spirit as
  // page-state.
  'dashboard-render',
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
//
// BUG-273 B2 — `opts.confirmedStep`, and why "unverified" needed a second field.
//
// The operator logged an incident about open_web(browser:true): it "reports
// 'unverified' even when successfully handed to default browser, causing operator
// confusion about actual state." The hand-off works — four succeeded on
// 2026-08-18 against 7/7 silent failure before BUG-272 T2 — and the operator was
// still left unsure whether anything had happened.
//
// The cause is that `unverified` was carrying two different epistemic states
// under one name:
//   (a) NOTHING is known. ui_type sent keystrokes and no control reads back; the
//       text may or may not be there. This is the case BUG-273 B1 exists for, and
//       its blanket "do not say it worked" is exactly right.
//   (b) A STEP is confirmed and the END STATE is not. shell.openExternal resolved,
//       which means the OS accepted the URL and dispatched it to the default
//       browser. That is a fact about the world, not the call's own optimism. Only
//       the render is unknown.
// This module had verifiedOk (an oracle proved the outcome) and unverified
// (nothing proved anything) and no shape for (b) — so (b) was narrated as (a),
// and the model was told not to say the one thing that was true and useful.
//
// Q8 — THIS DOES NOT PROMOTE THE OUTCOME. `unverified` stays true, isVerified()
// stays false, the breaker still declines to count it as a success and the HUD
// still shows the middle glyph. A confirmed STEP is not a confirmed OUTCOME, and
// "just make it ok:true" is one line away and wrong. Pinned by
// test/bug-273-b2-handoff-wording.test.js.
//
// Q1 — WHAT ELSE MATCHES THIS? The field is only meaningful when something
// genuinely independent of the call established the step. A blank or non-string
// value is DROPPED rather than stored: an empty confirmedStep would still be a
// present key downstream, and a present key is read as "a step was confirmed",
// which would let any effector claim partial success by passing nothing.
// ---------------------------------------------------------------------------
function unverified(result, reason, opts) {
  var base = isPlainObject(result) ? result : {};
  var why = asText(reason).trim() || 'no oracle available to confirm this landed';
  var out = Object.assign({}, base, { ok: true, unverified: true, reason: why });
  var o = isPlainObject(opts) ? opts : {};
  var step = typeof o.confirmedStep === 'string' ? o.confirmedStep.trim() : '';
  if (step) out.confirmedStep = step;
  return out;
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
