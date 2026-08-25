'use strict';

// Pins a DELIBERATE non-change, and the evidence for it.
//
// Backlog item M3 (2026-08-19 audit): "restructure handleLiveToolCalls so dedup
// bookkeeping runs synchronously per call and dispatches fan out." Both halves
// were checked against the code and the vault before building anything.
//
// FIRST HALF — already true. isDuplicateCall and isDuplicateSignature each
// check-and-record on the same tick (`has()` then `set()`/`add()`, no await
// between), so there is no window in which two calls both pass. Nothing to fix.
// The tests below pin that property so a refactor cannot open the window.
//
// SECOND HALF — measured, and rejected. Batch sizes came out of the operator's
// own audit trail, counting GATE rows only (dispatch-action.js writes a second
// row per call with decision:'completed'; counting both makes every single call
// look like a 2-call batch — that mistake put the multi-call rate at 22%):
//
//   1,400 gate rows -> 1,337 batches, 55 multi-call (4.1%), largest 5.
//
// So ~96% of batches contain one call and cannot benefit at all. And the
// multi-call shapes that DO occur include strictly ordered chains:
//
//   ui_type + send_key                (x3)  type, THEN press the key
//   close_window + browser_navigate   (x2)
//   navigate + close_panel + navigate (x1)
//   spotify_volume + spotify_play     (x1)
//   browser_navigate + browser_tabs   (x1)
//
// Dispatching those concurrently races a keystroke against the typing it is
// meant to follow — the exact failure class this repo already has scar tissue
// for (BUG-219, and "keystrokes follow the caret"). The sequential await is not
// an oversight; it is what makes an ordered batch work. Trading that for a few
// tens of milliseconds on 4% of batches is a bad deal, so it was not built.
//
// What these tests lock in is the ORDERING GUARANTEE, so that a future
// Promise.all() refactor fails here instead of silently racing in production.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

function harness(opts) {
  opts = opts || {};
  const events = [];          // interleaved start/end markers, in real time
  const session = { isOpen: () => true, sendText() {} };
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-m3' },
    },
    dispatchAction: async (decision) => {
      events.push('start:' + decision.tool);
      const delay = (opts.delays && opts.delays[decision.tool]) || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      events.push('end:' + decision.tool);
      return { ok: true, result: { evidence: decision.tool + ' done' } };
    },
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-m3',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
    // Generous, so nothing in these tests trips the ack deadline and turns into
    // a deliberately-not-awaited 'started' response — that path is BUG-128's and
    // is tested separately.
    toolAckDeadlineMs: 5000,
  });
  return { adapter, events };
}

function runBatch(adapter, calls) {
  const responses = [];
  return adapter
    .handleLiveToolCalls(calls, { sendToolResponse: (r) => responses.push(...r) })
    .then(() => responses);
}

describe('M3 — a Live tool batch dispatches strictly in order', () => {
  test('the second tool does not start until the first has finished', async () => {
    // ui_type + send_key is a real observed batch. If these overlap, the key
    // press races the typing and lands in whatever state the app is in.
    const { adapter, events } = harness({ delays: { ui_type: 60 } });

    await runBatch(adapter, [
      { id: 'c1', name: 'ui_type', args: { text: 'hello' } },
      { id: 'c2', name: 'send_key', args: { key: 'enter' } },
    ]);

    assert.deepEqual(events, ['start:ui_type', 'end:ui_type', 'start:send_key', 'end:send_key'],
      'dispatches must not interleave — send_key starting before ui_type ends is the race');
  });

  test('ordering holds for a longer chain, and the slow call does not reorder it', async () => {
    // navigate + close_panel + navigate, with the middle call slowest: under
    // Promise.all the two navigates would finish before close_panel and the
    // panel would close over the wrong view.
    const { adapter, events } = harness({ delays: { close_panel: 80, navigate: 10 } });

    await runBatch(adapter, [
      { id: 'd1', name: 'navigate', args: { panel: 'goals' } },
      { id: 'd2', name: 'close_panel', args: {} },
      { id: 'd3', name: 'navigate', args: { panel: 'kanban' } },
    ]);

    assert.deepEqual(events, [
      'start:navigate', 'end:navigate',
      'start:close_panel', 'end:close_panel',
      'start:navigate', 'end:navigate',
    ], 'a slow middle call must still complete before the call after it starts');
  });

  test('the guarantee is per batch — two batches in flight DO interleave', async () => {
    // Two things at once. It proves the assertions above are not vacuous: the
    // events array demonstrably records interleaving when interleaving happens,
    // so a fan-out refactor would show up there rather than passing silently.
    //
    // And it states the real limit honestly. handleLiveToolCalls is async and
    // live-session.js's onToolCall is fire-and-forget, so a second batch
    // arriving while the first is still awaiting runs concurrently with it.
    // Ordering is guaranteed WITHIN a batch, never across batches. Anything
    // relying on cross-batch order is already relying on luck, and no change
    // here is what would give it away.
    const { adapter, events } = harness({ delays: { ui_type: 80, send_key: 80 } });

    await Promise.all([
      runBatch(adapter, [{ id: 'i1', name: 'ui_type', args: { text: 'one' } }]),
      runBatch(adapter, [{ id: 'i2', name: 'send_key', args: { key: 'tab' } }]),
    ]);

    assert.deepEqual(events, ['start:ui_type', 'start:send_key', 'end:ui_type', 'end:send_key'],
      'separate batches overlap — which is exactly the shape the in-batch tests forbid');
  });

  test('responses come back in the order the model asked for them', async () => {
    // Not cosmetic: the model pairs responses to calls by id, but a reordered
    // array is the first visible symptom of a fan-out refactor, and it is free
    // to check here.
    const { adapter } = harness({ delays: { read_status: 70, list_goals: 5 } });

    const responses = await runBatch(adapter, [
      { id: 'e1', name: 'read_status', args: {} },
      { id: 'e2', name: 'list_goals', args: {} },
    ]);

    assert.deepEqual(responses.map((r) => r.id), ['e1', 'e2']);
    assert.deepEqual(responses.map((r) => r.name), ['read_status', 'list_goals']);
  });
});

