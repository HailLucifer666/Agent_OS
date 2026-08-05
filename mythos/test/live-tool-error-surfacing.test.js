'use strict';

// test/live-tool-error-surfacing.test.js — BUG-101. A failing tool's real reason
// never reached the model: effectors are supposed to speak `{ok, result}` (the
// ok()/fail() helpers), but several return `{ok:false, error:'...'}` instead, and
// EVERY consumer downstream reads only `.result` —
//   - live-tool-adapter's evaluateOutcome(): `(result && result.error) || result
//     || 'Failed.'` with `result === undefined` → the literal 'Failed.'
//   - dispatch-action's audit line: `reasonText(result && result.result)` → ''
// Logged live on 2026-08-05: reminder_add returned "Could not parse that time…"
// and the operator heard "Failed indeed, Sir", twice, with nothing to act on.
//
// The fix normalizes at the effector-adapter boundary so voice, audit, and the
// non-Live voice agent all get the text, plus a defensive read in
// evaluateOutcome for effectors invoked outside that adapter.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { effectorFromTool } = require('../src/core/effectors/adapter');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

describe('effector adapter — failure normalization', () => {
  test('a tool returning {ok:false, error} gets the message mirrored into result', async () => {
    const eff = effectorFromTool({
      name: 'reminder_add',
      description: 'x',
      params: {},
      fn: async () => ({ ok: false, error: 'Could not parse that time.' }),
    });

    const out = await eff.invoke({}, {});

    assert.equal(out.ok, false);
    assert.equal(out.result, 'Could not parse that time.', 'result must carry the reason for every downstream consumer');
    assert.equal(out.error, 'Could not parse that time.', 'the original field is preserved, not replaced');
  });

  test('a tool that already speaks {ok:false, result} is passed through untouched', async () => {
    const eff = effectorFromTool({
      name: 'x', description: 'x', params: {},
      fn: async () => ({ ok: false, result: 'the real reason' }),
    });

    const out = await eff.invoke({}, {});

    assert.equal(out.result, 'the real reason');
  });

  test('a successful result is never rewritten', async () => {
    const eff = effectorFromTool({
      name: 'x', description: 'x', params: {},
      fn: async () => ({ ok: true, result: { reminder: { id: 'r1' } } }),
    });

    const out = await eff.invoke({}, {});

    assert.equal(out.ok, true);
    assert.deepEqual(out.result, { reminder: { id: 'r1' } });
  });
});

describe('live-tool-adapter — a failure the model can describe', () => {
  function adapterWithOutcome(outcome) {
    const responses = [];
    const actions = [];
    const adapter = createLiveToolAdapter({
      leash: {
        check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'confirm-1' },
      },
      dispatchAction: async () => outcome,
      bus: { emit() {} },
      logger: { warn() {}, info() {} },
      connectionId: 'conn-1',
      memory: { working: {}, episodic: { write: async () => {} } },
      historyAppend: () => {},
      reflection: { noteTurn() {} },
      summarizeActionsForResult: (a) => { actions.push(...a); return null; },
      getLiveSession: () => null,
    });
    return { adapter, responses, actions };
  }

  test('an effector failing with {ok:false, error} surfaces that text, not a bare "Failed"', async () => {
    const { adapter, responses } = adapterWithOutcome({ ok: false, error: 'Could not parse that time.' });

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'reminder_add', args: {} }],
      { sendToolResponse: (r) => responses.push(...r) },
    );

    assert.equal(responses[0].response.status, 'failed');
    assert.match(responses[0].response.error, /could not parse that time/i);
    assert.doesNotMatch(responses[0].response.error, /^Failed\.$/);
  });

  test('a failure with nothing to say still degrades to the honest generic', async () => {
    const { adapter, responses } = adapterWithOutcome({ ok: false });

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'reminder_add', args: {} }],
      { sendToolResponse: (r) => responses.push(...r) },
    );

    assert.equal(responses[0].response.status, 'failed');
    assert.match(responses[0].response.error, /failed/i);
  });
});
