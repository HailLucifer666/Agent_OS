'use strict';

// test/bug-439-stale-index-refreshes-then-fails.test.js — BUG-439.
//
// 2026-09-11 11:12Z, vault/Audit + mythos-server.log. `cua_click` failed twice
// with the driver's own text:
//
//   Element 100 not in cache for hwnd=329782. Call get_window_state first.
//
// The model HAD called cua_get_window_state — 3 s earlier, in a separate Live
// batch — and that call took 14.3 s to return, so the click went out 11.4 s
// before the tree it depended on landed. Nothing orders calls across batches
// (live-tool-adapter serialises WITHIN one batch on purpose), and the driver's
// advice "call get_window_state first" is unactionable from the model's side:
// it did, and it has no way to know when the result arrives.
//
// WHAT THE FIX DOES. On a click the driver refuses as "not in cache", cua_click
// now refreshes the window state ONCE itself (the same resolveClickedLabel the
// no-repeat guard already uses), then FAILS with a message that says what
// element_index now resolves to and that the driver's cache is warm — so the
// model's next cua_click with the same index needs no separate
// cua_get_window_state. The foreground-escalation retry is skipped for this
// shape: a stale index is deterministic, and the incident's second click hit
// the same wall.
//
// WHAT THE FIX DELIBERATELY DOES NOT DO: click again by itself. The first draft
// of this fix retried the same element_index after the refresh. The 2026-09-16
// review was right that this proves nothing about identity — after a refresh,
// index N may be a different control, and cua-driver's index-stability
// contract is not documented anywhere in this repo (external binary). Without
// that contract no automatic retry is safe, so the model decides, with the
// fresh label in front of it. If a documented contract turns up, an auto-retry
// is a follow-up, not part of this fix.
//
// UNVERIFIED ASSUMPTION, NAMED: that a get_window_state call warms the
// driver's per-hwnd element cache so a following click with an index from
// that tree succeeds. That is what the driver's own error text says
// ("Call get_window_state first") and what the incident's ordering implies;
// it is not provable against a mock. Track A step 4/5 of the 2026-09-16 plan
// is where it gets measured.
//
// FIXTURES ARE THE WIRE. Driver results below carry the exact shapes
// adapters/cua-driver/index.js `invoke()` returns: `{ ok:false, result:{
// content, isError:true } }` for a tool-level refusal, `{ ok:false, result:
// '<message>', timedOut:true }` for a silent driver (BUG-354's flag).
//
// MUTATION RUN — see the block at the bottom of this file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_CUA_PATH = path.resolve(__dirname, '../src/core/effectors/from-cua.js');

// Same seam as cua-click-no-repeat.test.js: swap the driver module for this
// one require of from-cua.js, then drop it from the cache again.
const originalRequire = Module.prototype.require;
function withMockedCuaDriver(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/cua-driver') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_CUA_PATH];
  try {
    return fn(require(FROM_CUA_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_CUA_PATH];
  }
}

const STALE_TEXT = 'Element 100 not in cache for hwnd=329782. Call get_window_state first.';

function mcpErr(text) { return { ok: false, result: { content: [{ type: 'text', text }], isError: true } }; }
function mcpOk(structuredContent) { return { ok: true, result: { content: [], structuredContent, isError: false } }; }
const TIMED_OUT = { ok: false, result: 'cua-driver click timed out after 15000ms', timedOut: true };

// `answers` maps tool name -> function(args, nth) returning the driver result.
function driver(answers, calls) {
  const counts = {};
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    invoke: async (tool, args) => {
      counts[tool] = (counts[tool] || 0) + 1;
      calls.push({ tool, args });
      if (tool === 'list_windows') return mcpOk({ windows: [{ pid: 4242, window_id: 'w-1', title: 'YouTube' }] });
      if (!answers[tool]) throw new Error('unexpected tool: ' + tool);
      return answers[tool](args, counts[tool]);
    },
  };
}

