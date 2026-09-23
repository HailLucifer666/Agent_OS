'use strict';

// bug-414-external-open-oracle.test.js — BUG-414.
//
// WHAT THE TICKET SAID, AND WHY IT WAS WRONG. BUG-414 was filed as a tool
// SELECTION defect — "the voice model reaches for the HUD card tool when the
// operator asks to open a website" — off a 97:4 ratio of open_web to
// browser_navigate, with a proposed rename of open_web to show_hud_card.
// Measuring the operator's own Audit vault before writing any code (gate A)
// disproved it. 2026-08-18..09-08, REQUEST rows only:
//
//   open_web with browser:true (the real browser)   33
//   open_web as a HUD card                          75  — 32 search, 30 youtube,
//                                                        6 weather, 4 flights,
//                                                        2 web, 1 image
//
// Exactly one card-only row is website-shaped and it is type:"youtube" with a
// watch URL, which is that type used correctly. The model picks the right
// surface. The rename would have moved the word "open" away from the only code
// path that has been opening the operator's browser.
//
// WHAT THE SAME ROWS DO SAY. Of the 33 real-browser opens, ZERO are verified —
// 27 ok+unverified, 3 failed, 3 with no outcome row. Every one of them told the
// operator it could not confirm the page rendered. "It did not even open" is
// what that feels like from outside, working or not.
//
// It is a sibling-path gap. from-dashboard.js's HUD branch got a real render ack
// in BUG-273 B3 and returns verifiedOk when the dashboard answers (32 of the 75
// above); the browser branch returned straight out of the hand-off and asked
// nothing. That file's own comment predicted it: "BUG-272 T2 only ever fixed the
// browser:true branch; this is the dashboard one."
//
// MUTATION PROBES — all five run 2026-09-09, all five landed (the driver
// re-read the file and confirmed the text changed before running anything), all
// five fired, no survivors, and the source was restored from a byte copy with a
// matching sha256 afterwards. `git checkout --` would have been the wrong
// restore here: the file is already modified against HEAD. Recorded with the
// date because an unrecorded probe protects this commit and nothing after it.
//
//   (m1) classifyBrowserWindows drops its processName filter, matching ANY
//        window that carries the token
//        -> 1 fail: (c) "a matching title on another process is not this browser"
//   (m2) titleTokenForUrl keeps the FIRST usable label instead of the longest
//        -> 1 fail: (a) "takes the longest usable label" — news.google.com
//   (m3) settleExternalOpen returns early with noOracle() on a match
//        -> 4 fails, which is the honest count and more than first expected:
//           (d) verifiedOk, "keeps polling", (g) the disposition test, and the
//           OS-default case. Every assertion that reads isVerified() is
//           downstream of that one line.
//   (m4) the pc-child-offline branch stops naming pc-child
//        -> 1 fail: (e) "pc-child offline is named"
//   (m5) the browser-absent reason is reworded to lead with "nothing opened"
//        -> 1 fail: (f), the test that stops this fix trading one false claim
//           for its opposite
// ADJACENT CASES THAT MUST KEEP PASSING, and do: (h) and (i) below — every path
// where the oracle cannot run must return the PRE-FIX reason, byte for byte.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const evidence = require('../src/core/effectors/evidence');
const externalRoute = require('../src/core/effectors/open-external-route');
const { buildTools } = require('../src/core/effectors/from-dashboard');

const { titleTokenForUrl, classifyBrowserWindows, settleExternalOpen } = externalRoute;

// The exact string this route returned for every call before BUG-414. Held as a
// constant because three tests below assert it is STILL what comes back wherever
// the oracle cannot run — a fix that silently reworded the fallback would look
// identical to one that broke it.
const PRE_FIX_REASON = 'whether the page actually rendered in the browser';

function win(overrides) {
  return Object.assign({
    pid: 4242, processName: 'brave', title: 'New Tab - Brave', visible: true,
  }, overrides || {});
}

