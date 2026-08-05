'use strict';

// test/bug-107-browser-switch-remedy.test.js — BUG-107.
//
// Incident: "I can't drive Chrome if the browser is already attached to
// Brave." Correct and honest, then nothing — no remedy path. browser_switch
// is that remedy: it disconnects the adapter, closes the debug browser
// MYTHOS ITSELF LAUNCHED (never a browser it merely attached to — that could
// be the operator's own window), launches the requested browser, and
// re-attaches. It must route through browser_launch_debug's own launch logic
// rather than duplicating it.
//
// browserAgent (adapters/browser-agent) is a real singleton module; its
// exported functions are monkey-patched for the duration of each test and
// restored after, so no real Chrome/Playwright process is ever spawned or
// closed.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const browserAgent = require('../adapters/browser-agent');
const browserMod = require('../src/core/effectors/from-browser');

const { browser_switch, browser_launch_debug, __setAttachedBrowserForTest } = browserMod;

describe('BUG-107 — browser_switch is a real, reachable remedy for the wrong-browser refusal', () => {
  let originalGetStatus, originalDisconnect, originalEnsureOnline;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalDisconnect = browserAgent.disconnect;
    originalEnsureOnline = browserAgent.ensureOnline;
  });

  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.disconnect = originalDisconnect;
    browserAgent.ensureOnline = originalEnsureOnline;
    __setAttachedBrowserForTest(null);
  });

  test('browser is required', async () => {
    const res = await browser_switch({});
    assert.equal(res.ok, false);
    assert.match(String(res.result), /required/i);
  });

  test('an unsupported browser name is refused, not guessed', async () => {
    const res = await browser_switch({ browser: 'firefox' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /chrome/i);
  });

  test('already attached to the requested browser -> no-op, no disconnect', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'launched' });
    let disconnectCalled = false;
    browserAgent.disconnect = async () => { disconnectCalled = true; };

    const res = await browser_switch({ browser: 'brave' });
    assert.equal(res.ok, true);
    assert.equal(res.result.alreadyOnline, true);
    assert.equal(disconnectCalled, false);
  });

  test('switching FROM a MYTHOS-launched browser disconnects it, then routes through browser_launch_debug', async () => {
    __setAttachedBrowserForTest('brave');
    let disconnectCalled = false;
    // getStatus reports ONLINE+brave until disconnect() runs, then CONNECTING
    // — chosen deliberately so the real (unstubbed) browser_launch_debug takes
    // its CONNECTING/join branch, which only calls ensureOnline() and NEVER
    // reaches findBrowserExecutable()/spawn(). Chrome, Brave and Edge are all
    // genuinely installed on this dev machine, so any code path that reaches
    // the real spawn() call launches an actual visible browser window — this
    // test must never let that happen.
    let online = true;
    browserAgent.getStatus = () => online
      ? { state: 'ONLINE', mode: 'launched' }
      : { state: 'CONNECTING', mode: null };
    browserAgent.disconnect = async () => { disconnectCalled = true; online = false; };
    browserAgent.ensureOnline = async () => true; // joins the "in-flight" connect, no real network/process I/O

    const res = await browser_switch({ browser: 'chrome' });

    assert.equal(disconnectCalled, true, 'must disconnect the MYTHOS-launched browser before switching');
    // launched:false is a shape ONLY browser_launch_debug's CONNECTING-join
    // branch returns — proves browser_switch deferred to it instead of
    // fabricating its own "switched" response.
    assert.equal(res.ok, true);
    assert.equal(res.result.launched, false, 'browser_switch must defer to browser_launch_debug, not short-circuit its own result');
  });

  test('never closes a browser MYTHOS merely attached to (unknown identity) — refuses instead', async () => {
    __setAttachedBrowserForTest(null); // BUG-106 invariant: null means "merely attached", not "MYTHOS launched"
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp' });
    let disconnectCalled = false;
    browserAgent.disconnect = async () => { disconnectCalled = true; };

    const res = await browser_switch({ browser: 'brave' });

    assert.equal(disconnectCalled, false, 'must never close a browser MYTHOS did not launch');
    assert.equal(res.ok, false);
    assert.match(String(res.result), /did not launch/i);
  });

  test('not ONLINE (nothing attached) -> switch skips disconnect and defers straight to browser_launch_debug', async () => {
    __setAttachedBrowserForTest(null);
    // CONNECTING (not OFFLINE) for the same real-spawn-avoidance reason as the
    // test above — status.state !== 'ONLINE' is what matters for the
    // "skip disconnect" assertion, and this keeps browser_launch_debug's real
    // (unstubbed) call on its CONNECTING/join branch, never touching spawn().
    browserAgent.getStatus = () => ({ state: 'CONNECTING', mode: null });
    let disconnectCalled = false;
    browserAgent.disconnect = async () => { disconnectCalled = true; };
    browserAgent.ensureOnline = async () => true;

    const res = await browser_switch({ browser: 'chrome' });
    assert.equal(disconnectCalled, false, 'nothing online to disconnect');
    assert.equal(res.ok, true);
    assert.equal(res.result.launched, false, 'deferred to browser_launch_debug\'s own CONNECTING-join branch');
  });

  test('browser_switch is registered in the tool catalog', () => {
    const t = browserMod.TOOLS.find((x) => x.name === 'browser_switch');
    assert.ok(t, 'browser_switch must be a registered tool');
    assert.equal(typeof t.fn, 'function');
  });

  test('browser_switch is reachable from the Live voice path (a remedy the model cannot call is not a remedy)', () => {
    const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');
    assert.ok(DEFAULT_ALLOWLIST.includes('browser_switch'),
      'the wrong-browser refusal now names browser_switch as the fix — it must be callable from voice');
  });
});
