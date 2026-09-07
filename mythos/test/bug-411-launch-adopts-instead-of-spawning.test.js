'use strict';

// test/bug-411-launch-adopts-instead-of-spawning.test.js
//
// BUG-411. browser_launch_debug decided whether to spawn a browser by reading
// the ADAPTER'S OWN STATE and nothing else:
//
//     const status0 = browserAgent.getStatus();
//     if (status0.state === 'ONLINE')     { ...already online... }
//     if (status0.state === 'CONNECTING') { ...join the in-flight connect... }
//     ...otherwise SPAWN...
//
// OFFLINE is a statement about this process's connection, not about the
// machine. A browser can be running and holding port 9222 with this adapter
// OFFLINE — the poller gave up (the operator's own log: `browser-agent.giving-up`
// at 22:21:45 after seven failures), the connection dropped
// ("disconnected unexpectedly" twice on 2026-09-03), or a previous
// browser_switch left one alive because disconnect() never closed it (BUG-409).
// Spawning on that reading is the operator's "sometimes open two, three chromes
// at the same time".
//
// It is also why the outcome felt random. Measured on 2026-09-03 with two
// browsers deliberately spawned onto one port, twice, with different results:
//     port 9223: chrome bound it, then brave TOOK it — both processes alive
//     port 9224: chrome bound it, brave EXITED — one listener, chrome
// So "sometimes it opens, sometimes it does not, sometimes there are three" is
// one race with at least two observable endings, not several separate faults.
//
// THE FIX is to look before spawning: try to adopt whatever is already on the
// port. It costs nothing when nothing is there — a refused connect fails in
// well under a poll interval, which is the measurement BUG-140 already relies
// on when it polls this same call.
//
// MUTATION PROBES, run 2026-09-03, each green BEFORE this change:
//   (a) delete the pre-spawn adopt and go straight to the spawn -> reds (a).
//   (b) on adoption with a NAMED browser that does not match, return ok
//       instead of refusing -> reds (b).
//   (c) on adoption with a named browser whose identity cannot be read, return
//       ok -> reds (c).
//   (d) set attachedBrowser from the adopted browser -> reds (d): that would
//       let browser_switch try to close a window MYTHOS never launched, which
//       is BUG-106's invariant and browser-process.js's authorisation both.
// Verified applied by diff before restoring from a full-path copy.
//
// ADJACENT CASE THAT MUST KEEP PASSING: when the port really is free, the
// launch must still spawn. An adopt-first check that never spawns would pass
// every "do not spawn" assertion here and break the tool completely.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const browserAgent = require('../adapters/browser-agent');
const browserMod = require('../src/core/effectors/from-browser');

const { browser_launch_debug, __setLaunchDepsForTest, __setAttachedBrowserForTest, checkBrowserTarget } = browserMod;

const EXE = { chrome: path.join('C:', 'x', 'chrome.exe'), brave: path.join('C:', 'x', 'brave.exe') };

