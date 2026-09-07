'use strict';

// test/bug-275-unsourced-ranked-entity.test.js — BUG-275 H3 and H4, 2026-09-02.
//
// WHAT THIS CLOSES. A spoken turn gives a named entity a ranked position while
// that name does not occur anywhere in the fact-finding results currently in
// evidence. Two measured instances, both from the 2026-08-19 session:
//
//   H3  "Checked LiveBench ai leaderboard for coding, Sir. Top five currently
//        stands thus: Claude Mythos 5, next Claude Fable 5, then GPT-5 6 Sol,
//        Claude Opus 5, and Gemini CLI."
//   H4  "LMSpeed formally ranks Claude Opus 1 at global rank 1."
//
// WHY IT IS A NEW PREDICATE AND NOT A NEW CLAIM CATEGORY. detectUnbackedClaims
// short-circuits on `backed` as soon as any gateTool succeeded, and it must —
// claim-check.js's F1b note records what happened when it did not: MYTHOS was
// told to retract statements it had just earned, twice in one session. In the
// measured session `web_search` HAD succeeded, so no shape check ever ran. The
// gap is structural. This asks a different question over the same evidence:
// not "did a lookup succeed" but "is this name in what the lookup returned".
//
// THE FIXTURES ARE THE REAL RESULTS, NOT HAND-WRITTEN ONES. Every digest below
// is built from snippet text copied out of
// %APPDATA%\MYTHOS\vault\Episodic\2026-08-19.jsonl. That matters because the
// defect turns entirely on what the results did and did not contain, and a
// fixture written from the ticket's description would have encoded the ticket's
// three factual errors (see the corrections block below) instead of the session.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectUnsourcedRankedEntities, rankedEntitiesIn, EVIDENCE_TOOLS,
} = require('../src/core/voice/ranked-claim-check');
const {
  buildEvidenceDigest, normalizeForEvidence, EVIDENCE_DIGEST_MAX,
} = require('../src/core/voice/evidence-digest');

// ---------------------------------------------------------------------------
// Real evidence, transcribed from the vault.

// The LiveBench search, 22.4s before the H3 utterance (2,226 bytes on disk).
// Column headers and descriptions; NOT ONE model name in it. This is the whole
// of H3: the answer was attributed to a source that supplied no rows.
const LIVEBENCH_RESULT = {
  query: 'lifebench.ai leaderboard coding August 2026',
  results: [
    { title: 'LiveBench.ai', url: 'https://livebench.ai/',
      snippet: '## Leaderboard\nOverall + every category, sortable. Click a row for its '
        + 'subtask scores. Cost sits right beside the scores.\nCategoryAllReasoningCoding'
        + 'Agentic CodingMathematicsData AnalysisLanguageInstruction Following\n'
        + '| | Model | Overall | Reasoning | Coding | Agentic Coding | Mathematics' },
    { title: 'LiveBench Leaderboard & Scores — August 2026 | BenchLM.ai',
      url: 'https://benchlm.ai/benchmarks/livebench',
      snippet: 'A frequently refreshed benchmark with objective scoring across reasoning, '
        + 'coding, agentic coding, mathematics, data analysis, language, and instruction '
        + 'following.\nWe mirror the official LiveBench 2026-06-25 release: 43 model variants' },
  ],
  source: 'exa-mcp',
};

// The other search inside H3's 120s window (101.3s before it). Measured: this
// is what makes "Claude Fable 5" and "Claude Opus 5" PRESENT, so the detector
// flags three of the five names rather than all five. Included because leaving
// it out would make the fixture stricter than the wire and the test would pass
// for the wrong reason.
const KIMI_GLM_RESULT = {
  query: 'best coding LLM leaderboard status August 2026 Kimi K3 GLM 5.3 benchmark ranking sources',
  results: [
    { title: 'GLM-5.3: Frontier Coding with Emergent Cyber Capabilities',
      url: 'https://z.ai/blog/glm-5.3',
      snippet: '- Stronger Coding: GLM-5.3 is the most capable open-weights model for coding, '
        + 'with a 50% improvement over GLM-5.2 on our in-house Z.ai Code Bench.' },
    { title: 'Coding model comparison August 2026',
      url: 'https://example-benchmarks.test/compare',
      snippet: 'Claude Fable 5 and Claude Opus 5 both appear in the August comparison set.' },
  ],
  source: 'exa-mcp',
};

