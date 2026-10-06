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
// idempotent reads. That gate covers "same tool, same args, fresh id" for
// every non-exempt tool. The id-based mechanism itself (still-running
// suppression, browser_switch as a slow tool) is unchanged and still pinned by
// every other test in this file.
//
// UPDATED AGAIN — operator decision, 2026-08-12: click tools (browser_click,
// ui_click, click_at, see_and_click, cua_click) are exempt from the signature
// gate, which restores exactly the boundary line 16 above originally described
// ("two genuine clicks on the same button carry different ids, so an args-hash
// would eat legitimate repeated work") — A3 had overridden it, and the cost was
// real: double-click and same-button list paging lost their second half. So the
// signature-gate tests below use open_web, not browser_click. Clicks are still
// covered by the id guard, which is the point of keeping a browser_click case
// in the reused-id tests: a retry of the SAME id is still a retry, click or not.

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
    connectionId: 'conn-120', toolResultHoldMaxMs: 0, // BUG-457 R2 (2026-10-06): a SLOW_TOOLS call is now HELD when it fits the hold window; 0 selects the instant-ack late path this test pins
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

    await call(adapter, 'call-a', 'open_web', { url: 'https://example.com' });
    await call(adapter, 'call-b', 'open_web', { url: 'https://example.com' });

    // isDuplicateCall (the id guard this file pins) still lets a fresh id
    // through on its own — this dispatched-once outcome comes from the
    // ADDITIVE name+args gate layered on top of it, not from this guard.
    assert.deepEqual(dispatched, ['open_web'],
      'the per-turn signature gate now suppresses a repeat even under a fresh id — see live-duplicate-dispatch.test.js');
  });

  test('A3: a missing id no longer bypasses dedup — the signature gate keys on name+args, not id', async () => {
    const { adapter, dispatched } = harness();

    await call(adapter, undefined, 'open_web', { url: 'https://example.com' });
    await call(adapter, undefined, 'open_web', { url: 'https://example.com' });

    assert.equal(dispatched.length, 1,
      'the id guard alone never had anything to key on here, but the signature gate does');
  });

  test('a click with a fresh id runs again — the carve-out, and the id guard is all clicks have left', async () => {
    const { adapter, dispatched } = harness();

    // Fresh ids: both run (this is the operator-approved carve-out).
    await call(adapter, 'call-click-a', 'browser_click', { selector: '#next' });
    await call(adapter, 'call-click-b', 'browser_click', { selector: '#next' });
    assert.equal(dispatched.length, 2, 'a genuine second click on the same button must land');

    // Same id: still suppressed. Exempting clicks from the SIGNATURE gate must
    // not have exempted them from the id guard — a retry is still a retry.
    const retry = await call(adapter, 'call-click-b', 'browser_click', { selector: '#next' });
    assert.equal(dispatched.length, 2, 'a reused id is a retry, not a third click');
    assert.equal(retry.status, 'duplicate-suppressed');
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
