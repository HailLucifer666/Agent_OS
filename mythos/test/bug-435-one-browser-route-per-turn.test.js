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

// REPAIR 2026-09-11 — THE FIX ABOVE MADE THE BUG WORSE IN PRODUCTION.
// Attended run, 2026-09-10 18:21Z. "Open YouTube in Brave": browser_launch_debug
// ran and CONNECTED over CDP, then open_web was refused four times, and
// browser_navigate was never called. No page opened at all — worse than the two
// windows this guard exists to prevent. Three causes, all now covered here:
//   - open_web's own description still said "if they NAMED a browser, pass
//     browserName", so the model was doing what it was told. BUGS.md carried the
//     mismatch as "Flagged, not done". The coupling test in the pure-decision
//     block is the one that would have caught it, and it did not exist.
//   - the refusal's remedy was browser_launch_debug — already done, twenty
//     seconds earlier. (k) is that turn.
//   - the message named no tool at all, and the `then` field carrying the second
//     step is read by nothing in this repo. (g) now asserts the prose.
// (l) is the assertion the whole file was missing: not "was it refused" but "did
// the operator get their page". Every test here before today stopped at the
// refusal.
//
// MUTATION RUN 2026-09-11, each verified applied and restored sha256-identical:
//   `const online = false` (the refusal blind to state again) -> 4 red, (k) among them
//   the message stops naming browser_navigate                 -> (k) red
//   the offline message stops naming the second step          -> (g) red
//   from-dashboard's old browserName instruction restored     -> the coupling test red
// And one that reddened nothing until the test was fixed: repeating the refused
// call BYTE-IDENTICALLY returns 'duplicate-suppressed', not a refusal — see (m).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { checkBrowserRoute, browserRouteOf, parseSignature, createRouteMemory } = require('../src/core/voice/browser-route-guard');