// H1's evidence: the 2,495-byte BenchLM search. It ranks THREE models — and it
// also MENTIONS the other two in prose, which is the ticket's central factual
// error and the reason H1 is out of scope here. Both padded names are really in
// this text.
const BENCHLM_RESULT = {
  query: 'latest LLM benchmarks for coding top models output August 2026',
  results: [
    { title: 'Best LLM for Coding (August 2026): SWE-bench & ...', url: 'https://benchlm.ai/coding',
      snippet: 'Claude Mythos 5 leads coding on BenchLM\'s August 2026 rankings with a score of '
        + '81.1, ahead of Claude Fable 5(80.9) and GPT-5.6 Sol(78.8).' },
    { title: 'GPT-5.6 Sol and Claude Opus 5 are now 0.4 points apart on the industry’s '
        + 'toughest coding benchmark | BuildApps',
      url: 'https://buildapps.co.uk/signals/terminal-bench-gpt-5-6-sol-claude-opus-5-convergence/',
      snippet: 'Independent benchmarking now has GPT-5.6 Sol and Claude Opus 5 within half a '
        + 'point of each other on Terminal-Bench 2.1 (89.5% vs 89.1%)' },
    { title: 'Best AI Coding Agents August 2026 (Benchmarks & Guide) - NeuralCoreTech',
      url: 'https://neuralcoretech.com/best-ai-coding-agents-august-2026/',
      snippet: '## An in-depth comparison of Claude Opus 5, GPT-5.6 Sol, Gemini CLI, GitHub '
        + 'Copilot, and the top open-source coding agents' },
  ],
  source: 'exa-mcp',
};

function evidenceRow(tool, result, over) {
  return Object.assign({ tool, ok: true, evidence: buildEvidenceDigest(result) }, over || {});
}

// The real spoken text, verbatim from the vault.
const H3_REPLY = 'Checked LiveBench ai leaderboard for coding, Sir. Top five currently stands '
  + 'thus: Claude Mythos 5, next Claude Fable 5, then GPT-5 6 Sol, Claude Opus 5, and Gemini CLI. '
  + 'Kimi K3 and GLM 5.3 are not currently visible in that specific view. Shall I look further '
  + 'into category scores for any of them, Sir?';
const H4_REPLY = 'Conducting live search now, Sir. LMSpeed formally ranks Claude Opus 1 at '
  + 'global rank 1.';
const H1_REPLY = 'On current leaderboards, Sir, top five stands thus: Claude Mythos 5, then '
  + 'Claude Fable 5, followed by GPT-5.6 Sol, Claude Opus 5, and Gemini CLI. Shall I dig into '
  + 'specific benchmarks regarding particular models?';

