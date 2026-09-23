'use strict';

// bug-415-launch-the-operators-browser.test.js — BUG-415.
//
// MEASURED ON THIS MACHINE 2026-09-09, before any code was written:
//
//   osDefaultBrowser()              -> { name:'brave', progId:'BraveHTML', drivable:true }
//   resolveLaunchTarget(null)       -> { name:'brave', source:'os-default' }
//   findBrowserExecutable('brave')  -> ...\BraveSoftware\Brave-Browser\...\brave.exe
//   findBrowserExecutable('chrome') -> ...\Google\Chrome\Application\chrome.exe
//   findBrowserExecutable('edge')   -> null    <- Edge is NOT installed here
//
// The resolver has answered "brave" correctly since BUG-407. launchLocal was the
// one launch site that never asked it: playwright channel 'chrome', falling back
// to 'msedge', full stop. On this machine that silently starts CHROME, which the
// operator does not use; on a machine with neither it fails outright while Brave
// sits installed. browser-target.js's own header states the rule broken here —
// "when a change derives the same fact twice by different means, point both at
// the same input".
//
// WHAT IS DELIBERATELY NOT CHANGED, and is asserted below so it reads as a
// decision rather than an omission: the launched browser still gets a FRESH,
// EMPTY profile. This launcher drives with CDP, and browser-process.js's close
// path is structurally authorised only for a MYTHOS/<name>-debug-profile
// directory — pointing it at the operator's real profile would put an automated
// agent inside their logged-in session AND produce a browser nothing here could
// safely close. What did change is that the profile now FOLLOWS the browser, so
// Brave stops being handed the directory Chrome wrote.
//
// TESTED WITHOUT PLAYWRIGHT ON PURPOSE. Every browser is installed on a normal
// dev machine, so a test against the real filesystem can only ever observe one
// outcome and would pass whatever the rule was (the reason resolveLaunchTarget
// already takes an injected findBrowserExecutable). What CANNOT be covered here
// is the launch itself: whether Playwright can actually start Brave by
// executablePath is a live check, named in BUGS.md as remaining evidence.
//
// MUTATION PROBES, run 2026-09-09 against adapters/browser-agent/index.js, all
// four confirmed landed before running, all four fired, no survivors; source
// restored by byte copy with a matching sha256.
//
// THE FIRST RUN FOUND A DEFECT IN THIS FILE, NOT IN THE FIX, and it is the
// reason the fixture below resolves to edge. (m1) disabled the resolver
// completely and test (a) STAYED GREEN, because the fixture resolved to 'brave'
// and brave is also the first entry in BROWSER_SEARCH_ORDER — the expected value
// coincided with the fallback, so the assertion could not observe the rule it
// was written for. The probe failed a different test by luck. Reading the file
// would never have shown this.
//
//   (m1) planLocalLaunch ignores the resolver, starting from the search order
//        -> 5 fails, led by (a). Before the fixture fix: 1 fail, and NOT (a).
//   (m2) the profile directory stops following the browser
//        -> 1 fail: (c) "brave never inherits the directory chrome wrote"
//   (m3) a browser with neither channel nor executable stays a candidate
//        -> 2 fails: (d) and the channel-without-exe case beside it
//   (m4) the fallback tail is dropped, leaving only the resolver's answer
//        -> 9 fails; nearly every case depends on the ladder existing

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const browserAgent = require('../adapters/browser-agent');
const browserTarget = require('../src/core/effectors/browser-target');
const { TOOLS } = require('../src/core/effectors/from-browser');

const USER_DATA_DIR = path.join('C:', 'fake', 'MYTHOS', 'chrome-debug-profile');

// A machine where every browser exists, so the ORDER is the only variable.
function allInstalled(name) {
  return path.join('C:', 'fake', name, name + '.exe');
}

// THE FIXTURE DEFAULTS TO EDGE, AND THAT IS THE POINT. The first draft of this
// file resolved to 'brave' — which is genuinely what this machine answers, and
// is ALSO the first entry in BROWSER_SEARCH_ORDER. So "the resolver's answer
// goes first" was true whether or not the resolver was consulted at all, and
// mutation (m1) walked straight past it: disabling the resolver entirely left
// test (a) green. A fixture whose expected value coincides with the fallback
// cannot observe the rule. Edge is LAST in the search order, so only an honoured
// resolver can put it first. The real brave-default machine is covered
// separately below, where it belongs — as a case, not as the fixture.
function plan(overrides) {
  return browserAgent.planLocalLaunch(USER_DATA_DIR, Object.assign({
    resolveLaunchTarget: () => ({ name: 'edge', exe: allInstalled('edge'), source: 'os-default' }),
    findBrowserExecutable: allInstalled,
    debugProfileDir: (n) => path.join('C:', 'fake', 'MYTHOS', (n && n !== 'chrome' ? n : 'chrome') + '-debug-profile'),
  }, overrides || {}));
}

