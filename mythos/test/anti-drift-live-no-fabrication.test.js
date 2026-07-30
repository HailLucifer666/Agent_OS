'use strict';

// test/anti-drift-live-no-fabrication.test.js — AD-4 from
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan-V2-spine.md §1: "No fabricated
// success. The model's spoken claim is reconciled against real tool outcomes
// before the turn is persisted. Live has no needs_result loop, so this must
// be enforced on turnComplete." Executable check, verbatim from the spine's
// own table: force a tool to fail, assert the episodic record's
// detail.actions[].ok === false and that a system-role outcome note was
// appended to history.
//
// Driven through the REAL dispatch-action.js (sharedDispatch), not a stub,
// so the whole real chain — effectors.invoke -> breaker -> episodic write ->
// adapter reconciliation -> onLiveTurnComplete — is exercised end to end.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { dispatchAction: sharedDispatch } = require('../src/core/effectors/dispatch-action');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

function realEffectorHubAlwaysFails() {
  return {
    breakers: { allow: () => true },
    invoke: async () => ({ ok: false, result: { error: 'network down' } }),
  };
}

describe('AD-4: a failing tool never becomes a fabricated success in history or episodic memory', () => {
  test('a T0 tool that fails at the real effector layer is recorded as ok:false end-to-end', async () => {
    const bus = createBus({ historySize: 50 });
    const episodicWrites = [];
    const memory = {
      working: { tick: 7 },
      episodic: { write: async (rec) => { episodicWrites.push(rec); } },
    };
    const history = [];

    async function dispatchAction(decision, ctx) {
      return sharedDispatch(decision, {
        effectors: realEffectorHubAlwaysFails(), bus, goals: null, memory, config: {},
        goalId: ctx.goalId || null, tier: ctx.tier || 0, channel: ctx.channel || 'voice', traceId: ctx.traceId || null,
      });
    }

    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }), confirm: {} },
      dispatchAction,
      bus, logger: { warn() {}, info() {} }, connectionId: 'conn-ad4',
      memory, historyAppend: (role, content) => history.push({ role, content }),
      reflection: null,
      summarizeActionsForResult: (actions) => {
        if (!actions.length) return null;
        const parts = actions.filter((a) => a.tool && !a.confirmPending)
          .map((a) => `${a.tool} ${a.ok ? 'succeeded' : 'FAILED'}${a.summary ? ': ' + a.summary : ''}`);
        return parts.length ? 'Action outcomes: ' + parts.join('; ') + '.' : null;
      },
      getLiveSession: () => null,
    });

    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'call-fail-1', name: 'read_status', args: {} }],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    // The model's functionResponse must say failed, never ok.
    assert.equal(responses[0].response.status, 'failed');
    assert.match(responses[0].response.error, /network down/);

    // Even if the model were to SAY "done" in its spoken reply, the
    // reconciliation on turnComplete must record the real outcome.
    adapter.onLiveTurnComplete({ userText: 'check status', assistantText: 'All good, status checked.' });

    const systemNote = history.find((h) => h.role === 'system');
    assert.ok(systemNote, 'a system outcome note must be appended even though the model spoke a success-sounding reply');
    assert.match(systemNote.content, /FAILED/);

    // Two independent episodic writes happen for this turn: sharedDispatch's
    // own action-kind write (from dispatch-action.js), and the adapter's
    // conversation-kind write (onLiveTurnComplete). BOTH must reflect ok:false.
    const actionWrite = episodicWrites.find((w) => w.kind === 'action');
    assert.ok(actionWrite);
    assert.equal(actionWrite.detail.ok, false);

    const conversationWrite = episodicWrites.find((w) => w.kind === 'conversation');
    assert.ok(conversationWrite);
    assert.equal(conversationWrite.detail.actions.length, 1);
    assert.equal(conversationWrite.detail.actions[0].ok, false, "AD-4: the episodic record must say ok:false, never fabricate success");
  });
});