// `deny` lets a test refuse ONE tool at the leash, which is the only way to
// reach the state the route memory used to get wrong: a call seen, recorded and
// never dispatched.
// `browserOnline` is the fact the 2026-09-10 refusal was blind to. Injected so a
// test can be in the state the live 18:21Z turn was in — debug browser already
// attached — without a CDP socket.
function harness({ deny = null, browserOnline = false } = {}) {
  const dispatched = [];
  const dispatchedCalls = [];
  const logs = [];
  const session = { isOpen: () => true, sendText: () => {} };
  const adapter = createLiveToolAdapter({
    leash: {
      check: (decision) => (deny && decision.tool === deny
        ? { allow: false, requireConfirm: false, tier: 2, reason: 'boundaries-deny' }
        : { allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-435' },
    },
    browserOnline: () => browserOnline,
    dispatchAction: async (decision) => {
      // The ARGS are recorded, not just the tool name. A sequence that reaches
      // browser_navigate without the url is not the user's goal reached, and the
      // first version of this file could not tell the difference.
      dispatched.push(decision.tool);
      dispatchedCalls.push({ tool: decision.tool, args: decision.args });
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
  return { adapter, dispatched, dispatchedCalls, logs };
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
// The debug-browser state the refusal now reads, as the two answers it can give.
const ON = { browserOnline: () => true };
const OFF = { browserOnline: () => false };
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
    // Structured AND spoken. remedy() validates the tool against TIER_TABLE so a
    // rename cannot leave the model a call that does not exist — but the tools
    // must ALSO be in the sentence. The first version of this refusal put them
    // only in structured fields and the model never acted on them; see the
    // module header for the 18:21Z measurement.
    assert.equal(r.remedy.tool, 'browser_launch_debug');
    assert.deepEqual(r.remedy.args, { browser: 'brave' });
    assert.ok(r.remedy.why, 'a remedy has to say why');
    assert.match(r.message, /browser_launch_debug/, 'the message must name the call to make');
    assert.match(r.message, /browser_navigate/, 'and the one after it, or the page never loads');
    assert.equal(r.then, undefined, 'the invented `then` field is gone — nothing read it');
    assert.ok(logs.some((l) => l.event === 'live.browser-route-conflict'),
      'the refusal is logged like the other one');
  });

  test('(k) THE 18:21Z REGRESSION: with the debug browser already attached, the remedy is navigate — never the launch it just did', async () => {
    // This is the turn that opened nothing at all. browser_launch_debug had run
    // and CONNECTED; the refusal still answered "call browser_launch_debug", so
    // the model retried open_web four times and no page ever loaded. A remedy
    // whose step is already satisfied is as unfollowable as one naming a tool
    // that does not exist — the class BUG-099 and BUG-107 each fixed once.
    const { adapter, dispatched } = harness({ browserOnline: true });
    const r = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    assert.equal(r.status, 'refused');
    assert.equal(r.remedy.tool, 'browser_navigate', 'the browser is up; the only thing left is to navigate it');
    assert.deepEqual(r.remedy.args, { url: 'https://www.youtube.com' });
    assert.match(r.message, /already open and attached/);
    assert.match(r.message, /browser_navigate/);
    assert.doesNotMatch(r.message, /Call browser_launch_debug/,
      'telling the model to redo a finished step is what produced the four-refusal loop');
    assert.deepEqual(dispatched, []);
  });

  test('(l) THE GOAL IS REACHED, not merely refused: refusal -> launch -> navigate puts the url in a real browser', async () => {
    // The assertion this file did not have. Every other test here stops at "was
    // refused"; a guard is only correct if the thing the operator asked for still
    // happens. The url is checked at the dispatcher, because a sequence that
    // reaches browser_navigate with no url is not a page.
    const { adapter, dispatchedCalls } = harness();
    const refused = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    assert.equal(refused.status, 'refused');
    const launched = await call(adapter, 'fc_2', refused.remedy.tool, refused.remedy.args);
    assert.equal(launched.status, 'ok', launched.message);
    const navigated = await call(adapter, 'fc_3', 'browser_navigate', { url: 'https://www.youtube.com' });
    assert.equal(navigated.status, 'ok', navigated.message);
    assert.deepEqual(dispatchedCalls.map((c) => c.tool), ['browser_launch_debug', 'browser_navigate']);
    assert.equal(dispatchedCalls[1].args.url, 'https://www.youtube.com',
      'the page the operator asked for has to be the page that loads');
  });

  test('(m) pinned: a re-ask gets the SAME actionable answer — refusals are deliberately not remembered', async () => {
    // Deliberately NOT changing behaviour on the second ask. The four-refusal
    // loop was caused by dead advice, not by repetition, and an answer that
    // changes the second time is a new way to be wrong. If a future change adds
    // refusal memory, this test is the conversation to have first.
    //
    // WRITTEN WRONG FIRST, AND THE FAILURE IS WORTH KEEPING. The original version
    // repeated the call BYTE-IDENTICALLY and asserted 'refused'; it came back
    // 'duplicate-suppressed', because isDuplicateSignature already catches an
    // exact repeat within a turn. That is a real protection and is asserted here
    // rather than assumed. It also settles what the live 18:21Z turn must have
    // looked like: four calls all reached the guard, so they cannot have been
    // byte-identical within one turn — the model varied the args or the asks
    // spanned turns, which is why the guard, not the deduper, had to be the thing
    // that answered usefully.
    const { adapter } = harness({ browserOnline: true });
    const first = await call(adapter, 'fc_1', 'open_web', OPEN_WEB_BRAVE);
    assert.equal(first.status, 'refused');
    const identical = await call(adapter, 'fc_2', 'open_web', OPEN_WEB_BRAVE);
    assert.equal(identical.status, 'duplicate-suppressed', 'an exact repeat never reaches the guard');
    // The live shape: same intent, different bytes. This one does reach the guard.
    const varied = await call(adapter, 'fc_3', 'open_web', { ...OPEN_WEB_BRAVE, url: 'https://www.youtube.com/' });
    assert.equal(varied.status, 'refused');
    assert.equal(varied.remedy.tool, first.remedy.tool);
    assert.equal(varied.remedy.tool, 'browser_navigate', 'and it is still the one that works');
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
    // inventing one — on the attached branch, which is the one that hands back
    // browser_navigate and therefore the one that needs a url.
    const noUrl = checkBrowserRoute('open_web', { browser: true, browserName: 'edge' }, new Set(), ON);
    assert.deepEqual(noUrl.response.remedy.needsInput, ['url']);
    // And on the OTHER branch there is nothing missing to name: the launch takes
    // the browser it was given, and the url is the step after it.
    assert.equal(checkBrowserRoute('open_web', { browser: true, browserName: 'edge' }, new Set(), OFF)
      .response.remedy.needsInput, undefined);
  });

  test('the next call is derived from the browser state, and an unreadable state fails towards launching', () => {
    // The state read is injected, so this is the whole decision table in one
    // place. The default reader is the real adapter singleton; when it throws or
    // is missing it answers "not attached", which routes to browser_launch_debug
    // — idempotent (it returns alreadyOnline) so the safe direction costs nothing.
    const args = { browser: true, browserName: 'brave', url: 'https://a' };
    assert.equal(checkBrowserRoute('open_web', args, new Set(), OFF).response.remedy.tool, 'browser_launch_debug');
    assert.equal(checkBrowserRoute('open_web', args, new Set(), ON).response.remedy.tool, 'browser_navigate');
    const throws = { browserOnline: () => { throw new Error('no adapter'); } };
    assert.throws(() => checkBrowserRoute('open_web', args, new Set(), throws), /no adapter/,
      'an injected reader that throws is the test\'s fault and must not be swallowed; only the DEFAULT reader is allowed to fail closed');
    assert.equal(checkBrowserRoute('open_web', args, new Set(), {}).response.remedy.tool, 'browser_launch_debug',
      'no reader supplied falls through to the real adapter, which is OFFLINE in a test process');
  });

  test('THE COUPLING THAT WAS MISSING: no tool description may teach the shape this guard refuses', () => {
    // The root cause of the 18:21Z incident, and the only test here that could
    // have prevented it. open_web's own model-facing description said "if they
    // NAMED a browser, pass browserName as well" while the guard refused exactly
    // that. The model did as it was told and was refused four times. BUGS.md even
    // carried the mismatch as "Flagged, not done" — a follow-up that contradicts
    // the thing it follows is an unfinished fix, not a follow-up.
    //
    // Derived, not hardcoded: it asks the GUARD what it refuses, then holds the
    // descriptions to that answer. A future change to the decision moves this
    // test with it instead of leaving a stale assertion behind.
    const refused = checkBrowserRoute('open_web', { browser: true, browserName: 'brave', url: 'https://a' }, new Set(), OFF);
    assert.equal(refused && refused.response.reason, 'named-browser-is-the-debug-route',
      'if this decision is ever reversed, the assertions below are what must change with it');
    const { buildTools } = require('../src/core/effectors/from-dashboard');
    const { TOOLS } = buildTools({
      goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
      vault: {}, config: {}, bus: { emit() {} }, probes: { getStatus: async () => ({}) },
    });
    const entry = TOOLS.find((t) => t.name === 'open_web');
    assert.ok(entry, 'open_web must still be registered in from-dashboard.js');
    const text = entry.description + ' ' + Object.values(entry.params).join(' ');
    assert.doesNotMatch(text, /NAMED?\s+a\s+browser[^.]{0,80}pass\s+browserName/i,
      'the description must not instruct the argument the guard refuses');
    assert.doesNotMatch(text, /Pass it whenever the operator named a browser/i,
      'nor may the parameter doc, which is the sentence the model actually reads for an argument');
    assert.match(text, /BUG-435|REFUSED/,
      'and it has to say that a named browser goes elsewhere, or the model has no reason not to try');
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
