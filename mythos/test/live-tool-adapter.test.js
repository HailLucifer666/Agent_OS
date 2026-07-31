'use strict';

// test/live-tool-adapter.test.js — Phase 3 (V2 §8, merged-order step 4). Unit
// tests for the safety-seam adapter in isolation, with a fake leash/dispatch so
// every branch (allow, requireConfirm, deny, dispatch-throw, leash-throw) is
// exercised precisely. The real-leash AD-1/AD-2 proofs live in
// test/anti-drift-audit-single-write.test.js and
// test/anti-drift-live-no-fabrication.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

function fakeMemory() {
  const writes = [];
  return {
    working: { tick: 1 },
    episodic: { write: async (rec) => { writes.push(rec); } },
    _writes: writes,
  };
}

function baseDeps(overrides) {
  const history = [];
  const dispatchCalls = [];
  const busEvents = [];
  const memory = fakeMemory();
  const deps = Object.assign({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-1' },
    },
    dispatchAction: async (decision, ctx) => {
      dispatchCalls.push({ decision, ctx });
      return { ok: true, result: { done: true } };
    },
    bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-1',
    memory,
    historyAppend: (role, content) => history.push({ role, content }),
    reflection: { noteTurn() {} },
    summarizeActionsForResult: (actions) => {
      if (!actions.length) return null;
      return 'Action outcomes: ' + actions.map((a) => `${a.tool} ${a.ok ? 'succeeded' : 'FAILED'}`).join('; ') + '.';
    },
    getLiveSession: () => null,
  }, overrides || {});
  return { deps, history, dispatchCalls, busEvents, memory };
}

