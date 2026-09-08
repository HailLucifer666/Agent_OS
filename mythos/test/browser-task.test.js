'use strict';
// browser-task.test.js — the `browser_task` effector against a fake runner. No Python, no
// browser, no model: what is pinned here is the contract in from-browser-use.js —
// every runner outcome maps to a distinct, spoken-usable reason; "done" with nothing
// observable is unverified, not ok; the debug browser is launched exactly when it is
// offline; only the configured provider's key crosses into the child; a hung runner is
// killed at the timeout.
//
// Written after the effector, not before (2026-09-08, the order slipped); the mutation
// probes below are what make it a test rather than a description of the code:
//   (a) from-browser-use.js: drop the about:blank -> unverified branch -> "done with nothing
//       observable is unverified" fails.
//   (b) reasonFor: return the same string for every code -> "each exit code has its own
//       reason" fails.
//   (c) ensureBrowser: call launchDebug unconditionally -> "launches the debug browser only
//       when offline" fails.
//   (d) keyEnv: pass the whole env -> "only the provider's key reaches the runner" fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildTools, parseModel, reasonFor } = require('../src/core/effectors/from-browser-use');

const FAKE = path.join(__dirname, 'fixtures', 'fake-browser-use-runner.js');

function rig(over = {}) {
  const calls = { launch: 0 };
  let state = over.browserState || 'ONLINE';
  const tool = buildTools({
    config: { BROWSER_USE_MODEL: 'google/gemini-3.6-flash', BROWSER_USE_TIMEOUT_MS: over.timeoutMs || 5000, ...(over.config || {}) },
    env: { PATH: process.env.PATH, GOOGLE_API_KEY: 'g-key', GROQ_API_KEY: 'q-key', GMAIL_TOKEN: 'never', ...(over.env || {}) },
    browserAgent: { getStatus: () => ({ state }) },
    launchDebug: async () => { calls.launch++; state = 'ONLINE'; return over.launchResult || { ok: true, result: { browser: 'brave' } }; },
    findInstalled: over.findInstalled || (() => ({ ok: true, python: 'unused', home: 'unused', version: 'pinned' })),
    runnerCommand: process.execPath,
    runnerArgs: [FAKE, '--as-runner'],
  })[0];
  return { tool, calls };
}

test('done on a real page is ok with the evidence fields the golden path reads', async () => {
  const { tool } = rig();
  const r = await tool.fn({ task: 'DONE_WATCH play the second video' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.unverified, undefined);
  assert.equal(r.result.final_url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(r.result.final_title, 'Song - YouTube');
  assert.equal(r.result.steps, 6);
  assert.equal(r.result.model, 'google/gemini-3.6-flash');
});

test('done with nothing observable is unverified, not ok', async () => {
  const { tool } = rig();
  const r = await tool.fn({ task: 'DONE_BLANK do nothing' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.unverified, true);
  assert.match(r.reason, /about:blank/);
});

test('each exit code has its own reason, and a provider error names the provider', async () => {
  const { tool } = rig();
  const two = await tool.fn({ task: 'EXIT2 give up' }, {});
  const three = await tool.fn({ task: 'EXIT3 quota' }, {});
  const four = await tool.fn({ task: 'EXIT4 no browser' }, {});
  for (const r of [two, three, four]) assert.equal(r.ok, false);
  assert.match(two.result, /stopped before finishing after 20 steps/);
  assert.match(three.result, /google model error/);
  assert.match(three.result, /429/);
  assert.match(four.result, /No debuggable browser/);
  assert.equal(new Set([two.result, three.result, four.result]).size, 3);
  assert.equal(reasonFor(3, { error: 'x' }, 'groq').includes('groq'), true);
});

test('unreadable runner output is a failure that carries the stderr tail, never a throw', async () => {
  const { tool } = rig();
  const r = await tool.fn({ task: 'GARBAGE' }, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /code 1/);
  assert.match(r.result, /Traceback: boom/);
});

test('a hung runner is killed at the timeout and reported as such', async () => {
  const { tool } = rig({ timeoutMs: 600 });
  const t0 = Date.now();
  const r = await tool.fn({ task: 'HANG forever' }, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /ran past 1 seconds|ran past 0 seconds/);
  assert.ok(Date.now() - t0 < 5000, 'returned promptly after the timeout');
});

test('launches the debug browser only when offline', async () => {
  const online = rig({ browserState: 'ONLINE' });
  await online.tool.fn({ task: 'DONE_WATCH' }, {});
  assert.equal(online.calls.launch, 0);
  const offline = rig({ browserState: 'OFFLINE' });
  const r = await offline.tool.fn({ task: 'DONE_WATCH' }, {});
  assert.equal(offline.calls.launch, 1);
  assert.equal(r.result.launchedBrowser, true);
  const refused = rig({ browserState: 'OFFLINE', launchResult: { ok: false, result: 'port busy' } });
  const rr = await refused.tool.fn({ task: 'DONE_WATCH' }, {});
  assert.equal(rr.ok, false);
  assert.match(rr.result, /port busy/);
});

test('only the provider\'s key reaches the runner', async () => {
  const { tool } = rig();
  const r = await tool.fn({ task: 'ECHO_ENV' }, {});
  assert.deepEqual(JSON.parse(r.result.summary), ['GOOGLE_API_KEY']);
});

test('refuses honestly before spawning: missing task, bad url, unknown provider, missing key, not installed', async () => {
  const { tool } = rig();
  assert.equal((await tool.fn({}, {})).notExecuted, true);
  assert.match((await tool.fn({ task: 'x'.repeat(501) }, {})).result, /500/);
  assert.match((await tool.fn({ task: 'DONE_WATCH', url: 'ftp://x' }, {})).result, /http\(s\)/);
  assert.match((await tool.fn({ task: 'DONE_WATCH', url: 'https://user:pw@x.test/' }, {})).result, /credential-free/);
  const badProvider = rig({ config: { BROWSER_USE_MODEL: 'nope/model' } });
  assert.match((await badProvider.tool.fn({ task: 'DONE_WATCH' }, {})).result, /unsupported provider/);
  const noKey = rig({ env: { GOOGLE_API_KEY: '' } });
  assert.match((await noKey.tool.fn({ task: 'DONE_WATCH' }, {})).result, /GOOGLE_API_KEY/);
  const notInstalled = rig({ findInstalled: () => ({ ok: false, reason: 'browser-use is not installed. Run: node mythos/scripts/setup-browser-use.js --install' }) });
  const r = await notInstalled.tool.fn({ task: 'DONE_WATCH' }, {});
  assert.equal(r.notExecuted, true);
  assert.match(r.result, /setup-browser-use\.js --install/);
});

test('parseModel splits provider/model once and rejects the degenerate shapes', () => {
  assert.deepEqual(parseModel('groq/openai/gpt-oss-120b'), { provider: 'groq', model: 'openai/gpt-oss-120b' });
  assert.deepEqual(parseModel(undefined), { provider: 'google', model: 'gemini-3.6-flash' });
  assert.equal(parseModel('nomodel'), null);
  assert.equal(parseModel('google/'), null);
});