function toolFn(mod, name) {
  const t = mod.TOOLS.find((x) => x.name === name);
  assert.ok(t, name + ' must be registered');
  return t.fn;
}

const clickOf = (calls) => calls.filter((c) => c.tool === 'click');
const stateOf = (calls) => calls.filter((c) => c.tool === 'get_window_state');
// window_id given directly so the refresh needs no pid->window resolution.
const ARGS = { window_id: 'w-1', element_index: 100 };

describe('BUG-439 — a stale element_index refreshes the window state once, then fails with the fresh label', () => {
  it('(a) THE RECORDED CASE: one refresh, no second click, the message names what 100 resolves to now', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr(STALE_TEXT),
      get_window_state: () => mcpOk({ elements: [{ element_index: 100, role: 'button', label: 'Play' }] }),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false, 'the click did NOT happen and must not be reported as if it had');
      assert.equal(clickOf(calls).length, 1, 'no foreground retry and no auto-retry: a stale index is deterministic');
      assert.equal(stateOf(calls).length, 1, 'exactly one refresh');
      assert.match(String(res.result), /element_index 100 was stale/);
      assert.match(String(res.result), /now resolves to "Play"/);
      assert.match(String(res.result), /cua_click again/i, 'the next step must be in the MESSAGE — that is the channel the model reads');
      assert.doesNotMatch(String(res.result), /Call get_window_state first\.\s*$/,
        'the driver\'s own unactionable advice must not be the last word');
      // BUG-425: the next call is structured beside the prose, so the model
      // copies arguments instead of re-typing them. Same index, same window.
      assert.equal(res.remedy && res.remedy.tool, 'cua_click');
      assert.deepEqual(res.remedy.args, { element_index: 100, window_id: 'w-1' });
    });
  });

  it('(c2) when the index is gone, the structured remedy is the tree read, scoped to the same window', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr(STALE_TEXT),
      get_window_state: () => mcpOk({ elements: [] }),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.remedy && res.remedy.tool, 'cua_get_window_state');
      assert.deepEqual(res.remedy.args, { window_id: 'w-1' });
    });
  });

  it('(b) a moved control is visible: the message carries whatever label sits at 100 NOW', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr(STALE_TEXT),
      get_window_state: () => mcpOk({ elements: [{ element_index: 100, role: 'button', label: 'Mute' }] }),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.match(String(res.result), /now resolves to "Mute"/);
      assert.match(String(res.result), /cua_get_window_state/, 'if that is not the control meant, the tree is the next step');
      assert.equal(clickOf(calls).length, 1);
    });
  });

  it('(c) the index is gone from the refreshed tree: say so, do not click', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr(STALE_TEXT),
      get_window_state: () => mcpOk({ elements: [{ element_index: 7, role: 'button', label: 'Play' }] }),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.match(String(res.result), /no element 100 exists in the refreshed tree/);
      assert.match(String(res.result), /cua_get_window_state/);
      assert.equal(clickOf(calls).length, 1);
    });
  });

  it('(d) the refresh itself is refused by the driver: fail with both texts, no click', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr(STALE_TEXT),
      get_window_state: () => mcpErr('hwnd=329782 is no longer a window'),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.match(String(res.result), /element_index 100 was stale/);
      assert.match(String(res.result), /refresh also failed/);
      assert.match(String(res.result), /no longer a window/, 'the driver\'s real reason must reach the operator');
      assert.equal(clickOf(calls).length, 1);
      assert.equal(stateOf(calls).length, 1);
    });
  });

  it('(e) the refresh times out (BUG-354 shape): fail, no click, no second refresh', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr(STALE_TEXT),
      get_window_state: () => ({ ok: false, result: 'cua-driver get_window_state timed out after 15000ms', timedOut: true }),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.match(String(res.result), /refresh also failed/);
      assert.match(String(res.result), /timed out/);
      assert.equal(clickOf(calls).length, 1);
      assert.equal(stateOf(calls).length, 1);
    });
  });

  it('(f) adjacent: a NON-cache failure still takes the foreground escalation and never refreshes', async () => {
    const calls = [];
    const d = driver({
      click: () => mcpErr('background_unavailable: Chromium dropped the background click'),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.equal(clickOf(calls).length, 2, 'background then foreground — the pre-existing escalation is untouched');
      assert.equal(clickOf(calls)[1].args.delivery_mode, 'foreground');
      assert.equal(stateOf(calls).length, 0, 'the refresh is for a stale index only');
      assert.match(String(res.result), /background_unavailable/);
    });
  });

  it('(g) adjacent: a timed-out first click does nothing further (BUG-354 stays)', async () => {
    const calls = [];
    const d = driver({ click: () => TIMED_OUT }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.equal(clickOf(calls).length, 1, 'a silent driver may still be mid-click; a second click is a double-fire');
      assert.equal(stateOf(calls).length, 0);
    });
  });

  it('(h) adjacent: a stale index reported only by the FOREGROUND retry still refreshes instead of clicking a third time', async () => {
    // First click fails for another reason, the escalation then hits the stale
    // cache. The stale shape must be recognised wherever it appears.
    const calls = [];
    const d = driver({
      click: (args, nth) => nth === 1
        ? mcpErr('background_unavailable: Chromium dropped the background click')
        : mcpErr(STALE_TEXT),
      get_window_state: () => mcpOk({ elements: [{ element_index: 100, role: 'button', label: 'Play' }] }),
    }, calls);
    await withMockedCuaDriver(d, async (mod) => {
      const res = await toolFn(mod, 'cua_click')(ARGS);
      assert.equal(res.ok, false);
      assert.equal(clickOf(calls).length, 2);
      assert.equal(stateOf(calls).length, 1);
      assert.match(String(res.result), /now resolves to "Play"/);
    });
  });
});

