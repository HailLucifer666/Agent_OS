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

// FOLLOW-UP 2026-09-10, two changes in one file: the operator decided that a
// NAMED browser means the debug browser, and the store this guard reads was
// wrong. It read the adapter's executedSignatures, which isDuplicateSignature
// fills for every non-duplicate call BEFORE the leash and before any dispatch —
// so a denied or refused open_web still told the next browser_launch_debug that
// a browser had "already opened". Tests (h) and (i) are that defect; the store
// is now a route memory with one writer, at the single pre-dispatch call site.
//
// MUTATION RUN 2026-09-10, each verified applied by grep and restored
// sha256-identical:
//   `if (true) return null` in namedOperatorBrowser  -> 3 red
//   stop consulting namedOperatorBrowser at all      -> the same 3 red
//   note() moved back to the seen-site               -> (h) and (i) red
//   drop routeMemory.clear() at turnComplete         -> (e) red
//   remember the LAST route-taking call, not the first -> the memory test red
// That last mutation SURVIVED its first run: "first wins" is a choice rather
// than a correctness property (both pages really did open), so nothing observed
// it until the memory test was made to assert which url the refusal quotes.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { checkBrowserRoute, browserRouteOf, parseSignature, createRouteMemory } = require('../src/core/voice/browser-route-guard');

