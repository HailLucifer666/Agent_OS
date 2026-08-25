'use strict';
// late-outcome-system-channel.test.js — G3's remaining half.
//
// A tool outcome that lands after its turn closed was correctly dropped from
// the audit (it must not be misattributed to whatever turn is running now),
// but it was dropped from the MODEL too. The functionResponse still goes out
// addressed to the closed turn — a channel with no addressee — so the model
// never learned what happened. The BUG-128 root-cause note blames exactly that
// condition for the model reissuing the same batch under fresh call ids.
//
// The fix routes the late outcome through the same [SYSTEM]-prefixed sendText
// channel reportLateOutcome already uses for SLOW_TOOLS, which is the only
// path that reaches a model whose turn has ended.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// Builds an adapter whose dispatch closes the turn WHILE the tool is in
// flight — the real race, not a simulation of its symptom. dispatchAction
// awaits a tick, calls onLiveTurnComplete (advancing turnGeneration), and only
// then resolves, so commitAction runs with a stale generation snapshot.
function makeAdapter({ outcome, closeTurnDuringDispatch = true }) {
  const sentText = [];
  const emitted = [];
  const liveSession = {
    isOpen: () => true,
    sendText: (t) => sentText.push(t),
  };
  const adapter = createLiveToolAdapter({
    leash: { check: () => ({ allow: true }), confirm: { create: () => 'c1', reject: () => {} } },
    dispatchAction: async () => {
      if (closeTurnDuringDispatch) {
        await Promise.resolve();
        adapter.onLiveTurnComplete({ userText: 'list windows', assistantText: 'Looking.', turnId: 1 });
      }
      return outcome;
    },
    bus: { emit: (name, payload) => emitted.push({ name, payload }) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    connectionId: 'conn-1',
    memory: { working: { tick: 0 }, episodic: { write: () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult: () => null,
    getLiveSession: () => liveSession,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
    goals: null,
  });
  return { adapter, sentText, emitted, liveSession };
}

const SYSTEM_PREFIXED = (t) => /^\[SYSTEM/i.test(t) || /SYSTEM/.test(t.slice(0, 30));

test('a late successful outcome reaches the model on the [SYSTEM] text channel', async () => {
  const { adapter, sentText } = makeAdapter({ outcome: { ok: true, result: { windows: ['Chrome'] } } });
  await adapter.handleLiveToolCalls(
    [{ id: 'call-1', name: 'list_windows', args: {} }],
    { sendToolResponse: () => {} },
  );
  const notices = sentText.filter(SYSTEM_PREFIXED);
  assert.equal(notices.length, 1, 'the late outcome must be announced, not silently dropped');
  assert.match(notices[0], /list_windows/);
});

test('the late outcome is still kept OUT of the closed turn\'s audit', async () => {
  const { adapter, sentText } = makeAdapter({ outcome: { ok: true, result: { windows: [] } } });
  await adapter.handleLiveToolCalls(
    [{ id: 'call-1', name: 'list_windows', args: {} }],
    { sendToolResponse: () => {} },
  );
  // onLiveTurnComplete spliced the array when it fired mid-dispatch; a late
  // entry must not have been appended after that point.
  assert.equal(adapter._internal.liveTurnActions.length, 0);
  assert.equal(sentText.filter(SYSTEM_PREFIXED).length, 1, 'announced but unaudited — both halves matter');
});

test('the late-for-turn anomaly still fires', async () => {
  const { adapter, emitted } = makeAdapter({ outcome: { ok: true, result: {} } });
  await adapter.handleLiveToolCalls(
    [{ id: 'call-1', name: 'list_windows', args: {} }],
    { sendToolResponse: () => {} },
  );
  const late = emitted.filter((e) => e.name === 'health.anomaly'
    && e.payload.kind === 'live-tool-outcome-late-for-turn');
  assert.equal(late.length, 1);
  assert.equal(late[0].payload.target, 'list_windows', 'BUG-105: target, not just tool');
});

test('a late FAILURE carries the do-not-claim-success prohibition', async () => {
  const { adapter, sentText } = makeAdapter({ outcome: { ok: false, result: { error: 'no such window' } } });
  await adapter.handleLiveToolCalls(
    [{ id: 'call-1', name: 'list_windows', args: {} }],
    { sendToolResponse: () => {} },
  );
  const notices = sentText.filter(SYSTEM_PREFIXED);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /did NOT succeed/i);
});

test('a turn that closes normally is unaffected — no [SYSTEM] notice, outcome audited', async () => {
  const { adapter, sentText } = makeAdapter({
    outcome: { ok: true, result: { windows: ['Chrome'] } },
    closeTurnDuringDispatch: false,
  });
  await adapter.handleLiveToolCalls(
    [{ id: 'call-1', name: 'list_windows', args: {} }],
    { sendToolResponse: () => {} },
  );
  assert.equal(sentText.filter(SYSTEM_PREFIXED).length, 0, 'an on-time outcome needs no out-of-band notice');
  assert.equal(adapter._internal.liveTurnActions.length, 1);
  assert.equal(adapter._internal.liveTurnActions[0].tool, 'list_windows');
});
