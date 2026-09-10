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

// BUG-275 H1 — THE MENTION-ONLY SPLIT.
//
// H1 is not a fabrication and the absence test above cannot see it. The model
// spoke a top five where the evidence held a ranking of three, and the two extra
// names really were in the result — "Gemini CLI" only inside "An in-depth
// comparison of Claude Opus 5, GPT-5.6 Sol, Gemini CLI, GitHub Copilot", which
// gives no positions at all. So the reply promoted a name out of unranked prose
// into rank position five. Absence cannot detect a name that is present.
//
// THE QUESTION IS ASKED FROM THE REPLY SIDE, WHICH IS WHY THIS IS SMALL. The
// obvious design — parse names out of the snippet and classify their context —
// is a model of a document, and this file's own header records what those do:
// they drift, and they drift open. Nothing here extracts a name. The digest
// simply says which of its prose was a comparison-style list, and the detector
// asks about names it already has from the REPLY. A marker set that misses a
// phrasing produces a missed detection, never an accusation.
//
// THE MARKERS ARE DELIBERATELY FOUR PHRASES, NOT A GRAMMAR. Each one introduces
// a list of names as members of a set rather than as ranked positions. "versus"
// and "compared to" were considered and REJECTED: the same measured result
// contains "(89.5% vs 89.1%)", a comparison of two numbers inside a sentence
// about two models, and admitting it would have classified a whole ranked-prose
// snippet as mention-only. Narrow and provable beats broad and arguable here.
//
// FAIL CLOSED, AND THE ASYMMETRY IS THE POINT. `mentionOnly` carries ONLY the
// sentences positively classified; everything else — including every sentence
// the classifier cannot read — goes to `elsewhere`. The detector requires a name
// to be in `mentionOnly` AND absent from `elsewhere`, so an unclassifiable
// sentence that mentions the name silences the finding. That is a miss, which is
// the direction this whole file family is required to err in.
const MENTION_MARKERS = [/\bcomparison of\b/i, /\bsuch as\b/i, /\balongside\b/i, /\bincluding\b/i];

// Strings only, and URLs excluded: a slug like /claude-opus-5-convergence/ is not
// prose and classifying it either way would be inventing evidence.
function proseStrings(value, out, depth) {
  if (depth > 6 || out.length > 200) return out;
  if (typeof value === 'string') { if (!/^https?:\/\//i.test(value.trim())) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) proseStrings(v, out, depth + 1); return out; }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) { if (key !== 'url') proseStrings(v, out, depth + 1); }
  }
  return out;
}

// Sentence splitting is coarse on purpose. A wrong boundary moves text between
// the two buckets, and a boundary that puts too much in `elsewhere` silences a
// finding while one that puts too much in `mentionOnly` is caught by the
// `elsewhere` requirement on the other side.
function classifyProse(result) {
  const mention = [];
  const elsewhere = [];
  for (const chunk of proseStrings(result, [], 0)) {
    for (const sentence of String(chunk).split(/(?<=[.!?])\s+|\n+/)) {
      if (!sentence.trim()) continue;
      (MENTION_MARKERS.some((re) => re.test(sentence)) ? mention : elsewhere).push(sentence);
    }
  }
  return { mentionOnly: normalizeForEvidence(mention.join(' ')), elsewhere: normalizeForEvidence(elsewhere.join(' ')) };
}

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
  // BUG-275 H1: the two buckets ride WITH the digest, so the ledger row that
  // already carries `text` carries them too and no second wiring can be
  // forgotten. Capped by the same rule as `text` — a truncated digest already
  // refuses to prove anything, and these are strictly smaller than it.
  const prose = classifyProse(result);
  const buckets = { mentionOnly: prose.mentionOnly.slice(0, EVIDENCE_DIGEST_MAX), elsewhere: prose.elsewhere.slice(0, EVIDENCE_DIGEST_MAX) };
  return text.length > EVIDENCE_DIGEST_MAX
    ? Object.assign({ text: text.slice(0, EVIDENCE_DIGEST_MAX), truncated: true }, buckets)
    : Object.assign({ text, truncated: false }, buckets);
}

module.exports = { normalizeForEvidence, buildEvidenceDigest, classifyProse, MENTION_MARKERS, EVIDENCE_DIGEST_MAX };