describe('live-tool-adapter — handleLiveToolCalls', () => {
  test('an allowed (T0-T2) tool call dispatches through dispatchAction and returns status ok', async () => {
    const { deps, dispatchCalls } = baseDeps();
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'call-1', name: 'read_status', args: {} }],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].decision.tool, 'read_status');
    assert.equal(dispatchCalls[0].ctx.channel, 'voice-live');
    assert.equal(dispatchCalls[0].ctx.traceId, 'call-1');
    assert.equal(responses[0].response.status, 'ok');
  });

  test('a T3/T4 tool call returns awaiting_human_confirmation and dispatches NOTHING', async () => {
    const { deps, dispatchCalls, busEvents } = baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: () => 'confirm-t3' },
      },
    });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'call-2', name: 'delete_goal', args: { query: 'foo' } }],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    assert.equal(dispatchCalls.length, 0, 'a T3 call must dispatch NOTHING before human approval');
    assert.equal(responses[0].response.status, 'awaiting_human_confirmation');
    assert.ok(busEvents.some((e) => e.name === 'confirm-request'));
  });

  test('a denied tool call is reported as denied, dispatches nothing', async () => {
    const { deps, dispatchCalls } = baseDeps({
      leash: { check: () => ({ allow: false, requireConfirm: false, tier: 1, reason: 'boundary-denied' }) },
    });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls([{ id: 'call-3', name: 'gmail_send', args: {} }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(dispatchCalls.length, 0);
    assert.equal(responses[0].response.status, 'denied');
    assert.equal(responses[0].response.reason, 'boundary-denied');
  });

  test('dispatchAction throwing is caught and reported as status:error, never crashes the turn', async () => {
    const { deps } = baseDeps({ dispatchAction: async () => { throw new Error('disk full'); } });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls([{ id: 'call-4', name: 'read_status', args: {} }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(responses[0].response.status, 'error');
    assert.ok(responses[0].response.error);
  });

  test('leash.check throwing is caught and reported as a gate failure, never crashes the turn', async () => {
    const { deps } = baseDeps({ leash: { check: () => { throw new Error('leash exploded'); } } });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls([{ id: 'call-5', name: 'read_status', args: {} }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(responses[0].response.status, 'error');
    assert.match(responses[0].response.error, /gate failure/);
  });

  test('a failed dispatch reports status:failed with the real error, not a fabricated success', async () => {
    const { deps } = baseDeps({ dispatchAction: async () => ({ ok: false, result: { error: 'circuit-open' } }) });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    // WAVE 3: this must exercise the AWAITED path, so the tool has to be a fast
    // one. spotify_play moved onto the slow started/done path (it drives
    // cua-driver, 5-10s per click sequence) and now answers status:'started'
    // within the turn, with its real outcome delivered afterwards — that case is
    // covered in narration-waits-for-outcome.test.js. The assertion here is about
    // a failure that resolves inside the turn, which is unchanged.
    await adapter.handleLiveToolCalls([{ id: 'call-6', name: 'set_volume', args: { level: 20 } }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(responses[0].response.status, 'failed');
    assert.match(responses[0].response.error, /circuit-open/);
  });
});

describe('live-tool-adapter — resolveLiveConfirm', () => {
  test('resolveLiveConfirm end-to-end: T3 call -> confirm -> accept -> APPROVED text sent', async () => {
    const sent = [];
    const liveSession = { isOpen: () => true, sendText: (t) => sent.push(t) };
    let capturedConfirmId = null;
    const { deps } = baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: (summary, action, connId) => { capturedConfirmId = 'confirm-xyz'; return capturedConfirmId; } },
      },
      getLiveSession: () => liveSession,
    });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls([{ id: 'call-8', name: 'delete_goal', args: { query: 'x' } }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(responses[0].response.status, 'awaiting_human_confirmation');

    await adapter.resolveLiveConfirm(capturedConfirmId, { ok: true, result: { deleted: true } }, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /APPROVED/);
    assert.match(sent[0], /succeeded/);
  });

  test('a rejected confirm sends a DECLINED system text', async () => {
    const sent = [];
    const liveSession = { isOpen: () => true, sendText: (t) => sent.push(t) };
    let capturedConfirmId = null;
    const { deps } = baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: () => { capturedConfirmId = 'confirm-abc'; return capturedConfirmId; } },
      },
      getLiveSession: () => liveSession,
    });
    const adapter = createLiveToolAdapter(deps);
    await adapter.handleLiveToolCalls([{ id: 'call-9', name: 'delete_goal', args: {} }], { sendToolResponse: () => {} });
    await adapter.resolveLiveConfirm(capturedConfirmId, null, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /DECLINED/);
  });

  test('resolveLiveConfirm is a no-op when the live session is gone (closed mid-confirm)', async () => {
    const { deps } = baseDeps({ getLiveSession: () => null });
    const adapter = createLiveToolAdapter(deps);
    // Must not throw even with an unknown confirmId and no session.
    await assert.doesNotReject(() => adapter.resolveLiveConfirm('unknown-confirm', { ok: true }, true));
  });

  test('security fix: a resolved confirm is deleted from the pending map even when the live session is already gone (no leak)', async () => {
    let capturedConfirmId = null;
    const { deps } = baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: () => { capturedConfirmId = 'confirm-gone'; return capturedConfirmId; } },
      },
      getLiveSession: () => null, // session already closed by the time the human replies
    });
    const adapter = createLiveToolAdapter(deps);
    await adapter.handleLiveToolCalls([{ id: 'call-12', name: 'delete_goal', args: {} }], { sendToolResponse: () => {} });
    assert.equal(adapter._internal.livePendingConfirms.size, 1);
    await adapter.resolveLiveConfirm(capturedConfirmId, { ok: true }, true);
    assert.equal(adapter._internal.livePendingConfirms.size, 0, 'the entry must be removed even though there was no live session to notify');
  });

  test('security fix: connectionId falls back to \'system\' (never unscoped by accident) when none is provided', async () => {
    let capturedConnectionId = 'UNSET';
    const { deps } = baseDeps({
      connectionId: undefined,
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: (summary, action, connId) => { capturedConnectionId = connId; return 'confirm-noconn'; } },
      },
    });
    const adapter = createLiveToolAdapter(deps);
    await adapter.handleLiveToolCalls([{ id: 'call-13', name: 'delete_goal', args: {} }], { sendToolResponse: () => {} });
    assert.equal(capturedConnectionId, 'system', "a missing connectionId must fall back to 'system', matching voice-agent.js's executeAction()");
  });
});