function windowLister(windowsPerCall) {
  const calls = [];
  const lister = async () => {
    const windows = windowsPerCall[Math.min(calls.length, windowsPerCall.length - 1)];
    calls.push(windows);
    return { ok: true, result: { windows } };
  };
  lister.calls = calls;
  return lister;
}

function settle(opts) {
  const o = opts || {};
  return settleExternalOpen({
    href: o.href || 'https://www.youtube.com',
    handoff: o.handoff || { opened: true, via: 'named-browser', browser: 'brave' },
    payload: { ok: true, result: { widgetType: 'newtab', url: o.href || 'https://www.youtube.com', handedToBrowser: true } },
  }, Object.assign({ sleep: async () => {} }, o.deps || {}));
}

describe('BUG-414 (a) — the title token is derived from the hostname, never a site table', () => {
  it('takes the longest usable label, so a subdomain cannot beat the brand', () => {
    assert.equal(titleTokenForUrl('https://www.youtube.com'), 'youtube');
    assert.equal(titleTokenForUrl('https://news.google.com'), 'google',
      '(m2) the FIRST label is "news"; the distinctive one is "google"');
    assert.equal(titleTokenForUrl('https://mail.google.com/mail/u/0'), 'google');
    assert.equal(titleTokenForUrl('https://open.bigmodel.cn/'), 'bigmodel',
      '"open" is 4 characters and generic; "bigmodel" is the longer label');
    assert.equal(titleTokenForUrl('https://github.com'), 'github');
    assert.equal(titleTokenForUrl('https://www.microsoft.com'), 'microsoft');
  });

  it('never yields a two-letter label, so co.uk cannot contribute "co"', () => {
    assert.equal(titleTokenForUrl('https://www.google.co.uk/maps'), 'google');
  });

  it('answers null rather than guessing when no label can carry a title', () => {
    assert.equal(titleTokenForUrl('https://127.0.0.1:8080/x'), null,
      'an IP has no alphabetic label — the oracle must be skipped, not approximated');
    assert.equal(titleTokenForUrl('not a url'), null);
    assert.equal(titleTokenForUrl(''), null);
    assert.equal(titleTokenForUrl(undefined), null);
  });
});

describe('BUG-414 (b,c) — classification is scoped to the browser process', () => {
  it('finds the page when the browser owns a window titled for it', () => {
    const seen = classifyBrowserWindows(
      [win({ title: 'YouTube - Brave' }), win({ pid: 9, title: 'Untitled - Notepad', processName: 'notepad' })],
      'brave', 'youtube');
    assert.equal(seen.verdict, 'match');
    assert.equal(seen.window.pid, 4242);
  });

  it('(c) a matching title on another process is not this browser', () => {
    // (m1). from-pc's findWindowByTitle searches EVERY window, so a Notepad
    // document called youtube-notes.txt would satisfy it — the same
    // title-matched-an-unrelated-window trap ps-automation.ps1 refuses by name
    // for launch_app.
    const seen = classifyBrowserWindows(
      [win({ pid: 77, processName: 'notepad', title: 'youtube-notes.txt - Notepad' })],
      'brave', 'youtube');
    assert.equal(seen.verdict, 'browser-absent',
      'no BRAVE window exists; a Notepad file named after the site proves nothing');
    assert.equal(seen.window, null);
  });

  it('separates "the browser is not there" from "the browser is there without the page"', () => {
    assert.equal(classifyBrowserWindows([], 'brave', 'youtube').verdict, 'browser-absent');
    const busy = classifyBrowserWindows(
      [win({ title: 'Gmail - Brave' }), win({ pid: 5, title: 'Reddit - Brave' })], 'brave', 'youtube');
    assert.equal(busy.verdict, 'browser-without-page');
    assert.equal(busy.windowCount, 2, 'the count is what makes the reason actionable');
  });

  it('ignores zero-size windows, which are not on screen', () => {
    const seen = classifyBrowserWindows([win({ title: 'YouTube - Brave', visible: false })], 'brave', 'youtube');
    assert.equal(seen.verdict, 'browser-absent');
  });
});

