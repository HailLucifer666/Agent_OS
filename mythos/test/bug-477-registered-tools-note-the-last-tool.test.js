'use strict';
// BUG-477 wiring (2026-10-06). The disconnect line's `lastTool` is only true if every
// REGISTERED browser tool notes itself when invoked. The evidence tests drive
// agent.noteTool() directly, so they stay green if the registration stops calling
// it — measured: making the call a no-op in registerFromBrowser left all 17 of them
// passing. This test drives the real registration through the real adapter.
//
// Probe, 2026-10-06: replacing `browserAgent.noteTool(tool.name)` in
// registerFromBrowser with `void 0` fails (a); restored and compared byte for byte.
// The note is made through the tool's fn, before effectorFromTool, so the BUG-378
// single-seam guard (effector-failure-reason-class.test.js) still holds; (b) pins
// that a failing tool still reports its own failure and never the note's.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const browserAgent = require('../adapters/browser-agent');
const { registerFromBrowser } = require('../src/core/effectors/from-browser');

// The agent is stubbed as ONLINE with a fake page: an offline agent makes
// requireOnline() try to LAUNCH A REAL BROWSER from inside the test (the first draft
// of this file hung doing exactly that).
function stubAgent(t, { noteTool, withPage }) {
  const saved = { noteTool: browserAgent.noteTool, getStatus: browserAgent.getStatus, withPage: browserAgent.withPage };
  browserAgent.noteTool = noteTool;
  browserAgent.getStatus = () => ({ state: 'ONLINE' });
  browserAgent.withPage = withPage;
  t.after(() => Object.assign(browserAgent, saved));
}

function register() {
  const effectors = [];
  registerFromBrowser({ register(e) { effectors.push(e); } }, {});
  return effectors;
}

test('(a) invoking a registered browser tool notes it as the last tool', async (t) => {
  const noted = [];
  stubAgent(t, { noteTool: (name) => noted.push(name), withPage: async () => ({ ok: true, result: {} }) });
  const hover = register().find((e) => e.id === 'browser_hover');
  assert.ok(hover, 'browser_hover must be registered');
  await hover.invoke({ selector: '#x' }, {});
  assert.deepEqual(noted, ['browser_hover']);
});

test('(b) a throwing note never breaks the tool, and its own failure still comes through', async (t) => {
  stubAgent(t, {
    noteTool: () => { throw new Error('evidence store down'); },
    withPage: async () => { throw new Error('page gone'); },
  });
  const hover = register().find((e) => e.id === 'browser_hover');
  const res = await hover.invoke({ selector: '#x' }, {});
  assert.equal(res.ok, false);
  const text = JSON.stringify(res);
  assert.match(text, /page gone/, "the tool's own failure is reported");
  assert.doesNotMatch(text, /evidence store down/, 'the note failure is swallowed, never reported as the tool failing');
});