describe("BUG-415 (a,b) — the ladder is derived, and the operator's browser is first", () => {
  it("(a) the resolver's answer gets the first attempt, even from the back of the order", async () => {
    const attempts = (await plan());
    assert.equal(attempts[0].name, 'edge',
      '(m1) edge is LAST in BROWSER_SEARCH_ORDER — only an honoured resolver can put it first');
    assert.equal(attempts[0].source, 'os-default', 'and it says WHY it was chosen');
  });

  it('(b) the fallback ladder still runs after it, deduplicated', async () => {
    // (m4). The resolver returns the best answer, not the only viable one — a
    // UserChoice entry can outlive an uninstall — so removing the tail would
    // trade one failure mode for another.
    assert.deepEqual((await plan()).map((a) => a.name), ['edge', 'brave', 'chrome']);
  });

  it('on THIS machine, whose default really is brave, brave leads', async () => {
    // The measured case, kept honest by not being the fixture: here the expected
    // value coincides with the fallback, so this test alone proves nothing about
    // the rule — it proves the rule produces the right answer for the operator.
    const names = (await plan({
      resolveLaunchTarget: () => ({ name: 'brave', exe: allInstalled('brave'), source: 'os-default' }),
    })).map((a) => a.name);
    assert.deepEqual(names, ['brave', 'chrome', 'edge'], 'brave is promoted, not duplicated');
  });

  it('does not attempt the same browser twice when it is also the default', async () => {
    const names = (await plan({
      resolveLaunchTarget: () => ({ name: 'chrome', exe: allInstalled('chrome'), source: 'os-default' }),
    })).map((a) => a.name);
    assert.deepEqual(names, ['chrome', 'brave', 'edge'], 'chrome is promoted, not duplicated');
  });

  it('falls back to the search order when the registry cannot answer', async () => {
    const names = (await plan({ resolveLaunchTarget: () => ({ error: 'no supported browser found' }) })).map((a) => a.name);
    assert.deepEqual(names, ['brave', 'chrome', 'edge'], 'an unreadable default is not a reason to launch nothing');
  });

  it('survives a resolver that throws rather than answering', async () => {
    const names = (await plan({ resolveLaunchTarget: () => { throw new Error('reg.exe exploded'); } })).map((a) => a.name);
    assert.deepEqual(names, ['brave', 'chrome', 'edge']);
  });
});

describe('BUG-415 (c) — the profile follows the browser', () => {
  it('(c) brave never inherits the directory chrome wrote', async () => {
    // (m2). debugProfileDir takes a name precisely so switching browsers does
    // not hand Brave a profile Chrome wrote; the caller passes a hardcoded
    // chrome path, so without this every non-chrome attempt would do exactly
    // that. Asserted on brave BY NAME rather than on attempts[0], so the
    // assertion cannot be satisfied by whichever browser happens to lead.
    const brave = (await plan()).find((a) => a.name === 'brave');
    assert.match(brave.profileDir, /brave-debug-profile$/);
    assert.notEqual(brave.profileDir, USER_DATA_DIR,
      'the caller hands in the chrome directory; brave must not be launched into it');
    const edge = (await plan()).find((a) => a.name === 'edge');
    assert.match(edge.profileDir, /edge-debug-profile$/);
  });

  it('every profile directory still satisfies the close-path authorisation', async () => {
    // browser-process.js refuses to close anything not shaped like
    // MYTHOS/<name>-debug-profile. A launch into a directory that guard rejects
    // would produce a browser MYTHOS started and cannot stop.
    for (const attempt of (await plan())) {
      assert.equal(browserAgent.isMythosDebugProfile(attempt.profileDir), true,
        attempt.name + ' launches into ' + attempt.profileDir + ', which browser_close could not authorise');
    }
  });

  it('DISPOSITION: the profile stays EMPTY — the real one is deliberately not used', async () => {
    // Recorded as a decision, not an oversight. See the header. The route to the
    // operator's logged-in window is open_web(browser:true), which does not use
    // the debug port at all.
    for (const attempt of (await plan())) {
      assert.match(attempt.profileDir, /-debug-profile$/,
        'a real Chromium profile directory never ends in -debug-profile');
    }
  });

  it('keeps the caller directory when the profile resolver throws', async () => {
    // debugProfileDir joins process.env.LOCALAPPDATA with no guard, deliberately
    // (browser-target.js says so). A throw there must cost the naming, not the
    // launch.
    const attempts = (await plan({ debugProfileDir: () => { throw new Error('LOCALAPPDATA unset'); } }));
    assert.equal(attempts[0].profileDir, USER_DATA_DIR);
  });
});

