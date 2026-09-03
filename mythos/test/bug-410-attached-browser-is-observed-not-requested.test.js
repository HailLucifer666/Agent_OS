'use strict';

// test/bug-410-attached-browser-is-observed-not-requested.test.js
//
// BUG-410. from-browser.js used to end a launch with
//
//     // This is the only trustworthy source — over CDP, Brave reports a plain
//     // `Chrome/<version>` product string, so a version probe cannot tell
//     // them apart.
//     attachedBrowser = want || 'chrome';
//
// The first half of that comment is TRUE and still is — measured 2026-09-03, a
// Brave holding the debug port answered Browser.getVersion with
// product "Chrome/152.0.7977.65". The second half was not: `want` is not a
// trustworthy source, it is the REQUEST. It was merely the only answer anyone
// had looked for.
//
// Why it mattered. A browser MYTHOS launched used to survive its own
// disconnect and keep the port (BUG-409), so a switch spawned a second, VISIBLE
// window while the CDP session stayed attached to the first — and this line
// then labelled the session with the name of the window the operator was
// looking at. That is the operator's report on 2026-09-03, verbatim: "only once
// it was able to open YouTube on Brave, but it cannot navigate to the video by
// looking at it." Two browsers; MYTHOS driving the invisible one under the
// visible one's name; see_and_click reading a window that never changes.
//
// The oracle that CAN tell them apart is the process listening on the port —
// its executable path names it outright. Measured in the same session: port
// 9224 -> OwningProcess 21708 -> chrome.exe.
//
// MUTATION PROBES, run 2026-09-03, each green BEFORE this change:
//   (a) disable the mismatch guard, so a launch relabels and carries on
//       -> reds (a): the operator is left with two windows and no word of it.
//       Measured: this reds ONE test, not both of the mismatch pair. The
//       second ("nothing claims to be driving anything") still passes under
//       the mutation, because with the guard off attachedBrowser becomes the
//       OBSERVED browser and checkBrowserTarget refuses a chrome navigate for
//       a different, correct reason. That test is a real invariant and it
//       stays; it is simply not what pins this line. Written down so nobody
//       reads it as coverage it does not provide.
//   (b) report browserIdentity:'verified' unconditionally -> reds (b).
//   (c) identifyBrowserOnPort: answer 'chrome' instead of null when the port
//       owner cannot be read -> reds (c).
//   (d) restore `attachedBrowser = want || 'chrome'` while KEEPING the mismatch
//       guard -> reds (d), and only because of the test written for it. This
//       probe reddened NOTHING as first conceived; see the note above that
//       test for what it found instead.
// Verified applied by diff before restoring from a full-path copy.
//
// ADJACENT CASE THAT MUST KEEP PASSING: when the observed browser AGREES with
// the one launched, the launch must still succeed and still carry its normal
// result — a check that fires on the happy path would be worse than no check.
//
// The launch runs with an injected spawn, resolver and port oracle. That is not
// convenience: Chrome, Brave and Edge are all installed on a normal dev
// machine, so the real path opens a visible window, which is why this tool's
// spawn branch had no coverage at all before this ticket.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const browserAgent = require('../adapters/browser-agent');
const bp = require('../adapters/browser-agent/browser-process');
const browserMod = require('../src/core/effectors/from-browser');

const { browser_launch_debug, __setLaunchDepsForTest, __setAttachedBrowserForTest, checkBrowserTarget } = browserMod;

