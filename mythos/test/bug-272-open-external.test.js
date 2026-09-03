'use strict';
// bug-272-open-external.test.js — open_web(browser:true) reaches the operator's
// real browser, or fails saying so.
//
// The incident: 7 consecutive calls in the 2026-08-17 session, all returning
// ok:true + unverified, while Chrome sat on an unrelated page. Under the Electron
// shell widgetType:'newtab' had ZERO working surfaces — the media window refuses
// anything but youtube/web by design (bug-075-electron-media-window.test.js
// asserts that, deliberately), the HUD's window.open fallback is denied
// unconditionally by setWindowOpenHandler, and shell.openExternal appeared
// nowhere in the codebase. logs/main.log carried the corpses: 6x "denied external
// open for https://www.youtube.com/results?search_query=news".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildTools } = require('../src/core/effectors/from-dashboard');

// buildTools' dependency surface, trimmed to what open_web touches.
function tools(deps) {
  return buildTools(Object.assign({
    logger: { info() {}, warn() {}, error() {} },
    bus: { emit() {} },
    config: {},
  }, deps || {}));
}

// open_web REQUIRES a type; browser:true rides on top of one. Omitting it makes
// every call fail the type check before reaching the hand-off branch, which looks
// like a passing negative test and asserts nothing. Every fixture below passes
// type:'web' for that reason.
function openWebOf(built) {
  const entry = built.TOOLS.find((t) => t.name === 'open_web');
  assert.ok(entry, 'open_web must exist');
  return entry.fn;   // the TOOLS entry key, per bug-075-electron-media-window.test.js's toolFn
}

describe('BUG-272 T2 — open_web(browser:true) hands off, or fails honestly', () => {
  it('hands the url to the shell and reports unverified, not a bare success', async () => {
    const seen = [];
    const built = tools();
    built.setExternalOpener(async (url) => { seen.push(url); return { opened: true, reason: null }; });
    const res = await openWebOf(built)({ type: 'web', browser: true, url: 'https://example.com/news' });

    assert.deepEqual(seen, ['https://example.com/news'], 'the url must actually reach the shell');
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true,
      'openExternal resolves when the OS ACCEPTS the request, not when a page renders — '
      + 'claiming confirmation would be a new dishonesty in place of the old one');
    assert.match(String(res.reason), /browser/);
  });

  // UPDATED 2026-09-03 (BUG-407): the expected value gained its trailing slash.
  // This route now parses the URL with WHATWG `new URL()` and hands over
  // `parsed.href`, because the named-browser path passes the string to a
  // browser PROCESS and the scheme must be proven http/https at that edge, not
  // pattern-matched. `href` canonicalises an empty path to "/".
  //
  // This is not a loosened assertion. electron/main.js ALREADY called
  // shell.openExternal(parsed.href), so 'https://www.example.com/' is what the
  // browser received all along — the old expectation pinned the value one hop
  // before the normalisation and therefore did not describe what was opened.
  // Moving the parse earlier makes the reported url and the opened url the same
  // string, which is the fact worth pinning.
  it('a bare domain is normalised to https before hand-off', async () => {
    const seen = [];
    const built = tools();
    built.setExternalOpener(async (url) => { seen.push(url); return { opened: true }; });
    await openWebOf(built)({ type: 'web', browser: true, url: 'www.example.com' });
    assert.deepEqual(seen, ['https://www.example.com/']);
  });

  // The heart of the fix. Every one of these was previously ok:true.
  it('a refused hand-off is a FAILURE and carries the reason', async () => {
    const built = tools();
    built.setExternalOpener(async () => ({ opened: false, reason: 'refused scheme file: — only http and https are opened externally' }));
    const res = await openWebOf(built)({ type: 'web', browser: true, url: 'https://example.com' });

    assert.equal(res.ok, false, 'no surface is a failure, not an unverified success — that '
      + 'distinction is why the breaker counted 7 failures as 7 successes');
    assert.match(String(res.error || res.result), /refused scheme/,
      'the reason must survive to the operator, not be replaced by a generic message');
  });

  it('no shell at all is a failure that names the alternative', async () => {
    // setExternalOpener deliberately never called — a plain server/browser
    // session, mirroring how bug-075's test models a non-Electron boot.
    const built = tools();
    const res = await openWebOf(built)({ type: 'web', browser: true, url: 'https://example.com' });

    assert.equal(res.ok, false);
    assert.match(String(res.error || res.result), /browser_navigate/,
      'an honest failure names what WOULD work; the model had no way to learn that before');
  });

  it('a thrown opener does not escape as an unhandled rejection', async () => {
    const built = tools();
    built.setExternalOpener(async () => { throw new Error('IPC round trip failed'); });
    const res = await openWebOf(built)({ type: 'web', browser: true, url: 'https://example.com' });
    assert.equal(res.ok, false, 'open_web already wraps its body in try/catch; this pins it');
  });

  it('browser:true without a usable url still fails before any hand-off', async () => {
    const seen = [];
    const built = tools();
    built.setExternalOpener(async (u) => { seen.push(u); return { opened: true }; });
    const res = await openWebOf(built)({ browser: true, type: 'search', query: 'the weather' });
    assert.equal(res.ok, false, 'a search result list cannot open in a real browser');
    assert.deepEqual(seen, [], 'and nothing must be handed to the shell');
  });
});