describe('BUG-414 (d,g) — a browser window titled for the page is verified evidence', () => {
  it('(d) returns verifiedOk on the window-title oracle', async () => {
    const lister = windowLister([[win({ title: 'YouTube - Brave' })]]);
    const out = await settle({ deps: { listWindows: lister } });
    assert.equal(out.ok, true);
    assert.equal(out.unverified, false, '(m3) this is the whole point: it is no longer unverified');
    assert.equal(evidence.isVerified(out), true, 'the HUD tick and the breaker both read this');
    assert.equal(out.evidence.oracle, 'window-title');
    assert.equal(out.evidence.expected, 'youtube');
    assert.match(out.evidence.observed, /YouTube - Brave \(brave, pid 4242\)/,
      'the observation is the literal title, so a reader can judge it themselves');
  });

  it('stops at the first match instead of burning the whole poll budget', async () => {
    const lister = windowLister([[win({ title: 'YouTube - Brave' })]]);
    await settle({ deps: { listWindows: lister } });
    assert.equal(lister.calls.length, 1,
      'assert the mechanism, not the value: open_web is deliberately not in SLOW_TOOLS');
  });

  it('keeps polling while the title has not caught up yet', async () => {
    const lister = windowLister([[win({ title: 'New Tab - Brave' })], [win({ title: 'YouTube - Brave' })]]);
    const out = await settle({ deps: { listWindows: lister } });
    assert.equal(lister.calls.length, 2);
    assert.equal(evidence.isVerified(out), true);
  });

  it('(g) DISPOSITION: a page that was already showing still verifies, and that is deliberate', async () => {
    // This oracle proves the page is ON SCREEN. It cannot prove THIS CALL put it
    // there — if the operator already had YouTube focused, the title matches on
    // the first look. Kept on purpose: the question they ask is "is it open",
    // not "did you cause it", and a title cannot honestly answer the second.
    // Pinned so the next reader does not read it as an oversight and "fix" it.
    const lister = windowLister([[win({ title: 'YouTube - Brave' })]]);
    const out = await settle({ deps: { listWindows: lister } });
    assert.equal(evidence.isVerified(out), true);
  });

  it('resolves an unnamed hand-off through the OS default browser', async () => {
    const lister = windowLister([[win({ processName: 'chrome', title: 'GitHub - Google Chrome' })]]);
    const out = await settle({
      href: 'https://github.com',
      handoff: { opened: true, via: 'os-default', browser: null },
      deps: {
        listWindows: lister,
        osDefaultBrowser: () => ({ name: 'chrome', exe: 'chrome.exe', progId: 'ChromeHTML', drivable: true }),
      },
    });
    assert.equal(evidence.isVerified(out), true);
    assert.equal(out.evidence.expected, 'github');
  });
});

describe('BUG-414 (e,f) — the unverified reasons now say something useful', () => {
  it('names the window count when the browser is up without the page', async () => {
    const lister = windowLister([[win({ title: 'Gmail - Brave' }), win({ pid: 5, title: 'Reddit - Brave' })]]);
    const out = await settle({ deps: { listWindows: lister } });
    assert.equal(out.unverified, true);
    assert.equal(out.ok, true, 'the hand-off did succeed; the oracle only sharpens the reason');
    assert.match(out.reason, /brave has 2 windows open and none of them is titled for youtube/);
    assert.ok(out.confirmedStep, 'BUG-273 B2 must survive: the model may still say the browser was handed the URL');
  });

  it('(f) absence is reported as AMBIGUOUS, never as "nothing opened"', async () => {
    // (m5). A cold Chromium start outlasts this poll, so "no window yet" is
    // genuinely ambiguous. Claiming nothing opened would trade one false claim
    // for its opposite, which is the exact failure BUG-272 T2 fixed in the other
    // direction.
    const lister = windowLister([[]]);
    const out = await settle({ deps: { listWindows: lister } });
    assert.equal(out.unverified, true);
    assert.match(out.reason, /if it was not, it is still starting up/);
    assert.doesNotMatch(out.reason, /nothing opened|did not open at all|failed to open/,
      'the poll cannot see a cold start, so it must not claim one did not happen');
    assert.equal(lister.calls.length, externalRoute.VERIFY_TRIES,
      'absence is only reported after the full budget, never on the first look');
  });
});

