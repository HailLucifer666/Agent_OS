'use strict';
// evidence-digest.js — BUG-275 H3/H4. One normalisation, two callers.
//
// WHY THIS MODULE EXISTS AT ALL, rather than two helpers where they are used.
// The digest is BUILT in live-tool-adapter.js (where a tool result is still in
// scope) and QUERIED in claim-check.js (where the spoken text is). If those two
// sides normalise differently by so much as a character class, every query
// silently misses and the detector reports a fabrication for a name that was
// sitting in the result. Two independent guards drift apart; one function
// cannot. Both sides import `normalizeForEvidence` from here and neither owns a
// copy.
//
// WHY THE NORMALISATION IS THIS AGGRESSIVE. The claim side is TTS-shaped text
// and the evidence side is web prose, and they disagree on punctuation for the
// same name. Measured from the real 2026-08-19 session:
//
//   spoken   "GPT-5 6 Sol"      evidence "GPT-5.6 Sol"
//   spoken   "GLM 5 3"          evidence "GLM-5.3"
//   spoken   "LiveBench ai"     evidence "livebench.ai"
//
// A substring test that respects punctuation calls every one of those absent,
// which is a FALSE POSITIVE — the detector would tell the model to retract a
// correctly sourced name. So everything outside [a-z0-9] is discarded on both
// sides and the three pairs above collapse to identical strings. Pinned by test.
//
// EVERY ERROR IN THIS FUNCTION PUSHES TOWARDS SILENCE, WHICH IS THE REQUIRED
// DIRECTION. Collapsing separators makes the digest a longer unbroken string,
// so a query can only match MORE often, never less — "opus5" matches inside
// "claudeopus5", and a short name matches inside an unrelated word. Those are
// missed detections, not false accusations, and claim-check.js's header is
// explicit that this file family favours misses over false positives because a
// noisy honesty alarm is one nobody reads.

// Per-entry cap. A web_search result is ~2.5KB raw and smaller once normalised;
// a web_fetch of a full page is not, and the recent-action ledger holds up to 64
// entries for two minutes. 20k normalised characters per entry bounds that at a
// few hundred KB in the worst realistic window while being far above any search
// result measured in this repo.
const EVIDENCE_DIGEST_MAX = 20000;

function normalizeForEvidence(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Returns { text, truncated } or null when there is nothing to digest.
//
// TRUNCATION MUST BE VISIBLE, AND THIS IS THE ONE PLACE THE DIRECTION FLIPS.
// A digest cut short can be missing the very name being queried, and absence
// from a partial digest is not absence from the result — it is the one way this
// mechanism could accuse the model of inventing a name it actually read. So the
// flag rides with the text and the detector refuses to prove absence against a
// truncated entry, rather than trusting a cap nobody tuned.
function buildEvidenceDigest(result) {
  if (result === null || result === undefined) return null;
  let raw;
  if (typeof result === 'string') {
    raw = result;
  } else {
    try { raw = JSON.stringify(result); } catch { return null; }
  }
  if (raw === undefined) return null;
  const text = normalizeForEvidence(raw);
  if (!text) return null;
  return text.length > EVIDENCE_DIGEST_MAX
    ? { text: text.slice(0, EVIDENCE_DIGEST_MAX), truncated: true }
    : { text, truncated: false };
}

module.exports = { normalizeForEvidence, buildEvidenceDigest, EVIDENCE_DIGEST_MAX };
