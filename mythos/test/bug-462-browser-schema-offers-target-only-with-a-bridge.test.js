'use strict';

// test/bug-462-browser-schema-offers-target-only-with-a-bridge.test.js
//
// BUG-462 side-finding (attended run 2026-09-25, 02:16:41). browser_snapshot was
// refused with "A desktop-owned task is required for extension browser control"
// while the debug browser was attached over CDP. Cause, read from
// browser-driver-tools.js: the wrapper adds an extension `target` param to every
// CDP tool that has an extension counterpart, whether or not any extension bridge
// exists. A model that fills `target` outside a desktop task is refused by the
// wrapper before the CDP tool runs. On a machine with no extension bridge the
// `target` param can never be honoured, so offering it is an invitation to the
// refusal.
//
// THE FIX: the param is offered only while getBridge() returns a bridge (the one
// condition under which the extension path can run), and it is read LIVE: the
// bridge is created by desktopRuntime.start(), after registration, so a
// snapshot taken at registration time would be wrong in the exact case that
// matters. The refusal that remains (a stray target) now names the way forward.
//
// MUTATION PROBES, 2026-10-06 (each applied once, diffed, restored from a copy):
//   (a) offer `target` unconditionally (`tool.fn && true`)      -> reds "no bridge: no CDP tool ..." and "the bridge is read LIVE"
//   (b) read the bridge once at registration (plain property)   -> reds "the bridge is read LIVE" (and ONLY it)
//   (c) drop "...again without target" from the refusal          -> reds "a stray target ... names the way forward"
//   (d) never offer `target` (ADJACENT: `false && getBridge()`)  -> reds "with a bridge: every CDP tool ..." and "read LIVE"
//   Each applied once, diffed, restored from a copy and hash-verified.
//
// ADJACENT CASES THAT MUST KEEP PASSING: with a bridge the param IS offered and is
// never "required" (validate() passes without it); a call with no target still
// reaches the CDP tool outside a desktop task; a desktop task with a target still
// reaches the bridge (test/desktop-integration.test.js owns that, re-asserted here
// through the real catalog).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { withBrowserDriver } = require('../src/core/effectors/browser-driver-tools');
const { effectorFromTool } = require('../src/core/effectors/adapter');
const { TOOLS } = require('../src/core/effectors/from-browser');

// Tools that have an extension counterpart AND a CDP implementation. Derived from
// the wrapper's own behaviour, not typed: a tool qualifies when handing it a
// bridge adds `target` to its schema.
function schemaOf(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, name + ' must exist in the catalog');
  return effectorFromTool(t).describeMeta().params;
}

function cdpTool(name, fn) { return { name, description: 'd', params: { thing: 'string (optional) - x' }, fn }; }

describe('BUG-462 side-finding: the schema offers `target` only when a bridge exists', () => {
  test('no bridge: no CDP tool in the real catalog offers `target` (the snapshot refusal can no longer be invited)', () => {
    const offering = TOOLS
      .filter((t) => 'target' in (effectorFromTool(t).describeMeta().params || {}))
      .map((t) => t.name)
      .sort();
    // browser_media_state / browser_media_control are extension-only tools (no CDP
    // implementation, `target` is their identity) - a separate, unchanged matter.
    assert.deepEqual(offering, ['browser_media_control', 'browser_media_state'],
      'with no bridge, only the extension-only tools may carry target');
    assert.equal('target' in schemaOf(TOOLS, 'browser_snapshot'), false);
    assert.equal('target' in schemaOf(TOOLS, 'browser_click'), false);
  });

  test('with a bridge: every CDP tool that has an extension counterpart offers `target`', () => {
    const tools = withBrowserDriver([
      cdpTool('browser_snapshot', () => ({ ok: true })),
      cdpTool('browser_click', () => ({ ok: true })),
      cdpTool('browser_type', () => ({ ok: true })), // no extension counterpart
    ], { getBridge: () => ({ execute() {} }) });
    assert.equal('target' in schemaOf(tools, 'browser_snapshot'), true);
    assert.equal('target' in schemaOf(tools, 'browser_click'), true);
    assert.equal('target' in schemaOf(tools, 'browser_type'), false, 'a tool with no extension counterpart never offers target');
  });

  test('the bridge is read LIVE: it appears after registration, as desktopRuntime.start() does', () => {
    let bridge = null;
    const tools = withBrowserDriver([cdpTool('browser_snapshot', () => ({ ok: true }))], { getBridge: () => bridge });
    assert.equal('target' in schemaOf(tools, 'browser_snapshot'), false, 'before the bridge exists');
    bridge = { execute() {} };
    assert.equal('target' in schemaOf(tools, 'browser_snapshot'), true, 'once it exists');
    bridge = null;
    assert.equal('target' in schemaOf(tools, 'browser_snapshot'), false, 'and withdrawn again when it goes');
  });

  test('`target` is never a required param, so validate() passes without it', () => {
    const tools = withBrowserDriver([cdpTool('browser_snapshot', () => ({ ok: true }))], { getBridge: () => ({ execute() {} }) });
    const eff = effectorFromTool(tools.find((t) => t.name === 'browser_snapshot'));
    assert.deepEqual(eff.validate({}), { ok: true });
  });

  test('a call with no target outside a desktop task still reaches the CDP tool', async () => {
    let reached = 0;
    const tools = withBrowserDriver([cdpTool('browser_snapshot', () => { reached++; return { ok: true, result: 'cdp' }; })],
      { getBridge: () => null });
    const res = await tools.find((t) => t.name === 'browser_snapshot').fn({}, {});
    assert.equal(res.ok, true);
    assert.equal(reached, 1);
  });

  test('a stray target outside a desktop task is still refused, and the refusal names the way forward', async () => {
    let reached = 0;
    const tools = withBrowserDriver([cdpTool('browser_snapshot', () => { reached++; return { ok: true }; })],
      { getBridge: () => null });
    const res = await tools.find((t) => t.name === 'browser_snapshot').fn({ target: { tabId: 1 } }, {});
    assert.equal(res.ok, false);
    assert.equal(res.notExecuted, true);
    assert.equal(reached, 0, 'the CDP tool must not run on a call that asked for the extension');
    assert.match(res.result, /without target/i, 'the message (what the model reads) must say to call again without target');
  });

  test('a desktop task with a target still reaches the bridge', async () => {
    const calls = [];
    const tools = withBrowserDriver([cdpTool('browser_snapshot', () => ({ ok: true }))], {
      isDesktopTask: (id) => id === 'task',
      getBridge: () => ({ execute: async (...a) => { calls.push(a[0]); return { ok: true }; } }),
    });
    const res = await tools.find((t) => t.name === 'browser_snapshot').fn({ target: { tabId: 1 } }, { goalId: 'task' });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, ['observe']);
  });
});