describe('BUG-414 (h,i) — wherever the oracle cannot run, the pre-fix verdict is unchanged', () => {
  it('(e) pc-child offline is named, and is not mistaken for a missing browser', async () => {
    // (m4). Folding "the oracle is dead" into "the browser is dead" is how a
    // broken sensor reads as a broken browser — the reason from-pc's
    // findExplorerWindow carries an `online` flag at all.
    const out = await settle({ deps: { listWindows: async () => null } });
    assert.equal(out.unverified, true);
    assert.ok(out.reason.startsWith(PRE_FIX_REASON), 'the old verdict survives underneath');
    assert.match(out.reason, /pc-child is not running/);
    assert.doesNotMatch(out.reason, /still starting up/);
  });

  it('(h) a host with no usable label returns the pre-fix reason byte for byte', async () => {
    let asked = false;
    const out = await settle({
      href: 'https://127.0.0.1:8080/dashboard',
      deps: { listWindows: async () => { asked = true; return null; } },
    });
    assert.equal(out.reason, PRE_FIX_REASON);
    assert.equal(asked, false, 'no oracle is attempted, so no pc-child round trip is spent');
  });

  it('(i) an OS default MYTHOS cannot drive returns the pre-fix reason byte for byte', async () => {
    // Firefox as the Windows default. Skipped entirely rather than guessed at.
    let asked = false;
    const out = await settle({
      handoff: { opened: true, via: 'os-default', browser: null },
      deps: {
        listWindows: async () => { asked = true; return null; },
        osDefaultBrowser: () => ({ name: null, exe: null, progId: 'FirefoxURL', drivable: false }),
      },
    });
    assert.equal(out.reason, PRE_FIX_REASON);
    assert.equal(asked, false);
  });

  it('the poll budget stays inside the 1500ms ack deadline open_web is measured against', () => {
    // BUG-295 measured open_web breaching that deadline 44 times in one session,
    // and live-tool-adapter.js argues open_web out of SLOW_TOOLS on the grounds
    // that it "is not slow". This guard is what keeps that sentence true.
    assert.ok(externalRoute.VERIFY_TRIES * externalRoute.VERIFY_INTERVAL_MS <= 900,
      'the whole oracle must fit well inside the deadline, budget was '
      + (externalRoute.VERIFY_TRIES * externalRoute.VERIFY_INTERVAL_MS) + 'ms');
  });
});

describe('BUG-414 — open_web actually routes through the new settle path', () => {
  function openWeb(opener) {
    const built = buildTools({
      goalsEffector: {}, pipeline: {}, kanban: {}, agentActions: {}, buildRunner: {},
      vault: {}, config: {}, bus: { emit() {} },
      probes: { getStatus: async () => ({}) },
    });
    built.setExternalOpener(opener);
    return built.TOOLS.find((t) => t.name === 'open_web').fn;
  }

  it('carries the hand-off payload into the verdict, with no pc-child contact', async () => {
    // Deliberately an IP so titleTokenForUrl returns null and the call short
    // -circuits before any window lookup: this asserts the WIRING (from-dashboard
    // delegates, and the payload survives the hop) without spawning pc-child in
    // the suite. The oracle branches are covered above with injected deps.
    const fn = openWeb(async () => ({ opened: true }));
    const out = await fn({ type: 'web', browser: true, url: 'https://127.0.0.1:8080/dashboard' });
    assert.equal(out.ok, true);
    assert.equal(out.unverified, true);
    assert.equal(out.reason, PRE_FIX_REASON, 'unchanged where the oracle cannot run');
    assert.equal(out.result.handedToBrowser, true, 'the payload composed in from-dashboard survived the hop');
    assert.equal(out.result.widgetType, 'newtab');
    assert.ok(out.confirmedStep, 'BUG-273 B2 still applies through the new path');
  });
});