describe('BUG-411 — look at the port before spawning onto it', () => {
  let originalGetStatus, originalEnsureOnline, spawned, localAppData;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalEnsureOnline = browserAgent.ensureOnline;
    spawned = [];
    localAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = require('node:fs').mkdtempSync(
      path.join(require('node:os').tmpdir(), 'bug411-'));
  });

  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.ensureOnline = originalEnsureOnline;
    __setLaunchDepsForTest(null);
    __setAttachedBrowserForTest(null);
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
  });

  // The state that produced the bug: adapter OFFLINE, browser very much alive.
  test('a missing executable returns its spawn error before CDP polling', async () => {
    let connects = 0;
    browserAgent.getStatus = () => ({ state: 'OFFLINE' });
    browserAgent.ensureOnline = async () => { connects += 1; return false; };
    const missing = path.join(process.env.LOCALAPPDATA, 'missing-browser.exe');
    __setLaunchDepsForTest({
      resolveLaunchTarget: () => ({ name: 'chrome', exe: missing, source: 'requested' }),
      spawn: require('node:child_process').spawn,
    });
    const result = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(result.ok, false);
    assert.match(result.result, /Failed to launch browser:.*ENOENT/);
    assert.equal(connects, 1, 'only the pre-launch adoption probe runs');
  });

  function arrangeOfflineButBrowserAlive(portOwner) {
    let online = false;
    browserAgent.getStatus = () => (online
      ? { state: 'ONLINE', mode: 'cdp', pageCount: 3 }
      : { state: 'OFFLINE', mode: null, pageCount: 0 });
    browserAgent.ensureOnline = async () => { online = true; return true; };
    __setLaunchDepsForTest({
      spawn: (exe, args) => { spawned.push({ exe, args }); const child = new (require('node:events').EventEmitter)(); child.pid = 1; child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; },
      resolveLaunchTarget: () => ({ name: 'chrome', exe: EXE.chrome, source: 'search-order' }),
      identifyBrowserOnPort: () => portOwner,
    });
  }

  // (a)
  test('an OFFLINE adapter with a live browser on the port ADOPTS it and spawns nothing', async () => {
    arrangeOfflineButBrowserAlive('brave');
    const res = await browser_launch_debug({});
    assert.equal(res.ok, true);
    assert.equal(spawned.length, 0,
      'this is the "two or three browsers at once" line: OFFLINE is about our connection, not the machine');
    assert.equal(res.result.adopted, true);
    assert.equal(res.result.launched, false, 'nothing was launched, so it must not say it was');
    assert.equal(res.result.portOwner, 'brave', 'and it reports what is actually there');
    assert.equal(res.result.pageCount, 3);
  });

  // (b)
  test('adopting something that is NOT the browser asked for refuses, and does not spawn a rival', async () => {
    arrangeOfflineButBrowserAlive('brave');
    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /already on the debug port and it is brave, not chrome/);
    assert.match(String(res.result), /MYTHOS did not launch it/);
    assert.match(String(res.result), /close that brave window yourself/i,
      'the only true remedy for a window MYTHOS did not open — not a dead end, an accurate one');
    assert.equal(spawned.length, 0);
  });

  // (c)
  test('adopting an UNIDENTIFIABLE browser refuses a named request rather than vouching for it', async () => {
    arrangeOfflineButBrowserAlive(null);
    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /cannot tell which browser it is/);
    assert.match(String(res.result), /will not claim to be driving chrome/);
    assert.equal(spawned.length, 0);
  });

  test('an unnamed request adopts an unidentifiable browser, and says the owner is unknown', async () => {
    arrangeOfflineButBrowserAlive(null);
    const res = await browser_launch_debug({});
    assert.equal(res.ok, true, 'nobody asked for a particular browser, so there is nothing to refuse');
    assert.equal(res.result.portOwner, 'unknown', 'unknown is reported as unknown, never filled in');
  });

  // (d)
  test('adoption never makes MYTHOS claim it launched the browser', async () => {
    arrangeOfflineButBrowserAlive('brave');
    await browser_launch_debug({});
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp' });
    const refusal = checkBrowserTarget('brave');
    assert.ok(refusal && refusal.ok === false,
      'attachedBrowser must stay null for an adopted browser: it is what authorises the CLOSE, and '
      + 'closing a window MYTHOS did not open is the thing BUG-106 exists to prevent');
    assert.match(String(refusal.result), /cannot confirm which browser is attached/);
  });

  // the adjacent case, and the one that matters most
  test('a genuinely free port still spawns', async () => {
    let online = false;
    let probes = 0;
    browserAgent.getStatus = () => (online
      ? { state: 'ONLINE', mode: 'cdp', pageCount: 1 }
      : { state: 'OFFLINE', mode: null, pageCount: 0 });
    browserAgent.ensureOnline = async () => {
      probes += 1;
      if (spawned.length === 0) return false; // the adopt probe: nothing there
      online = true;
      return true;
    };
    __setLaunchDepsForTest({
      spawn: (exe, args) => { spawned.push({ exe, args }); const child = new (require('node:events').EventEmitter)(); child.pid = 1; child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; },
      resolveLaunchTarget: () => ({ name: 'chrome', exe: EXE.chrome, source: 'os-default' }),
      identifyBrowserOnPort: () => 'chrome',
    });

    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, true);
    assert.equal(spawned.length, 1, 'an adopt-first check that never spawns would pass every test above');
    assert.equal(res.result.launched, true);
    assert.match(spawned[0].args.join(' '), /--remote-debugging-port=9222/);
    assert.match(spawned[0].args.join(' '), /--user-data-dir=.*chrome-debug-profile/);
    assert.ok(probes >= 2, 'the adopt probe runs before the spawn, and the connect runs after it');
  });

  test('an already-ONLINE adapter is untouched by any of this', async () => {
    // The pre-existing ONLINE branch must not start probing or spawning —
    // BUG-107's mismatch refusal lives there and this ticket does not move it.
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp', pageCount: 1 });
    browserAgent.ensureOnline = async () => { throw new Error('must not probe when already ONLINE'); };
    __setLaunchDepsForTest({ spawn: () => { throw new Error('must not spawn when already ONLINE'); } });

    const same = await browser_launch_debug({ browser: 'brave' });
    assert.equal(same.ok, true);
    assert.equal(same.result.alreadyOnline, true);

    const other = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(other.ok, false);
    assert.match(String(other.result), /already owns the debug port/);
    assert.match(String(other.result), /browser_switch/, 'BUG-107\'s remedy must survive this change');
  });
});
