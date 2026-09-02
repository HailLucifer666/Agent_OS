'use strict';

// test/bug-275-evidence-digest-reaches-the-ledger.test.js — the WIRING half.
//
// WHY THIS FILE EXISTS SEPARATELY. bug-275-unsourced-ranked-entity.test.js
// proves the detector's logic, and every mutation probe in it mutates the
// detector. None of them can see the failure that actually matters in
// production: a detector with a flawless gate reads NOTHING if no push site
// fills `evidence`. That is a fail-open in the wiring rather than in the logic,
// and it would present as a permanently quiet guard with a green suite — this
// repo's "false green" class, and the one it has been bitten by most.
//
// So this file drives the REAL adapter end to end: a real web_search dispatch,
// through the real digest builder, into the real recent-action ledger, into the
// real detector, out as a real system notice. Nothing about the path is faked
// except the transport at each end.
//
// IT IS NOT A SOURCE-SHAPE TEST, DELIBERATELY. A grep for `evidence:` in
// live-tool-adapter.js would pass on a commented-out line, and this repo has
// already had a source-shape guard pass while the code it described was gone
// (the grep matched the explanatory comment). Behaviour, not text.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// A search result with exactly one model name in it. "Gemini CLI" is absent,
// which is the whole fixture: the reply below gives it a ranked position.
const SEARCH_RESULT = {
  query: 'coding leaderboard august 2026',
  results: [{ title: 'Board', url: 'https://example-benchmarks.test/',
    snippet: 'Claude Mythos 5 leads with 81.1.' }],
};

function deps(over) {
  const busEvents = [];
  const sent = [];
  const base = {
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-1' },
    },
    dispatchAction: async () => ({ ok: true, result: SEARCH_RESULT }),
    bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-1',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sent.push(t) }),
  };
  return { deps: Object.assign(base, over || {}), busEvents, sent };
}

