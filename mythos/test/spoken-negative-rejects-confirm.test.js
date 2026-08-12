'use strict';

// test/spoken-negative-rejects-confirm.test.js — Task B3 (MYTHOS Installed-Build
// Repair Plan). 2026-08-12 diagnosis (G4): a show_desktop confirm (Tier 2, NOT
// in SEND_TOOLS) sat pending in live-tool-adapter.js's livePendingConfirms
// while the operator said "No" out loud, and nothing consumed it —
// resolveSpokenConfirm (voice-agent.js) only ever inspects armedSpokenConfirms,
// which only SEND_TOOLS ever populates. This covers the path that was missing
// entirely: a spoken negative rejecting a confirm live-tool-adapter.js is
// already tracking for any other T2+ tool.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

function fakeMemory() {
  return { working: { tick: 1 }, episodic: { write: async () => {} } };
}

function baseDeps(overrides) {
  const history = [];
  const dispatchCalls = [];
  const busEvents = [];
  const rejectCalls = [];
  const deps = Object.assign({
    leash: {
      check: () => ({ allow: false, requireConfirm: true, tier: 2, reason: 'tier-2-requires-confirm' }),
      confirm: {
        create: () => 'confirm-show-desktop',
        reject: (id, connId) => { rejectCalls.push({ id, connId }); return true; },
      },
    },
    dispatchAction: async (decision, ctx) => {
      dispatchCalls.push({ decision, ctx });
      return { ok: true, result: { done: true } };
    },
    bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-1',
    memory: fakeMemory(),
    historyAppend: (role, content) => history.push({ role, content }),
    reflection: { noteTurn() {} },
    summarizeActionsForResult: (actions) => (actions.length ? 'summary' : null),
    getLiveSession: () => null,
  }, overrides || {});
  return { deps, history, dispatchCalls, busEvents, rejectCalls };
}

describe('a spoken "no" cancels any pending confirm (B3)', () => {
  test('a pending show_desktop confirm is rejected by a spoken "No." and never dispatched', async () => {
    const { deps, dispatchCalls, rejectCalls } = baseDeps();
    const adapter = createLiveToolAdapter(deps);

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'show_desktop', args: {} }],
      { sendToolResponse: () => {} },
    );
    assert.equal(adapter._internal.livePendingConfirms.size, 1, 'the confirm must be tracked as pending');

    await adapter.onLiveTurnComplete({ userText: 'No.', assistantText: '', turnId: 1 });

    assert.equal(rejectCalls.length, 1, 'leash.confirm.reject must be called for the pending confirm');
    assert.equal(rejectCalls[0].id, 'confirm-show-desktop');
    assert.equal(adapter._internal.livePendingConfirms.size, 0, 'the confirm must no longer be pending');
    assert.equal(dispatchCalls.length, 0, 'show_desktop must never have been dispatched');
  });

  test('the spoken reply names exactly what was cancelled', async () => {
    const sent = [];
    const liveSession = { isOpen: () => true, sendText: (t) => sent.push(t) };
    const { deps } = baseDeps({ getLiveSession: () => liveSession });
    const adapter = createLiveToolAdapter(deps);

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'show_desktop', args: {} }],
      { sendToolResponse: () => {} },
    );
    await adapter.onLiveTurnComplete({ userText: 'No, don\'t.', assistantText: '', turnId: 1 });

    assert.equal(sent.length, 1);
    assert.match(sent[0], /show_desktop/, 'the operator must be told exactly which action was cancelled');
    assert.match(sent[0], /Do NOT run/i, 'the model must be told not to execute it');
  });

  test('multiple pending confirms are ALL rejected by a single spoken "no"', async () => {
    let nextId = 0;
    const { deps, rejectCalls } = baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 2, reason: 'tier-2-requires-confirm' }),
        confirm: {
          create: () => `confirm-${nextId++}`,
          reject: (id, connId) => { rejectCalls.push({ id, connId }); return true; },
        },
      },
    });
    const adapter = createLiveToolAdapter(deps);

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'show_desktop', args: {} }, { id: 'call-2', name: 'launch_app', args: {} }],
      { sendToolResponse: () => {} },
    );
    assert.equal(adapter._internal.livePendingConfirms.size, 2);

    await adapter.onLiveTurnComplete({ userText: 'No.', assistantText: '', turnId: 1 });

    assert.equal(rejectCalls.length, 2, 'both pending confirms must be rejected, not just the most recent');
    assert.equal(adapter._internal.livePendingConfirms.size, 0);
  });

  test('an affirmative utterance does NOT reject a pending confirm (no widened accept path)', async () => {
    const { deps, rejectCalls } = baseDeps();
    const adapter = createLiveToolAdapter(deps);

    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'show_desktop', args: {} }],
      { sendToolResponse: () => {} },
    );
    await adapter.onLiveTurnComplete({ userText: 'Yes, go ahead.', assistantText: '', turnId: 1 });

    assert.equal(rejectCalls.length, 0, 'an affirmative utterance must not touch the pending confirm at all');
    assert.equal(adapter._internal.livePendingConfirms.size, 1, 'the confirm must still be pending — this path never accepts');
  });

  test('with nothing pending, an ordinary "no" is a no-op (does not call leash.confirm.reject)', async () => {
    const { deps, rejectCalls } = baseDeps();
    const adapter = createLiveToolAdapter(deps);
    await adapter.onLiveTurnComplete({ userText: 'No thanks.', assistantText: '', turnId: 1 });
    assert.equal(rejectCalls.length, 0);
  });
});