describe('BUG-272 T2 — the Electron side', () => {
  const main = () => fs.readFileSync(
    path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it('handles mythos:open-external and acks back', () => {
    const src = main();
    assert.match(src, /msg\.channel === 'mythos:open-external'/,
      'the request half of the channel');
    assert.match(src, /channel: 'mythos:open-external-ack'/,
      'and the ack half — a request with no ack is how the media-window verdict '
      + 'got dropped on the floor for seven turns');
  });

  // SECURITY. shell.openExternal hands the string to the OS handler for its
  // scheme, so this is not "open a web page", it is "run whatever is registered
  // for this protocol". file: opens Explorer on an arbitrary path; ms-msdt: and
  // search-ms: have been live Windows RCE vectors. The URL comes from a tool call
  // the MODEL composed, so it is influenceable by anything that reached the
  // model's context — a summarised web page, an email, a filename.
  it('only http and https are handed to the OS', () => {
    const src = main();
    const fn = src.slice(src.indexOf('function openExternalUrl'));
    const body = fn.slice(0, fn.indexOf('\n  }\n') + 1);
    assert.ok(body.length > 100, 'openExternalUrl must exist and be locatable');
    assert.match(body, /protocol !== 'http:'/, 'an allowlist, not a denylist');
    assert.match(body, /protocol !== 'https:'/);
    assert.match(body, /new URL\(/,
      'parsed by WHATWG URL, not string-matched — a startsWith check is bypassable');
    assert.ok(body.indexOf('new URL(') < body.indexOf('shell.openExternal'),
      'validation must run BEFORE the hand-off, or it is decoration');
  });

  it('requires shell lazily, not at module scope', () => {
    const src = main();
    assert.doesNotMatch(src.slice(0, src.indexOf('function ')), /\{[^}]*\bshell\b[^}]*\} = require\('electron'\)/,
      'several Electron exports are lazy getters that throw before app.ready, and a '
      + 'module-scope destructure of one is what once stopped this app booting at all');
    const fn = src.slice(src.indexOf('function openExternalUrl'));
    assert.match(fn.slice(0, fn.indexOf('\n  }\n')), /require\('electron'\)/,
      'required at the use site instead');
  });

  it('the media-window open-web verdict is acked instead of discarded', () => {
    const src = main();
    assert.match(src, /channel: 'mythos:ui\.open-web-ack'/,
      "handleOpenWeb returns {opened:false, reason:'not a media widgetType'} for anything it "
      + 'refuses, and that verdict used to be log()ed and thrown away — so open_web reported '
      + 'ok:true for a window that never opened');
  });
});

describe('BUG-272 T2 — the server side request/ack', () => {
  const server = () => fs.readFileSync(
    path.join(__dirname, '..', 'server', 'index.js'), 'utf8'
  ).replace(/\r\n/g, '\n');

  it('mirrors requestCloseMediaWindow, including the no-Electron and timeout paths', () => {
    const src = server();
    const fn = src.slice(src.indexOf('function requestOpenExternal'));
    const body = fn.slice(0, fn.indexOf('\n  }\n') + 1);
    assert.match(body, /typeof process\.send !== 'function'/,
      'a plain server boot must resolve, not hang');
    assert.match(body, /setTimeout/, 'and an unanswered request must time out');
    assert.match(body, /reason:/,
      'it resolves an OBJECT, not a boolean: "did not open" and "did not open BECAUSE the '
      + 'scheme was refused" are different things, and a bare false is how the original '
      + 'failure stayed invisible');
  });

  it('is exported so src/main.js can wire it', () => {
    assert.match(server(), /requestOpenExternal,/);
    const wiring = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert.match(wiring, /setExternalOpener\(serverHandle\.requestOpenExternal\)/,
      'wired only when both halves exist, like setMediaWindowCloser');
  });
});
