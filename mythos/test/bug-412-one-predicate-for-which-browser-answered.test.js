'use strict';

// test/bug-412-one-predicate-for-which-browser-answered.test.js
//
// BUG-412 — found by running the scope gates against BUG-407..411's OWN commit,
// hours after it was pushed. Gate B: derive the set from the reason, not from
// the diff. The reason those tickets gave was "an identity taken from the
// request instead of from what answered". That is not a property of one branch,
// and the first pass fixed one branch.
//
// THREE SITES THE FIRST PASS MISSED, all in files it had just edited:
//
//   1. `requireOnline()` in from-browser.js ended with
//        attachedBrowser = status.mode === 'launched' ? 'chrome' : null;
//      launchLocal tries playwright channel 'chrome' and FALLS BACK to
//      'msedge', so a machine without Chrome launched EDGE and this labelled it
//      chrome. BUG-410's exact defect, twenty lines above BUG-410's fix.
//      Worse: the comment justifying the literal claimed parity with
//      browser_launch_debug's unnamed path — and BUG-407 had just made that
//      false by teaching the unnamed path to read the OS default. The fix broke
//      the argument for the neighbouring line and left the line (/kee class 11,
//      and class 10 for the comment).
//
//   2. `browser_launch_debug`'s already-ONLINE branch guarded with
//        if (want && attachedBrowser && attachedBrowser !== want)
//      which SKIPS ITSELF whenever attachedBrowser is null — returning
//      ok({ alreadyOnline: true, browser: 'unknown' }) for a request that named
//      brave. The adopt path added in BUG-411 refuses exactly that case. Same
//      predicate, opposite answers, in one function.
//
//   3. `browser_launch_debug`'s CONNECTING branch never compared `want` at all.
//      DELIBERATELY LEFT — see the disposition test at the bottom.
//
// The fix is one predicate, `namedRequestRefusal`, with the three callers
// passing what they know. `attached` (BUG-106's value: non-null means MYTHOS
// launched it) selects the remedy, because browser_switch can close our own
// browser and nothing can safely close someone else's.
//
// MUTATION PROBES, run 2026-09-03, each verified applied on disk, verified to
// still load, and reverted from a full-path copy:
//   (a) namedRequestRefusal: `if (!identity) return null;` — treat an
//       unknowable identity as satisfiable -> reds (a).
//   (b) namedRequestRefusal: always return the browser_switch remedy,
//       ignoring `ours` -> reds (b), the not-ours wording.
//   (c) restore the ONLINE branch's `want && attachedBrowser && ...` guard
//       -> reds (c).
//   (d) browserNameForChannel: return 'chrome' for any input -> reds (d).
//   (e) launchLocal: stop recording launchedChannel on the msedge fallback.
//       REDDENED NOTHING on the first run — bug-106's test stubs
//       ensureOnline/getStatus, so it asserted the CONSUMER while nothing
//       asserted the PRODUCER, and the fix's own new field could be deleted
//       from the branch that needed it most with the suite still green. Now
//       reds the launchLocal pairing test written for it.
//   (f) namedRequestRefusal: probe unconditionally instead of only when the
//       identity cannot be vouched for -> reds (f), four cases including the
//       happy path, because a probe that always runs also overrides `attached`.
//   (g) from-browser's delegation: replace the body with `return null`.
//       ALSO REDDENED NOTHING at first — the test "asserting" the delegation
//       compared two exports and a typeof, neither of which the mutation
//       touches. Two vacuous guards out of seven probes, in a file written
//       specifically about vacuous guards.
//
// ADJACENT CASES THAT MUST KEEP PASSING, and they are the point: an UNNAMED
// request must never be refused by any of this, and a named request that
// MATCHES what is attached must go straight through. A predicate that refuses
// too much would pass every assertion above.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bt = require('../src/core/effectors/browser-target');
const browserAgent = require('../adapters/browser-agent');
const browserMod = require('../src/core/effectors/from-browser');

const { browser_launch_debug, __setLaunchDepsForTest, __setAttachedBrowserForTest } = browserMod;