describe('M3 — dedup bookkeeping is already atomic, and must stay that way', () => {
  test('a repeated call id in the same batch is suppressed and never dispatched', async () => {
    const { adapter, events } = harness({ delays: { write_file: 50 } });

    const responses = await runBatch(adapter, [
      { id: 'same-id', name: 'write_file', args: { path: 'a.txt', content: 'x' } },
      { id: 'same-id', name: 'write_file', args: { path: 'a.txt', content: 'x' } },
    ]);

    assert.equal(events.filter((e) => e === 'start:write_file').length, 1,
      'the repeat must not reach dispatchAction — this is a world-changing tool');
    assert.equal(responses.length, 2, 'the model still gets an answer for BOTH ids');
    assert.equal(responses[1].response.status, 'duplicate-suppressed');
  });

  test('the same {name,args} under a different id is suppressed within the turn', async () => {
    // BUG-120 follow-up: Gemini re-issues a batch under FRESH ids, which the
    // id-keyed guard above cannot see. write_file is neither an idempotent read
    // nor a repeatable click, so the signature guard owns it.
    const { adapter, events } = harness({ delays: { write_file: 50 } });

    const responses = await runBatch(adapter, [
      { id: 'f1', name: 'write_file', args: { path: 'b.txt', content: 'y' } },
      { id: 'f2', name: 'write_file', args: { path: 'b.txt', content: 'y' } },
    ]);

    assert.equal(events.filter((e) => e === 'start:write_file').length, 1,
      'identical args under a fresh id must not run a second time');
    assert.equal(responses[1].response.status, 'duplicate-suppressed');
  });

  test('suppression happens before the first dispatch resolves, not after it', async () => {
    // The property that makes fan-out tempting and dedup fragile: the guard must
    // record on the SAME tick it checks. write_file, not launch_app: launch_app
    // is in SLOW_TOOLS and is deliberately never awaited, so it could not show
    // the in-flight window this test is about.
    // record the call on the SAME tick it checks it. If recording moved to after
    // the await, two identical calls in one batch would both pass the check and
    // both run. The slow dispatch here is what would open that window.
    const { adapter, events } = harness({ delays: { write_file: 120 } });

    const started = runBatch(adapter, [
      { id: 'g1', name: 'write_file', args: { path: 'c.txt', content: 'z' } },
      { id: 'g2', name: 'write_file', args: { path: 'c.txt', content: 'z' } },
      { id: 'g3', name: 'write_file', args: { path: 'c.txt', content: 'z' } },
    ]);
    // Sample while the first dispatch is still in flight.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(events.filter((e) => e === 'start:write_file').length, 1,
      'only one write may be in flight; the other two were already suppressed');

    const responses = await started;
    assert.equal(events.filter((e) => e === 'start:write_file').length, 1,
      'and no further write may start once the first one finishes');
    assert.deepEqual(responses.map((r) => r.response.status),
      ['ok', 'duplicate-suppressed', 'duplicate-suppressed']);
  });

  test('two independent reads in one batch are both dispatched', () => {
    // The guard must not be so eager that it eats a legitimate batch.
    // read_status + list_goals is the single most common real multi-call shape
    // in the vault (11 occurrences).
    const { adapter, events } = harness({});
    return runBatch(adapter, [
      { id: 'h1', name: 'read_status', args: {} },
      { id: 'h2', name: 'list_goals', args: {} },
    ]).then((responses) => {
      assert.deepEqual(events, ['start:read_status', 'end:read_status', 'start:list_goals', 'end:list_goals']);
      assert.deepEqual(responses.map((r) => r.response.status), ['ok', 'ok']);
    });
  });
});