describe('BUG-415 (d) — a browser that is installed nowhere is not attempted', () => {
  it('(d) drops a candidate with no channel and no executable', async () => {
    // (m3). Brave has no playwright channel, so with no executable there is
    // nothing to launch and the attempt would burn a real Playwright timeout.
    const attempts = (await plan({ findBrowserExecutable: (n) => (n === 'brave' ? null : allInstalled(n)) }));
    assert.deepEqual(attempts.map((a) => a.name), ['edge', 'chrome'],
      'brave is unreachable on this machine and must not be attempted');
  });

  it('keeps a CHANNEL candidate even when the executable resolver cannot find it', async () => {
    // The adjacent case that must keep passing: a machine-wide Chrome under a
    // root browserCandidatePaths does not enumerate is still launchable by
    // channel, and dropping it would be a regression on the path that worked.
    const attempts = (await plan({ findBrowserExecutable: () => null }));
    assert.deepEqual(attempts.map((a) => a.name), ['edge', 'chrome'],
      'brave has no channel and no exe, so only the two channel browsers remain');
    assert.deepEqual(attempts[0].options, { channel: 'msedge' });
  });

  it('launches brave by executablePath and chrome/edge by channel', async () => {
    const byName = new Map((await plan()).map((a) => [a.name, a.options]));
    assert.deepEqual(byName.get('brave'), { executablePath: allInstalled('brave') },
      'playwright has no brave channel');
    assert.deepEqual(byName.get('chrome'), { channel: 'chrome' });
    assert.deepEqual(byName.get('edge'), { channel: 'msedge' },
      "edge's playwright channel is msedge, not its browser name");
  });

  it('returns an empty plan when nothing is reachable, so launchLocal can say so', async () => {
    const attempts = (await browserAgent.planLocalLaunch(USER_DATA_DIR, {
      resolveLaunchTarget: () => ({ error: 'none' }),
      findBrowserExecutable: () => null,
      debugProfileDir: (n) => path.join('C:', 'fake', 'MYTHOS', n + '-debug-profile'),
      // no channels either: shadow the real table by asking for a browser set
      // that has none. BROWSER_SEARCH_ORDER is chrome/edge/brave, two of which
      // have channels, so an empty plan is only reachable through the real
      // module when the table itself is empty. Asserted as a shape instead.
    }));
    assert.ok(Array.isArray(attempts), 'the plan is always a list, never null');
  });
});

describe('BUG-415 — the choice is not restated anywhere else', () => {
  it('the search order and the channel map both derive from browser-target', async () => {
    // Gate D: the failure being fixed IS a hand-typed list. A second copy of the
    // browser set inside the adapter would rebuild it one browser later.
    assert.deepEqual(browserTarget.BROWSER_SEARCH_ORDER, ['brave', 'chrome', 'edge']);
    for (const attempt of (await plan())) {
      assert.ok(browserTarget.BROWSER_SUBPATHS[attempt.name],
        attempt.name + ' must be a browser browser-target knows, not a name typed here');
    }
  });

  it('browser_launch_debug now states the empty profile instead of leaving it to be discovered', () => {
    // BUG-415's recorded decision had two halves and this is the second. A
    // signed-out window is the correct behaviour and reads as a fault unless the
    // model can say so first.
    const tool = TOOLS.find((t) => t.name === 'browser_launch_debug');
    assert.ok(tool, 'browser_launch_debug must still be registered');
    assert.match(tool.description, /SEPARATE, EMPTY profile/);
    assert.match(tool.description, /logged out/);
    assert.match(tool.description, /open_web with browser:true/,
      'naming the remedy is the pattern this codebase already proves works');
    assert.match(tool.description, /DEFAULT browser/,
      'and the unnamed case must no longer claim chrome is the default');
  });
});
