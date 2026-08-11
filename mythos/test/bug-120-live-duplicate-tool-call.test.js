'use strict';

// test/bug-120-live-duplicate-tool-call.test.js — BUG-120.
//
// 2026-08-05: one spoken request to switch browsers relaunched the browser
// twice. browser_switch was not in SLOW_TOOLS, so it went through the awaited
// branch — but it disconnects the attached browser, closes it, launches another
// with a debug port and re-attaches. The Live turn ended long before that
// returned, and with no toolResponse in sight Gemini re-issued the same call.
//
// Two things are pinned here. browser_switch now answers 'started' immediately,
// which removes the specific trigger. And handleLiveToolCalls now suppresses a
// repeat of a call.id it has already accepted, which closes the general hole for
// every tool: a re-dispatched world-changing action is not a cosmetic problem.
// Dedup was on the id alone here — two genuine clicks on the same button carry
// different ids, so an args-hash would eat legitimate repeated work.
//
// UPDATED — MYTHOS Installed-Build Repair Plan A3 (2026-08-12): id-only dedup
// left a hole this file's own comment predicted was safe to leave: Gemini does
// not only retry with a REUSED id, it also re-issues a call with a FRESH id
// once the original already completed in milliseconds (4x open_web in 3s,
// 13x set_persona_level in 1s — neither ever "still running" for the id guard
// below to catch). live-tool-adapter.js now layers an ADDITIVE per-turn gate
// keyed on name+JSON.stringify(args) on top of the id guard (see
// test/live-duplicate-dispatch.test.js), exempting only a small allowlist of
// idempotent reads. That gate now also covers "same tool, same args, fresh
// id" for every non-exempt tool — including browser_click, which is why the
// two tests below that pinned the OLD "an args-hash would eat legitimate
// repeated work" boundary now assert the new, tighter behavior instead. The
// id-based mechanism itself (still-running suppression, browser_switch as a
// slow tool) is unchanged and still pinned by every other test in this file.

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
      confirm: { create: () => 'confirm-120' },
    },
    dispatchAction: async (decision) => {
      dispatched.push(decision.tool);
      return opts.outcome || { ok: true, result: {} };
    },
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-120',
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

describe('BUG-120 — the same call.id must never dispatch twice', () => {
  test('a repeated call.id is answered but not re-run', async () => {
    const { adapter, dispatched } = harness();

    const first = await call(adapter, 'call-dup', 'browser_click', { selector: '#play' });
    const second = await call(adapter, 'call-dup', 'browser_click', { selector: '#play' });

    assert.equal(dispatched.length, 1, 'the action must run exactly once');
    assert.equal(second.status, 'duplicate-suppressed');
    assert.match(second.message, /NOT run a second time/i);
    assert.notEqual(first.status, 'duplicate-suppressed', 'the first call is the real one');
  });

  test('A3: a DIFFERENT id for the same tool and args is now caught by the per-turn signature gate', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, 'call-a', 'browser_click', { selector: '#play' });
    await call(adapter, 'call-b', 'browser_click', { selector: '#play' });

    // isDuplicateCall (the id guard this file pins) still lets a fresh id
    // through on its own — this dispatched-once outcome comes from the
    // ADDITIVE name+args gate layered on top of it, not from this guard.
    assert.deepEqual(dispatched, ['browser_click'],
      'the per-turn signature gate now suppresses a repeat even under a fresh id — see live-duplicate-dispatch.test.js');
  });

  test('A3: a missing id no longer bypasses dedup — the signature gate keys on name+args, not id', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, undefined, 'browser_click', { selector: '#play' });
    await call(adapter, undefined, 'browser_click', { selector: '#play' });

    assert.equal(dispatched.length, 1,
      'the id guard alone never had anything to key on here, but the signature gate does');
  });

  test('the suppressed repeat is not recorded as a second action in the turn', async () => {
    const { adapter } = harness();
    await call(adapter, 'call-dup', 'browser_click', {});
    await call(adapter, 'call-dup', 'browser_click', {});

    const entries = adapter._internal.liveTurnActions.filter((a) => a.tool === 'browser_click');
    assert.equal(entries.length, 1, 'AD-4: one dispatch, one record');
  });
});

describe('BUG-120 — browser_switch is a slow tool', () => {
  test('browser_switch answers "started" immediately instead of blocking the turn', async () => {
    const { adapter } = harness();
    const response = await call(adapter, 'call-switch', 'browser_switch', { browser: 'brave' });

    assert.equal(response.status, 'started',
      'a disconnect + close + relaunch + re-attach cannot finish inside a Live turn');
    assert.match(response.message, /do NOT claim completion/i);
  });

  test('a fast browser tool is still awaited inside the turn — no over-widening', async () => {
    const { adapter } = harness();
    const response = await call(adapter, 'call-click', 'browser_click', { selector: '#play' });

    assert.equal(response.status, 'ok');
  });
});
