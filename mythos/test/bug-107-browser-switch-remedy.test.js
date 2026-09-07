'use strict';

// test/bug-107-browser-switch-remedy.test.js — BUG-107.
//
// Incident: "I can't drive Chrome if the browser is already attached to
// Brave." Correct and honest, then nothing — no remedy path. browser_switch
// UPDATED 2026-09-03 (BUG-409). The mechanism assertion here moved from
// browserAgent.disconnect() to browserAgent.closeLaunchedBrowser(), because
// disconnect() was measured NOT to close a CDP-attached browser: pid 13152
// stayed alive and kept holding port 9223 after it ran, so browser_switch was
// launching the next browser onto a port the old one still owned. Every test's
// intent is unchanged, and one is now STRONGER — "never closes a browser MYTHOS
// did not launch" watches BOTH calls, where it used to watch only the one that
// could not have closed anything in the first place.
//
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
  let originalGetStatus, originalDisconnect, originalEnsureOnline, originalClose;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalDisconnect = browserAgent.disconnect;
    originalClose = browserAgent.closeLaunchedBrowser;
    originalEnsureOnline = browserAgent.ensureOnline;
  });

  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.disconnect = originalDisconnect;
    browserAgent.closeLaunchedBrowser = originalClose;
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

  test('switching FROM a MYTHOS-launched browser CLOSES it, then routes through browser_launch_debug', async () => {
    __setAttachedBrowserForTest('brave');
    let closedProfile = null;
    // getStatus reports ONLINE+brave until the close runs, then CONNECTING
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
    browserAgent.closeLaunchedBrowser = async (profileDir) => {
      closedProfile = profileDir;
      online = false;
      return { closed: true, method: 'cdp', survivors: [], reason: null };
    };
    browserAgent.ensureOnline = async () => true; // joins the "in-flight" connect, no real network/process I/O

    const res = await browser_switch({ browser: 'chrome' });

    assert.ok(closedProfile, 'must CLOSE the MYTHOS-launched browser before switching, not merely disconnect from it');
    // The profile dir is the authorisation: browser-process.js will only act on
    // a %LOCALAPPDATA%\MYTHOS\*-debug-profile path, and it must be BRAVE's —
    // the browser being switched away from, never the one being switched to.
    assert.match(String(closedProfile), /brave-debug-profile$/,
      'must close the profile of the browser it is switching AWAY from');
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
    let closeCalled = false;
    browserAgent.disconnect = async () => { disconnectCalled = true; };
    browserAgent.closeLaunchedBrowser = async () => { closeCalled = true; return { closed: true }; };

    const res = await browser_switch({ browser: 'brave' });

    assert.equal(disconnectCalled, false, 'must never close a browser MYTHOS did not launch');
    assert.equal(closeCalled, false, 'and must not reach the real close path either — that is the one that can kill a process');
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
    let closeCalled = false;
    browserAgent.disconnect = async () => { disconnectCalled = true; };
    browserAgent.closeLaunchedBrowser = async () => { closeCalled = true; return { closed: true }; };
    browserAgent.ensureOnline = async () => true;

    const res = await browser_switch({ browser: 'chrome' });
    assert.equal(disconnectCalled, false, 'nothing online to disconnect');
    assert.equal(closeCalled, false, 'nothing online to close');
    assert.equal(res.ok, true);
    assert.equal(res.result.launched, false, 'deferred to browser_launch_debug\'s own CONNECTING-join branch');
  });

  // The dead end BUG-107 removed lived in TWO places, not one. checkBrowserTarget()
  // (the browser_navigate path) now names browser_switch as the remedy, but
  // browser_launch_debug's own already-ONLINE mismatch branch still told the model
  // to "close it first" — the same refusal-with-no-remedy, reached by the more
  // obvious route: a model asked for Brave calls browser_launch_debug, not
  // browser_navigate. A remedy that only one of two refusals mentions is still a
  // dead end from wherever the model happened to knock.
  test('browser_launch_debug\'s own wrong-browser refusal names the remedy too, not just "close it first"', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'launched' });

    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, false, 'one debug port, one browser — the mismatch must still be refused');
    const msg = String(res.result);
    assert.match(msg, /brave/i, 'it must still say which browser actually owns the port');
    assert.match(msg, /browser_switch/,
      'the refusal must name browser_switch as the way out — a manual close is not a remedy MYTHOS can offer');
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