// MUTATION RUN 2026-09-16. Each probe applied by exact single-match replacement
// (refused on 0 or 2+ matches), from-cua.js restored from a snapshot and checked
// sha256-identical (ceb2456c...). Green baseline first: 40/40 across this file
// and the five neighbouring cua tests.
//   HEAD (pre-fix) from-cua.js against this file      -> 6 of 8 red: (a)-(e), (h).
//                   (f) and (g) stay green — the adjacent non-stale and timed-out
//                   paths were already right and this fix must not move them.
//   staleIndexText() -> always null                   -> 6 red: (a)-(e), (h).
//   drop `!staleIndexText(r)` from the escalation     -> 5 red: (a)-(e) on the click
//                   count — the stale index got a second, pointless click. (h) stays
//                   green because its stale text arrives on the retry anyway.
//   resolveClickedLabel: `found: false` -> `found: true` for a missing index
//                                                     -> 1 red: (c) — a vanished index
//                   would be reported as 'now resolves to ""'.
// cua-click-no-repeat.test.js and bug-354-cua-timeout-kill-and-budget.test.js
// stayed green under every probe: the no-repeat guard and the timeout rule are
// untouched.
//
// TWO HOUSE GUARDS FIRED ON THE FIRST GREEN DRAFT, same run, and shaped the
// final code: remedy-prose-ratchet.test.js (BUG-425) refused four new prose
// refusals naming cua_click/cua_get_window_state without a structured remedy —
// so each return now carries `remedy: remedy(tool, args, why)` beside the prose
// ((a) and (c2) assert it). Then refusal-is-actionable.test.js (d) flagged those
// remedies because cua_* is withheld from Live when the adapter is down. Its own
// doctrine exempts advice withheld TOGETHER with its speaker, and cua_click's
// refusal can only run while cua is online; the selector was widened to derive
// that exemption (liveSpeakerRemedies, fixture-tested there as (e)) rather than
// list this file.
