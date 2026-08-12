'use strict';

// test/auth-session-prime.test.js — Task D4: the app authenticates itself.
//
// The token lives in keys.json (decrypted server-side by
// decryptedKeysForChild(), same value the child's env already gets — see
// startChild() in electron/main.js) or in a plain .env MYTHOS_AUTH_TOKEN for
// headless/Docker. Electron never used it: the operator had to paste the
// same secret back into the HUD's own gate after every restart, which is
// asking a human to be a password manager for a credential the main process
// already holds. This adds primeAuthSession(win, token, port) — POST
// /api/auth/session, then mirror the returned mythos_token cookie into the
// window's own session — called once at boot, before the first loadURL.
//
// electron/main.js cannot be require()d under a bare `node --test`: it loads
// the real `electron` module and calls app.whenReady() with real side effects
// (fork a child, open a window) at require time. Two layers, same shape as
// test/electron-cursor-overlay.test.js:
//
//   1. primeAuthSession/resolveAuthTokenForPriming themselves — REAL behavior
//      tests. Both functions are self-contained (only `fetch`, `log`,
//      `process.env` and an injected `win`/keystore reader; no top-level
//      `require('electron')` inside their own bodies), so their exact source
//      text is extracted out of main.js and run in a fresh vm context with
//      fakes standing in for fetch/log/win. This is NOT a require() of
//      main.js — no Electron module, no app.whenReady(), no side effect ever
//      runs; it is the same "test the real logic against fakes" idea as
//      cursor-overlay-window.js's injected BrowserWindowCtor/screenModule,
//      just reached by extraction instead of a separate requireable file
//      (this task's scope is electron/main.js + this test only).
//
//   2. electron/main.js wiring — SOURCE-SHAPE assertions (readSource), the
//      established pattern for the parts of main.js that cannot be exercised
//      directly: primeAuthSession is called inside app.whenReady(), after
//      mainWindow exists and before the first loadURL(), and the boot path
//      never reaches any lazy Electron export (`screen`, `session`, etc.) at
//      module scope to get there.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MAIN_PATH = path.join(REPO_ROOT, 'electron', 'main.js');
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Extraction: pull one function's exact source text out of main.js by
// brace-matching from its declaration, and hand back a live function bound
// to a controlled vm context (fetch/log/process.env are the only free
// variables primeAuthSession/resolveAuthTokenForPriming touch).
// ---------------------------------------------------------------------------
function extractFunctionSource(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start > -1, `could not find "${signature}" in electron/main.js`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > -1, `unbalanced braces extracting "${signature}"`);
  return src.slice(start, end);
}

function loadIntoContext(contextExtras) {
  const primeSrc = extractFunctionSource(MAIN, 'async function primeAuthSession(win, token, port) {');
  const resolveSrc = extractFunctionSource(MAIN, 'function resolveAuthTokenForPriming() {');
  // decryptedKeysForChild() is resolveAuthTokenForPriming's other free
  // variable — supplied by the caller (tests inject their own keystore).
  const context = vm.createContext(Object.assign(
    { process: { env: {} }, decryptedKeysForChild: () => ({}) },
    contextExtras,
  ));
  vm.runInContext(`${resolveSrc}\n${primeSrc}`, context);
  return context;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
function fakeWin() {
  const calls = [];
  return {
    calls,
    webContents: {
      session: {
        cookies: {
          set: async (opts) => { calls.push(opts); },
        },
      },
    },
  };
}

function fakeFetch({ status = 200, setCookie, throws } = {}) {
  const requests = [];
  const fn = async (url, opts) => {
    requests.push({ url, opts });
    if (throws) throw throws;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name === 'set-cookie' ? (setCookie || null) : null) },
    };
  };
  fn.requests = requests;
  return fn;
}

function fakeLog() {
  const lines = [];
  return Object.assign((...args) => { lines.push(args); }, { lines });
}

