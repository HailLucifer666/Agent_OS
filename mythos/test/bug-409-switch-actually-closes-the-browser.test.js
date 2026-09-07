'use strict';

// test/bug-409-switch-actually-closes-the-browser.test.js
//
// BUG-409. browser_switch closed nothing. It called browserAgent.disconnect(),
// which for a CDP-attached browser runs playwright's browser.close() — and
// playwright's own types say what that does: "In case this browser is CONNECTED
// TO, clears all created contexts belonging to this browser and DISCONNECTS
// FROM THE BROWSER SERVER." `launched` is true only inside launchLocal(), and
// browser_launch_debug spawns the process itself and then attaches, so every
// debug browser MYTHOS starts took that branch.
//
// Reproduced live 2026-09-03 on a spawned Brave, port 9223:
//     after 3s               : pid 13152 alive, port owner 13152
//     after browser.close()  : pid 13152 ALIVE, port owner 13152
//     after CDP Browser.close: pid 13152 gone,  port owner (none)
// browser_switch then launched the next browser onto a port the old one still
// held — which is why "sometimes two or three browsers open at once" and "it
// opened YouTube but could not act on it" are one defect and not two.
//
// AND WHY THE CDP CLOSE ALONE IS NOT THE FIX. Measured across 10 trials:
//     warm profile, chrome x3   close=resolved   survivors: none
//     warm profile, brave  x3   close=resolved   survivors: none
//     cold profile, chrome x2   close=RESOLVED   survivors: chrome.exe
//     cold profile, brave  x2   close=resolved   survivors: none
// A first-run Chrome sits on chrome://intro/default-browser — its own
// make-me-default flow — and that outlives Browser.close while the command
// still reports success. /kee class 15: a resolved call standing in for a
// multi-way outcome. So the close VERIFIES against the process table and
// ESCALATES, and `method` records which step actually worked.
//
// MUTATION PROBES, run 2026-09-03, each green BEFORE this change:
//   (a) closeDebugBrowser: return {closed:true} straight after sendClose,
//       skipping the verification poll -> reds (a), the cold-profile case.
//   (b) closeDebugBrowser: treat a null process list as an empty one
//       -> reds (b) (an unreadable process table becomes a claimed close).
//   (c) closeDebugBrowser: delete the "look FIRST" pre-check -> reds (c)
//       (nothing of ours running is reported as a successful close, which
//       would let browser_switch launch onto a held port again).
//   (d) isMythosDebugProfile: `return typeof dir === 'string'` -> reds (d)
//       on the empty string and on a real user profile path.
//   (e) browser_switch: launch anyway when the close verdict says it failed
//       -> reds (e).
//   (f) parseProcessRows, run as two halves because it guards two things:
//       (f1) drop the `Number.isInteger(pid) || pid <= 0` check -> reds (f)
//            on the pid-0 row;
//       (f2) fall back to split('=') for a line the pattern rejects -> reds
//            (f) on the NaN row.
//       The single combined edit NEVER APPLIED on the first pass (mis-escaped
//       regex literal in the harness) and was silently reported as a probe.
//       Recorded, because a probe that does not apply is indistinguishable
//       from a guard that works.
// Every probe was verified APPLIED (file diffed on disk) and verified to still
// LOAD, then restored from a full-path copy re-checked by sha256.
//
// ADJACENT CASES THAT MUST KEEP PASSING: a warm-profile close must still report
// method 'cdp' and NOT taskkill anything (escalating always would be a
// different bug wearing this fix's clothes); and browser_switch must still
// refuse outright for a browser MYTHOS did not launch — that is BUG-106's
// invariant and this ticket does not touch it.
//
// No browser, no port and no PowerShell are involved: the process list, the
// killer and the CDP send are all injected.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bp = require('../adapters/browser-agent/browser-process');
const browserAgent = require('../adapters/browser-agent');
const browserMod = require('../src/core/effectors/from-browser');

const { browser_switch, __setAttachedBrowserForTest } = browserMod;

const OURS = path.join('C:', 'Users', 'x', 'AppData', 'Local', 'MYTHOS', 'brave-debug-profile');
const NOWAIT = { sleep: async () => {}, ceilingMs: 0, intervalMs: 0 };

function lister(sequence) {
  // Each call returns the next entry; the last repeats, so a poll that runs
  // longer than the script does not fall off the end.
  let i = 0;
  return () => sequence[Math.min(i++, sequence.length - 1)];
}

