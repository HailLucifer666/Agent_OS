'use strict';

// test/late-tool-anomaly-attribution.test.js — BUG-105. On 2026-08-05 a
// `live-tool-outcome-late-for-turn` anomaly for `list_windows` was spoken to the
// operator as "It appears the MUSIC PLAYBACK TOOL is running late to turn due to
// an internal communication delay." Nothing looked it up wrong: the anomaly
// carried the tool under a `tool` key, but every immune consumer keys on
// `target`, so immune/explainer.js prompted the brain with `Target: (none)` and
// the model invented a plausible component to finish the sentence.
//
// Two halves, both pinned here: the emitter names the tool in the field the
// pipeline actually reads, and the explainer is forbidden from naming a
// component that was not given to it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { createExplainer } = require('../src/core/immune/explainer');
const { fakeBus } = require('./helpers');

describe('the late-outcome anomaly names its tool', () => {
  test('health.anomaly carries the tool as `target`, the field the immune chain reads', async () => {
    const busEvents = [];
    let resolveDispatch;
    const adapter = createLiveToolAdapter({
      leash: {
        check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'confirm-1' },
      },
      dispatchAction: () => new Promise((r) => { resolveDispatch = r; }),
      bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
      logger: { warn() {}, info() {} },
      connectionId: 'conn-1',
      memory: { working: {}, episodic: { write: async () => {} } },
      historyAppend: () => {},
      reflection: { noteTurn() {} },
      summarizeActionsForResult: () => null,
      getLiveSession: () => null,
    });

    const inFlight = adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'list_windows', args: {} }],
      { sendToolResponse: () => {} },
    );
    // The turn ends before the tool answers — the misattribution window.
    adapter.onLiveTurnComplete({ userText: 'close chrome', assistantText: 'on it' });
    resolveDispatch({ ok: true, result: {} });
    await inFlight;

    const anomaly = busEvents.find((e) => e.name === 'health.anomaly'
      && e.payload.kind === 'live-tool-outcome-late-for-turn');
    assert.ok(anomaly, 'the late-for-turn anomaly must still be raised');
    assert.equal(anomaly.payload.tool, 'list_windows');
    assert.equal(anomaly.payload.target, 'list_windows',
      'immune/explainer.js and the episodic summary both read `target`, not `tool`');
  });
});

describe('the explainer never invents a component', () => {
  function capturedPrompt(payload) {
    const prompts = [];
    const bus = fakeBus();
    const explainer = createExplainer({
      bus,
      memory: { episodic: { recall: () => [] } },
      config: {},
      brain: {
        async think(req) {
          prompts.push(req.messages[0].content);
          return { offline: true };
        },
      },
    });
    return { explainer, prompts, payload };
  }

  test('the prompt states the real tool when the anomaly names one', async () => {
    const { explainer, prompts } = capturedPrompt();
    await explainer._onHealed({ payload: {
      kind: 'live-tool-outcome-late-for-turn', target: 'list_windows',
      outcome: 'no-match', detail: {},
    } });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /list_windows/);
  });

  // 2026-08-10 — this test used to assert the prompt contained "do not name any
  // tool, provider or subsystem that is not stated above". That guard was
  // load-bearing while the model wrote the spoken sentence, and it was not
  // enough: forbidden from naming a COMPONENT, the model invented a MECHANISM
  // instead, and the operator was told "maybe a tool spinning its wheels and
  // triggering a limit" about a deliberate idle close. The prompt no longer asks
  // for prose at all, so the stronger property is now assertable — there is
  // nothing in the response for the operator to hear.
  // FIXTURE REPOINTED, BUG-278 (2026-08-20). This used to fire `target: ''`, which now
  // takes the no-brain-call path on purpose: with no target, neither suppress_tool nor
  // probe_provider can act, so the remedy menu is empty and there is no question to ask
  // (91 of 104 health.anomaly emit sites carry no target, so that path is the common one).
  // The property under test here is the SHAPE OF THE PROMPT, not whether an empty target
  // produces one — the empty string was incidental to it. A tool-shaped target keeps the
  // brain in the loop so the assertions below still traverse the branch they describe.
  test('the prompt asks for a remedy only, so there is no prose to fabricate', async () => {
    const { explainer, prompts } = capturedPrompt();
    await explainer._onHealed({ payload: {
      kind: 'some-anomaly', target: 'some_tool', outcome: 'no-match', detail: {},
    } });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /"remedy"/,
      'the remedy menu is the only thing the brain is asked for');
    assert.doesNotMatch(prompts[0], /explanation|likely cause|spoken sentence/i,
      'asking a model to explain a bare anomaly kind is what produced an invented cause');
  });
});