// ---------------------------------------------------------------------------
// Layer 1 — real behavior against fakes
// ---------------------------------------------------------------------------
describe('primeAuthSession — real behavior (extracted from electron/main.js)', () => {
  it('no token: does nothing at all — fetch is never called, win is never touched', async () => {
    const fetch = fakeFetch();
    const log = fakeLog();
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log });
    await ctx.primeAuthSession(win, '', 4478);
    assert.equal(fetch.requests.length, 0, 'a default loopback install must never POST');
    assert.equal(win.calls.length, 0, 'a default loopback install must never touch the window session');
    assert.equal(log.lines.length, 0, 'a no-token boot must be completely silent — untouched');
  });

  it('undefined token: same as empty — still a strict no-op', async () => {
    const fetch = fakeFetch();
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log: fakeLog() });
    await ctx.primeAuthSession(win, undefined, 4478);
    assert.equal(fetch.requests.length, 0);
    assert.equal(win.calls.length, 0);
  });

  it('given a stored token: POSTs /api/auth/session with the token in the JSON body, on the right port', async () => {
    const TOKEN = 'stored-secret-abc123';
    const fetch = fakeFetch({ status: 200, setCookie: 'mythos_token=cookie-value-xyz; Path=/; HttpOnly; SameSite=Strict' });
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log: fakeLog() });
    await ctx.primeAuthSession(win, TOKEN, 4478);

    assert.equal(fetch.requests.length, 1);
    const { url, opts } = fetch.requests[0];
    assert.equal(url, 'http://127.0.0.1:4478/api/auth/session');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(opts.body), { token: TOKEN });
  });

  it('given a stored token and a 200 + Set-Cookie response: sets mythos_token on the window session', async () => {
    const fetch = fakeFetch({ status: 200, setCookie: 'mythos_token=cookie-value-xyz; Path=/; HttpOnly; SameSite=Strict' });
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log: fakeLog() });
    await ctx.primeAuthSession(win, 'some-token', 4478);

    assert.equal(win.calls.length, 1);
    const set = win.calls[0];
    assert.equal(set.url, 'http://127.0.0.1:4478');
    assert.equal(set.name, 'mythos_token');
    assert.equal(set.value, 'cookie-value-xyz');
    assert.equal(set.httpOnly, true);
  });

  it('401 (wrong token): does not set a cookie, and only the status is logged — never the token, never the response body', async () => {
    const TOKEN = 'sk-real-secret-should-never-be-logged';
    const fetch = fakeFetch({ status: 401 });
    const win = fakeWin();
    const log = fakeLog();
    const ctx = loadIntoContext({ fetch, log });
    await ctx.primeAuthSession(win, TOKEN, 4478);

    assert.equal(win.calls.length, 0, 'a failed exchange must never set a cookie');
    assert.ok(log.lines.length >= 1, 'a failure must be logged, not swallowed');
    const logged = JSON.stringify(log.lines);
    assert.ok(!logged.includes(TOKEN), 'the token must never appear in a log line');
  });

  it('409 (combined PIN + token deployment): does not set a cookie — the operator still sees the real gate', async () => {
    const fetch = fakeFetch({ status: 409 });
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log: fakeLog() });
    await ctx.primeAuthSession(win, 'some-token', 4478);
    assert.equal(win.calls.length, 0);
  });

  it('404 (no MYTHOS_AUTH_TOKEN configured server-side): does not set a cookie', async () => {
    const fetch = fakeFetch({ status: 404 });
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log: fakeLog() });
    await ctx.primeAuthSession(win, 'some-token', 4478);
    assert.equal(win.calls.length, 0);
  });

  it('200 with no Set-Cookie header at all: does not throw, does not set a cookie, and logs the gap', async () => {
    const fetch = fakeFetch({ status: 200, setCookie: null });
    const win = fakeWin();
    const log = fakeLog();
    const ctx = loadIntoContext({ fetch, log });
    await ctx.primeAuthSession(win, 'some-token', 4478);
    assert.equal(win.calls.length, 0);
    assert.ok(log.lines.length >= 1);
  });

  it('a connection error (server not up yet) is caught, not thrown — priming must never be able to block boot', async () => {
    const fetch = fakeFetch({ throws: new Error('ECONNREFUSED 127.0.0.1:4478') });
    const win = fakeWin();
    const log = fakeLog();
    const ctx = loadIntoContext({ fetch, log });
    await assert.doesNotReject(ctx.primeAuthSession(win, 'some-token', 4478));
    assert.equal(win.calls.length, 0);
    assert.ok(log.lines.length >= 1, 'the failure must still be logged, not silently dropped');
  });

  it('the token never appears in the request URL — only in the JSON body', async () => {
    const TOKEN = 'must-not-leak-into-a-url-539d1e11';
    const fetch = fakeFetch({ status: 200, setCookie: 'mythos_token=v; Path=/' });
    const win = fakeWin();
    const ctx = loadIntoContext({ fetch, log: fakeLog() });
    await ctx.primeAuthSession(win, TOKEN, 4478);
    assert.ok(!fetch.requests[0].url.includes(TOKEN), 'the URL handed to fetch must never carry the token');
  });
});