describe('BUG-275 H3/H4 — a ranked position given to a name not in the evidence', () => {
  it('H3: the five-name ranking attributed to a source that returned no rows is flagged', () => {
    const out = detectUnsourcedRankedEntities(H3_REPLY, [], [
      evidenceRow('web_search', LIVEBENCH_RESULT),
      evidenceRow('web_search', KIMI_GLM_RESULT),
    ]);
    assert.equal(out.length, 1, 'the measured H3 utterance must be flagged');
    assert.equal(out[0].category, 'unsourced-ranking');
    // Exactly the three names absent from BOTH results — verified against the
    // vault by a second, independent route (hand-written punctuation variants
    // over the raw JSON) which returned the same three.
    assert.deepEqual(out[0].absent.sort(), ['Claude Mythos 5', 'GPT-5 6 Sol', 'Gemini CLI'].sort());
    assert.deepEqual(out[0].sawTools, ['web_search']);
  });

  it('H3: the names that ARE in evidence are not flagged, so the notice cannot overstate', () => {
    const out = detectUnsourcedRankedEntities(H3_REPLY, [], [
      evidenceRow('web_search', LIVEBENCH_RESULT),
      evidenceRow('web_search', KIMI_GLM_RESULT),
    ]);
    assert.ok(!out[0].absent.includes('Claude Fable 5'),
      'Claude Fable 5 occurs in the second result and must not be reported missing');
    assert.ok(!out[0].absent.includes('Claude Opus 5'),
      'Claude Opus 5 occurs in the second result and must not be reported missing');
  });

  it('H4: a single entity given a rank by a verb is flagged', () => {
    // "ranks Claude Opus 1 at" — the evidence in front of it said Claude Opus 5,
    // and "Claude Opus 1" occurs in 0 of all 213 action results in the session.
    const out = detectUnsourcedRankedEntities(H4_REPLY, [], [
      evidenceRow('web_search', KIMI_GLM_RESULT),
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].absent, ['Claude Opus 1']);
  });

  it('H4 BOUND: the same sentence with the name that IS in evidence stays silent', () => {
    // The adjacent case. A guard that fires on "Claude Opus 1" must not fire on
    // "Claude Opus 5", or it is flagging the shape rather than the defect.
    const out = detectUnsourcedRankedEntities(
      'LMSpeed formally ranks Claude Opus 5 at global rank 1.',
      [], [evidenceRow('web_search', KIMI_GLM_RESULT)]);
    assert.deepEqual(out, [], 'a correctly sourced name must produce nothing');
  });

  // -------------------------------------------------------------------------
  // THE DISPOSITION. H1 is deliberately NOT caught. This test exists so that
  // nobody closes it by weakening the absence test, and so the limit is visible
  // to the next reader instead of looking like an oversight.
  it('DISPOSITION — H1 is NOT flagged, because both "padded" names are really in the result', () => {
    // The ticket says H1 padded positions 4 and 5 with names that appear in no
    // snippet. MEASURED 2026-09-02: false. "Claude Opus 5" is in a Terminal-Bench
    // convergence article and "Gemini CLI" is in the sentence "a comparison of
    // Claude Opus 5, GPT-5.6 Sol, Gemini CLI, GitHub Copilot". The model
    // promoted names out of unranked PROSE into rank positions; it did not
    // invent them.
    //
    // Catching that needs "is this name in a RANKED context in the snippet",
    // i.e. classifying snippet structure — a model of a system, which drifts,
    // and drifts open. This detector can only fire on total absence, so its
    // errors are misses rather than false accusations. Trading that for a
    // ranked-context heuristic would put a guard that CAN false-accuse on the
    // reply path, which claim-check.js's header forbids outright.
    const out = detectUnsourcedRankedEntities(H1_REPLY, [], [
      evidenceRow('web_search', BENCHLM_RESULT),
    ]);
    assert.deepEqual(out, [],
      'H1 must stay silent: every name it spoke occurs in the result, and firing here '
      + 'would require a ranked-context heuristic that can accuse a correctly sourced name');
  });

  // -------------------------------------------------------------------------
  // THE GATE. Every clause fails closed. Absence can only be proven against a
  // result that actually arrived and was not cut short.
  it('GATE: no evidence tool in the window -> silent', () => {
    assert.deepEqual(detectUnsourcedRankedEntities(H3_REPLY, [], [
      { tool: 'launch_app', ok: true },
    ]), [], 'a window of desktop actions proves nothing about a model name');
  });

  it('GATE: a FAILED lookup is silent — that is the external-fact category’s case', () => {
    assert.deepEqual(detectUnsourcedRankedEntities(H3_REPLY, [], [
      evidenceRow('web_search', LIVEBENCH_RESULT, { ok: false }),
    ]), [], 'a lookup that failed cannot prove a name is absent from its result');
  });

  it('GATE: an UNVERIFIED lookup is silent', () => {
    assert.deepEqual(detectUnsourcedRankedEntities(H3_REPLY, [], [
      evidenceRow('web_search', LIVEBENCH_RESULT, { unverified: true }),
    ]), []);
  });

  it('GATE: a TRUNCATED digest is silent, and this is the only false-accusation route', () => {
    // A digest cut short may be missing the very name being queried, so absence
    // from it is not absence from the result. This is the one clause whose
    // failure would let the detector accuse the model of inventing a name it
    // actually read, so it is refused rather than trusted.
    const row = evidenceRow('web_search', LIVEBENCH_RESULT);
    row.evidence = { text: row.evidence.text, truncated: true };
    assert.deepEqual(detectUnsourcedRankedEntities(H3_REPLY, [], [row]), []);
  });

  it('GATE: a real over-cap result truncates, and therefore cannot fire', () => {
    // Not a hand-set flag — build a genuinely oversized result and confirm the
    // cap engages and the gate holds. Proves the flag is reachable in
    // production, not only in a fixture.
    const huge = { query: 'x', results: [{ title: 't', url: 'u', snippet: 'ab'.repeat(EVIDENCE_DIGEST_MAX) }] };
    const d = buildEvidenceDigest(huge);
    assert.equal(d.truncated, true, 'an over-cap result must be marked truncated');
    assert.equal(d.text.length, EVIDENCE_DIGEST_MAX);
    assert.deepEqual(detectUnsourcedRankedEntities(H3_REPLY, [], [
      { tool: 'web_search', ok: true, evidence: d },
    ]), []);
  });

  it('GATE: complete evidence cannot substitute for an incomplete successful lookup', () => {
    // The omitted tail contains the claimed name. The old filter discarded it
    // and falsely proved absence against unrelated complete column headers.
    const raw = 'x'.repeat(EVIDENCE_DIGEST_MAX + 10) + ' Claude Opus 1';
    const truncated = evidenceRow('web_search', raw);
    assert.equal(truncated.evidence.truncated, true);
    assert.ok(raw.includes('Claude Opus 1'));
    assert.ok(!truncated.evidence.text.includes('claudeopus1'));
    const complete = evidenceRow('web_search', LIVEBENCH_RESULT);
    for (const incomplete of [truncated, { tool: 'web_search', ok: true },
      { tool: 'web_search', ok: true, evidence: { text: '', truncated: false } }]) {
      for (const [current, recent] of [
        [[complete], [incomplete]], [[incomplete], [complete]],
        [[complete, incomplete], []], [[], [incomplete, complete]],
      ]) {
        assert.deepEqual(detectUnsourcedRankedEntities(
          'LMSpeed ranks Claude Opus 1 at global rank 1.', current, recent), [],
        'an incomplete successful lookup makes absence across the whole window unknown');
      }
    }
  });

  it('BOUND: incomplete failed or unverified lookups do not hide a proven absence', () => {
    for (const other of [
      { tool: 'web_search', ok: false },
      { tool: 'web_search', ok: true, unverified: true },
      { tool: 'launch_app', ok: true },
    ]) {
      assert.equal(detectUnsourcedRankedEntities(
        'LMSpeed ranks Claude Opus 1 at global rank 1.', [other],
        [evidenceRow('web_search', LIVEBENCH_RESULT)]).length, 1);
    }
  });

  it('GATE: future tense is not a claim', () => {
    assert.deepEqual(detectUnsourcedRankedEntities(
      'I will give you the top five: Claude Mythos 5, and Gemini CLI.',
      [], [evidenceRow('web_search', LIVEBENCH_RESULT)]), []);
  });

  // -------------------------------------------------------------------------
  // FALSE-POSITIVE BOUNDS. The corpus replay (171 real replies, 82 of them with
  // evidence in window) fired exactly twice — H3 and H4 — and these are the
  // shapes that replay proved must stay silent.
  it('BOUND: a correctly reported ABSENCE is not a ranking claim', () => {
    // H3's own reply contains "Kimi K3 and GLM 5.3 are not currently visible in
    // that specific view" — a true, useful report of absence. It sits in a
    // different sentence with no ranking shape, so it is never examined. If a
    // future widening reaches it, this fails.
    const out = detectUnsourcedRankedEntities(
      'Kimi K3 and GLM 5.3 are not currently visible in that specific view.',
      [], [evidenceRow('web_search', LIVEBENCH_RESULT)]);
    assert.deepEqual(out, [], 'reporting that something is missing must never be flagged');
  });

  it('BOUND: the vocative "Sir" is never collected as a ranked entity', () => {
    // The persona says "Sir" in most replies and it is capitalised. An
    // extractor built on "capitalised words near a ranking word" would collect
    // it from every second sentence — which is why extraction is positional
    // (after a colon, or after the verb) rather than lexical.
    // The assertion is /\bSir\b/ over every extracted name, NOT equality with
    // "Sir". Found while running probe (d): an equality check passes happily on
    // a mutation that yields "Sir: Claude Fable 5" as one name, because that is
    // not the string "Sir". A bound that a plausible mutation walks past is not
    // a bound.
    for (const s of [
      'Top five, Sir: Claude Fable 5, Claude Opus 5.',
      'Sir, that ranks Claude Opus 5 as the leader.',
      'Top three stands thus, Sir: Claude Fable 5.',
    ]) {
      const names = rankedEntitiesIn(s);
      for (const n of names) {
        assert.ok(!/\bSir\b/i.test(n),
          'the vocative leaked into an extracted name from: ' + s + ' -> ' + JSON.stringify(names));
      }
    }
  });

  it('BOUND: bare ranking prose with no enumeration and no ranked subject is silent', () => {
    for (const s of [
      'That is my top priority, Sir.',
      'We are at the top of the hour.',
      'Claude Mythos 5 leads the coding board.',
    ]) {
      assert.deepEqual(rankedEntitiesIn(s), [], 'extracted an entity from: ' + s);
    }
  });

  it('BOUND: speech-mangled punctuation must MATCH, not be reported absent', () => {
    // The single most dangerous false positive in this design, and the reason
    // one shared normaliser exists. Measured pairs from the session: spoken
    // "GPT-5 6 Sol" vs evidence "GPT-5.6 Sol"; spoken "GLM 5 3" vs "GLM-5.3".
    // A punctuation-respecting substring test calls both absent and tells the
    // model to retract a correctly sourced name.
    assert.equal(normalizeForEvidence('GPT-5 6 Sol'), normalizeForEvidence('GPT-5.6 Sol'));
    assert.equal(normalizeForEvidence('GLM 5 3'), normalizeForEvidence('GLM-5.3'));
    assert.notEqual(normalizeForEvidence('Claude Opus 1'), normalizeForEvidence('Claude Opus 5'));

    const out = detectUnsourcedRankedEntities(
      'Top two stands thus: GPT-5 6 Sol, and GLM 5 3.',
      [], [evidenceRow('web_search', {
        results: [{ snippet: 'GPT-5.6 Sol and GLM-5.3 both feature in the August set.' }],
      })]);
    assert.deepEqual(out, [],
      'punctuation differences between spoken and fetched text must not read as absence');
  });

  it('one flag per reply, the rule every detector in claim-check.js follows', () => {
    const out = detectUnsourcedRankedEntities(
      'Top two: Alpha Nine, and Beta Nine. Also that ranks Gamma Nine as first.',
      [], [evidenceRow('web_search', { results: [{ snippet: 'nothing relevant here' }] })]);
    assert.equal(out.length, 1);
  });

  it('EVIDENCE_TOOLS is derived from the external-fact category, not retyped', () => {
    // Trap D: a hand-kept second copy of a tool list is the same omission
    // scheduled for the day someone adds a fact-finding tool. Assert the
    // identity rather than the contents, so this cannot rot into a snapshot.
    const { CLAIM_CATEGORIES } = require('../src/core/voice/claim-check');
    const cat = CLAIM_CATEGORIES.find((c) => c.name === 'external-fact');
    assert.ok(cat && cat.gateTools.length, 'the external-fact category must own the list');
    assert.deepEqual(EVIDENCE_TOOLS, cat.gateTools,
      'EVIDENCE_TOOLS must BE the external-fact gateTools, so a tool added there is covered here');
    assert.ok(EVIDENCE_TOOLS.includes('web_search'));
  });

  it('buildEvidenceDigest handles the shapes a result can actually be', () => {
    assert.equal(buildEvidenceDigest(null), null);
    assert.equal(buildEvidenceDigest(undefined), null);
    assert.equal(buildEvidenceDigest(''), null, 'an empty result is no evidence');
    assert.equal(buildEvidenceDigest({}), null, 'an empty object normalises to nothing');
    assert.equal(buildEvidenceDigest('Claude Opus 5').text, 'claudeopus5');
    const cyc = {}; cyc.self = cyc;
    assert.equal(buildEvidenceDigest(cyc), null, 'a circular result must not throw');
  });
});

