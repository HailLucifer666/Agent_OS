'use strict';

// test/bug-435-one-browser-route-per-turn.test.js — BUG-435.
//
// Audit 2026-09-10 09:37Z: one spoken "open YouTube on Brave" ran
// open_web({browser:true,url:"https://www.youtube.com",browserName:"brave"}) and
// then browser_launch_debug({browser:"brave"}) in the same turn — two Brave
// windows, one signed in and one not. The operator asked why there were two.
//
// The adapter-level tests drive the REAL handleLiveToolCalls with the real
// per-turn signature store, exactly as Gemini's two separate toolCall frames
// did (two invocations, no turnComplete between them). The fixture is the wire:
// the call args are the audited ones.
//
// MUTATION RUN 2026-09-10, before trusting this file. Deleting the guard line in
// live-tool-adapter.js fails (a) with "dispatched: open_web,browser_launch_debug
// — the second browser opened" and (b) symmetrically; (c)-(f) pass either way
// and are the bounds: same route twice allowed, a HUD card is not a route, a new
// turn clears the memory, and each route alone is allowed (the undecided
// product question stays undecided — see the module header).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { checkBrowserRoute, browserRouteOf, parseSignature } = require('../src/core/voice/browser-route-guard');

function harness() {
  const dispatched = [];
  const logs = [];
  const session = { isOpen: () => true, sendText: () => {} };
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-435' },
    },
    dispatchAction: async (decision) => {
      dispatched.push(decision.tool);
      return { ok: true, result: { handedToBrowser: true } };
    },
    bus: { emit() {} },
    logger: { warn() {}, info(event, f) { logs.push({ event, f }); } },
    connectionId: 'conn-435',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
  });
  return { adapter, dispatched, logs };
}

function call(adapter, id, name, args) {
  const responses = [];
  return adapter
    .handleLiveToolCalls([{ id, name, args: args || {} }], { sendToolResponse: (r) => responses.push(...r) })
    .then(() => responses[0] && responses[0].response);
}

// The audited arguments, verbatim.
const OPEN_WEB_BRAVE = { browser: true, type: 'web', url: 'https://www.youtube.com', browserName: 'brave' };
const LAUNCH_DEBUG_BRAVE = { browser: 'brave' };

describe('BUG-435 — one real-browser route per turn (adapter)', () => {
  test('(a) the 09:37 shape: open_web browser:true then browser_launch_debug — the second is refused, not run', async () => {
    const { adapter, dispatched, logs } = harness();
    const first = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    assert.equal(first.status, 'ok');
    const second = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.deepEqual(dispatched, ['open_web'], `dispatched: ${dispatched.join(',')} — the second browser opened`);
    assert.equal(second.status, 'refused');
    assert.equal(second.reason, 'browser-route-conflict');
    assert.match(second.message, /already handed https:\/\/www\.youtube\.com to the operator's normal brave browser/);
    assert.match(second.message, /Do NOT also launch the debug browser/);
    assert.ok(logs.some((l) => l.event === 'live.browser-route-conflict' && l.f.priorTool === 'open_web'),
      'the refusal must leave a log line naming the prior route');
  });

  test('(b) the reverse order is refused too: debug launch, then open_web browser:true', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    const second = await call(adapter, 'fc_2', 'open_web', OPEN_WEB_BRAVE);
    assert.deepEqual(dispatched, ['browser_launch_debug']);
    assert.equal(second.status, 'refused');
    assert.match(second.message, /Use browser_navigate in the debug browser you already have/);
  });

  test('(b2) derived, not listed: open_web browser:true then browser_navigate is the same two-windows outcome', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    const second = await call(adapter, 'fc_2', 'browser_navigate', { url: 'https://www.youtube.com' });
    assert.deepEqual(dispatched, ['open_web']);
    assert.equal(second.status, 'refused');
  });

  test('(c) bound: the same route twice is allowed — two pages in the operator\'s browser', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    const second = await call(adapter, 'fc_2', 'open_web', { ...OPEN_WEB_BRAVE, url: 'https://news.ycombinator.com' });
    assert.equal(second.status, 'ok');
    assert.deepEqual(dispatched, ['open_web', 'open_web']);
  });

  test('(d) bound: an open_web HUD card (no browser:true) is not a browser route', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', { type: 'weather', location: 'Kolkata' });
    const second = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.equal(second.status, 'ok');
    assert.deepEqual(dispatched, ['open_web', 'browser_launch_debug']);
  });

  test('(e) bound: a new turn clears the memory — the operator may ask for the other browser next', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    adapter.onLiveTurnComplete({ userText: 'open it in the debug browser', assistantText: 'done', turnId: 1 });
    const next = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.equal(next.status, 'ok');
    assert.deepEqual(dispatched, ['open_web', 'browser_launch_debug']);
  });

  test('(f) disposition pinned: each route ALONE is allowed — which one a named-browser request means is not decided here', async () => {
    for (const [name, args] of [['open_web', OPEN_WEB_BRAVE], ['browser_launch_debug', LAUNCH_DEBUG_BRAVE]]) {
      const { adapter, dispatched } = harness();
      const r = await call(adapter, 'fc_1', name, args);
      assert.equal(r.status, 'ok', `${name} alone must not be refused`);
      assert.deepEqual(dispatched, [name]);
    }
  });
});

describe('browser-route-guard — the pure decision', () => {
  test('routes are derived from the reason: a page in a real window', () => {
    assert.equal(browserRouteOf('open_web', { browser: true, url: 'x' }), 'operator-browser');
    assert.equal(browserRouteOf('open_web', { type: 'web', url: 'x' }), null);
    assert.equal(browserRouteOf('open_web', { browser: 'true' }), null, 'a string "true" is not the boolean the tool reads');
    assert.equal(browserRouteOf('browser_launch_debug', {}), 'debug-browser');
    assert.equal(browserRouteOf('browser_switch', { browser: 'chrome' }), 'debug-browser');
    assert.equal(browserRouteOf('browser_navigate', { url: 'x' }), 'debug-browser');
    assert.equal(browserRouteOf('launch_app', { name: 'brave' }), null);
  });

  test('parseSignature reads the adapter\'s own format and skips what it cannot read', () => {
    assert.deepEqual(parseSignature('open_web:{"browser":true}'), { name: 'open_web', args: { browser: true } });
    assert.equal(parseSignature('open_web:not-json'), null);
    assert.equal(parseSignature(':{}'), null);
    assert.equal(parseSignature(''), null);
    assert.equal(parseSignature(undefined), null);
  });

  test('checkBrowserRoute: conflict only across routes, never within one, and never from a non-route or unreadable entry', () => {
    const store = new Set(['open_web:{"browser":true,"url":"https://a"}', 'garbage', 'launch_app:{"name":"x"}']);
    assert.equal(checkBrowserRoute('open_web', { browser: true, url: 'https://b' }, store), null);
    assert.equal(checkBrowserRoute('screen_look', {}, store), null);
    const refusal = checkBrowserRoute('browser_launch_debug', { browser: 'brave' }, store);
    assert.equal(refusal.priorTool, 'open_web');
    assert.equal(refusal.response.status, 'refused');
    assert.equal(checkBrowserRoute('browser_launch_debug', {}, new Set()), null);
    assert.equal(checkBrowserRoute('browser_launch_debug', {}, undefined), null);
  });
});