describe('resolveAuthTokenForPriming — real behavior', () => {
  it('prefers the decrypted keystore value over process.env, matching startChild()\'s env merge precedence', () => {
    const ctx = loadIntoContext({
      fetch: fakeFetch(),
      log: fakeLog(),
      decryptedKeysForChild: () => ({ MYTHOS_AUTH_TOKEN: 'from-keystore' }),
      process: { env: { MYTHOS_AUTH_TOKEN: 'from-env' } },
    });
    assert.equal(ctx.resolveAuthTokenForPriming(), 'from-keystore');
  });

  it('falls back to process.env.MYTHOS_AUTH_TOKEN when the keystore has none (the headless/.env path)', () => {
    const ctx = loadIntoContext({
      fetch: fakeFetch(),
      log: fakeLog(),
      decryptedKeysForChild: () => ({}),
      process: { env: { MYTHOS_AUTH_TOKEN: 'from-env' } },
    });
    assert.equal(ctx.resolveAuthTokenForPriming(), 'from-env');
  });

  it('returns \'\' (never undefined/null) on a fully loopback, tokenless install', () => {
    const ctx = loadIntoContext({
      fetch: fakeFetch(),
      log: fakeLog(),
      decryptedKeysForChild: () => ({}),
      process: { env: {} },
    });
    assert.equal(ctx.resolveAuthTokenForPriming(), '');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — electron/main.js wiring (source-shape, per the established
// pattern — see test/electron-cursor-overlay.test.js).
// ---------------------------------------------------------------------------
describe('electron/main.js wiring (source-shape)', () => {
  it('primeAuthSession and resolveAuthTokenForPriming both exist', () => {
    assert.match(MAIN, /async function primeAuthSession\(win, token, port\)/);
    assert.match(MAIN, /function resolveAuthTokenForPriming\(\)/);
  });

  it('is called inside app.whenReady(), after mainWindow is constructed and before the first loadURL()', () => {
    const readyStart = MAIN.indexOf('app.whenReady().then(');
    assert.ok(readyStart > -1);
    const readyBlock = MAIN.slice(readyStart);

    const ctorIdx = readyBlock.indexOf('mainWindow = new BrowserWindow(');
    const primeIdx = readyBlock.indexOf('primeAuthSession(mainWindow,');
    const loadIdx = readyBlock.indexOf('mainWindow.loadURL(');
    assert.ok(ctorIdx > -1, 'mainWindow construction not found inside whenReady()');
    assert.ok(primeIdx > -1, 'primeAuthSession(...) call not found inside whenReady()');
    assert.ok(loadIdx > -1, 'mainWindow.loadURL(...) not found inside whenReady()');
    assert.ok(ctorIdx < primeIdx, 'primeAuthSession must run AFTER mainWindow exists');
    assert.ok(primeIdx < loadIdx, 'primeAuthSession must run BEFORE the first loadURL() — no gate flash on a good prime');
  });

  it('primeAuthSession is awaited, not fired-and-forgotten', () => {
    const callIdx = MAIN.indexOf('primeAuthSession(mainWindow,');
    const lineStart = MAIN.lastIndexOf('\n', callIdx) + 1;
    const line = MAIN.slice(lineStart, MAIN.indexOf('\n', callIdx));
    assert.match(line, /await primeAuthSession\(/);
  });

  it('the token is sourced from resolveAuthTokenForPriming(), not hardcoded or re-derived at the call site', () => {
    const callIdx = MAIN.indexOf('primeAuthSession(mainWindow,');
    const line = MAIN.slice(callIdx, MAIN.indexOf('\n', callIdx));
    assert.match(line, /resolveAuthTokenForPriming\(\)/);
  });

  it('resolveAuthTokenForPriming reads decryptedKeysForChild() and process.env, never a hardcoded/literal token', () => {
    const start = MAIN.indexOf('function resolveAuthTokenForPriming() {');
    const body = MAIN.slice(start, MAIN.indexOf('\n}', start));
    assert.match(body, /decryptedKeysForChild\(\)\.MYTHOS_AUTH_TOKEN/);
    assert.match(body, /process\.env\.MYTHOS_AUTH_TOKEN/);
  });

  it('no property of a lazy app-ready-gated Electron export is reached to get there (the screen/session crash class)', () => {
    // primeAuthSession/resolveAuthTokenForPriming touch only `fetch`, `log`,
    // `process.env`, `decryptedKeysForChild()` and the already-constructed
    // `win` argument — none of those is a top-level Electron module export.
    const primeStart = MAIN.indexOf('async function primeAuthSession(win, token, port) {');
    const primeEnd = MAIN.indexOf('\n}\n', primeStart) + 2;
    const resolveStart = MAIN.indexOf('function resolveAuthTokenForPriming() {');
    const resolveEnd = MAIN.indexOf('\n}\n', resolveStart) + 2;
    const block = MAIN.slice(resolveStart, resolveEnd) + MAIN.slice(primeStart, primeEnd);
    assert.doesNotMatch(block, /require\('electron'\)/, 'must not require electron at all — win is already a live BrowserWindow');
    assert.doesNotMatch(block, /\bscreen\b/, 'must never touch the lazy `screen` export');
  });

  it('never logs or forwards the raw token — only a status code or an error message', () => {
    const start = MAIN.indexOf('async function primeAuthSession(win, token, port) {');
    const end = MAIN.indexOf('\n}\n', start) + 2;
    const body = MAIN.slice(start, end);
    // Every log( call inside the function must reference status/err.message,
    // never the bare `token` identifier or the raw response body.
    const logCalls = body.match(/log\([^)]*\)/g) || [];
    assert.ok(logCalls.length > 0, 'a failure path must log something');
    for (const call of logCalls) {
      assert.ok(!/\btoken\b/.test(call), `log call must not reference the token: ${call}`);
    }
    // The token is used exactly once, inside the request body construction —
    // never interpolated into the URL template.
    const urlLine = body.match(/`http:\/\/127\.0\.0\.1:\$\{port\}\/api\/auth\/session`/);
    assert.ok(urlLine, 'the request URL must be built from port only, never the token');
  });
});
