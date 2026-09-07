'use strict';

// test/bug-407-one-answer-to-which-browser.test.js
//
// BUG-407. MYTHOS held two answers to "open it in a browser" and neither
// derived from the other: open_web(browser:true) went to the OS default via
// shell.openExternal with no way to name a browser at all, while
// browser_launch_debug picked from BROWSER_SEARCH_ORDER, brave-first. On the
// operator's machine both say Brave — the Windows default really is
// `BraveHTML`, measured 2026-09-03 — so the disagreement was invisible and a
// named request ("open it in Chrome") did not fail, it silently resolved to
// something else. BUG-398 E3 is that, three times in one session.
//
// Pinned here:
//   1. the OS default is READ, and read through a rule (ProgId -> command ->
//      executable -> name) rather than a hand-typed ProgId prefix list;
//   2. a named request wins, and an unresolvable name FAILS rather than
//      quietly becoming the default — that fallback is the bug;
//   3. the search order is the FALLBACK, used when the default is unreadable,
//      uninstalled, or a browser MYTHOS cannot drive;
//   4. a URL bound for a browser PROCESS is proven http/https at the edge;
//   5. the named route never records its pid as a MYTHOS-owned browser.
//
// Nothing here touches the real registry or the real filesystem: the registry
// reader and the executable resolver are both injected. That is deliberate and
// load-bearing — Chrome, Brave and Edge are all installed on a normal dev
// machine, so a test against the real disk can only observe one outcome and
// would pass whatever the rule happened to be (/kee class 3: the fixture is
// test data too).
//
// MUTATION PROBES, all run 2026-09-03, all verified APPLIED (file diffed on
// disk) and all verified to still LOAD (a probe that breaks the parse proves
// only that the file is required, which is not what a mutation is for). Each
// was green BEFORE this change and each now fails the test marked with its
// letter:
//   (a) parseCommandExecutable: disable the quoted-path branch so the bare
//       \S+\.exe match wins -> truncates the path to "C:\Program" -> reds (a).
//       FIRST ATTEMPT AT THIS PROBE NEVER APPLIED — the harness had the regex
//       literal mis-escaped, and a probe that silently does not apply looks
//       exactly like a guard that works. Recorded because that is the failure
//       mode, not a footnote.
//   (b) osDefaultBrowser: return { name: 'chrome', drivable: true } for any
//       ProgId whose command could not be read -> reds (b).
//   (c) resolveLaunchTarget: on an unresolvable NAMED browser, fall through to
//       the search order instead of erroring -> reds (c). This is the original
//       bug, reintroduced on purpose.
//   (d) resolveLaunchTarget: check the search order before the OS default
//       -> reds (d).
//   (e) externalUrl, run as two halves because the parse does two jobs:
//       (e1) neutralise the protocol comparison -> reds the scheme test AND
//            openUrlInBrowser's own refusal test;
//       (e2) hand back the raw string instead of parsed.href -> reds the
//            backslash-normalisation case and the canonicalisation case.
//       The FIRST version of (e) swapped the whole parse for a
//       /^https?:\/\//i test in one edit and produced a SYNTAX ERROR, so the
//       run went red for a reason that had nothing to do with the guard.
//       Recorded, because "the suite went red" is not the same evidence as
//       "the assertion caught it".
//   (f) identifyBrowserByExecutable: replace the derived index with a literal
//       { 'chrome.exe': 'chrome' } map -> reds (f).
//   (g) openUrlInBrowser: pass the raw url instead of the parsed href, and
//       prepend a flag -> reds (g).
// Verified applied by diffing the file before restoring from a full-path copy.
//
// ADJACENT CASES THAT MUST KEEP PASSING (a guard nobody knows the bounds of is
// not a guard): an unnamed request on a machine whose default IS drivable must
// still use it; BROWSER_EXECUTABLE must still outrank the OS default; and a
// plain http/https URL must pass externalUrl untouched apart from
// canonicalisation.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const bt = require('../src/core/effectors/browser-target');
const externalRoute = require('../src/core/effectors/open-external-route');