describe('BUG-275 — the evidence digest actually reaches the detector in production', () => {
  test('a real web_search dispatch makes the unsourced-ranking notice fire', async () => {
    const { deps: d, busEvents, sent } = deps();
    const adapter = createLiveToolAdapter(d);

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'web_search', args: { query: 'coding leaderboard august 2026' } }],
      { sendToolResponse: () => {} },
    );
    adapter.onLiveTurnComplete({
      userText: 'what is the top two',
      assistantText: 'Top two stands thus: Claude Mythos 5, and Gemini CLI.',
    });

    const anomaly = busEvents.find((e) => e.name === 'health.anomaly'
      && e.payload && e.payload.kind === 'unsourced-ranked-entity');
    assert.ok(anomaly,
      'the digest never reached the detector — nothing on the path from ev.result to '
      + 'detectUnsourcedRankedEntities is wired. Saw: '
      + JSON.stringify(busEvents.map((e) => (e.payload || {}).kind || e.name)));
    assert.deepEqual(anomaly.payload.absent, ['Gemini CLI']);
    assert.deepEqual(anomaly.payload.sawTools, ['web_search']);

    const notice = sent.find((t) => /Gemini CLI/.test(t));
    assert.ok(notice, 'the correction must reach the model, not only the bus');
    assert.match(notice, /does not occur|Not one of those names occurs/i);
  });

  // -------------------------------------------------------------------------
  // Written because probe (g) found the field UNPINNED: deleting `reason` from
  // the anomaly reddened nothing, in either BUG-275 file, while being a real
  // operator-facing defect.
  //
  // WHY `reason` IS LOAD-BEARING. None of these four detector kinds has a
  // healer playbook, so each reaches the immune explainer's `no-match` path and
  // is SPOKEN to the operator, and conversation/announcer.js's
  // honestCauseClause reads `reason` and nothing else — emitting "I do not yet
  // know the cause" when it is absent. An honesty alarm announced as an
  // unexplained fault, in the voice channel this ticket is about, is noise that
  // teaches the operator to ignore it.
  //
  // THE ASSERTION IS A RULE, NOT A LIST, and it is deliberately STRUCTURAL.
  // It says "every health.anomaly these detectors emit carries a non-empty
  // reason" rather than naming the three kinds or matching their wording. A
  // per-kind check is the omission scheduled for the day a fourth detector is
  // added — which happened the same day, and BUG-275 H2 was covered by this
  // loop without editing an assertion. A prose match rots on the first
  // rewording. Non-empty is exactly
  // what the consumer needs.
  const DETECTOR_TURNS = [
    {
      kind: 'unsourced-ranked-entity',
      tool: 'web_search',
      result: SEARCH_RESULT,
      assistantText: 'Top two stands thus: Claude Mythos 5, and Gemini CLI.',
    },
    {
      kind: 'promised-schedule-not-created',
      tool: 'web_search',
      result: SEARCH_RESULT,
      assistantText: 'I will send you a briefing every day at 10 AM, Sir.',
    },
    {
      kind: 'retracted-a-proven-action',
      tool: 'open_folder',
      result: { opened: true, window: 'Downloads - File Explorer' },
      assistantText: 'I was mistaken about that folder opening successfully; I am retracting that claim.',
    },
    {
      // BUG-275 H2, added 2026-09-02. The fourth detector, and it is in this
      // loop because the rule is "every turn-auditing detector carries a
      // reason", not "the three that existed when the loop was written". It is
      // the only entry needing `userText`: the challenge is what the operator
      // said, so a fixture without it cannot reach the detector at all.
      kind: 'defended-claim-under-challenge',
      tool: 'launch_app',
      result: { launched: true },
      userText: 'I see a lie. Where did you get that?',
      assistantText: "'Gemini CLI' refers to the access method, not the model name.",
    },
  ];

  for (const turn of DETECTOR_TURNS) {
    test(`${turn.kind}: the emitted anomaly carries a non-empty \`reason\``, async () => {
      const { deps: d, busEvents } = deps({
        dispatchAction: async () => ({ ok: true, result: turn.result }),
      });
      const adapter = createLiveToolAdapter(d);
      await adapter.handleLiveToolCalls(
        [{ id: 'call-1', name: turn.tool, args: {} }],
        { sendToolResponse: () => {} },
      );
      adapter.onLiveTurnComplete({ userText: turn.userText || 'go', assistantText: turn.assistantText });

      const hit = busEvents.find((e) => e.name === 'health.anomaly'
        && e.payload && e.payload.kind === turn.kind);
      assert.ok(hit, `${turn.kind} did not fire; this test cannot check its payload. Saw: `
        + JSON.stringify(busEvents.map((e) => (e.payload || {}).kind || e.name)));
      assert.equal(typeof hit.payload.reason, 'string',
        `${turn.kind} has no \`reason\`, so the immune explainer will speak `
        + '"I do not yet know the cause" for a condition this detector knows exactly');
      assert.ok(hit.payload.reason.length > 0, 'an empty reason is the same defect');
    });
  }

  test('a name that IS in the result produces no notice (the negative control)', async () => {
    // Without this, every assertion above could hold while the detector fired
    // on everything — which is the direction that makes a guard get muted.
    const { deps: d, busEvents } = deps();
    const adapter = createLiveToolAdapter(d);
    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'web_search', args: { query: 'q' } }],
      { sendToolResponse: () => {} },
    );
    adapter.onLiveTurnComplete({
      userText: 'who leads',
      assistantText: 'Top one stands thus: Claude Mythos 5.',
    });
    assert.ok(!busEvents.some((e) => e.payload && e.payload.kind === 'unsourced-ranked-entity'),
      'a correctly sourced ranking must not be flagged');
  });

  test('a NON-evidence tool grows no digest, so an ordinary desktop turn is untouched', async () => {
    // The cost bound. If every tool carried a digest, the ledger would hold up
    // to 64 result payloads for two minutes for no reader.
    const { deps: d, busEvents } = deps({
      dispatchAction: async () => ({ ok: true, result: { launched: true, pid: 4321 } }),
    });
    const adapter = createLiveToolAdapter(d);
    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'launch_app', args: { name: 'notepad' } }],
      { sendToolResponse: () => {} },
    );
    adapter.onLiveTurnComplete({
      userText: 'open notepad',
      assistantText: 'Top two stands thus: Alpha Nine, and Beta Nine.',
    });
    assert.ok(!busEvents.some((e) => e.payload && e.payload.kind === 'unsourced-ranked-entity'),
      'a window of desktop actions carries no external evidence and must prove nothing');
  });
});

// MUTATION PROOF, run 2026-09-02, verified applied by re-counting the mutated
// string and restored by full-path file copy:
//
//   (f) DELETE the `evidence:` field from the awaited commitAction site in
//       live-tool-adapter.js (the whole `evidence: EVIDENCE_TOOLS.indexOf(...)`
//       expression) -> reds "a real web_search dispatch makes the
//       unsourced-ranking notice fire" with the wiring message above, while
//       every test in bug-275-unsourced-ranked-entity.test.js stays GREEN.
//       That contrast is the reason this file exists.
//
//   (g) DELETE the `reason:` field from the unsourced-ranking anomaly.
//       FIRST RUN: reddened NOTHING, in either BUG-275 file — a real
//       operator-facing defect (the immune explainer would speak "I do not yet
//       know the cause") with no guard on it. The three `reason` tests above
//       were written in response, and the probe was then RE-RUN: it now reds
//       "unsourced-ranked-entity: the emitted anomaly carries a non-empty
//       `reason`" and nothing else. A guard written to catch a probe is not
//       finished until it has been shown to catch that probe.
//
//   (h) DELETE the `reason:` field from the false-retraction anomaly — a
//       DIFFERENT one of the three, to check the loop asserts per-iteration
//       rather than all three passing off one emission -> reds only
//       "retracted-a-proven-action", confirming independence.
//
// Two of those three `reason` fields belong to the BUG-398 detectors, not to
// BUG-275. They were missing for the same reason and were fixed in this pass:
// the justification is "an emitter that knows its cause must state it", and
// that sentence covers all three, so fixing only the new one would have left
// two live instances of the defect this pass identified.
