'use strict';

// adapters/browser-agent/disconnect-evidence.js — BUG-477 (2026-10-06).
//
// Two things the adapter's log could not tell the operator apart, and a pure
// home for both so index.js stays under its size ceiling and this can be tested
// with no browser, no Playwright and no network.
//
// 1. DISCONNECT EVIDENCE. `browser-agent disconnected unexpectedly` fired for
//    every 'disconnected' event that was not an intentional close, and carried
//    no fields: the operator closing the window, the browser crashing, and the
//    websocket dropping while the browser lived all read the same.
//
//    WHAT THE LIBRARY ACTUALLY REPORTS (read from playwright-core 1.62.1,
//    lib/coreBundle.js, not assumed):
//      - Browser 'disconnected' is emitted when the CDP transport closes
//        (Connection._onClose -> ConnectionEvents.Disconnected -> CRBrowser
//        ._didDisconnect). It carries NO reason, and a page navigating cannot
//        produce it: navigation is a frame event on a live connection. So
//        "a page navigation looked like a disconnect" is not a thing this
//        event can say; what the event cannot distinguish is the three causes
//        below.
//      - Page 'close' and 'crash', and BrowserContext 'page', DO exist, and are
//        the only in-process evidence of what the pages were doing.
//    So the in-process evidence is: how many pages were open, when the last one
//    closed, whether any crashed, which tool ran last. The one thing no event
//    gives is whether the BROWSER PROCESS is still alive, so that is read from
//    outside, by asking the debug port (GET /json/version): an answer means the
//    browser is up and the connection alone dropped; a refusal means the
//    browser is gone.
//
//    The `cause` is an INFERENCE from those facts and is named as one; the facts
//    ride beside it so a wrong inference can be overruled by reading the line.
//
// 2. SUPPRESSED CONNECT FAILURES. browser_launch_debug polls connect() on a cold
//    start (BUG-140) and the first probes are EXPECTED to be refused (measured
//    2026-10-05: four ECONNREFUSED warns inside one second, then a success).
//    Quiet probes are counted here and surface on the NEXT connect line (success
//    or a real failure), so a cold start leaves one line that names the attempts
//    and the final outcome, and a failure that is real is still loud.

const http = require('node:http');

const PORT_PROBE_TIMEOUT_MS = 1000;
// A page closing this shortly before the connection dropped is read as the
// operator closing the window (the last page closing takes the browser with it).
const WINDOW_CLOSE_WINDOW_MS = 3000;

function safeOn(emitter, event, fn) {
  try { if (emitter && typeof emitter.on === 'function') emitter.on(event, fn); } catch (_) { /* a fake or closed handle */ }
}

// Tracks what the pages did since this connection was made. Defensive on purpose:
// every tracked object may be a test fake exposing only `on`.
function track(browser, deps) {
  const now = (deps && deps.now) || Date.now;
  const t = { connectedAt: now(), open: new Set(), closes: 0, crashes: 0, lastCloseAt: null, lastTool: null, lastToolAt: null };
  function watch(page) {
    if (!page || t.open.has(page)) return;
    t.open.add(page);
    safeOn(page, 'close', () => { t.open.delete(page); t.closes += 1; t.lastCloseAt = now(); });
    safeOn(page, 'crash', () => { t.crashes += 1; });
  }
  let contexts = [];
  try { contexts = browser && typeof browser.contexts === 'function' ? browser.contexts() : []; } catch (_) { contexts = []; }
  for (const ctx of contexts) {
    safeOn(ctx, 'page', watch);
    try { for (const p of (typeof ctx.pages === 'function' ? ctx.pages() : [])) watch(p); } catch (_) { /* ignore */ }
  }
  return {
    noteTool(name) { t.lastTool = String(name || ''); t.lastToolAt = now(); },
    snapshot() {
      const at = now();
      return {
        connectedForMs: at - t.connectedAt,
        openPages: t.open.size,
        pagesClosed: t.closes,
        pageCrashes: t.crashes,
        lastPageCloseMsAgo: t.lastCloseAt === null ? null : at - t.lastCloseAt,
        lastTool: t.lastTool,
        lastToolMsAgo: t.lastToolAt === null ? null : at - t.lastToolAt,
      };
    },
  };
}

// 'answers' | 'refused' | 'timeout' | 'error'. Never throws.
function probePort(cdpUrl, deps) {
  const httpGet = (deps && deps.httpGet) || http.get;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let u;
    try {
      u = new URL(cdpUrl);
      u.protocol = u.protocol === 'wss:' ? 'https:' : (u.protocol === 'ws:' ? 'http:' : u.protocol);
      u.pathname = '/json/version';
      u.search = '';
    } catch (_) { finish('error'); return; }
    try {
      const req = httpGet(u.href, { timeout: PORT_PROBE_TIMEOUT_MS }, (res) => { res.resume(); finish('answers'); });
      req.on('timeout', () => { try { req.destroy(); } catch (_) { /* ignore */ } finish('timeout'); });
      req.on('error', (err) => finish(err && err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
    } catch (_) { finish('error'); }
  });
}

// Pure. Inference only; the facts it read are logged next to it.
function classifyDisconnect(facts) {
  const f = facts || {};
  if (f.port === 'answers') return 'connection-lost-browser-alive';
  if (f.port === 'refused') {
    const closedJustNow = f.lastPageCloseMsAgo !== null && f.lastPageCloseMsAgo !== undefined
      && f.lastPageCloseMsAgo <= WINDOW_CLOSE_WINDOW_MS;
    if (f.openPages === 0 && closedJustNow) return 'last-page-closed-then-browser-exited';
    if (f.pageCrashes > 0) return 'browser-exited-after-page-crash';
    return 'browser-exited';
  }
  return 'unknown-port-unreadable';
}

// Writes the ONE warn line. Async (it asks the port) but the caller has already
// set state OFFLINE synchronously; this only adds the evidence. Never throws.
// Attack (2026-10-06): the probe could hang the log -> it is bounded by
// PORT_PROBE_TIMEOUT_MS; it could fail -> the line is still written, with
// port:'error'; it could hide the line behind a rejection -> every path is caught.
async function reportUnexpectedDisconnect(tracker, opts) {
  const o = opts || {};
  let facts = {};
  try { facts = tracker.snapshot(); } catch (_) { facts = {}; }
  let port = 'error';
  try { port = await (o.probePort || probePort)(o.cdpUrl); } catch (_) { port = 'error'; }
  const full = { ...facts, port };
  try { o.log.warn('browser-agent disconnected unexpectedly', { cause: classifyDisconnect(full), ...full }); }
  catch (_) { /* a logger that throws must not break the offline path */ }
}

// Counts connect failures that were deliberately not logged (quiet probes).
function createSuppressedCounter() {
  let n = 0; let last = null;
  return {
    add(message) { n += 1; last = String(message || ''); },
    // Fields for the next connect line, and the count resets: each line names
    // only the failures since the line before it.
    take() {
      if (!n) return {};
      const out = { suppressedFailures: n, lastSuppressedError: last };
      n = 0; last = null;
      return out;
    },
  };
}

module.exports = { track, probePort, classifyDisconnect, reportUnexpectedDisconnect, createSuppressedCounter, PORT_PROBE_TIMEOUT_MS, WINDOW_CLOSE_WINDOW_MS };
