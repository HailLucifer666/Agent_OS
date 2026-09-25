'use strict';

// test/bug-275-h1-promoted-ranked-entity.test.js — BUG-275 H1.
//
// WHAT H1 ACTUALLY IS, and why the existing detector could never see it. The
// model said "top five stands thus: Claude Mythos 5, then Claude Fable 5,
// followed by GPT-5.6 Sol, Claude Opus 5, and Gemini CLI" while the evidence
// held a ranking of THREE. The two extra names were not invented — "Gemini CLI"
// is in the result, but only inside "An in-depth comparison of Claude Opus 5,
// GPT-5.6 Sol, Gemini CLI, GitHub Copilot", a sentence that gives no positions
// at all. The reply promoted a name out of unranked prose into rank five. An
// absence test cannot detect a name that is present, and ranked-claim-check.js's
// header, this repo's BUGS.md disposition and the pinned test in
// bug-275-unsourced-ranked-entity.test.js all forbid weakening that test to
// reach H1. So this is a SECOND detector, and every one of those pins still
// holds — the test below asserts the two detectors disagree on this input.
//
// TELEMETRY ONLY, OPERATOR DECISION 2026-09-10: a prompt rule plus a silent
// anomaly, never a spoken retraction. The RANK RULE now sits at the end of the
// HONESTY RULE paragraph in voice-agent.js and does the live work; this detector
// records what got through, for the next corpus replay. It is wired through
// promoted-rank-anomaly.js and NOT through reportTurnAudit, because every path
// through that helper ends in MYTHOS telling the operator aloud it was wrong,
// and this detector reads a structure classification of web prose — a model of a
// document, which can be wrong in a way a tool outcome cannot. A false positive
// there would retract a TRUE statement, the one error this family forbids.
//
// MUTATION RUN 2026-09-10, each verified applied by grep and restored
// sha256-identical:
//   drop the `elsewhere` clause from the detector (present-in-mention is enough)
//     -> (b) red: GPT-5.6 Sol and Claude Opus 5 are flagged although the same
//        window ranks them, which would be a false accusation.
//   invert it to require presence in `elsewhere`
//     -> (a) red: H1's own name stops being found.
//   add a bare /vs/i marker
//     -> (c) red: "(89.5% vs 89.1%)" reclassifies a whole ranked snippet, and
//        Claude Opus 5 is flagged off a comparison of two numbers.
//   classify unreadable prose as mention-only instead of elsewhere
//     -> (d) red: the fail-closed direction reverses, and 5 tests go with it.
//   speak the correction beside the bus emit
//     -> (g) red — but ONLY after (g) was fixed. Its first version handed the
//        module a bus with just emit(), so a probe that added a spoken
//        correction changed nothing observable and SURVIVED. "Speaks nothing"
//        was in the test's title and in none of its assertions. The fake now
//        carries every speaking door and asserts none was used.
//
// NOT COVERED. A promotion out of prose the classifier cannot read is a MISS,
// deliberately: `mentionOnly` carries only positively classified sentences and
// the detector also requires absence from everything else, so one unreadable
// sentence mentioning the name silences the finding. Also not covered: whether
// the RANK RULE changes model behaviour. A prompt instruction is not a
// mechanism (this repo has that on record), which is exactly why the silent
// detector exists beside it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectPromotedRankedEntities, detectUnsourcedRankedEntities,
} = require('../src/core/voice/ranked-claim-check');
const { buildEvidenceDigest, classifyProse } = require('../src/core/voice/evidence-digest');
const { reportPromotedRanks } = require('../src/core/voice/promoted-rank-anomaly');

// The measured result, verbatim from the 2026-08-19 vault and identical to the
// fixture in bug-275-unsourced-ranked-entity.test.js. Kept as its own copy on
// purpose: this file must keep testing the real bytes even if that file's
// fixtures are refactored, and a shared fixture that quietly changes would move
// both detectors' evidence at once.
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

// The real spoken text, verbatim from the vault.
const H1_REPLY = 'On current leaderboards, Sir, top five stands thus: Claude Mythos 5, then '
  + 'Claude Fable 5, followed by GPT-5.6 Sol, Claude Opus 5, and Gemini CLI. Shall I dig into '
  + 'specific benchmarks regarding particular models?';

const row = (result, over) => Object.assign(
  { tool: 'web_search', ok: true, evidence: buildEvidenceDigest(result) }, over || {});

