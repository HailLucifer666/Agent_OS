'use strict';

// test/live-duplicate-dispatch.test.js — MYTHOS Installed-Build Repair Plan
// Task A3.
//
// BUG-120's isDuplicateCall (live-tool-adapter.js) only suppresses a repeat of
// the SAME call.id, and only while that id is still tracked — it says nothing
// about two calls that carry DIFFERENT ids but identical {name, args}. That is
// exactly what the live session produced on 2026-08-12: four open_web calls in
// three seconds (01:43:49-52, which tripped the circuit breaker) and thirteen
// set_persona_level calls in one second (02:18:47). Every one of those
// duplicates completed in milliseconds — there was no "still running" window
// for the id-based guard to catch, because each repeat carried a fresh id and,
// by the time it arrived, the earlier call had already resolved.
//
// Pinned here: a second, additive gate keyed on name+JSON.stringify(args),
// scoped to the CURRENT turn (cleared when turnGeneration advances on
// onLiveTurnComplete) so a legitimate "do it again" request next turn is never
// blocked. Idempotent reads (list_windows, read_status) are exempt — repeating
// a read is harmless, repeating open_web or a persona write is not.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

function harness(overrides) {
  const opts = overrides || {};
  const dispatched = [];
  const session = { isOpen: () => true, sendText: () => {} };
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-a3' },
    },
    dispatchAction: async (decision) => {
      dispatched.push(decision.tool);
      return opts.outcome || { ok: true, result: {} };
    },
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-a3',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
  });
  return { adapter, dispatched };
}

function call(adapter, id, name, args) {
  const responses = [];
  return adapter
    .handleLiveToolCalls([{ id, name, args: args || {} }], { sendToolResponse: (r) => responses.push(...r) })
    .then(() => responses[0] && responses[0].response);
}

describe('A3 — a repeated {name, args} is suppressed within a turn even after the first call resolved', () => {
  test('the same open_web call under a fresh id is suppressed once the first has already finished', async () => {
    const { adapter, dispatched } = harness();

    const first = await call(adapter, 'call-1', 'open_web', { url: 'https://example.com' });
    // The first call is fully resolved by this point (awaited above) — this is
    // the exact shape BUG-120's id guard cannot catch.
    const second = await call(adapter, 'call-2', 'open_web', { url: 'https://example.com' });

    assert.equal(dispatched.length, 1, 'open_web must run exactly once');
    assert.notEqual(first.status, 'duplicate-suppressed', 'the first call is the real one');
    assert.equal(second.status, 'duplicate-suppressed');
    assert.match(second.message, /NOT run/i);
  });

  test('thirteen set_persona_level calls with identical args in one turn dispatch exactly once', async () => {
    const { adapter, dispatched } = harness();

    for (let i = 0; i < 13; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await call(adapter, `call-persona-${i}`, 'set_persona_level', { level: 'flirty' });
    }

    assert.equal(dispatched.length, 1, 'thirteen repeats of the same signature must not re-dispatch');
  });

  test('different args for the same tool are never treated as duplicates', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, 'call-a', 'open_web', { url: 'https://example.com' });
    await call(adapter, 'call-b', 'open_web', { url: 'https://example.org' });

    assert.equal(dispatched.length, 2, 'distinct args are distinct calls, not repeats');
  });

  test('idempotent reads (list_windows, read_status) are exempt from the signature gate', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, 'call-r1', 'list_windows', {});
    const second = await call(adapter, 'call-r2', 'list_windows', {});
    await call(adapter, 'call-r3', 'read_status', {});
    await call(adapter, 'call-r4', 'read_status', {});

    assert.equal(dispatched.length, 4, 'repeating a read is harmless and must always run');
    assert.notEqual(second.status, 'duplicate-suppressed');
  });

  test('click tools are exempt — a repeated click at identical coords is a real workflow, not a duplicate', async () => {
    const { adapter, dispatched } = harness();

    // Double-click, and paging a list by hitting the same "next" button twice.
    await call(adapter, 'call-c1', 'click_at', { x: 400, y: 300 });
    const second = await call(adapter, 'call-c2', 'click_at', { x: 400, y: 300 });
    await call(adapter, 'call-c3', 'ui_click', { pid: 1234, elementPath: ['Next'] });
    await call(adapter, 'call-c4', 'ui_click', { pid: 1234, elementPath: ['Next'] });
    await call(adapter, 'call-c5', 'browser_click', { selector: '#next' });
    await call(adapter, 'call-c6', 'browser_click', { selector: '#next' });

    assert.equal(dispatched.length, 6, 'every click must run — suppressing the second breaks paging and double-click');
    assert.notEqual(second.status, 'duplicate-suppressed');
  });

  test('the carve-out is clicks only — typing the same text twice is still suppressed', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, 'call-t1', 'ui_type', { pid: 1234, text: 'hello' });
    const second = await call(adapter, 'call-t2', 'ui_type', { pid: 1234, text: 'hello' });

    assert.equal(dispatched.length, 1, 'duplicate typing has a real failure mode a click does not');
    assert.equal(second.status, 'duplicate-suppressed');
  });

  test('the signature set clears on the next turn — a repeat request later is legitimate', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, 'call-1', 'open_web', { url: 'https://example.com' });
    const suppressed = await call(adapter, 'call-2', 'open_web', { url: 'https://example.com' });
    assert.equal(suppressed.status, 'duplicate-suppressed');

    // Turn ends — turnGeneration advances, and with it the per-turn signature set.
    adapter.onLiveTurnComplete({ userText: 'open it again', assistantText: 'done', turnId: 1 });

    const nextTurn = await call(adapter, 'call-3', 'open_web', { url: 'https://example.com' });
    assert.equal(dispatched.length, 2, 'a genuine repeat request on a later turn must run');
    assert.notEqual(nextTurn.status, 'duplicate-suppressed');
  });

  test('the suppressed repeat is not recorded as a second action in the turn (AD-4)', async () => {
    const { adapter } = harness();
    await call(adapter, 'call-1', 'set_persona_level', { level: 'shy' });
    await call(adapter, 'call-2', 'set_persona_level', { level: 'shy' });

    const entries = adapter._internal.liveTurnActions.filter((a) => a.tool === 'set_persona_level');
    assert.equal(entries.length, 1, 'one dispatch, one record');
  });
});