describe('BUG-412 — one predicate for "is what answered what was asked?"', () => {
  // (a)
  test('an unknowable identity REFUSES a named request', () => {
    const r = bt.namedRequestRefusal({ want: 'chrome', attached: null, probe: () => null });
    assert.match(String(r), /cannot tell which browser it is/);
    assert.match(String(r), /will not claim to be driving chrome/);
  });

  // (b)
  test('the remedy depends on whether MYTHOS can safely close it', () => {
    const ours = bt.namedRequestRefusal({ want: 'chrome', attached: 'brave' });
    assert.match(String(ours), /brave already owns the debug port/);
    assert.match(String(ours), /Call browser_switch/,
      'BUG-107: MYTHOS can close its own browser, so name the tool that does it');

    const theirs = bt.namedRequestRefusal({ want: 'chrome', attached: null, probe: () => 'brave' });
    assert.match(String(theirs), /it is brave, not chrome/);
    assert.match(String(theirs), /close that brave window yourself/,
      'nothing can safely close a window MYTHOS did not open — that is the only true remedy');
    assert.doesNotMatch(String(theirs), /browser_switch/,
      'and browser_switch must NOT be offered for it: browser-process.js refuses that close');
  });

  // the adjacent cases — a predicate that refuses too much passes everything above
  test('an UNNAMED request is never refused, whatever is attached', () => {
    for (const attached of [null, 'brave', 'chrome']) {
      for (const want of [undefined, null, '']) {
        assert.equal(bt.namedRequestRefusal({ want, attached, probe: () => 'edge' }), null,
          `want=${JSON.stringify(want)} attached=${JSON.stringify(attached)} must pass`);
      }
    }
  });

  test('a named request that MATCHES goes straight through, ours or not', () => {
    assert.equal(bt.namedRequestRefusal({ want: 'chrome', attached: 'chrome' }), null);
    assert.equal(bt.namedRequestRefusal({ want: 'chrome', attached: null, probe: () => 'chrome' }), null);
    assert.equal(bt.namedRequestRefusal({ want: 'Google Chrome', attached: 'chrome' }), null,
      'the operator says "google chrome" out loud, so the alias must resolve before comparing');
  });

  test('the probe is LAZY and never allowed to throw the caller', () => {
    let probes = 0;
    bt.namedRequestRefusal({ want: 'chrome', attached: 'chrome', probe: () => { probes += 1; return 'chrome'; } });
    assert.equal(probes, 0, 'we can already vouch for it — a PowerShell round trip here is pure cost');
    bt.namedRequestRefusal({ want: null, attached: null, probe: () => { probes += 1; return 'chrome'; } });
    assert.equal(probes, 0, 'nothing was named, so there is nothing to check');
    const r = bt.namedRequestRefusal({ want: 'chrome', attached: null, probe: () => { throw new Error('ps gone'); } });
    assert.match(String(r), /cannot tell which browser it is/,
      'a throwing probe degrades to "unknown", it does not propagate');
  });

  // (e) — AND THE REASON THIS TEST EXISTS. Probe (e) deleted
  // `launchedChannel = 'msedge'` from launchLocal's fallback and reddened
  // NOTHING: bug-106's test stubs ensureOnline/getStatus, so it asserts the
  // CONSUMER (requireOnline reads the channel) while nothing asserted the
  // PRODUCER. A false green of the purest kind — the fix's own new field could
  // be deleted from the branch that needed it most and every test stayed green.
  //
  // launchPersistentContext cannot be driven here without launching a real
  // browser, so this is a source-shape check — but a DERIVED one. It extracts
  // the channels launchLocal actually asks playwright for and the channels it
  // records, then compares the two sets. That catches a deleted assignment AND
  // the worse shape: recording 'chrome' on the msedge branch.
  test('launchLocal RECORDS every channel it asks playwright for, and pairs them correctly', () => {
    const src = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'adapters', 'browser-agent', 'index.js'), 'utf8');
    const body = src.slice(src.indexOf('async function launchLocal'), src.indexOf('async function ensureOnline'));
    assert.ok(body.length > 200, 'launchLocal must be findable — this guard is worthless if the slice is empty');

    const asked = [...body.matchAll(/channel:\s*'([^']+)'/g)].map((m) => m[1]);
    const recorded = [...body.matchAll(/launchedChannel\s*=\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(asked.length >= 2, 'launchLocal tries chrome then falls back to msedge');
    assert.deepEqual(recorded, asked,
      'every channel launchLocal asks for must be recorded, IN THE SAME ORDER — a missing '
      + 'assignment loses the identity, and a mismatched pair reports the wrong browser, '
      + 'which is the defect this whole ticket is about');
  });

  // (g) — same story. Probe (g) replaced the delegation body with `return null`
  // and reddened nothing, because the test asserting the delegation compared
  // two exports and a typeof, neither of which the mutation touches. A guard
  // that passes vacuously is not a guard.
  test('from-browser really delegates the oracle rather than answering for itself', () => {
    const original = browserAgent.identifyBrowserOnPort;
    try {
      browserAgent.identifyBrowserOnPort = (url) => 'edge:' + url;
      assert.equal(browserMod.identifyBrowserOnPort('http://127.0.0.1:9222'), 'edge:http://127.0.0.1:9222',
        'the effector must return what the adapter says, not a value of its own');
      browserAgent.identifyBrowserOnPort = undefined;
      assert.equal(browserMod.identifyBrowserOnPort('http://127.0.0.1:9222'), null,
        'and degrade to null when the adapter does not export it');
    } finally {
      browserAgent.identifyBrowserOnPort = original;
    }
  });

  // (d)
  test('a playwright CHANNEL resolves to a browser name through the alias table', () => {
    assert.equal(bt.browserNameForChannel('chrome'), 'chrome');
    assert.equal(bt.browserNameForChannel('msedge'), 'edge',
      'msedge is the channel name and edge is the browser name — this is the pair that was mislabelled');
    assert.equal(bt.browserNameForChannel(null), null);
    assert.equal(bt.browserNameForChannel('chrome-beta'), null, 'unknown stays unknown, never a guess');
  });
});

