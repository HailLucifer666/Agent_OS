'use strict';

// test/bug-408-debug-profile-identity.test.js
//
// BUG-408. The operator's words, 2026-09-03: "it's sometimes open on Brave
// where I think it's a debug Brave window." They were right, and nothing MYTHOS
// said gave them any way to know it. browser_launch_debug runs the browser on
// --user-data-dir=%LOCALAPPDATA%\MYTHOS\<name>-debug-profile — a separate
// Chromium profile with none of their logins, history, bookmarks or extensions.
// A window that looks like their browser and is signed out of everything reads
// as a BROKEN browser, not as a second profile.
//
// The only thing the launch result said about any of this was BUG-345's ads
// caveat, and only for chrome/edge. A Brave launch said nothing at all.
//
// THE DISPOSITION IS PINNED HERE, because it is deliberately not a behaviour
// change (/kee: "deliberately not changing behaviour -> say why in code and add
// a regression test that locks it in"). The separate profile STAYS:
//   - Chromium refuses --remote-debugging-port on a profile another instance
//     already has open, so driving the real profile means closing the
//     operator's browser first;
//   - a debug port on a fully logged-in profile lets any local page drive it,
//     which is a worse thing than an inconvenience.
// What was missing was the sentence. And where the operator genuinely wants
// their real, logged-in window, the route is open_web's browserName (BUG-407),
// which does not use a debug profile at all.
//
// MUTATION PROBES, run 2026-09-03, each green BEFORE this change:
//   (a) buildLaunchResult: drop the profile-identity sentence from `notes`
//       -> reds (a).
//   (b) buildLaunchResult: gate the profile sentence behind the same
//       /chrome|edge/ test the ads caveat uses -> reds (b) (the Brave case).
//   (c) buildLaunchResult: set separateProfile:false / signedIn:true
//       -> reds (c).
//   (d) debugProfileDir: change the leaf to '<name>-profile'
//       -> reds (d), the cross-module agreement test — because that is the
//       exact shape browser-process.js's kill authorisation depends on.
// Verified applied by diff before restoring from a full-path copy.
//
// ADJACENT CASE THAT MUST KEEP PASSING: Brave must still never be warned about
// ads (test/adblock-caveat.test.js owns that assertion), and a launch with a
// loaded extension must still not be warned either. Adding a sentence to that
// field must not turn into warning everyone about everything.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { _buildLaunchResult: buildLaunchResult } = require('../src/core/effectors/from-browser');
const bt = require('../src/core/effectors/browser-target');
const browserProcess = require('../adapters/browser-agent/browser-process');

const STATUS = { mode: 'cdp', pageCount: 1 };

describe('BUG-408 — a debug launch says whose profile it is', () => {
  // (a) (b)
  test('every browser says it is MYTHOS\'s own profile, and names the directory', () => {
    for (const browser of ['chrome', 'brave', 'edge']) {
      const dir = path.join('C:', 'Users', 'x', 'AppData', 'Local', 'MYTHOS', browser + '-debug-profile');
      const r = buildLaunchResult(browser, STATUS, dir, []);
      assert.match(String(r.caveat), new RegExp("MYTHOS's own " + browser + ' profile'),
        browser + ' must say whose profile this is — the operator could not tell the debug window from their own');
      assert.ok(String(r.caveat).includes(dir), browser + ' must name the profile directory, so it can be found');
      assert.match(String(r.caveat), /none of your logins/,
        browser + ' must say it is signed out, which is what actually looked broken');
    }
  });

  // (c)
  test('the two facts are also machine-readable, not only prose', () => {
    const r = buildLaunchResult('brave', STATUS, 'C:\\x\\MYTHOS\\brave-debug-profile', []);
    assert.equal(r.separateProfile, true);
    assert.equal(r.signedIn, false);
  });

  test('a loaded extension still gets the profile sentence (it is a different fact)', () => {
    const r = buildLaunchResult('chrome', STATUS, 'C:\\x\\MYTHOS\\chrome-debug-profile', ['C:\\ublock']);
    assert.match(String(r.caveat), /MYTHOS's own chrome profile/);
    assert.doesNotMatch(String(r.caveat), /pages will show ads/,
      'adjacent case: an extension IS loaded, so the ads warning must stay off');
    assert.deepEqual(r.extensionsLoaded, ['C:\\ublock']);
  });

  // BUG-407 rides on the same result
  test('the launch reports WHY this browser, and explains a fallback choice', () => {
    const requested = buildLaunchResult('chrome', STATUS, 'C:\\x\\MYTHOS\\chrome-debug-profile', [], 'requested');
    assert.equal(requested.browserSource, 'requested');
    assert.doesNotMatch(String(requested.caveat), /Windows default browser was not used/,
      'a browser the operator named needs no explanation about defaults');

    const fallback = buildLaunchResult('brave', STATUS, 'C:\\x\\MYTHOS\\brave-debug-profile', [], 'search-order');
    assert.equal(fallback.browserSource, 'search-order');
    assert.match(String(fallback.caveat), /Windows default browser was not used/,
      'when the machine default was NOT used, say so — that is the disagreement BUG-407 was about');

    const dflt = buildLaunchResult('brave', STATUS, 'C:\\x\\MYTHOS\\brave-debug-profile', [], 'os-default');
    assert.equal(dflt.browserSource, 'os-default');
    assert.doesNotMatch(String(dflt.caveat), /Windows default browser was not used/,
      'it WAS used — saying otherwise would be a new false statement');
  });

  test('omitting the source leaves the field off rather than inventing one', () => {
    const r = buildLaunchResult('chrome', STATUS, 'C:\\x\\MYTHOS\\chrome-debug-profile', []);
    assert.equal('browserSource' in r, false);
  });

  // (d) — the cross-module agreement, and the reason it is load-bearing
  test('debugProfileDir produces exactly the shape the close guard authorises', () => {
    // browser-process.js will only kill a process whose --user-data-dir sits
    // under %LOCALAPPDATA%\MYTHOS and ends in -debug-profile. If these two
    // drift, either the close silently refuses every real target (harmless but
    // useless) or the guard widens (not harmless at all). Pin them together.
    const before = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join('C:', 'Users', 'x', 'AppData', 'Local');
    try {
      for (const name of [null, '', 'chrome', 'brave', 'edge']) {
        const dir = bt.debugProfileDir(name);
        assert.equal(browserProcess.isMythosDebugProfile(dir), true,
          JSON.stringify(name) + ' -> ' + dir + ' must be recognised by the close authorisation');
      }
      assert.equal(bt.debugProfileDir(null), bt.debugProfileDir('chrome'),
        'unnamed keeps the historical chrome- path, so an old profile is not orphaned');
      assert.match(bt.debugProfileDir('brave'), /brave-debug-profile$/);
    } finally {
      if (before === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = before;
    }
  });

  test('the disposition is written down where the next editor will read it', () => {
    // /kee: a deliberate non-change needs its reason in the code, not only in a
    // ticket. If someone later "fixes" the debug profile by pointing it at the
    // real one, this is the sentence that has to be argued with.
    const src = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'browser-launch-plan.js'), 'utf8');
    assert.match(src, /NOT THE BUG AND IS NOT BEING CHANGED/);
    // Comment prose wraps, so the two halves of the reason are matched
    // separately rather than as one line that reflowing would break.
    assert.match(src, /refuses --remote-debugging-port on a profile/);
    assert.match(src, /a fully logged-in browser, which is a worse thing than an inconvenience/);
  });
});