// Real reg.exe output, captured verbatim on 2026-09-03 including the CRLF and
// the doubled-space padding. A hand-tidied fixture would not exercise either.
const REAL_USERCHOICE = '\r\nHKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n    ProgId    REG_SZ    BraveHTML\r\n\r\n';
const REAL_COMMAND = '\r\nHKEY_CLASSES_ROOT\\BraveHTML\\shell\\open\\command\r\n    (Default)    REG_SZ    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --single-argument %1\r\n\r\n';

// A reader that answers from a { ProgId, command } pair. Two queries, told
// apart by the flag reg.exe is given, exactly as production calls it.
function reader(progIdOut, commandOut) {
  return (args) => {
    const isProgId = args.indexOf('/v') !== -1;
    return isProgId ? progIdOut : (commandOut === undefined ? '' : commandOut);
  };
}

function fakeExeResolver(installed) {
  // installed: { chrome: '<path>', ... }. Mirrors findBrowserExecutable's real
  // contract: a NAME resolves that browser or null; null/'' walks the search
  // order and returns the first installed one.
  return (name) => {
    if (name) return installed[name] || null;
    for (const n of bt.BROWSER_SEARCH_ORDER) if (installed[n]) return installed[n];
    return null;
  };
}

const P = {
  chrome: path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  brave: path.join('C:', 'Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  edge: path.join('C:', 'Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
};

describe('BUG-407 — one answer to "which browser"', () => {
  // (a)
  test('the registry chain parses real reg.exe output, quoted path and all', () => {
    assert.equal(bt.parseProgId(REAL_USERCHOICE), 'BraveHTML');
    assert.equal(bt.parseCommandExecutable(REAL_COMMAND), P.brave,
      'the executable must survive the spaces in "Program Files" — a bare \\S+ match truncates it to C:\\Program');
    assert.equal(bt.parseProgId('nothing here'), null);
    assert.equal(bt.parseCommandExecutable('nothing here'), null);
  });

  test('an unquoted command still yields its executable', () => {
    assert.equal(bt.parseCommandExecutable('    (Default)    REG_SZ    C:\\brave\\brave.exe --single-argument %1'),
      'C:\\brave\\brave.exe');
  });

  test('the OS default is resolved by RULE: ProgId -> command -> executable -> name', () => {
    const d = bt.osDefaultBrowser({ platform: 'win32', readRegistryValue: reader(REAL_USERCHOICE, REAL_COMMAND) });
    assert.deepEqual(
      { name: d.name, progId: d.progId, drivable: d.drivable },
      { name: 'brave', progId: 'BraveHTML', drivable: true },
      'the ProgId is never pattern-matched to a name — it is resolved to a real exe and THAT is identified',
    );
  });

  test('a real default MYTHOS cannot drive is "not drivable", which is not "unreadable"', () => {
    const ff = '\r\n    ProgId    REG_SZ    FirefoxURL\r\n';
    const cmd = '\r\n    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"\r\n';
    const d = bt.osDefaultBrowser({ platform: 'win32', readRegistryValue: reader(ff, cmd) });
    assert.equal(d.name, null, 'firefox is not a browser this codebase can drive over CDP');
    assert.equal(d.drivable, false);
    assert.equal(d.progId, 'FirefoxURL', 'and it still reports WHAT the default is, so the caveat can say so');
  });

  // (b)
  test('an unreadable default is null or not-drivable — never a guessed browser', () => {
    assert.equal(bt.osDefaultBrowser({ platform: 'win32', readRegistryValue: () => '' }), null,
      'no ProgId means no answer');
    const noCmd = bt.osDefaultBrowser({ platform: 'win32', readRegistryValue: reader(REAL_USERCHOICE, '') });
    assert.equal(noCmd.drivable, false, 'a ProgId whose command cannot be read is not a drivable browser');
    assert.equal(noCmd.name, null, 'and it must not be filled in with a plausible default');
    assert.equal(bt.osDefaultBrowser({ platform: 'darwin', readRegistryValue: () => REAL_USERCHOICE }), null,
      'there is no Windows UrlAssociations registry off Windows');
  });

  test('a named request wins, and says so', () => {
    const r = bt.resolveLaunchTarget('brave', { findBrowserExecutable: fakeExeResolver(P) });
    assert.deepEqual({ name: r.name, source: r.source }, { name: 'brave', source: 'requested' });
    assert.equal(bt.resolveLaunchTarget('Google Chrome', { findBrowserExecutable: fakeExeResolver(P) }).name, 'chrome',
      'aliases resolve — the operator says "google chrome" out loud');
  });

  // (c) — the original bug, pinned so it cannot come back
  test('a named browser that is NOT installed FAILS — it never becomes the default', () => {
    const r = bt.resolveLaunchTarget('edge', {
      findBrowserExecutable: fakeExeResolver({ chrome: P.chrome, brave: P.brave }),
      platform: 'win32',
      readRegistryValue: reader(REAL_USERCHOICE, REAL_COMMAND),
    });
    assert.ok(r.error, 'silently opening Brave for an "edge" request is exactly BUG-398 E3');
    assert.match(r.error, /No edge installation found/);
    assert.equal(r.name, undefined, 'and no browser is chosen at all');
  });

  test('an unsupported name FAILS and lists what is supported', () => {
    const r = bt.resolveLaunchTarget('safari', { findBrowserExecutable: fakeExeResolver(P) });
    assert.match(String(r.error), /not a browser I can drive/);
    assert.match(String(r.error), /brave, chrome, edge/);
  });

  // (d) — and its adjacent case, below
  test('unnamed follows the OS DEFAULT when MYTHOS can drive it', () => {
    // Default is Chrome while the fallback order would have said Brave. If the
    // order is consulted first this reads 'brave' and the whole ticket is undone.
    const chromeDefaultCmd = '\r\n    (Default)    REG_SZ    "' + P.chrome + '" --single-argument %1\r\n';
    const r = bt.resolveLaunchTarget(null, {
      findBrowserExecutable: fakeExeResolver(P),
      platform: 'win32',
      readRegistryValue: reader('\r\n    ProgId    REG_SZ    ChromeHTML\r\n', chromeDefaultCmd),
    });
    assert.deepEqual({ name: r.name, source: r.source }, { name: 'chrome', source: 'os-default' },
      'Brave is first in BROWSER_SEARCH_ORDER, so this can only be chrome if the default was read FIRST');
  });

  test('unnamed falls back to the search order when the default is not drivable', () => {
    const ff = '\r\n    ProgId    REG_SZ    FirefoxURL\r\n';
    const cmd = '\r\n    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -url "%1"\r\n';
    const r = bt.resolveLaunchTarget(null, {
      findBrowserExecutable: fakeExeResolver(P),
      platform: 'win32',
      readRegistryValue: reader(ff, cmd),
    });
    assert.deepEqual({ name: r.name, source: r.source }, { name: 'brave', source: 'search-order' },
      'a Firefox default cannot be driven, so BUG-130\'s Brave-first order is exactly what it is for');
  });

  test('unnamed falls back to the search order when the registry says nothing', () => {
    const r = bt.resolveLaunchTarget(null, {
      findBrowserExecutable: fakeExeResolver(P), platform: 'win32', readRegistryValue: () => '',
    });
    assert.equal(r.source, 'search-order');
  });

  test('nothing installed at all is an honest error, not a path to a missing exe', () => {
    const r = bt.resolveLaunchTarget(null, {
      findBrowserExecutable: fakeExeResolver({}), platform: 'win32', readRegistryValue: () => '',
    });
    assert.match(String(r.error), /No supported browser found/);
  });

  // (f)
  test('executable -> name is DERIVED from BROWSER_SUBPATHS, not a typed list', () => {
    for (const name of Object.keys(bt.BROWSER_SUBPATHS)) {
      const sub = bt.BROWSER_SUBPATHS[name];
      const full = path.join('C:', 'anywhere', ...sub);
      assert.equal(bt.identifyBrowserByExecutable(full), name, `${name} must be identifiable from its own subpath`);
    }
    assert.equal(bt.identifyBrowserByExecutable('C:\\x\\BRAVE.EXE'), 'brave', 'Windows paths are not case-sensitive');
    assert.equal(bt.identifyBrowserByExecutable('C:\\x\\firefox.exe'), null, 'unknown stays unknown, never a guess');
    assert.equal(bt.identifyBrowserByExecutable(''), null);
    assert.equal(bt.identifyBrowserByExecutable(null), null);
  });

  // (e)
  test('a URL bound for a browser PROCESS is proven http/https at the edge', () => {
    for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ms-msdt:/id', 'search-ms:query=x',
      'vbscript:x', 'data:text/html,<script>1</script>']) {
      const r = bt.externalUrl(bad);
      assert.equal(r.ok, false, bad + ' must be refused');
      assert.match(String(r.reason), /refused scheme|not a valid url/);
    }
    assert.equal(bt.externalUrl('').ok, false);
    assert.equal(bt.externalUrl(null).ok, false);
  });

  // CORRECTED WHILE WRITING THIS FILE (2026-09-03), and worth keeping as the
  // record. The first version of this test asserted that "https:/\evil.example"
  // is REFUSED, on the strength of the codebase comment that names it as the
  // shape a startsWith() check lets past. Measured: WHATWG treats a backslash
  // as a slash for special schemes, so it parses to https://evil.example/ —
  // accepted, and correctly, because that is exactly what a browser would
  // resolve it to. The parse is more permissive than a string match HERE, and
  // that is fine: the rule being enforced is the SCHEME, never the host, and
  // normalising to what the browser would do is the honest reading. Asserting
  // the normalisation instead of a wrong refusal is the whole point.
  test('a backslash-for-slash URL is normalised the way a browser would, not refused', () => {
    assert.deepEqual(bt.externalUrl('https:/\\evil.example'),
      { ok: true, href: 'https://evil.example/' });
  });

  test('a plain http/https URL passes, canonicalised', () => {
    assert.deepEqual(bt.externalUrl('https://example.com/news?q=1'),
      { ok: true, href: 'https://example.com/news?q=1' });
    assert.equal(bt.externalUrl('http://example.com').href, 'http://example.com/',
      'href canonicalises an empty path — this is the string the browser actually receives');
  });

  test('openUrlInBrowser demands a real URL — bare-domain guessing stays in ONE place', async () => {
    // resolveExternalTarget is the only thing allowed to turn "openai.com" into
    // a URL. A second guesser inside the spawn helper would be a second
    // derivation of the same fact, which is the ticket's own defect class — so
    // this refuses, honestly and by name, rather than being clever.
    let spawned = 0;
    const r = await bt.openUrlInBrowser('chrome', 'www.example.com/x', {
      spawn: () => { spawned += 1; return { pid: 1, unref() {} }; },
      findBrowserExecutable: fakeExeResolver(P),
    });
    assert.equal(r.opened, false);
    assert.equal(r.reason, 'not a valid url');
    assert.equal(spawned, 0);
  });

  // (g)
  test('openUrlInBrowser spawns the exe with the parsed href as its ONLY argument', async () => {
    const calls = [];
    const res = await bt.openUrlInBrowser('chrome', 'https://www.example.com/x', {
      spawn: (exe, args, opts) => { calls.push({ exe, args, opts }); const child = new (require('node:events').EventEmitter)(); child.unref = () => {}; process.nextTick(() => child.emit('spawn')); return child; },
      findBrowserExecutable: fakeExeResolver(P),
    });
    assert.equal(res.opened, true);
    assert.equal(res.browser, 'chrome');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, P.chrome);
    assert.deepEqual(calls[0].args, ['https://www.example.com/x'],
      'exactly one positional argument, always beginning http(s) so Chromium cannot read it as a flag');
    assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore',
      cwd: require('../src/core/util/child-runtime').childRuntimeDir() });
  });

  test('openUrlInBrowser refuses a bad scheme and an unknown browser without spawning', async () => {
    let spawned = 0;
    const spawn = () => { spawned += 1; return { pid: 1, unref() {} }; };
    const deps = { spawn, findBrowserExecutable: fakeExeResolver(P) };
    assert.equal((await bt.openUrlInBrowser('chrome', 'file:///C:/x', deps)).opened, false);
    assert.equal((await bt.openUrlInBrowser('safari', 'https://example.com', deps)).opened, false);
    assert.equal((await bt.openUrlInBrowser('edge', 'https://example.com',
      { spawn, findBrowserExecutable: fakeExeResolver({ chrome: P.chrome }) })).opened, false,
    'a named browser that is not installed must fail, not fall back');
    assert.equal(spawned, 0, 'nothing may be spawned on any refusal path');
  });

  test('openUrlInBrowser reports a spawn failure rather than throwing', async () => {
    const res = await bt.openUrlInBrowser('chrome', 'https://example.com', {
      spawn: () => { throw new Error('EACCES'); },
      findBrowserExecutable: fakeExeResolver(P),
    });
    assert.equal(res.opened, false);
    assert.match(String(res.reason), /EACCES/);
  });

  test('openUrlInBrowser returns the real asynchronous ENOENT without crashing', async () => {
    const missing = path.resolve(__dirname, '../../.cache/campaign/nonexistent-browser.exe');
    assert.equal(require('node:fs').existsSync(missing), false);
    const res = await externalRoute.performExternalOpen(
      { browser: 'chrome', href: 'https://example.com/' },
      { deps: { findBrowserExecutable: () => missing } },
    );
    assert.equal(res.opened, false);
    assert.match(res.reason, /ENOENT/);
  });

  test('the named route never claims MYTHOS owns the browser it opened', () => {
    // BUG-029's pidfile arms `Start Agent OS.bat` to kill an orphaned DEBUG
    // browser on the next boot. This route opens the operator's REAL browser,
    // so recording its pid there would arm the next boot to kill the window
    // they are working in. Source-shape assertion because the trap is the
    // ABSENCE of a call — there is nothing to observe at runtime.
    //
    // THIS GUARD'S FIRST VERSION FAILED ON ITS OWN SUBJECT'S COMMENT. The code
    // carries a "DELIBERATELY NOT recordLaunchedPid()" note explaining the
    // trap, and a bare /recordLaunchedPid/ match cannot tell an explanation
    // from a call. Comments are stripped first. Recorded rather than quietly
    // corrected, because a source-shape guard matching prose is a standing
    // false-positive class in this repo rather than a one-off.
    const raw = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'browser-target.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /recordLaunchedPid/,
      'browser-target.js must never record a pid: the browser it opens is the operator\'s, not MYTHOS\'s');
    assert.match(raw, /DELIBERATELY NOT recordLaunchedPid/,
      'and the reason must stay written where the next editor will read it');
  });

  // --- the open_web side of the same question -----------------------------

  test('open_web keeps the OS default when no browser is named', () => {
    const t = externalRoute.resolveExternalTarget({ url: 'https://example.com/a' });
    assert.deepEqual(t, { ok: true, href: 'https://example.com/a', browser: null },
      'browser:null means "the OS default", which is unchanged behaviour');
  });

  test('open_web honours a named browser, and a bad name FAILS rather than defaulting', () => {
    assert.equal(externalRoute.resolveExternalTarget({ url: 'https://x.example', browserName: 'Brave Browser' }).browser,
      'brave');
    const bad = externalRoute.resolveExternalTarget({ url: 'https://x.example', browserName: 'safari' });
    assert.equal(bad.ok, false, 'quietly using the default for an unrecognised name is the bug');
    assert.match(String(bad.reason), /not a browser I can open this in/);
  });

  test('open_web still refuses a non-URL with browser:true', () => {
    const r = externalRoute.resolveExternalTarget({ query: 'weather in tokyo' });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /needs a url/);
  });

  test('the named route works with NO Electron shell; the default route says why it cannot', async () => {
    const calls = [];
    const named = await externalRoute.performExternalOpen(
      { ok: true, href: 'https://x.example/', browser: 'chrome' },
      { openUrlInBrowser: (b, u) => { calls.push([b, u]); return { opened: true }; } },
    );
    assert.deepEqual({ opened: named.opened, via: named.via }, { opened: true, via: 'named-browser' });
    assert.deepEqual(calls, [['chrome', 'https://x.example/']]);

    const dflt = await externalRoute.performExternalOpen({ ok: true, href: 'https://x.example/', browser: null }, {});
    assert.equal(dflt.opened, false, 'BUG-272 T2: no surface is a FAILURE, never an unverified success');
    assert.match(String(dflt.reason), /desktop shell is not running/);
    assert.match(String(dflt.reason), /browserName/, 'and it must name the route that does work here');
  });

  test('the spoken confirmation distinguishes the real profile from the debug one', () => {
    const named = externalRoute.confirmedStepFor({ via: 'named-browser', browser: 'chrome' }, 'https://x.example/');
    assert.match(named, /normal chrome profile/);
    assert.match(named, /not the MYTHOS debug one/);
    const dflt = externalRoute.confirmedStepFor({ via: 'os-default', browser: null }, 'https://x.example/');
    assert.match(dflt, /your default browser/);
    // BUG-405 rides along on both: this route may have LAUNCHED the browser.
    for (const s of [named, dflt]) assert.match(s, /list_windows/);
  });

  test('BROWSER_EXECUTABLE still outranks the OS default (adjacent case)', () => {
    const before = process.env.BROWSER_EXECUTABLE;
    const portable = path.join('D:', 'portable', 'chrome.exe');
    process.env.BROWSER_EXECUTABLE = portable;
    try {
      const r = bt.resolveLaunchTarget(null, {
        findBrowserExecutable: (name) => (name ? P[name] || null : portable),
        platform: 'win32',
        readRegistryValue: reader(REAL_USERCHOICE, REAL_COMMAND),
      });
      assert.equal(r.source, 'browser-executable-env',
        'an explicit operator override must not be silently outranked by the machine default');
      assert.equal(r.exe, portable);
    } finally {
      if (before === undefined) delete process.env.BROWSER_EXECUTABLE;
      else process.env.BROWSER_EXECUTABLE = before;
    }
  });

  test('open_web and browser_launch_debug now resolve names through the SAME module', () => {
    // Two derivations of one fact is the shape this ticket is about. The
    // effector re-exports rather than redefines, so this identity check is the
    // guard against a second copy reappearing.
    const fromBrowser = require('../src/core/effectors/from-browser');
    assert.equal(fromBrowser.normalizeBrowserName, bt.normalizeBrowserName);
    assert.equal(fromBrowser.findBrowserExecutable, bt.findBrowserExecutable);
    assert.equal(fromBrowser.identifyBrowserByExecutable, bt.identifyBrowserByExecutable);
    // The URL-shape rule had two copies for one turn of this fix. Source-shape
    // assertion because a duplicated regex literal is invisible at runtime —
    // both copies agree until one is edited, which is precisely the failure.
    const dash = require('node:fs').readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'effectors', 'from-dashboard.js'), 'utf8');
    assert.match(dash, /require\('\.\/open-external-route'\)/,
      'from-dashboard.js must import the URL-shape rule, not restate it');
    assert.doesNotMatch(dash, /const URL_SHAPED = \//,
      'a second URL_SHAPED literal here is the two-derivations-of-one-fact bug reappearing');
  });
});
