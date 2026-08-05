'use strict';

// test/bug-128-live-tool-ack-deadline.test.js — BUG-128.
//
// 2026-08-06: one spoken request produced three open_web calls, and all three
// ran a SECOND time ~28s later with different call ids and different traceIds.
// Each repeat was preceded by a live-tool-outcome-late-for-turn anomaly: the
// turn completed before the toolResponse went back, so the model never saw an
// answer for the ids it had asked about and re-issued the whole batch.
// BUG-120's dedup is keyed on call.id by design and cannot see fresh ids.
//
// Pinned here: any call still unresolved at the ack deadline is answered with
// status:'started' inside the turn, and its real outcome is still delivered
// afterwards on the [SYSTEM] channel. A fast call is unaffected — one response,
// no interim.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

function harness(overrides) {
  const opts = overrides || {};
  const dispatched = [];
  const injected = [];
  const logs = [];
  const session = { isOpen: () => true, sendText: (t) => injected.push(t) };
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-128' },
    },
    dispatchAction: async (decision) => {
      dispatched.push(decision.tool);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return opts.outcome || { ok: true, result: { evidence: 'page loaded' } };
    },
    bus: { emit() {} },
    logger: { warn() {}, info(event, fields) { logs.push({ event, fields }); } },
    connectionId: 'conn-128',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
    toolAckDeadlineMs: opts.deadlineMs === undefined ? 40 : opts.deadlineMs,
  });
  return { adapter, dispatched, injected, logs };
}

function call(adapter, id, name, args) {
  const responses = [];
  return adapter
    .handleLiveToolCalls([{ id, name, args: args || {} }], { sendToolResponse: (r) => responses.push(...r) })
    .then(() => responses);
}

describe('BUG-128 — no call may reach turnComplete unanswered', () => {
  test('a dispatch slower than the ack deadline is answered "started" inside the turn', async () => {
    const { adapter, injected } = harness({ delayMs: 200, deadlineMs: 30 });
    const responses = await call(adapter, 'call-slow', 'open_web', { url: 'https://example.com' });

    assert.equal(responses.length, 1, 'exactly one functionResponse for the call id');
    assert.equal(responses[0].id, 'call-slow');
    assert.equal(responses[0].response.status, 'started');
    assert.match(responses[0].response.message, /do NOT claim completion/);

    // ...and the real outcome still arrives afterwards, so nothing is lost.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(injected.length, 1, 'the late outcome must still be delivered');
    assert.match(injected[0], /open_web finished/);
  });

  test('a fast dispatch is unaffected — one normal response, no interim ack', async () => {
    const { adapter, injected } = harness({ delayMs: 0, deadlineMs: 200 });
    const responses = await call(adapter, 'call-fast', 'web_search', { query: 'weather' });

    assert.equal(responses.length, 1);
    assert.equal(responses[0].response.status, 'ok');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(injected.length, 0, 'a call answered inside the turn needs no [SYSTEM] follow-up');
  });

  test('a dispatch that rejects after the deadline is reported as a failure, never as success', async () => {
    const { adapter, injected } = harness({ deadlineMs: 20 });
    // Reject slowly so the deadline fires first and the rejection lands late.
    const failing = createLiveToolAdapter({
      leash: {
        check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'confirm-128b' },
      },
      dispatchAction: async () => {
        await new Promise((r) => setTimeout(r, 120));
        throw new Error('navigation timed out');
      },
      bus: { emit() {} },
      logger: { warn() {}, info() {} },
      connectionId: 'conn-128b',
      memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
      historyAppend: () => {},
      reflection: null,
      summarizeActionsForResult,
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => injected.push(t) }),
      toolAckDeadlineMs: 20,
    });
    const responses = await call(failing, 'call-boom', 'open_web', { url: 'https://example.com' });
    assert.equal(responses[0].response.status, 'started');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(injected.length, 1);
    assert.match(injected[0], /FAILED/);
    void adapter;
  });

  test('every tool-call batch is logged with its ids and a content hash, so a re-issued batch is recognisable', async () => {
    const { adapter, logs } = harness({ deadlineMs: 200 });
    const responses = [];
    await adapter.handleLiveToolCalls(
      [
        { id: 'a1', name: 'open_web', args: { url: 'https://youtube.com' } },
        { id: 'a2', name: 'open_web', args: { url: 'https://worldmonitor.app' } },
      ],
      { sendToolResponse: (r) => responses.push(...r) },
    );
    const batch = logs.find((l) => l.event === 'live.tool-call-batch');
    assert.ok(batch, 'the batch must be logged');
    assert.deepEqual(batch.fields.callIds, ['a1', 'a2']);
    assert.deepEqual(batch.fields.tools, ['open_web', 'open_web']);
    assert.equal(typeof batch.fields.batchHash, 'string');

    // The same batch re-issued with FRESH ids — the case BUG-120's id dedup
    // cannot see — must hash identically, which is the whole point of logging it.
    const { adapter: second, logs: logs2 } = harness({ deadlineMs: 200 });
    await second.handleLiveToolCalls(
      [
        { id: 'b1', name: 'open_web', args: { url: 'https://youtube.com' } },
        { id: 'b2', name: 'open_web', args: { url: 'https://worldmonitor.app' } },
      ],
      { sendToolResponse: () => {} },
    );
    const batch2 = logs2.find((l) => l.event === 'live.tool-call-batch');
    assert.equal(batch2.fields.batchHash, batch.fields.batchHash);
    assert.notDeepEqual(batch2.fields.callIds, batch.fields.callIds);
  });
});
