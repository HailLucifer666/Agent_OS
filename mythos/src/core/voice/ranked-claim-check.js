'use strict';
// ranked-claim-check.js — BUG-275 H3/H4. A ranked position handed to a name
// that is not in the evidence.
//
// SPLIT OUT OF claim-check.js, and the reason is worth recording rather than
// hiding: adding this detector took that file to 801 lines against an 800-line
// house ceiling, and the guard says "split them or add a justified exception".
// The exception would have been the easy option and the wrong one — this is a
// self-contained second detector over the same text, so it is a file.
//
// IT SHARES splitSentences AND FUTURE_RE WITH claim-check.js RATHER THAN
// COPYING THEM. Both detectors run over the same assistant reply, and a
// second copy of either would drift from the first invisibly — the same
// reasoning that puts normalizeForEvidence in one module for both sides of
// the digest. The dependency is one-directional: this file imports from
// claim-check.js and claim-check.js knows nothing about this one.

const { CLAIM_CATEGORIES, splitSentences, FUTURE_RE } = require('./claim-check');
const { normalizeForEvidence, buildEvidenceDigest } = require('./evidence-digest');
// ---------------------------------------------------------------------------
// BUG-275 H3/H4 — a ranked position handed to a name that is not in the
// evidence. This is the CONTENT check the BUG-275 entry says the detector above
// cannot be, and it is deliberately not built by loosening that one.
//
// WHY detectUnbackedClaims CANNOT REACH THESE. Its `backed` short-circuit exits
// as soon as any gateTool succeeded, and it must — the F1b lesson in the
// searching category is that without it the detector tells the assistant to
// retract statements it had just earned. In the real session `web_search` had
// succeeded, so every shape check was skipped. That gap is structural, not a
// tuning miss, so this is a separate predicate over the same evidence: not
// "did a lookup succeed" but "is this name in what the lookup returned".
// Existence standing in for agreement is the class; the two questions differ.
//
// MEASURED 2026-09-02 against %APPDATA%\MYTHOS\vault\Episodic\2026-08-19.jsonl
// (667 records, 231 conversation, 213 action), and the measurement CORRECTED the
// ticket on three points. Recorded here because the corrections are what set
// this scope:
//
//   H3 (caught).  "Checked LiveBench ai leaderboard for coding, Sir. Top five
//     currently stands thus: Claude Mythos 5, next Claude Fable 5, then
//     GPT-5 6 Sol, Claude Opus 5, and Gemini CLI." The LiveBench result 22.4s
//     earlier (2,226 bytes) is column headers and nothing else — 0 of those 5
//     names occur in it. The earlier BenchLM result that DID carry three of them
//     was 253.3s old, so the 120s recent-action window had already dropped it.
//   H4 (caught).  "LMSpeed formally ranks Claude Opus 1 at global rank 1", where
//     the result in front of it said Claude Opus 5. "Claude Opus 1" occurs in
//     0 of all 213 action results in the session.
//   H1 (NOT caught, deliberately — see the disposition below).
//   H5 (NOT A DEFECT). The ticket calls "GLM 5 3 is also live since August
//     fourteenth" an invented date. It is sourced: the z.ai blog snippet
//     ("2026-08-14 · Research ... Today we are releasing GLM-5.3") and a
//     SiliconANGLE article dated AUGUST 14 2026 were both in evidence 350s
//     earlier. The ticket audited ONE search instead of the evidence window.
//   H7 (NOT A DEFECT). The ticket says the operator never mentioned Nvidia.
//     They did, verbatim: "tell me what what what what was that Nvidia's news
//     you were telling?" 22 action results also carry Nvidia.
//
// THE WINDOW IS THE SCOPE, AND THAT IS THE DESIGN. The first draft of this
// detector parsed the source out of the spoken text ("Checked LiveBench…") to
// decide which result to compare against. That is a whole attribution parser to
// maintain, and it is unnecessary: H3's misattribution is visible with no
// attribution parsing at all, because the source it borrowed from had already
// aged out of the evidence window. The existing, tested 120s ledger does the
// scoping for free. No new surface.
//
// DISPOSITION — H1 IS NOT CAUGHT, ON PURPOSE, AND MUST NOT BE "FIXED" HERE.
// H1 is the same five names spoken 56s earlier as a top five, when the evidence
// held a ranking of three. Both padded names ARE in that result: "Claude Opus 5"
// in a Terminal-Bench convergence article and "Gemini CLI" in the sentence "a
// comparison of Claude Opus 5, GPT-5.6 Sol, Gemini CLI, GitHub Copilot". So the
// model did not invent them — it promoted names out of unranked prose into rank
// positions 4 and 5. The ticket's own text ("manufactured the remainder") is
// wrong about the mechanism, and an absence test cannot see it by construction.
//
// Catching H1 needs "is this name in a RANKED context in the snippet", which
// means classifying snippet structure — a model of a system that will drift, and
// drift open. The absence test here is the opposite: it can only fire when a
// name is wholly missing, so its errors are misses. Weakening it into a
// ranked-context heuristic would trade a guard that cannot false-accuse for one
// that can, on the reply path, which is the one error claim-check.js's header
// forbids outright. Pinned by test: H1's real utterance against H1's real
// evidence returns [].
//
// 2026-09-10 — H1 IS NOW DETECTED, AND THE PARAGRAPH ABOVE STILL STANDS WORD FOR
// WORD. Operator decision the same day: a prompt rule plus a SILENT anomaly,
// never a spoken retraction. `detectPromotedRankedEntities` below is a second,
// separate detector, and every property that made weakening this one
// unacceptable is preserved by keeping them apart:
//   - it never reaches reportTurnAudit, so it cannot inject a correction into a
//     live turn. It is emitted as health.anomaly telemetry and nothing else.
//   - the absence test is untouched: H1 against H1's evidence still returns [],
//     and the test that pins that is unchanged. The two detectors are REQUIRED
//     to disagree on this input, which is itself pinned.
//   - the structure classification lives in evidence-digest.js, fails closed,
//     and extracts no names at all — the question is asked from the reply side
//     about names rankedEntitiesIn already produced. A marker the classifier
//     does not know yields a miss.
// WHAT THIS KILLS: nothing, and that is checked rather than assumed. The
// obvious candidate is the external-fact category's `top N` shape, added for
// this same ticket on 2026-08-28 — but the two gates are disjoint by
// construction. That shape fires only when a gateTool was attempted and did
// NOT succeed; this detector fires only when one DID succeed and returned a
// digest. No reply can reach both, so neither becomes unreachable and neither
// can double-report the same sentence. The "GATE: a FAILED lookup is silent"
// test pins that boundary from this side.
//
// WHAT IT NEWLY REQUIRES: an `evidence` digest on the ledger row. That is a
// fail-open in the wiring rather than the logic — a detector with a perfect
// gate reads nothing if a push site forgets the field, and the suite would stay
// green. Guarded behaviourally in
// test/bug-275-evidence-digest-reaches-the-ledger.test.js, which was written
// because a probe deleting the production wiring left every test in the
// detector's own file passing.
const RANK_WORDS = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten';