const EXE = {
  chrome: path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  brave: path.join('C:', 'Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
};

describe('BUG-410 — the attached browser is the one that ANSWERED', () => {
  let originalGetStatus, originalEnsureOnline, spawned, localAppData;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalEnsureOnline = browserAgent.ensureOnline;
    spawned = [];
    localAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = require('node:fs').mkdtempSync(
      path.join(require('node:os').tmpdir(), 'bug410-'));
  });

  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.ensureOnline = originalEnsureOnline;
    __setLaunchDepsForTest(null);
    __setAttachedBrowserForTest(null);
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
  });

  // A launch that reaches the spawn: adapter starts OFFLINE, the pre-spawn
  // adopt attempt finds nothing, then the post-spawn connect succeeds.
  function arrangeLaunch(portOwner, chosen) {
    let connectAttempts = 0;
    browserAgent.getStatus = () => (connectAttempts > 0
      ? { state: 'ONLINE', mode: 'cdp', pageCount: 1 }
      : { state: 'OFFLINE', mode: null, pageCount: 0 });
    browserAgent.ensureOnline = async () => {
      // First call is BUG-411's adopt probe: nothing is there yet.
      if (spawned.length === 0) return false;
      connectAttempts += 1;
      return true;
    };
    __setLaunchDepsForTest({
      spawn: (exe, args) => { spawned.push({ exe, args }); return { pid: 999, unref() {} }; },
      resolveLaunchTarget: () => ({ name: chosen, exe: EXE[chosen], source: 'requested' }),
      identifyBrowserOnPort: () => portOwner,
    });
  }

  // (a) (b)
  test('a launch whose port is held by a DIFFERENT browser fails, naming both', async () => {
    arrangeLaunch('brave', 'chrome');
    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, false,
      'relabelling the session and carrying on is what left the operator driving an invisible window');
    assert.match(String(res.result), /Launched chrome/);
    assert.match(String(res.result), /held by brave/);
    assert.match(String(res.result), /not to the window that just opened/,
      'both facts must reach the operator: a new window opened AND it is not the one being driven');
    assert.equal(spawned.length, 1, 'it really did spawn — the failure is about what is ATTACHED');
  });

  test('after that failure nothing claims to be driving anything', async () => {
    arrangeLaunch('brave', 'chrome');
    await browser_launch_debug({ browser: 'chrome' });
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp' });
    const refusal = checkBrowserTarget('chrome');
    assert.ok(refusal, 'a navigate for chrome must not be allowed after a mismatched launch');
    assert.equal(refusal.ok, false);
  });

  // adjacent case
  test('when the observed browser agrees, the launch succeeds and says "verified"', async () => {
    arrangeLaunch('brave', 'brave');
    const res = await browser_launch_debug({ browser: 'brave' });
    assert.equal(res.ok, true);
    assert.equal(res.result.browser, 'brave');
    assert.equal(res.result.browserIdentity, 'verified');
    assert.equal(res.result.launched, true);
    // BUG-408 rides on the same result.
    assert.match(String(res.result.caveat), /MYTHOS's own brave profile/);
  });

  // (d) — AND THE REASON THIS TEST EXISTS. A candidate probe for this ticket
  // was "put `attachedBrowser = want || 'chrome'` back but KEEP the mismatch
  // check". Predicted red; reasoned through, it reddened nothing — every test
  // above happens to pass a `want` equal to the browser chosen, so the old
  // expression and the new one agree on all of them. The mutation was not
  // useless: it named a real uncovered path. On an UNNAMED launch `want` is
  // null, so `want || 'chrome'` reports chrome for a Brave that the search
  // order or the OS default picked — the same wrong-label defect this ticket is
  // about, reached from the other direction. (/kee: a guard nobody knows the
  // bounds of is not a guard.)
  test('an UNNAMED launch reports the browser that was chosen, not a hardcoded chrome', async () => {
    let connectAttempts = 0;
    browserAgent.getStatus = () => (connectAttempts > 0
      ? { state: 'ONLINE', mode: 'cdp', pageCount: 1 }
      : { state: 'OFFLINE', mode: null, pageCount: 0 });
    browserAgent.ensureOnline = async () => {
      if (spawned.length === 0) return false;
      connectAttempts += 1;
      return true;
    };
    __setLaunchDepsForTest({
      spawn: (exe, args) => { spawned.push({ exe, args }); return { pid: 999, unref() {} }; },
      // No name was requested; the OS default chose brave.
      resolveLaunchTarget: () => ({ name: 'brave', exe: EXE.brave, source: 'os-default' }),
      identifyBrowserOnPort: () => 'brave',
    });

    const res = await browser_launch_debug({});
    assert.equal(res.ok, true);
    assert.equal(res.result.browser, 'brave',
      'the request named nothing, so the answer must come from what was chosen and observed — never a default literal');
    assert.equal(res.result.browserSource, 'os-default');
  });

  // (b) (c)
  test('an unreadable port owner is "assumed", and never becomes a verified claim', async () => {
    arrangeLaunch(null, 'chrome');
    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, true, 'a machine that cannot read the port owner must still be able to launch');
    assert.equal(res.result.browserIdentity, 'assumed',
      '"assumed" is the true word for it — the same distinction BUG-106 draws between knowing and vouching');
    assert.equal(res.result.browser, 'chrome');
  });

  // Driven through the REAL implementation in browser-process.js with an
  // injected processOnPort, not through a stub of the whole oracle. The function
  // moved out of from-browser.js during this ticket's own self-review (it was
  // one file away from its data source), and the first version of this test
  // monkey-patched `browserAgent.processOnPort` — which the moved code does not
  // read, so the test would have gone on passing while exercising nothing. That
  // is the false-green shape (/kee class 14), caught by the move.
  test('the identity oracle answers null for "cannot tell", never a guess', () => {
    const at = (owner) => bp.identifyBrowserOnPort('http://127.0.0.1:9222', { processOnPort: owner });
    assert.equal(at(() => ({ pid: 21708, exe: EXE.chrome })), 'chrome');
    assert.equal(at(() => ({ pid: 24080, exe: EXE.brave })), 'brave',
      'brave.exe must be identifiable — the CDP product string says Chrome for both');
    assert.equal(at(() => null), null);
    assert.equal(at(() => ({ pid: 1, exe: 'C:\\x\\firefox.exe' })), null,
      'a browser MYTHOS cannot drive is unknown, not a mismatch and not a match');
    assert.equal(at(() => ({ pid: 1, exe: null })), null, 'a process with no path is not an identity');
    assert.equal(at(() => { throw new Error('powershell missing'); }), null,
      'the oracle runs on the launch path — it must degrade, never fail the launch');
    const good = () => ({ pid: 1, exe: EXE.chrome });
    assert.equal(bp.identifyBrowserOnPort('not a url', { processOnPort: good }), null);
    assert.equal(bp.identifyBrowserOnPort('http://127.0.0.1/', { processOnPort: good }), null,
      'no port, no answer');
  });

  test('the effector delegates to the adapter rather than keeping a second copy', () => {
    assert.equal(browserAgent.identifyBrowserOnPort, bp.identifyBrowserOnPort,
      'one implementation, exported through the adapter the effector already talks to');
    assert.equal(typeof browserMod.identifyBrowserOnPort, 'function',
      'and from-browser keeps a named seam, so the launch path stays readable');
  });

  test('processOnPort rejects a port number it cannot use', () => {
    // Guards the string interpolated into the PowerShell query. Anything but a
    // real port must never reach it.
    for (const bad of [0, -1, 70000, 'nine', null, undefined, 1.5]) {
      assert.equal(bp.processOnPort(bad, { execFileSync: () => { throw new Error('must not run'); } }), null,
        JSON.stringify(bad) + ' must not reach the query');
    }
  });

  test('processOnPort reads the owning process, and reports "could not tell" as null', () => {
    const ok = bp.processOnPort(9222, { execFileSync: () => Buffer.from('21708=' + EXE.chrome) });
    assert.deepEqual(ok, { pid: 21708, exe: EXE.chrome });
    assert.equal(bp.processOnPort(9222, { execFileSync: () => Buffer.from('') }), null, 'nothing listening');
    assert.equal(bp.processOnPort(9222, { execFileSync: () => { throw new Error('blocked'); } }), null,
      'a blocked or absent PowerShell is ignorance, not "nothing is running"');
  });
});