describe('live-tool-adapter — security-review fixes', () => {
  test('an oversized args summary is truncated, never sent to the confirm modal unbounded', async () => {
    let capturedSummary = null;
    const longValue = 'x'.repeat(1000);
    const { deps } = baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: (summary) => { capturedSummary = summary; return 'confirm-long'; } },
      },
    });
    const adapter = createLiveToolAdapter(deps);
    await adapter.handleLiveToolCalls([{ id: 'call-14', name: 'delete_goal', args: { query: longValue } }], { sendToolResponse: () => {} });
    assert.ok(capturedSummary.length < longValue.length, 'the confirm summary must be capped, not pass a 1000-char arg through unbounded');
    assert.match(capturedSummary, /truncated/);
  });

  test('a raw effector error string (not a thrown Error) is still routed through the sanitizer', async () => {
    const sanitizerCalls = [];
    const { deps } = baseDeps({
      dispatchAction: async () => ({ ok: false, result: { error: '/C/Users/real-name/secret-path failed' } }),
      sanitizeErrorForClient: (err) => { sanitizerCalls.push(err.message); return 'sanitized'; },
    });
    const adapter = createLiveToolAdapter(deps);
    const responses = [];
    await adapter.handleLiveToolCalls([{ id: 'call-15', name: 'read_status', args: {} }], { sendToolResponse: (r) => responses.push(...r) });
    assert.ok(sanitizerCalls.some((m) => m.includes('secret-path')), 'the raw effector error must be passed through the sanitizer, not skipped');
    assert.equal(responses[0].response.error, 'sanitized');
  });

  test('a tool outcome that resolves AFTER turnComplete already fired is not misattributed to the next turn', async () => {
    let resolveDispatch;
    const dispatchAction = () => new Promise((resolve) => { resolveDispatch = resolve; });
    const busEvents = [];
    const { deps, memory } = baseDeps({
      dispatchAction,
      bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
    });
    const adapter = createLiveToolAdapter(deps);

    // Fire the tool call but do NOT await it yet — simulate live-session.js's
    // fire-and-forget onToolCall invocation racing ahead of the dispatch.
    const inFlight = adapter.handleLiveToolCalls(
      [{ id: 'call-16', name: 'read_status', args: {} }],
      { sendToolResponse: () => {} },
    );

    // Turn 1 completes with NO tool outcome recorded yet (still in flight).
    adapter.onLiveTurnComplete({ userText: 'turn one', assistantText: 'reply one' });
    // Turn 2 starts and also completes, before the slow dispatch resolves.
    adapter.onLiveTurnComplete({ userText: 'turn two', assistantText: 'reply two' });

    // NOW the slow dispatch resolves — after both turns already closed.
    resolveDispatch({ ok: true, result: {} });
    await inFlight;

    assert.equal(memory._writes[0].detail.actions.length, 0);
    assert.equal(memory._writes[1].detail.actions.length, 0, 'the late outcome must not silently attach itself to turn 2 either');
    assert.ok(busEvents.some((e) => e.name === 'health.anomaly' && e.payload.kind === 'live-tool-outcome-late-for-turn'));
  });
});

describe('live-tool-adapter — onLiveTurnComplete (AD-4: no fabricated success)', () => {
  test('a completed turn with a failed action appends BOTH the conversation AND a system outcome note, and the episodic record reflects ok:false', async () => {
    const { deps, history, memory } = baseDeps({ dispatchAction: async () => ({ ok: false, result: { error: 'offline' } }) });
    const adapter = createLiveToolAdapter(deps);
    await adapter.handleLiveToolCalls([{ id: 'call-10', name: 'read_status', args: {} }], { sendToolResponse: () => {} });
    adapter.onLiveTurnComplete({ userText: 'check status', assistantText: 'Checking now.' });

    assert.ok(history.some((h) => h.role === 'user' && h.content === 'check status'));
    assert.ok(history.some((h) => h.role === 'assistant' && h.content === 'Checking now.'));
    const systemNote = history.find((h) => h.role === 'system');
    assert.ok(systemNote, 'a system outcome note must be appended when an action failed');
    assert.match(systemNote.content, /FAILED/);

    assert.equal(memory._writes.length, 1);
    assert.equal(memory._writes[0].detail.actions[0].ok, false);
  });

  test('liveTurnActions is cleared after each turnComplete so a later turn does not carry stale actions', async () => {
    const { deps, memory } = baseDeps();
    const adapter = createLiveToolAdapter(deps);
    await adapter.handleLiveToolCalls([{ id: 'call-11', name: 'read_status', args: {} }], { sendToolResponse: () => {} });
    adapter.onLiveTurnComplete({ userText: 'a', assistantText: 'b' });
    adapter.onLiveTurnComplete({ userText: 'c', assistantText: 'd' }); // no actions this turn
    assert.equal(memory._writes[1].detail.actions.length, 0, 'second turn must not carry over the first turn\'s actions');
  });
});
