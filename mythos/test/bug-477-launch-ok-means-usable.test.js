'use strict';

// test/bug-477-launch-ok-means-usable.test.js
//
// BUG-477 (attended run 2026-10-05/06), the browser_launch_debug half.
//
// Inventory, measured from source: the four `connect failed ... ECONNREFUSED`
// warns inside one second were the designed cold-start poll (waitForDebugPortReady,
// from-browser.js; BUG-140) calling ensureOnline() on a browser that was still
// starting. They were EXPECTED refusals logged as failures. browser_launch_debug
// now asks every cold-start probe (and the pre-spawn adoption probe) to be quiet,
// and the FINAL connect, the one whose failure is real, stays loud.
//
// The plan also requires that launch succeeds ONLY after a usable connection.
// From code: ok is reachable only after ensureOnline() returned true, which is
// `state === 'ONLINE'` or a fresh connectOverCDP success - but the connection
// could drop in the async port-owner read (identifyBrowserOnPort, a PowerShell
// round trip) between that true and the ok. This pins that the result is checked
// against the adapter's state at the moment it is returned.
//
// MUTATION PROBES, 2026-10-06 (each applied once, diffed, restored from a copy):
//   (j) the pre-spawn adoption probe loses `quiet`                  -> reds "every probe before the final connect is quiet" and "never comes online"
//   (k) the cold-start poll probe loses `quiet`                     -> same two
//   (l) the FINAL connect becomes quiet (a real failure would hide) -> same two
//   (m) remove the ONLINE re-check before ok                        -> reds "ok is never returned when the connection dropped ..."
//   Each applied once, diffed, restored from a copy and hash-verified.
//
// ADJACENT CASES THAT MUST KEEP PASSING: a launch whose connection stays up is ok;
// a launch that never comes online is a failure naming the connect that did not
// come online (and its final, non-quiet connect is still loud).

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const browserAgent = require('../adapters/browser-agent');
const { browser_launch_debug, __setLaunchDepsForTest, __setAttachedBrowserForTest } = require('../src/core/effectors/from-browser');

const EXE = path.join('C:', 'x', 'chrome.exe');

describe('BUG-477 — browser_launch_debug: quiet cold-start probes, ok only when usable', () => {
  let saved, localAppData, calls, statusState;

  function fakeSpawn() {
    return () => { const c = new EventEmitter(); c.pid = 1; c.unref = () => {}; process.nextTick(() => c.emit('spawn')); return c; };
  }

  beforeEach(() => {
    saved = { getStatus: browserAgent.getStatus, ensureOnline: browserAgent.ensureOnline };
    localAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bug477-'));
    calls = [];
    statusState = 'OFFLINE';
    browserAgent.getStatus = () => ({ state: statusState, mode: statusState === 'ONLINE' ? 'cdp' : null, pageCount: 1 });
  });

  afterEach(() => {
    browserAgent.getStatus = saved.getStatus;
    browserAgent.ensureOnline = saved.ensureOnline;
    __setLaunchDepsForTest(null);
    __setAttachedBrowserForTest(null);
    if (localAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = localAppData;
  });

  function arrange({ comesUpOnCall, owner, dropDuringOwnerRead }) {
    browserAgent.ensureOnline = async (opts) => {
      calls.push({ quiet: Boolean(opts && opts.quiet) });
      if (statusState === 'ONLINE') return true;
      if (calls.length >= comesUpOnCall) { statusState = 'ONLINE'; return true; }
      return false;
    };
    __setLaunchDepsForTest({
      spawn: fakeSpawn(),
      resolveLaunchTarget: () => ({ name: 'chrome', exe: EXE, source: 'search-order' }),
      identifyBrowserOnPort: async () => { if (dropDuringOwnerRead) statusState = 'OFFLINE'; return owner; },
    });
  }

  test('every probe before the final connect is quiet; the final connect is not', async () => {
    arrange({ comesUpOnCall: 3, owner: 'chrome' });
    const res = await browser_launch_debug({});
    assert.equal(res.ok, true);
    // call 1 = pre-spawn adoption probe, 2..3 = the cold-start poll, 4 = the final connect
    assert.deepEqual(calls.map((c) => c.quiet), [true, true, true, false]);
  });

  test('a launch that never comes online fails, and its final connect is the loud one', async () => {
    arrange({ comesUpOnCall: 1e9, owner: null });
    const res = await browser_launch_debug({});
    assert.equal(res.ok, false);
    assert.match(String(res.result || res.error), /did not come online/);
    assert.equal(calls[calls.length - 1].quiet, false, 'the last attempt must not be quiet');
    assert.ok(calls.slice(0, -1).every((c) => c.quiet === true), 'all the rest are quiet probes');
  });

  test('ok is never returned when the connection dropped while the port owner was being read', async () => {
    arrange({ comesUpOnCall: 2, owner: 'chrome', dropDuringOwnerRead: true });
    const res = await browser_launch_debug({});
    assert.equal(res.ok, false, 'the adapter is OFFLINE at the moment of return, so this launch is not usable');
    assert.match(String(res.result || res.error), /connection dropped/);
  });

  test('ADJACENT: a connection that stays up is ok, with the observed browser recorded', async () => {
    arrange({ comesUpOnCall: 2, owner: 'chrome' });
    const res = await browser_launch_debug({});
    assert.equal(res.ok, true);
    assert.equal(res.result.browser, 'chrome');
  });
});