// `deny` lets a test refuse ONE tool at the leash, which is the only way to
// reach the state the route memory used to get wrong: a call seen, recorded and
// never dispatched.
function harness({ deny = null } = {}) {
  const dispatched = [];
  const logs = [];
  const session = { isOpen: () => true, sendText: () => {} };
  const adapter = createLiveToolAdapter({
    leash: {
      check: (decision) => (deny && decision.tool === deny
        ? { allow: false, requireConfirm: false, tier: 2, reason: 'boundaries-deny' }
        : { allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
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

// The audited arguments, verbatim. Since the operator decided that a NAMED
// browser means the debug browser (2026-09-10), this exact call is refused on its
// own — so the cross-route tests below use the UNNAMED operator-route call, which
// is the one that still legitimately reaches the signed-in browser.
const OPEN_WEB_BRAVE = { browser: true, type: 'web', url: 'https://www.youtube.com', browserName: 'brave' };
const OPEN_WEB_DEFAULT = { browser: true, type: 'web', url: 'https://www.youtube.com' };
const LAUNCH_DEBUG_BRAVE = { browser: 'brave' };

describe('BUG-435 — one real-browser route per turn (adapter)', () => {
  test('(a) the 09:37 shape: open_web browser:true then browser_launch_debug — the second is refused, not run', async () => {
    const { adapter, dispatched, logs } = harness();
    const first = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_DEFAULT);
    assert.equal(first.status, 'ok');
    const second = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.deepEqual(dispatched, ['open_web'], `dispatched: ${dispatched.join(',')} — the second browser opened`);
    assert.equal(second.status, 'refused');
    assert.equal(second.reason, 'browser-route-conflict');
    assert.match(second.message, /already handed https:\/\/www\.youtube\.com to the operator's normal browser/);
    assert.match(second.message, /Do NOT also launch the debug browser/);
    assert.ok(logs.some((l) => l.event === 'live.browser-route-conflict' && l.f.priorTool === 'open_web'),
      'the refusal must leave a log line naming the prior route');
  });

  test('(b) the reverse order is refused too: debug launch, then open_web browser:true', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    const second = await call(adapter, 'fc_2', 'open_web', OPEN_WEB_DEFAULT);
    assert.deepEqual(dispatched, ['browser_launch_debug']);
    assert.equal(second.status, 'refused');
    assert.match(second.message, /Use browser_navigate in the debug browser you already have/);
  });

  test('(b2) derived, not listed: open_web browser:true then browser_navigate is the same two-windows outcome', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_DEFAULT);
    const second = await call(adapter, 'fc_2', 'browser_navigate', { url: 'https://www.youtube.com' });
    assert.deepEqual(dispatched, ['open_web']);
    assert.equal(second.status, 'refused');
  });

  test('(c) bound: the same route twice is allowed — two pages in the operator\'s browser', async () => {
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_DEFAULT);
    const second = await call(adapter, 'fc_2', 'open_web', { ...OPEN_WEB_DEFAULT, url: 'https://news.ycombinator.com' });
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
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_DEFAULT);
    adapter.onLiveTurnComplete({ userText: 'open it in the debug browser', assistantText: 'done', turnId: 1 });
    const next = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.equal(next.status, 'ok');
    assert.deepEqual(dispatched, ['open_web', 'browser_launch_debug']);
  });

  test('(f) each route ALONE is still allowed, as long as the operator-route call names no browser', async () => {
    for (const [name, args] of [['open_web', OPEN_WEB_DEFAULT], ['browser_launch_debug', LAUNCH_DEBUG_BRAVE]]) {
      const { adapter, dispatched } = harness();
      const r = await call(adapter, 'fc_1', name, args);
      assert.equal(r.status, 'ok', name + ' alone must not be refused');
      assert.deepEqual(dispatched, [name]);
    }
  });

  test('(g) THE DECISION: open_web browser:true with a browserName is refused, and answered with the two calls that do it properly', async () => {
    // Operator decision 2026-09-10: "open YouTube on Brave" means the browser
    // MYTHOS controls. This is the audited 09:37 call verbatim, and it is now
    // refused BEFORE dispatch rather than handing the URL to a signed-in window
    // and then refusing the debug launch that followed it.
    const { adapter, dispatched, logs } = harness();
    const r = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'named-browser-is-the-debug-route');
    assert.deepEqual(dispatched, [], 'nothing may reach a real browser');
    // Structured, not prose: a tool taught in a sentence is the debt the remedy
    // ratchet exists to stop growing, and remedy() validates the tool name against
    // TIER_TABLE so a rename cannot leave the model a call that does not exist.
    assert.equal(r.remedy.tool, 'browser_launch_debug');
    assert.deepEqual(r.remedy.args, { browser: 'brave' });
    assert.equal(r.then.tool, 'browser_navigate');
    assert.deepEqual(r.then.args, { url: 'https://www.youtube.com' });
    assert.ok(r.remedy.why && r.then.why, 'a remedy has to say why');
    assert.ok(logs.some((l) => l.event === 'live.browser-route-conflict'),
      'the refusal is logged like the other one');
  });

  test('(h) and the debug launch it asks for is then allowed — the refusal must not have taken the route', async () => {
    // The whole point of refusing early. Under the first version of this guard the
    // refused call had already been recorded as having taken the operator route,
    // so the model's next call was refused too and it could do nothing at all.
    const { adapter, dispatched } = harness();
    await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    const second = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.equal(second.status, 'ok', second.message);
    const third = await call(adapter, 'fc_3', 'browser_navigate', { url: 'https://www.youtube.com' });
    assert.equal(third.status, 'ok');
    assert.deepEqual(dispatched, ['browser_launch_debug', 'browser_navigate']);
  });

  test('(i) a route the leash DENIED was never taken, so the other route stays open', async () => {
    // The proxy defect this branch fixes. isDuplicateSignature records every
    // non-duplicate call it sees, before the leash and before dispatch, so a
    // denied open_web used to poison the turn and the following debug launch was
    // told a browser "already opened" when nothing had.
    const { adapter, dispatched } = harness({ deny: 'open_web' });
    const first = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_DEFAULT);
    assert.equal(first.status, 'denied');
    const second = await call(adapter, 'fc_2', 'browser_launch_debug', LAUNCH_DEBUG_BRAVE);
    assert.equal(second.status, 'ok', second.message);
    assert.deepEqual(dispatched, ['browser_launch_debug']);
  });

  test('(j) unnamed open_web browser:true still reaches the operator\'s default browser (Stage 1 golden path)', async () => {
    // The adjacent case that must keep passing. Plans/RESUME.md drives spoken
    // YouTube control in the operator's already-signed-in browser, and "open this
    // in my browser" with no name is exactly that request.
    const { adapter, dispatched } = harness();
    const r = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_DEFAULT);
    assert.equal(r.status, 'ok');
    assert.deepEqual(dispatched, ['open_web']);
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

  test('createRouteMemory holds routes, records only what it is told, and clears per turn', () => {
    // The store is the fix: one writer, at the dispatch site, holding routes
    // rather than every signature the adapter happened to see.
    const memory = createRouteMemory();
    assert.equal(memory.check('browser_launch_debug', { browser: 'brave' }), null, 'empty memory refuses nothing');
    memory.note('screen_look', {});
    memory.note('open_web', { type: 'weather' });
    assert.equal(memory.size(), 0, 'a non-route call is not a route');
    memory.note('open_web', { browser: true, url: 'https://a' });
    assert.equal(memory.size(), 1);
    const refusal = memory.check('browser_launch_debug', { browser: 'brave' });
    assert.equal(refusal.priorTool, 'open_web');
    memory.note('open_web', { browser: true, url: 'https://b' });
    // The guard promises the FIRST route taken wins, and the refusal quotes that
    // call's url. Both urls really did open, so 'first' is a choice rather than a
    // correctness property — which is exactly why it needs pinning: without this
    // assertion, remembering the last one instead passes every other test.
    assert.equal(memory.size(), 1, 'one entry per route');
    assert.match(memory.check('browser_launch_debug', { browser: 'brave' }).response.message, /https:\/\/a/,
      'the refusal names the FIRST call to take the route, not the most recent');
    memory.clear();
    assert.equal(memory.check('browser_launch_debug', { browser: 'brave' }), null);
  });

  test('namedOperatorBrowser fires only on a real name, and never on the debug route', () => {
    // What else matches: a blank or whitespace name is not a name, browserName
    // without browser:true is a HUD card, and the debug tools are untouched.
    const named = checkBrowserRoute('open_web', { browser: true, browserName: 'brave', url: 'https://a' }, new Set());
    assert.equal(named.response.reason, 'named-browser-is-the-debug-route');
    assert.equal(checkBrowserRoute('open_web', { browser: true, browserName: '  ', url: 'https://a' }, new Set()), null);
    assert.equal(checkBrowserRoute('open_web', { browser: true }, new Set()), null);
    assert.equal(checkBrowserRoute('open_web', { browserName: 'brave', type: 'web' }, new Set()), null);
    assert.equal(checkBrowserRoute('browser_launch_debug', { browser: 'brave' }, new Set()), null);
    // A named call with no url still names the missing argument rather than
    // inventing one.
    const noUrl = checkBrowserRoute('open_web', { browser: true, browserName: 'edge' }, new Set());
    assert.deepEqual(noUrl.response.then.needsInput, ['url']);
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