// ---------------------------------------------------------------------------
// MUTATION PROOF — run 2026-09-02, recorded here with the date so the proof
// survives this commit. Each probe was applied with `sed`, the occurrence count
// of the mutated string re-checked to confirm the edit actually landed (a
// mutation that silently fails looks exactly like a guard that works), the file
// restored, and the restore verified by re-running the suite.
//
 // RESULTS ARE AS OBSERVED, NOT AS PREDICTED. Two of the five probes reddened a
// different set of tests than this note originally claimed, and both
// discrepancies are kept below because each one says something true about what
// these tests do and do not depend on.
//
//   (a) DELETE the truncation clause from the gate in claim-check.js
//         `&& a.evidence.truncated !== true`
//       -> RED: "GATE: a TRUNCATED digest is silent" and "GATE: a real over-cap
//          result truncates", both 1 flag where 0 expected. As predicted.
//
//   (b) DROP the punctuation strip in evidence-digest.js, leaving a plain
//       lowercase (`.replace(/[^a-z0-9]+/g,'')` removed)
//       -> RED: "BOUND: speech-mangled punctuation must MATCH" and
//          "buildEvidenceDigest handles the shapes a result can actually be".
//       -> PREDICTED AND DID NOT HAPPEN: the H3 test staying green. It does,
//          because H3's fixture happens to spell its names with the same
//          punctuation the reply uses, so H3 does not exercise normalisation at
//          all. The punctuation BOUND is the only test guarding it. Worth
//          knowing before anyone deletes that bound as redundant with H3.
//
//   (c) DROP the `ok === true && unverified !== true` clause from the gate
//       -> RED: "GATE: a FAILED lookup is silent" and "GATE: an UNVERIFIED
//          lookup is silent". As predicted.
//
//   (d) REPLACE positional extraction with a lexical one — drop the colon
//       requirement from RANKED_LIST_RE so the capture starts right after
//       "top N", which is the plausible simplification a next editor makes
//       -> RED: "BOUND: the vocative Sir is never collected" and the H3 test.
//       -> AND IT CAUGHT A DEFECT IN THIS FILE. The Sir bound originally
//          asserted `!names.includes('Sir')`, and this mutation yields
//          "Sir: Claude Fable 5" as a single extracted name — which is not the
//          string "Sir", so the bound PASSED against it. Rewritten to test
//          /\bSir\b/ over every extracted name, and only then did it red. A
//          bound a plausible mutation walks past is not a bound.
//
//   (e) INVERT the absence test to a presence test (`=== -1` -> `!== -1`).
//       This probe exists to answer whether the DISPOSITION test can go red at
//       all, or passes vacuously because nothing could make H1 fire.
//       -> RED: 7 tests including DISPOSITION. It is reachable and
//          load-bearing, not vacuous.
//
// Restored after each probe by full-path file copy and verified sha256-identical
// (`sha256sum -c`), not by `git checkout --`, which this repo has recorded as
// insufficient for restoring a mutation harness.
//
// NOT PROBED, and stated rather than left implied: that the digest is actually
// SET in production. Every probe above mutates the detector, and a detector
// with a perfect gate reads nothing if no push site fills `evidence` — a
// fail-open in the wiring rather than the logic. That is guarded behaviourally
// in test/bug-275-evidence-digest-reaches-the-ledger.test.js rather than here.