// (c)
describe('BUG-412 — the already-ONLINE branch no longer skips its own guard', () => {
  let originalGetStatus, originalEnsureOnline;

  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalEnsureOnline = browserAgent.ensureOnline;
  });
  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.ensureOnline = originalEnsureOnline;
    __setLaunchDepsForTest(null);
    __setAttachedBrowserForTest(null);
  });

  test('ONLINE with an unvouched-for browser refuses a NAMED request', async () => {
    __setAttachedBrowserForTest(null); // BUG-106: null means "we did not launch it"
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp', pageCount: 1 });
    browserAgent.ensureOnline = async () => { throw new Error('must not connect'); };
    __setLaunchDepsForTest({
      spawn: () => { throw new Error('must not spawn'); },
      identifyBrowserOnPort: () => null,
    });

    const res = await browser_launch_debug({ browser: 'brave' });
    assert.equal(res.ok, false,
      'ok({browser:"unknown"}) for a request that named brave is a false success — the adopt path refuses it');
    assert.match(String(res.result), /cannot tell which browser it is/);
  });

  test('ONLINE with an unvouched-for browser that the PORT identifies as another one names both', async () => {
    __setAttachedBrowserForTest(null);
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp', pageCount: 1 });
    __setLaunchDepsForTest({
      spawn: () => { throw new Error('must not spawn'); },
      identifyBrowserOnPort: () => 'chrome',
    });
    const res = await browser_launch_debug({ browser: 'brave' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /it is chrome, not brave/);
  });

  test('ONLINE and UNNAMED still reports alreadyOnline without probing anything', async () => {
    __setAttachedBrowserForTest(null);
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp', pageCount: 1 });
    let probed = 0;
    __setLaunchDepsForTest({
      spawn: () => { throw new Error('must not spawn'); },
      identifyBrowserOnPort: () => { probed += 1; return 'chrome'; },
    });
    const res = await browser_launch_debug({});
    assert.equal(res.ok, true);
    assert.equal(res.result.alreadyOnline, true);
    assert.equal(res.result.browser, 'unknown', 'honest about the identity without refusing');
    assert.equal(probed, 0, 'nothing was named, so the round trip must not be paid');
  });

  test('ONLINE and NAMED-and-ours still succeeds — the guard must not fire on the happy path', async () => {
    __setAttachedBrowserForTest('brave');
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp', pageCount: 1 });
    __setLaunchDepsForTest({ spawn: () => { throw new Error('must not spawn'); } });
    const res = await browser_launch_debug({ browser: 'brave' });
    assert.equal(res.ok, true);
    assert.equal(res.result.alreadyOnline, true);
    assert.equal(res.result.browser, 'brave');
  });
});

// Disposition, pinned. /kee: "deliberately not changing behaviour -> say why in
// code and add a regression test that locks it in."
describe('BUG-412 — the CONNECTING branch is deliberately left alone', () => {
  let originalGetStatus, originalEnsureOnline;
  beforeEach(() => {
    originalGetStatus = browserAgent.getStatus;
    originalEnsureOnline = browserAgent.ensureOnline;
  });
  afterEach(() => {
    browserAgent.getStatus = originalGetStatus;
    browserAgent.ensureOnline = originalEnsureOnline;
    __setLaunchDepsForTest(null);
    __setAttachedBrowserForTest(null);
  });

  test('a NAMED request that joins an in-flight connect still succeeds', async () => {
    // A `want` check WAS added here and reverted. The identity of a connect
    // still in flight is not unknown, it is not yet decidable — and refusing
    // turned a poller race into a hard failure of browser_switch, which
    // bug-107's own tests caught. The ACTION stays guarded one step later:
    // checkBrowserTarget() refuses a named browser_navigate while
    // attachedBrowser is null. What remains is a narration cost, not a wrong
    // action, and it is recorded in BUGS.md rather than forced here.
    __setAttachedBrowserForTest(null);
    browserAgent.getStatus = () => ({ state: 'CONNECTING', mode: null, pageCount: 0 });
    browserAgent.ensureOnline = async () => true;
    __setLaunchDepsForTest({
      spawn: () => { throw new Error('must not spawn'); },
      identifyBrowserOnPort: () => { throw new Error('must not probe a connect in flight'); },
    });

    const res = await browser_launch_debug({ browser: 'chrome' });
    assert.equal(res.ok, true, 'refusing here breaks browser_switch on a poller race');
    assert.equal(res.result.launched, false);
  });

  test('and the ACTION it would have guarded is still refused downstream', () => {
    // The reason the narration cost is acceptable: nothing acts on the
    // unverified identity. This is the guard that makes the disposition safe.
    __setAttachedBrowserForTest(null);
    browserAgent.getStatus = () => ({ state: 'ONLINE', mode: 'cdp' });
    const refusal = browserMod.checkBrowserTarget('chrome');
    assert.ok(refusal && refusal.ok === false);
    assert.match(String(refusal.result), /cannot confirm which browser is attached/);
  });

  test('the disposition is written where the next editor will read it', () => {
    const src = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-browser.js'), 'utf8');
    assert.match(src, /DISPOSITION \(self-review, second round\)/);
    assert.match(src, /BUG-412/);
  });
});