describe('BUG-275 H1 — a name given a rank its source never gave it', () => {
  test('(a) H1 fires on the measured reply against the measured evidence', () => {
    const out = detectPromotedRankedEntities(H1_REPLY, [], [row(BENCHLM_RESULT)]);
    assert.equal(out.length, 1, 'the measured H1 utterance must be caught');
    assert.equal(out[0].kind, 'promoted-ranked-entity');
    assert.deepEqual(out[0].promoted, ['Gemini CLI']);
    assert.deepEqual(out[0].sawTools, ['web_search']);
  });

  test('(b) the three names the evidence really does rank are NOT flagged', () => {
    // The adjacent case, and the one that matters most: this detector must not
    // become a second way to accuse the model of sourcing a name it sourced.
    // Claude Mythos 5, Claude Fable 5 and GPT-5.6 Sol are all in the BenchLM
    // ranking sentence. Claude Opus 5 is in a non-comparison snippet too, so the
    // `elsewhere` clause keeps it silent — a miss, in the required direction.
    const out = detectPromotedRankedEntities(H1_REPLY, [], [row(BENCHLM_RESULT)]);
    for (const name of ['Claude Mythos 5', 'Claude Fable 5', 'GPT-5.6 Sol', 'Claude Opus 5']) {
      assert.ok(!out[0].promoted.includes(name), name + ' is ranked or mentioned elsewhere in this window');
    }
  });

  test('(c) "vs" between two numbers is not a comparison of names', () => {
    // Considered and rejected as a marker. The measured snippet 2 contains
    // "(89.5% vs 89.1%)" inside ranked prose about two models; admitting versus
    // would reclassify that whole snippet as mention-only and flag Claude Opus 5
    // off a comparison of two percentages.
    const prose = classifyProse(BENCHLM_RESULT);
    assert.ok(!/independentbenchmarking/.test(prose.mentionOnly),
      'the Terminal-Bench snippet must stay OUT of the mention-only bucket');
    assert.ok(/independentbenchmarking/.test(prose.elsewhere));
  });

  test('(d) prose the classifier cannot read counts as elsewhere, so it silences rather than accuses', () => {
    const opaque = { results: [{ title: 'Leaderboard', url: 'https://x/y',
      snippet: 'Gemini CLI Claude Mythos 5 Claude Fable 5 GPT-5.6 Sol Claude Opus 5' }] };
    const prose = classifyProse(opaque);
    assert.equal(prose.mentionOnly, '', 'nothing is positively classified');
    assert.ok(prose.elsewhere.length > 0, 'and all of it lands in the bucket that silences');
    assert.deepEqual(detectPromotedRankedEntities(H1_REPLY, [], [row(opaque)]), []);
  });

  test('(e) a URL slug is not prose and cannot become evidence of a mention', () => {
    // The measured result's own url contains claude-opus-5. Classifying a slug
    // either way would be inventing evidence, so urls are excluded outright.
    const prose = classifyProse({ results: [{ url: 'https://x/comparison-of-gemini-cli-and-others', snippet: 'Nothing here.' }] });
    assert.equal(prose.mentionOnly, '', 'a slug that reads like a comparison is still not a sentence');
  });

  test('(f) the two detectors disagree on this input BY DESIGN, and the older pin is untouched', () => {
    const actions = [row(BENCHLM_RESULT)];
    assert.equal(detectPromotedRankedEntities(H1_REPLY, [], actions).length, 1);
    assert.deepEqual(detectUnsourcedRankedEntities(H1_REPLY, [], actions), [],
      'the absence test must STILL return [] on H1 — weakening it is what the disposition forbids');
  });

  test('(g) the wiring emits a health.anomaly with a reason, and speaks nothing', () => {
    // "Speaks nothing" has to be ASSERTED, not implied by the fake being unable to
    // speak. A first version of this test used a bus with only emit(), so a probe
    // that added a spoken correction beside the emit changed nothing and SURVIVED.
    // The fake now carries every speaking door this module could reach, and the
    // source-shape check below closes the ones it could reach by require().
    const events = [];
    const spoke = [];
    const bus = { emit: (type, payload) => events.push({ type, payload }),
      sendText: (t2) => spoke.push(t2), sendSystemNotice: (t2) => spoke.push(t2) };
    const n = reportPromotedRanks({ bus, assistantText: H1_REPLY, actionsThisTurn: [], recentActions: [row(BENCHLM_RESULT)] });
    assert.equal(n, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'health.anomaly');
    assert.equal(events[0].payload.kind, 'promoted-ranked-entity');
    // immune/explainer.js narrates an unplaybooked anomaly from target + reason,
    // so an anomaly without a reason is announced as an unexplained fault.
    assert.equal(events[0].payload.target, 'promoted-ranked-entity');
    assert.match(events[0].payload.reason, /Gemini CLI/);
    assert.match(events[0].payload.reason, /in passing rather than ranking/);
    assert.match(events[0].payload.claim, /top five stands thus/);
    assert.deepEqual(spoke, [], 'nothing may be spoken — this is telemetry, by decision');
    // And it cannot reach a speaking door indirectly either. Source-shape, but
    // narrow: four named function calls, comments stripped so this comment cannot
    // satisfy its own guard.
    const fsMod = require('fs');
    const pathMod = require('path');
    const raw = fsMod.readFileSync(pathMod.join(__dirname, '..', 'src', 'core', 'voice', 'promoted-rank-anomaly.js'), 'utf8');
    const code = raw.split(String.fromCharCode(10)).filter((line) => !line.trim().startsWith('//')).join(' ');
    for (const door of ['sendText', 'sendSystemNotice', 'reportTurnAudit', 'speakWhenClosed']) {
      assert.ok(!code.includes(door),
        'promoted-rank-anomaly.js must not mention ' + door + ' — H1 is silent by decision');
    }
  });

  test('(h) the gate: a failed, unverified or truncated lookup proves nothing here either', () => {
    for (const over of [{ ok: false }, { ok: true, unverified: true }]) {
      assert.deepEqual(detectPromotedRankedEntities(H1_REPLY, [], [row(BENCHLM_RESULT, over)]), [], JSON.stringify(over));
    }
    const truncated = row(BENCHLM_RESULT);
    truncated.evidence = Object.assign({}, truncated.evidence, { truncated: true });
    assert.deepEqual(detectPromotedRankedEntities(H1_REPLY, [], [truncated]), [],
      'a truncated digest cannot prove the name is absent from everything else');
    // launch_app, not screen_look: screen_look IS an evidence tool (it is in the
    // external-fact category's gateTools, which EVIDENCE_TOOLS is derived from), and
    // a fixture that picks the wrong tool would pass for the wrong reason.
    assert.deepEqual(detectPromotedRankedEntities(H1_REPLY, [], [{ tool: 'launch_app', ok: true, evidence: buildEvidenceDigest(BENCHLM_RESULT) }]), [],
      'a non-evidence tool is outside this proof domain');
    assert.deepEqual(detectPromotedRankedEntities(H1_REPLY, [], []), []);
    assert.deepEqual(detectPromotedRankedEntities('', [], [row(BENCHLM_RESULT)]), []);
  });

  test('(i) a reply with no enumerated ranking is silent, however the evidence reads', () => {
    // The same names, no ranking claim: this detector fires on RANK, not mention.
    const out = detectPromotedRankedEntities(
      'I looked at a few, Sir — Gemini CLI and GitHub Copilot came up.', [], [row(BENCHLM_RESULT)]);
    assert.deepEqual(out, []);
  });

  test('(j) the RANK RULE is in the prompt, and it is inside the ceiling', () => {
    // Source-shape, deliberately narrow: the sentence is the live half of the
    // operator's decision, and a silent detector beside a missing rule would
    // record the problem forever without ever reducing it.
    const { RULES } = require('../src/core/voice/voice-agent');
    const rules = typeof RULES === 'string' ? RULES : require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'core', 'voice', 'voice-agent.js'), 'utf8');
    assert.match(rules, /never give a name a rank its source did not give it/i);
    assert.match(rules, /a passing mention is not a ranking/i);
  });
});