// An enumerated ranking: a "top N" head, then a colon, then the list. The list
// is captured to end of sentence rather than up to the first "." because model
// version numbers contain dots ("GPT-5.6") and a dot-bounded capture cuts the
// name in half — found while testing, not by reading.
const RANKED_LIST_RE = new RegExp(
  '\\btop\\s+(?:' + RANK_WORDS + ')\\b[^:]{0,80}:\\s*(.+)$', 'i');

// A single entity given a position: "LMSpeed formally ranks Claude Opus 1 at
// global rank 1". Positional on the verb, so the name is taken from where a
// ranked subject grammatically has to be, not from "every capitalised word" —
// which would collect "Sir" out of every second sentence in this persona.
const RANKED_SINGLE_RE =
  /\branks?\s+([A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z0-9][A-Za-z0-9.'-]*){0,3})\s+(?:at|as)\b/;

// Ordinals and connectives that introduce a list member without being part of
// the name. Grammar, not a catalogue of models — the thing trap D forbids is a
// hand-kept list of the SET BEING CHECKED, and the set being checked here is
// derived from the sentence at run time.
const LIST_CONNECTIVE_RE =
  /^(?:and|then|next|followed\s+by|finally|lastly|plus|with|also|first|second|third|fourth|fifth)\s+/i;

// The tools whose results are the evidence for an external fact. DERIVED from
// the external-fact category above rather than retyped: one list, and a tool
// added there is covered here the same day.
const EXTERNAL_FACT_CATEGORY = CLAIM_CATEGORIES.find((c) => c.name === 'external-fact');
const EVIDENCE_TOOLS = EXTERNAL_FACT_CATEGORY ? EXTERNAL_FACT_CATEGORY.gateTools : [];

// The gate for "does this tool's result count as external evidence?", exported
// so the two commit sites in live-tool-adapter.js share ONE copy of it. Both
// sites started with their own inline copy of the membership test, and two
// copies of a membership test are how one of them quietly stops matching — the
// same reason normalizeForEvidence is imported rather than reimplemented. It
// lives here because this file is what defines the set.
function evidenceFor(toolName, result) {
  return EVIDENCE_TOOLS.indexOf(toolName) !== -1 ? buildEvidenceDigest(result) : null;
}

function rankedEntitiesIn(sentence) {
  const out = [];
  const list = RANKED_LIST_RE.exec(sentence);
  if (list) {
    for (const piece of String(list[1]).split(',')) {
      for (const part of piece.split(/\s+and\s+/i)) {
        const name = part.trim()
          .replace(LIST_CONNECTIVE_RE, '')
          .replace(/[.!?,;:]+$/, '')
          .trim();
        // Must read as a name: an initial capital, and long enough that the
        // normalised form cannot match half the alphabet by accident.
        if (/^[A-Z]/.test(name) && name.replace(/[^A-Za-z0-9]/g, '').length >= 3) out.push(name);
      }
    }
  }
  const single = RANKED_SINGLE_RE.exec(sentence);
  if (single) {
    const name = single[1].trim();
    if (name.replace(/[^A-Za-z0-9]/g, '').length >= 3) out.push(name);
  }
  return [...new Set(out)];
}

// BUG-275 H1 — a name given a rank the evidence never gave it.
//
// Fires only when all three hold: the reply enumerates a ranking (the same
// rankedEntitiesIn the absence test uses, so the two cannot disagree about what
// a ranking is); the name sits in some usable row's comparison-style prose; and
// it appears NOWHERE else in the whole usable window. That last clause is what
// makes this a miss-first detector — one unclassifiable sentence mentioning the
// name anywhere in the window silences it.
//
// TELEMETRY ONLY, BY DECISION. The return shape is deliberately NOT the
// {category, sentence, ...} shape reportTurnAudit consumes, so wiring it into a
// spoken correction would be a visible change rather than a one-line mistake.
// Upgrading it to speech re-opens the fail-closed question and needs its own
// review: a false positive here would tell MYTHOS to retract a true statement,
// which is the one error this file family forbids.
//
// Returns [] or one entry: { kind, sentence, promoted:[names], sawTools:[tools] }.
function detectPromotedRankedEntities(assistantText, actionsThisTurn, recentActions) {
  const text = String(assistantText || '');
  if (!text) return [];
  const current = Array.isArray(actionsThisTurn) ? actionsThisTurn : [];
  const recent = Array.isArray(recentActions) ? recentActions : [];
  const actions = current.concat(recent).filter((a) => a && a.tool);
  // The same gate as the absence test, for the same reasons, minus the
  // truncation refusal: a truncated digest cannot prove absence, but the
  // mention-only buckets here are used to prove PRESENCE in one bucket, and the
  // `elsewhere` clause is what has to be complete. So truncation is refused too.
  const usable = actions.filter((a) => EVIDENCE_TOOLS.indexOf(a.tool) !== -1
    && a.ok === true && a.unverified !== true && a.evidence
    && a.evidence.truncated !== true && typeof a.evidence.mentionOnly === 'string'
    && typeof a.evidence.elsewhere === 'string');
  if (!usable.length) return [];
  const mentionOnly = usable.map((a) => a.evidence.mentionOnly).join('|');
  if (!mentionOnly) return [];
  const elsewhere = usable.map((a) => a.evidence.elsewhere).join('|');
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (FUTURE_RE.test(sentence)) continue;
    const names = rankedEntitiesIn(sentence);
    if (!names.length) continue;
    const promoted = names.filter((n) => {
      const key = normalizeForEvidence(n);
      return key.length >= 3 && mentionOnly.indexOf(key) !== -1 && elsewhere.indexOf(key) === -1;
    });
    if (!promoted.length) continue;
    out.push({ kind: 'promoted-ranked-entity', sentence, promoted,
      sawTools: [...new Set(usable.map((a) => a.tool))] });
    break; // one per reply, like the other detectors
  }
  return out;
}

// Pure, exported, separately testable — same contract as the two detectors
// above. Returns [] or one entry:
// { category:'unsourced-ranking', sentence, absent:[names], sawTools:[tools] }.
function detectUnsourcedRankedEntities(assistantText, actionsThisTurn, recentActions) {
  const text = String(assistantText || '');
  if (!text) return [];

  const current = Array.isArray(actionsThisTurn) ? actionsThisTurn : [];
  const recent = Array.isArray(recentActions) ? recentActions : [];
  const actions = current.concat(recent).filter((a) => a && a.tool);

  // THE GATE, and every clause of it fails CLOSED.
  //
  // `ok === true` and not unverified: only a result that actually came back can
  // prove a name is absent from it. A FAILED lookup proves nothing about the
  // name and is already the external-fact category's case — firing here too
  // would report one defect twice.
  //
  // BUG-275 campaign: absence requires the WHOLE successful evidence window.
  // A mixed complete/truncated window reproduced a false accusation: the name
  // existed beyond the digest cap, but filtering that row proved absence from
  // unrelated complete headers. Refuse the whole absence check if a successful
  // lookup has incomplete evidence; a neighbouring complete row cannot repair
  // its missing tail. Failed/unverified and non-evidence tools remain outside
  // this proof domain. This only suppresses uncertain post-turn notices; it
  // neither proves ranking context (H1) nor prevents already-streamed speech.
  const usable = actions.filter((a) => EVIDENCE_TOOLS.indexOf(a.tool) !== -1
    && a.ok === true && a.unverified !== true);
  if (!usable.length || usable.some((a) => !a.evidence
    || a.evidence.truncated === true
    || typeof a.evidence.text !== 'string' || a.evidence.text.length === 0)) return [];

  const digest = usable.map((a) => a.evidence.text).join('|');

  for (const sentence of splitSentences(text)) {
    if (FUTURE_RE.test(sentence)) continue;
    const names = rankedEntitiesIn(sentence);
    if (!names.length) continue;
    const absent = names.filter((n) => digest.indexOf(normalizeForEvidence(n)) === -1);
    if (!absent.length) continue;
    return [{
      category: 'unsourced-ranking',
      sentence: sentence.trim().slice(0, 300),
      absent,
      sawTools: [...new Set(usable.map((a) => a.tool))],
    }];
  }
  return [];
}
// ---------------------------------------------------------------------------
// BUG-275 H2 — THE OPERATOR SAYS IT IS A LIE, AND THE MODEL EXPLAINS INSTEAD OF
// CHECKING. The highest-severity half of BUG-275, and until now nothing looked
// at it.
//
// MEASURED, verbatim from the 2026-08-19 session:
//   operator: "I mean I see a lie. How is Gemini CLI a AI model?"
//   MYTHOS:   "Indeed, Sir, good eye. 'Gemini CLI' refers to the model's access
//              method in that benchmark, not the actual model version name. It
//              belongs to Google's Gemini family, rated highly for coding tasks."
//
// No lookup ran in that turn. Challenged on a claim, it produced a confident,
// plausible, unevidenced justification — which converts the operator's correct
// scepticism into false reassurance, and is why the entry records their trust in
// tool-backed answers as low.
//
// THIS IS THE THIRD CASE OF A POLICY BUG-398 ROW 7 ALREADY SAID WAS MISSING:
// "there is NO POLICY for 'the operator contradicts my evidence', and which way
// it goes is unrelated to how strong the evidence is." `detectFalseRetractions`
// covers the FOLD direction — taking back something proven. This covers the DIG
// IN direction — defending something unproven. Both are the same absent policy
// seen from opposite sides, and a system corrected in only one direction learns
// to fail in the other.
//
// WHAT IS DELIBERATELY NOT HERE, and it is most of the shape space. An earlier
// draft also matched a challenge to a CATEGORISATION — "How is <Named Thing> a
// <noun>?" — because that is the second sentence of the measured case. It was
// removed after measuring: across all 127 operator utterances in that session
// the accusation markers alone catch the one real instance, while the
// categorisation form fires on ordinary questions ("How is Spotify a good
// choice for this?"). On the reply path a false positive tells the model to
// retract something true, which claim-check.js's header forbids outright, so the
// ambiguous half buys nothing and costs the one error this family must not make.
const CHALLENGE_RE = new RegExp([
  // An explicit accusation of falsehood.
  '\\bi (?:see|smell) a lie\\b',
  "\\bthat(?:'s| is)\\s+(?:a\\s+)?(?:lie|false|incorrect|made up)\\b",
  "\\byou(?:'re| are)\\s+(?:lying|making (?:it|that|this) up|fabricating)\\b",
  "\\b(?:stop|don'?t)\\s+(?:lying|making (?:it|that|this) up)\\b",
  // A demand for provenance, which is the same challenge asked politely.
  '\\bwhere did you get (?:that|this|those)\\b',
  '\\bwhich (?:website|source|site) (?:are|did) you\\b',
].join('|'), 'i');

// The reply shape that matters: EXPLAINING what a disputed thing means, rather
// than re-checking it or saying it is not known. Complying ("Searching now")
// carries none of these, which is what keeps the honest response silent — the
// measured session has exactly such a turn one exchange later and it must not
// be flagged.
const EXPLANATORY_DEFENCE_RE = new RegExp([
  '\\brefers to\\b',
  '\\bit means\\b|\\bwhat (?:that|this) means\\b',
  '\\bnot the actual\\b',
  '\\bin that (?:benchmark|context|listing|view|table)\\b',
  '\\bit belongs to\\b',
  "\\bthat(?:'s| is) (?:the|a|an) \\w+(?:'s)? (?:name|method|label|term|alias)\\b",
].join('|'), 'i');

// A retraction or an admission of ignorance is the CORRECT response to a
// challenge, and it frequently sits in the same reply as an explanation. Tested
// before the positive, per the MARK table's rule in claim-check.js: every
// negative is checked before the positive it contains.
const HONEST_RESPONSE_RE = new RegExp([
  '\\bi (?:was|am) (?:wrong|mistaken)\\b',
  '\\bi (?:do not|don\'?t) know\\b',
  '\\bi cannot (?:confirm|verify)\\b|\\bcan\'?t (?:confirm|verify)\\b',
  '\\bretract(?:ing|ion)?\\b',
  '\\blet me (?:re-?check|check again|search|look)\\b',
  '\\b(?:re-?checking|searching|looking) (?:now|again)\\b',
  '\\bno (?:source|evidence) for\\b',
].join('|'), 'i');

// Pure, exported, separately testable. Returns [] or one entry:
// { category:'defended-under-challenge', sentence, sawTools }.
function detectDefendedChallenge(assistantText, userText, actionsThisTurn) {
  const said = String(userText || '');
  const reply = String(assistantText || '');
  if (!said || !reply) return [];

  // The operator's transcript is not always present on the Live path —
  // `inputTranscription` arrived on 97 of 144 turns in the measured session — so
  // this detector is silent on the rest by construction. Under-firing, which is
  // the required direction.
  if (!CHALLENGE_RE.test(said)) return [];
  if (HONEST_RESPONSE_RE.test(reply)) return [];   // negative before positive
  if (!EXPLANATORY_DEFENCE_RE.test(reply)) return [];

  // A FRESH lookup in THIS turn is the whole remedy, so the window is this turn
  // ONLY — deliberately not the 120s recent-action window the other detectors
  // use. A search from eighty seconds ago is precisely what the measured reply
  // was defending with, and counting it as a re-check would excuse the defect.
  const current = Array.isArray(actionsThisTurn) ? actionsThisTurn : [];
  const rechecked = current.some((a) => a && a.ok === true && a.unverified !== true
    && EVIDENCE_TOOLS.indexOf(a.tool) !== -1);
  if (rechecked) return [];

  for (const sentence of splitSentences(reply)) {
    if (!EXPLANATORY_DEFENCE_RE.test(sentence)) continue;
    return [{
      category: 'defended-under-challenge',
      sentence: sentence.trim().slice(0, 300),
      sawTools: [...new Set(current.map((a) => a && a.tool).filter(Boolean))],
    }];
  }
  return [];
}

module.exports = {
  detectUnsourcedRankedEntities, detectPromotedRankedEntities, EVIDENCE_TOOLS, rankedEntitiesIn, evidenceFor,
  detectDefendedChallenge,
};