describe('BUG-409 — the close verifies, then escalates', () => {
  test('unknown ownership cannot authorize CDP close', async () => {
    let closes = 0;
    const result = await bp.closeDebugBrowser({ profileDir: OURS,
      sendClose: async () => { closes += 1; },
      deps: { ...NOWAIT, processesForProfile: () => null },
    });
    assert.equal(closes, 0);
    assert.equal(result.closed, false);
    assert.equal(result.method, 'unknown');
  });

  test('an unreadable process table after kill is not proof of exit', async () => {
    const result = await bp.closeDebugBrowser({ profileDir: OURS,
      sendClose: async () => {},
      deps: { ...NOWAIT, processesForProfile: lister([
        [{ pid: 15048, name: 'chrome.exe' }], [{ pid: 15048, name: 'chrome.exe' }], null,
      ]), killProcess: () => true },
    });
    assert.equal(result.closed, false);
    assert.equal(result.method, 'unknown');
  });

  // (d)
  test('the profile directory IS the authorisation, and it is strict', () => {
    assert.equal(bp.isMythosDebugProfile(OURS), true);
    for (const bad of [
      '', ' ', null, undefined, 42,
      // The empty-string case is the dangerous one: a `-like '**'` filter built
      // from it matches every process on the machine.
      'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data',
      'C:\\Users\\x\\AppData\\Local\\MYTHOS\\vault',
      'C:\\MYTHOS',
      'MYTHOS\\brave-debug-profile',
      'C:\\Users\\x\\MYTHOS\\brave-debug-profile-backup',
      'C:\\Users\\x\\AppData\\Local\\MYTHOS\\*-debug-profile',
      'C:\\Users\\x\\AppData\\Local\\mythos\\brave-debug-profile',
    ]) {
      assert.equal(bp.isMythosDebugProfile(bad), false, JSON.stringify(bad) + ' must not authorise a kill');
    }
  });

  test('a refused directory kills nothing and says why', async () => {
    let kills = 0;
    const r = await bp.closeDebugBrowser({
      profileDir: '',
      sendClose: async () => {},
      deps: Object.assign({}, NOWAIT, {
        processesForProfile: () => { throw new Error('must never be asked'); },
        killProcess: () => { kills += 1; return true; },
      }),
    });
    assert.equal(r.closed, false);
    assert.equal(r.method, 'refused');
    assert.equal(kills, 0);
    assert.match(r.reason, /not a MYTHOS debug profile/);
  });

  // (c)
  test('nothing of ours running is "not-ours", NOT a successful close', async () => {
    let closeSent = false;
    const r = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: async () => { closeSent = true; },
      deps: Object.assign({}, NOWAIT, { processesForProfile: () => [] }),
    });
    assert.equal(r.closed, false, 'reporting this as closed is how the fix would rebuild the bug');
    assert.equal(r.method, 'not-ours');
    assert.equal(closeSent, false, 'and it must not even ask — there is nothing of ours to ask');
    assert.match(r.reason, /not one MYTHOS launched/);
  });

  // adjacent case: the warm-profile path must NOT escalate
  test('a close that works reports cdp and terminates nothing', async () => {
    let kills = 0;
    const r = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: async () => {},
      deps: Object.assign({}, NOWAIT, {
        processesForProfile: lister([[{ pid: 13152, name: 'brave.exe' }], []]),
        killProcess: () => { kills += 1; return true; },
      }),
    });
    assert.deepEqual({ closed: r.closed, method: r.method }, { closed: true, method: 'cdp' });
    assert.equal(kills, 0, 'escalating on a browser that already exited would be its own defect');
  });

  // (a) — the measured cold-profile Chrome
  test('a close that RESOLVES and leaves the browser running escalates to a kill', async () => {
    const killed = [];
    const r = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: async () => {}, // resolves, exactly as Chrome's did
      deps: Object.assign({}, NOWAIT, {
        // survives the whole verification window, then is gone after the kill
        processesForProfile: lister([
          [{ pid: 15048, name: 'chrome.exe' }],
          [{ pid: 15048, name: 'chrome.exe' }],
          [],
        ]),
        killProcess: (pid) => { killed.push(pid); return true; },
      }),
    });
    assert.deepEqual({ closed: r.closed, method: r.method }, { closed: true, method: 'kill' });
    assert.deepEqual(killed, [15048]);
    assert.match(r.reason, /acknowledged the close but stayed running/,
      'the reason must name what happened, or a first-run survivor looks like a clean close');
  });

  test('a kill that does not take is reported as a failure with the survivors named', async () => {
    const r = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: async () => {},
      deps: Object.assign({}, NOWAIT, {
        processesForProfile: () => [{ pid: 15048, name: 'chrome.exe' }],
        killProcess: () => false,
      }),
    });
    assert.equal(r.closed, false);
    assert.equal(r.method, 'none');
    assert.deepEqual(r.survivors, [{ pid: 15048, name: 'chrome.exe' }]);
    assert.match(r.reason, /chrome\.exe pid 15048/);
  });

  // (b)
  test('an unreadable process table is "unknown" — never a claimed close', async () => {
    const r = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: async () => {},
      deps: Object.assign({}, NOWAIT, { processesForProfile: lister([[{ pid: 7, name: 'brave.exe' }], null]) }),
    });
    assert.equal(r.closed, false, 'the CDP ack alone is the evidence measured to be wrong');
    assert.equal(r.method, 'unknown');
    assert.match(r.reason, /could not verify it exited/);
  });

  test('a CDP session that throws still verifies, and carries the reason', async () => {
    const r = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: async () => { throw new Error('Target closed'); },
      deps: Object.assign({}, NOWAIT, { processesForProfile: lister([[{ pid: 7, name: 'brave.exe' }], []]) }),
    });
    assert.equal(r.closed, true, 'the browser did exit — a throwing ack does not make that untrue');
    const r2 = await bp.closeDebugBrowser({
      profileDir: OURS,
      sendClose: null, // no live handle at all
      deps: Object.assign({}, NOWAIT, { processesForProfile: lister([[{ pid: 7, name: 'brave.exe' }], null]) }),
    });
    assert.match(r2.reason, /no CDP session was available to ask/);
  });

  // (f)
  test('the process-row parser refuses a row it cannot trust', () => {
    assert.deepEqual(bp.parseProcessRows('  13152=brave.exe\r\n15048=chrome.exe'),
      [{ pid: 13152, name: 'brave.exe' }, { pid: 15048, name: 'chrome.exe' }]);
    assert.deepEqual(bp.parseProcessRows('notapid=chrome.exe'), [],
      'a NaN pid reaching taskkill is a very bad kind of surprise');
    assert.deepEqual(bp.parseProcessRows('0=chrome.exe'), [], 'pid 0 is not a process to kill');
    assert.deepEqual(bp.parseProcessRows(''), []);
    assert.deepEqual(bp.parseProcessRows(null), []);
    assert.deepEqual(bp.parseProcessRows('9=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
      [{ pid: 9, name: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }],
      'processOnPort puts a full path in the second field — the parser must keep it whole');
  });

  test('processesForProfile refuses an unauthorised directory before asking Windows anything', () => {
    // Returns [] rather than shelling out, so a bad directory cannot become a
    // machine-wide query even in the read path.
    assert.deepEqual(bp.processesForProfile(''), []);
    assert.deepEqual(bp.processesForProfile('C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data'), []);
  });
});