// ADDED 2026-09-23. A probe found this detector's WIRING unpinned: removing its
// call from the adapter's silent path (now silent-turn-anomalies.js) left every
// test green, before and after that path was extracted, because every test above
// calls the detector or its reporter directly. (k) drives the real adapter.
describe('BUG-275 H1 — through the real adapter', () => {
  test('(k) a real web_search result, then the measured reply: the adapter reports the anomaly, silently', async () => {
    const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
    const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
    const anomalies = []; const notices = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: { create: () => 'c', reject() {} } },
      dispatchAction: async () => ({ ok: true, result: BENCHLM_RESULT }),
      bus: { emit: (t, p) => { if (t === 'health.anomaly') anomalies.push(p); } }, logger: { info() {}, warn() {} },
      connectionId: 'conn-275-h1', memory: { working: { tick: 1 }, episodic: { write: async () => {} } }, historyAppend: () => {},
      reflection: null, summarizeActionsForResult, config: {},
      getLiveSession: () => ({ isOpen: () => true, sendText: (text, meta) => { notices.push(meta && meta.site); return true; } }),
    });
    await adapter.handleLiveToolCalls([{ id: 'c-h1', name: 'web_search', args: { query: BENCHLM_RESULT.query } }], { sendToolResponse: () => {} });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
    adapter.onLiveTurnComplete({ userText: 'what are the top coding models', assistantText: H1_REPLY });
    const row = anomalies.find((a) => a.kind === 'promoted-ranked-entity');
    assert.ok(row, 'the adapter did not run the H1 detector: ' + JSON.stringify(anomalies.map((a) => a.kind)));
    assert.deepEqual(row.promoted, ['Gemini CLI']);
    assert.ok(!notices.some((site) => /promoted|rank/.test(String(site))), 'and nothing was injected for it');
  });
});
