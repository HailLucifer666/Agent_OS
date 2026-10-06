'use strict';

// test/bug-477-browser-agent-log-evidence.test.js
//
// BUG-477 (attended run 2026-10-05/06), two log-evidence defects in
// adapters/browser-agent/index.js:
//
// (i) browser_launch_debug logged FOUR `browser-agent connect failed ...
//     ECONNREFUSED 127.0.0.1:9222` warns inside one second and then reported ok.
//     That is the designed cold-start poll (waitForDebugPortReady, BUG-140): the
//     first probes of a browser that is still starting are EXPECTED to be
//     refused. The final connect succeeded. The defect is that each expected
//     refusal was logged as a failure. Quiet probes are now counted and the next
//     connect line (success OR a real failure) names how many were suppressed
//     and the last error. A real failure stays loud.
//
// (ii) `browser-agent disconnected unexpectedly` carried no fields, so the
//      operator closing the window, a browser crash and a dropped websocket read
//      the same. It now records what the library and the OS can actually say:
//      page open/close/crash history, the last tool, and whether the debug port
//      still answers. (Playwright's Browser 'disconnected' carries no reason and
//      cannot be raised by a page navigation - see disconnect-evidence.js.) A
//      stale handle's late 'disconnected' event no longer clobbers the CURRENT
//      connection (found while reading the handler: it nulled `browser` and set
//      OFFLINE unconditionally).
//
// MUTATION PROBES, 2026-10-06 (each applied once, diffed, restored from a copy):
//   (a) drop `suppressed.add` (quiet failures not counted)          -> reds both (i) tests
//   (b) ensureOnline stops passing `quiet` through to connect()     -> reds both (i) tests
//   (c) the real-failure line drops `...suppressed.take()`          -> reds "a REAL failure stays loud ..."
//   (d) remove the stale-handle guard                               -> reds "a stale handle's late disconnected event ..."
//   (e) remove the evidence report                                  -> reds all seven (ii) evidence tests
//   (f) classify ignores openPages                                  -> reds "one of two pages closing ..."
//   (g) page 'close' no longer tracked                              -> reds "operator closes the last page" and "one of two pages"
//   (h) noteTool becomes a no-op                                    -> reds "the last tool called rides on the line"
//   (i) report even when the close was deliberate (`if (true)`)     -> reds ADJACENT "a deliberate close ..."
//       (first attempt SURVIVED: disconnect() nulls `browser`, so the stale guard returned before the flag
//       was read. That was the fixture, not a sound guard - the test now drives closeLaunchedBrowser, which
//       raises the flag while the handle is still current, and (i) reds. Gate F: with the guard in place,
//       `intentionalDisconnect` only matters in that window.)
//   Each applied once, diffed, restored from a copy and hash-verified.
//
// ADJACENT CASES THAT MUST KEEP PASSING: a non-quiet failure still warns, once,
// per attempt; an intentional disconnect writes no "unexpectedly" line and never
// probes the port; the poller's own backoff behaviour is test/browser-agent-
// backoff.test.js and is untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const originalRequire = Module.prototype.require;
const ADAPTER_PATH = path.resolve(__dirname, '../adapters/browser-agent/index.js');

function makeSpyLogger() {
  const entries = [];
  const logger = {
    debug: () => {},
    info: (msg, fields) => entries.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
  };
  return { entries, logger };
}

function loadAdapter(mockChromium, logger) {
  Module.prototype.require = function (id) {
    if (id === 'playwright-core') return { chromium: mockChromium };
    if (id === '../../src/core/logger') return { createLogger: () => logger };
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[ADAPTER_PATH];
  try { return require(ADAPTER_PATH); } finally { Module.prototype.require = originalRequire; }
}

// A fake CDP browser whose pages are emitters, like the real ones.
function fakeBrowser(pageCount) {
  const pages = Array.from({ length: pageCount }, () => new EventEmitter());
  const ctx = Object.assign(new EventEmitter(), { pages: () => pages.slice() });
  const browser = Object.assign(new EventEmitter(), { contexts: () => [ctx], close() {} });
  return { browser, pages, ctx };
}

// Real loopback sockets, so the port probe is exercised for real: an HTTP server
// is "the browser is alive"; a port that was listening and is now closed is
// "the browser is gone".
function listenAnswering() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.end('{}'); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}
async function refusedUrl() {
  const { srv, url } = await listenAnswering();
  await new Promise((r) => srv.close(r));
  return url;
}

