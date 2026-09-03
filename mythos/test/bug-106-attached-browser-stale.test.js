'use strict';

// test/bug-106-attached-browser-stale.test.js — BUG-106.
//
// At 17:10 browser_launch_debug({browser:'brave'}) launched Brave and set the
// module-level attachedBrowser='brave'. The operator closed Brave. The adapter
// dropped OFFLINE. The next browser_navigate hit requireOnline(), whose lazy
// ensureOnline() silently connected/launched Chrome while attachedBrowser
// still said 'brave'. checkBrowserTarget() compared the request against that
// stale value, passed, and Chrome got driven and described as Brave.
//
// Fixed by:
//   (a) checkBrowserTarget() now reads browserAgent.getStatus().state and
//       clears attachedBrowser whenever the adapter is not ONLINE — the stale
//       window is now structurally impossible.
//   (b) requireOnline()'s lazy bring-up now records what it actually did:
//       'chrome' only when it LAUNCHED (mode:'launched', the same default
//       chrome-first fallback path browser_launch_debug uses), never when it
//       merely CONNECTED to an endpoint it did not start (mode:'cdp').
//
// browserAgent is a real singleton module (adapters/browser-agent); its
// exported functions are monkey-patched for the duration of each test and
// restored after, so no real Chrome/Playwright connection is ever attempted.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const browserAgent = require('../adapters/browser-agent');
const browserMod = require('../src/core/effectors/from-browser');

const { checkBrowserTarget, __setAttachedBrowserForTest, browser_navigate } = browserMod;

describe('BUG-106 — attachedBrowser must not outlive the real connection', () => {
  let originalGetStatus, originalEnsureOnline, originalWithPage;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalEnsureOnline = browserAgent.ensureOnline;
    originalWithPage = browserAgent.withPage;
  });

  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.ensureOnline = originalEnsureOnline;
    browserAgent.withPage = originalWithPage;
    __setAttachedBrowserForTest(null);
  });

  test('checkBrowserTarget clears a stale attachedBrowser once the adapter is not ONLINE', () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'OFFLINE', mode: null, hint: 'Chrome disconnected unexpectedly.' });

    const res = checkBrowserTarget('brave');
    assert.ok(res, 'must refuse once the adapter is no longer ONLINE — nothing to vouch for');
    assert.equal(res.ok, false);
    assert.match(String(res.result), /cannot confirm/i);
  });

  test('a still-ONLINE adapter keeps the existing attachedBrowser (no false clear)', () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'launched' });
    assert.equal(checkBrowserTarget('brave'), null, 'still attached to brave, still ONLINE -> no objection');
  });

  test('a CONNECTING adapter also clears the stale value (not-ONLINE, not just OFFLINE)', () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'CONNECTING', mode: null });
    const res = checkBrowserTarget('brave');
    assert.ok(res);
    assert.equal(res.ok, false);
    assert.match(String(res.result), /cannot confirm/i);
  });

  test('browser_navigate: Brave attached, adapter goes OFFLINE, request Brave again -> honest refusal, never a silent reconnect/launch', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'OFFLINE', mode: null, hint: 'Chrome disconnected unexpectedly.' });
    let ensureOnlineCalled = false;
    browserAgent.ensureOnline = async () => { ensureOnlineCalled = true; return false; };

    const result = await browser_navigate({ url: 'https://example.com', browser: 'brave' });

    assert.equal(result.ok, false);
    assert.match(String(result.result), /cannot confirm/i);
    assert.equal(ensureOnlineCalled, false, 'must refuse BEFORE ever attempting to reconnect/launch anything');
  });

  test('requireOnline lazy fallback: a bare CDP connect (mode:cdp) never claims a browser identity', async () => {
    __setAttachedBrowserForTest(null);
    // Models the real transition: OFFLINE until ensureOnline() actually runs,
    // then ONLINE via a bare connect it did not start.
    let fakeState = { state: 'OFFLINE', mode: null, hint: null };
    browserAgent.getStatus = () => ({ ...fakeState });
    browserAgent.ensureOnline = async () => { fakeState = { state: 'ONLINE', mode: 'cdp' }; return true; };
    browserAgent.withPage = async (cb) => cb({
      goto: async () => {}, waitForLoadState: async () => {}, title: async () => 'Example', url: () => 'https://example.com',
    });

    const result = await browser_navigate({ url: 'https://example.com' }); // no browser named
    assert.equal(result.ok, true);
    assert.equal(result.result.browser, 'unknown', 'a bare CDP connect must never be reported as a specific browser');
  });

  // REWRITTEN 2026-09-03 (BUG-410, found reviewing BUG-410's own commit).
  //
  // This test asserted that mode:'launched' is "reported as chrome", which is
  // what the code did — and the code was wrong. launchLocal tries playwright
  // channel 'chrome' and FALLS BACK to 'msedge', so on a machine without Chrome
  // it launches Edge and the label said chrome: an identity taken from an
  // assumption, the exact defect BUG-410 fixed in browser_launch_debug and
  // missed here.
  //
  // The fixture is why it read as safe. It returned mode:'launched' and nothing
  // else, which the real adapter never does — launchLocal now sets
  // launchedChannel in the same breath as mode. A fixture more generous than
  // the wire cannot see the production failure (/kee class 3), and this one
  // could not express the Edge case at all.
  //
  // Intent preserved and widened: a browser MYTHOS launched still earns a
  // label; the label now comes from the launch, and an unnameable channel stays
  // unknown rather than becoming the plausible default.
  test('requireOnline lazy fallback: the label is the channel that ACTUALLY launched', async () => {
    const cases = [
      { launchedChannel: 'chrome', expect: 'chrome' },
      { launchedChannel: 'msedge', expect: 'edge' },
      // The pre-fix code answered 'chrome' for all three of these rows.
      { launchedChannel: null, expect: 'unknown' },
    ];
    for (const c of cases) {
      __setAttachedBrowserForTest(null);
      let fakeState = { state: 'OFFLINE', mode: null, hint: null };
      browserAgent.getStatus = () => ({ ...fakeState });
      browserAgent.ensureOnline = async () => {
        fakeState = { state: 'ONLINE', mode: 'launched', launchedChannel: c.launchedChannel };
        return true;
      };
      browserAgent.withPage = async (cb) => cb({
        goto: async () => {}, waitForLoadState: async () => {}, title: async () => 'Example', url: () => 'https://example.com',
      });

      const result = await browser_navigate({ url: 'https://example.com' });
      assert.equal(result.ok, true);
      assert.equal(result.result.browser, c.expect,
        `channel ${JSON.stringify(c.launchedChannel)} must be reported as ${c.expect}, never as a plausible default`);
    }
  });

  test('an already-ONLINE adapter is left untouched by requireOnline (no reconnect attempt, identity unchanged)', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'launched' });
    let ensureOnlineCalled = false;
    browserAgent.ensureOnline = async () => { ensureOnlineCalled = true; return true; };
    browserAgent.withPage = async (cb) => cb({
      goto: async () => {}, waitForLoadState: async () => {}, title: async () => 'Example', url: () => 'https://example.com',
    });

    const result = await browser_navigate({ url: 'https://example.com', browser: 'brave' });
    assert.equal(result.ok, true);
    assert.equal(result.result.browser, 'brave');
    assert.equal(ensureOnlineCalled, false, 'already ONLINE — requireOnline must not touch attachedBrowser or reconnect');
  });
});