// (e)
describe('BUG-409 — browser_switch refuses to launch when the close failed', () => {
  let originalGetStatus, originalClose, originalEnsureOnline;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalClose = browserAgent.closeLaunchedBrowser;
    originalEnsureOnline = browserAgent.ensureOnline;
  });

  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.closeLaunchedBrowser = originalClose;
    browserAgent.ensureOnline = originalEnsureOnline;
    __setAttachedBrowserForTest(null);
  });

  test('a failed close does NOT launch the next browser on top of it', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp' });
    browserAgent.ensureOnline = async () => { throw new Error('must never reach a launch'); };
    browserAgent.closeLaunchedBrowser = async () => ({
      closed: false, method: 'none', survivors: [{ pid: 15048, name: 'chrome.exe' }],
      reason: 'the browser did not close and could not be terminated: chrome.exe pid 15048',
    });

    const res = await browser_switch({ browser: 'chrome' });
    assert.equal(res.ok, false, 'launching onto a held port is the whole of BUG-409');
    assert.match(String(res.result), /Could not close brave/);
    assert.match(String(res.result), /chrome\.exe pid 15048/, 'the survivor must reach the operator');
    assert.match(String(res.result), /Close the brave window yourself/);
  });

  test('a close whose verdict is missing entirely is treated as a failure', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp' });
    browserAgent.ensureOnline = async () => { throw new Error('must never reach a launch'); };
    browserAgent.closeLaunchedBrowser = async () => undefined;
    const res = await browser_switch({ browser: 'chrome' });
    assert.equal(res.ok, false, 'an absent verdict must not read as consent to launch');
  });
});