async function until(fn, ms) {
  const deadline = Date.now() + (ms || 3000);
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the log line');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const REFUSED = () => { throw new Error('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222'); };

// ---------------------------------------------------------------- (i) cold start

test('(i) four refused cold-start probes log no failure; the success line names how many were suppressed', async () => {
  const { entries, logger } = makeSpyLogger();
  let calls = 0;
  const { browser } = fakeBrowser(1);
  const agent = loadAdapter({ connectOverCDP: async () => { calls += 1; if (calls <= 4) REFUSED(); return browser; } }, logger);

  for (let i = 0; i < 4; i += 1) {
    assert.equal(await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222', quiet: true }), false);
    // Nothing is hidden from getStatus(): the failure is fully reportable.
    assert.match(agent.getStatus().hint, /CDP connect failed: .*ECONNREFUSED/);
  }
  assert.equal(entries.filter((e) => e.msg === 'browser-agent connect failed').length, 0,
    'an expected cold-start refusal is not a failure line');

  assert.equal(await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222', quiet: true }), true);
  const connected = entries.filter((e) => e.msg === 'browser-agent connected via CDP');
  assert.equal(connected.length, 1);
  assert.equal(connected[0].fields.suppressedFailures, 4);
  assert.match(connected[0].fields.lastSuppressedError, /ECONNREFUSED/);
  assert.equal(entries.filter((e) => e.level === 'warn').length, 0, 'a cold start that succeeds warns about nothing');
  assert.equal(agent.getStatus().state, 'ONLINE');
});

test('(i) a REAL failure stays loud, and says how many probes came before it', async () => {
  const { entries, logger } = makeSpyLogger();
  const agent = loadAdapter({ connectOverCDP: async () => REFUSED() }, logger);

  await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222', quiet: true });
  await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222', quiet: true });
  assert.equal(entries.length, 0);

  assert.equal(await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222' }), false);
  const fails = entries.filter((e) => e.msg === 'browser-agent connect failed');
  assert.equal(fails.length, 1, 'the non-quiet attempt IS the loud one');
  assert.equal(fails[0].level, 'warn');
  assert.match(fails[0].fields.error, /ECONNREFUSED/);
  assert.equal(fails[0].fields.suppressedFailures, 2);
});

test('ADJACENT: non-quiet attempts each still warn once (default behaviour unchanged)', async () => {
  const { entries, logger } = makeSpyLogger();
  const agent = loadAdapter({ connectOverCDP: async () => REFUSED() }, logger);
  await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222' });
  await agent.ensureOnline({ cdpUrl: 'http://127.0.0.1:9222' });
  assert.equal(entries.filter((e) => e.msg === 'browser-agent connect failed').length, 2);
});

// ------------------------------------------------------------ (ii) disconnect evidence

async function connected(url, pageCount, logger) {
  const f = fakeBrowser(pageCount);
  const agent = loadAdapter({ connectOverCDP: async () => f.browser }, logger);
  assert.equal(await agent.connect(url), true);
  return { agent, ...f };
}
const unexpected = (entries) => entries.find((e) => e.msg === 'browser-agent disconnected unexpectedly');

test('(ii) the operator closes the last page and the browser exits: named as such, with the facts', async () => {
  const { entries, logger } = makeSpyLogger();
  const { agent, browser, pages } = await connected(await refusedUrl(), 1, logger);
  pages[0].emit('close');
  browser.emit('disconnected');
  assert.equal(agent.getStatus().state, 'OFFLINE', 'state still flips synchronously');
  const line = (await until(() => unexpected(entries))).fields;
  assert.equal(line.cause, 'last-page-closed-then-browser-exited');
  assert.equal(line.port, 'refused');
  assert.equal(line.openPages, 0);
  assert.equal(line.pagesClosed, 1);
  assert.ok(line.lastPageCloseMsAgo >= 0 && line.lastPageCloseMsAgo < 3000);
});

test('(ii) the connection drops while the browser is alive and its pages are open: named as a connection loss', async () => {
  const { entries, logger } = makeSpyLogger();
  const { srv, url } = await listenAnswering();
  try {
    const { agent, browser } = await connected(url, 2, logger);
    browser.emit('disconnected');
    const line = (await until(() => unexpected(entries))).fields;
    assert.equal(line.cause, 'connection-lost-browser-alive');
    assert.equal(line.port, 'answers');
    assert.equal(line.openPages, 2);
    assert.equal(line.pagesClosed, 0);
    assert.equal(agent.getStatus().state, 'OFFLINE');
  } finally { srv.close(); }
});

test('(ii) page navigation is not evidence of anything: navigations then a vanished browser read as browser-exited, not a window close', async () => {
  const { entries, logger } = makeSpyLogger();
  const { browser, pages } = await connected(await refusedUrl(), 1, logger);
  pages[0].emit('framenavigated'); pages[0].emit('load'); pages[0].emit('domcontentloaded');
  browser.emit('disconnected');
  const line = (await until(() => unexpected(entries))).fields;
  assert.equal(line.cause, 'browser-exited');
  assert.equal(line.pagesClosed, 0);
  assert.equal(line.openPages, 1);
});

test('(ii) one of two pages closing is not the window closing', async () => {
  const { entries, logger } = makeSpyLogger();
  const { browser, pages } = await connected(await refusedUrl(), 2, logger);
  pages[0].emit('close');
  browser.emit('disconnected');
  const line = (await until(() => unexpected(entries))).fields;
  assert.equal(line.openPages, 1);
  assert.equal(line.cause, 'browser-exited', 'a page was still open, so this was not the last-page-close signature');
});

test('(ii) the last tool called rides on the line', async () => {
  const { entries, logger } = makeSpyLogger();
  const { agent, browser } = await connected(await refusedUrl(), 1, logger);
  agent.noteTool('browser_click');
  browser.emit('disconnected');
  const line = (await until(() => unexpected(entries))).fields;
  assert.equal(line.lastTool, 'browser_click');
  assert.ok(line.lastToolMsAgo >= 0);
});

test('(ii) a page that crashed before the browser vanished is recorded', async () => {
  const { entries, logger } = makeSpyLogger();
  const { browser, pages } = await connected(await refusedUrl(), 1, logger);
  pages[0].emit('crash');
  browser.emit('disconnected');
  const line = (await until(() => unexpected(entries))).fields;
  assert.equal(line.pageCrashes, 1);
  assert.equal(line.cause, 'browser-exited-after-page-crash');
});

test('(ii) an unreadable port is said to be unreadable, not guessed', async () => {
  const { entries, logger } = makeSpyLogger();
  const { browser } = await connected('not a url at all', 1, logger);
  browser.emit('disconnected');
  const line = (await until(() => unexpected(entries))).fields;
  assert.equal(line.port, 'error');
  assert.equal(line.cause, 'unknown-port-unreadable');
});

test('ADJACENT: a deliberate close writes no "unexpectedly" line', async () => {
  const { entries, logger } = makeSpyLogger();
  const { agent, browser } = await connected(await refusedUrl(), 1, logger);
  // closeLaunchedBrowser sets the intentional flag synchronously and the browser's
  // 'disconnected' event arrives while the handle is still the CURRENT one - the one
  // situation in which the flag (not the stale-handle guard) is what keeps the line
  // quiet. A directory that is not a MYTHOS debug profile is refused by
  // browser-process.js, so nothing real is closed or killed here.
  const closing = agent.closeLaunchedBrowser(path.join(require('node:os').tmpdir(), 'not-a-mythos-debug-profile'));
  browser.emit('disconnected');
  await closing;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(unexpected(entries), undefined);
  assert.equal(agent.getStatus().state, 'OFFLINE');
});

test('ADJACENT: disconnect() then a late event from the same handle is also silent', async () => {
  const { entries, logger } = makeSpyLogger();
  const { agent, browser } = await connected(await refusedUrl(), 1, logger);
  await agent.disconnect();
  browser.emit('disconnected');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(unexpected(entries), undefined);
});

test('a stale handle\'s late disconnected event does not take down the CURRENT connection', async () => {
  const { entries, logger } = makeSpyLogger();
  const a = fakeBrowser(1);
  const b = fakeBrowser(1);
  const handles = [a.browser, b.browser];
  const agent = loadAdapter({ connectOverCDP: async () => handles.shift() }, logger);
  assert.equal(await agent.connect('http://127.0.0.1:9222'), true);
  assert.equal(await agent.connect('http://127.0.0.1:9222'), true, 'a reconnect replaces handle A with handle B');
  a.browser.emit('disconnected'); // A's transport finishes closing AFTER B is up
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(agent.getStatus().state, 'ONLINE', 'B is healthy; A closing must not mark it OFFLINE');
  assert.equal(unexpected(entries), undefined);
  b.browser.emit('disconnected');
  assert.equal(agent.getStatus().state, 'OFFLINE', 'while B\'s own event still does');
});
