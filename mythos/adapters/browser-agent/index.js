'use strict';

// adapters/browser-agent/index.js — untouched CA of app/lib/voice/browser-agent.js.
// Lifecycle management for Chrome CDP connection via playwright-core (already a declared
// mythos/package.json dependency, pre-added anticipating this phase). Only re-pointing:
// NOVA's `const { log } = require('../logger')` -> a logger instance obtained from
// MYTHOS's createLogger() factory — same re-pointing as adapters/pc-child/index.js.
//
// Connects to an already-running Chrome instance (launched via setup-chrome-debug.ps1)
// OR launches a local Chrome/Edge via playwright-core's launchPersistentContext.
// Side-effect-free require — does NOT launch Chrome or connect at require time.
// Caller must call connect() or ensureOnline() explicitly.
//
// Exposes: connect(), disconnect(), getStatus(), withPage(callback) -> Promise,
//          launchLocal(userDataDir), ensureOnline({ cdpUrl, userDataDir })

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../src/core/logger');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const CONNECT_TIMEOUT_MS = 10000;
const PAGE_TIMEOUT_MS = 15000;
const NAVIGATE_TIMEOUT_MS = 30000;

// BUG-029: the launched browser is a real OS process MYTHOS owns. If the app
// dies without a clean shutdown (Windows terminal closed — SIGINT never
// delivered, see main.js), that Chrome survives invisibly and keeps playing
// audio. Track its PID in a file so the NEXT launch (Start Agent OS.bat's
// cleanup step) can kill any orphan before booting.
const BROWSER_PID_FILE = path.join(__dirname, '..', '..', '.browser-agent.pid');

function writeBrowserPidFile(ctx) {
  try {
    // launchPersistentContext exposes the browser process via the context's
    // browser() (null for persistent contexts on some versions) — fall back to
    // the private _browser process handle when needed. Best-effort only.
    const proc = (ctx.browser() && ctx.browser().process && ctx.browser().process())
      || (ctx._browser && ctx._browser._process) || null;
    if (proc && proc.pid) {
      fs.writeFileSync(BROWSER_PID_FILE, String(proc.pid), 'utf8');
      return proc.pid;
    }
  } catch (_) { /* best-effort */ }
  return null;
}

function clearBrowserPidFile() {
  try { fs.unlinkSync(BROWSER_PID_FILE); } catch (_) { /* already gone */ }
}

// Module-level singleton state
let browser = null;      // CDP-connected Browser instance
let context = null;      // launchPersistentContext BrowserContext instance
let launched = false;    // true when we own the context (launched mode)
let mode = null;         // 'cdp' | 'launched' | null
let state = 'OFFLINE';   // OFFLINE | CONNECTING | ONLINE
let hint = null;
let intentionalDisconnect = false;
let cdpUrl = null;

function getStatus() {
  let pageCount = 0;
  try {
    if (launched && context) {
      pageCount = context.pages().length;
    } else if (browser) {
      const contexts = browser.contexts();
      for (const ctx of contexts) {
        pageCount += ctx.pages().length;
      }
    }
  } catch { /* ignore */ }
  return { state, mode, hint, cdpUrl, pageCount };
}

async function connect(url) {
  if (browser || context) {
    log.info('browser-agent already connected, disconnecting first');
    await disconnect();
  }

  cdpUrl = url;
  state = 'CONNECTING';
  hint = null;
  intentionalDisconnect = false;

  try {
    browser = await chromium.connectOverCDP(url, { timeout: CONNECT_TIMEOUT_MS });
    launched = false;
    mode = 'cdp';
    state = 'ONLINE';
    log.info('browser-agent connected via CDP', { url, contexts: browser.contexts().length });

    // Handle disconnection events
    browser.on('disconnected', function() {
      if (!intentionalDisconnect) {
        state = 'OFFLINE';
        hint = 'Chrome disconnected unexpectedly.';
        log.warn('browser-agent disconnected unexpectedly');
      }
      browser = null;
    });

    return true;
  } catch (err) {
    state = 'OFFLINE';
    hint = 'CDP connect failed: ' + err.message;
    browser = null;
    log.warn('browser-agent connect failed', { error: err.message });
    return false;
  }
}

async function launchLocal(userDataDir) {
  if (browser || context) {
    log.info('browser-agent already connected, disconnecting first');
    await disconnect();
  }

  state = 'CONNECTING';
  hint = null;
  intentionalDisconnect = false;
  launched = false;
  mode = null;

  try {
    // Playwright expects channel as a string, not array. Try Chrome first, fall back to Edge.
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chrome', headless: false, viewport: null,
      });
    } catch (e1) {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'msedge', headless: false, viewport: null,
      });
    }
    launched = true;
    mode = 'launched';
    state = 'ONLINE';
    const browserPid = writeBrowserPidFile(context); // BUG-029
    log.info('browser-agent launched local browser', { userDataDir, pages: context.pages().length, browserPid });

    context.on('close', function() {
      if (!intentionalDisconnect) {
        state = 'OFFLINE';
        hint = 'Launched browser closed unexpectedly.';
        log.warn('browser-agent launched browser closed unexpectedly');
      }
      clearBrowserPidFile(); // BUG-029: browser gone — pidfile no longer needed
      context = null;
      launched = false;
    });

    return true;
  } catch (err) {
    state = 'OFFLINE';
    hint = 'launchLocal failed: ' + err.message;
    context = null;
    launched = false;
    mode = null;
    log.warn('browser-agent launchLocal failed', { error: err.message });
    return false;
  }
}

async function ensureOnline(opts) {
  opts = opts || {};
  if (state === 'ONLINE') return true;

  // Try CDP connection first
  if (opts.cdpUrl) {
    var ok = await connect(opts.cdpUrl);
    if (ok) return true;
  }

  // Fall back to launching a local browser
  if (opts.userDataDir) {
    var ok2 = await launchLocal(opts.userDataDir);
    if (ok2) return true;
  }

  return false;
}

async function disconnect() {
  intentionalDisconnect = true;

  if (launched && context) {
    try {
      await context.close();
    } catch { /* best-effort */ }
    clearBrowserPidFile(); // BUG-029
    context = null;
    launched = false;
    mode = null;
  } else if (browser) {
    try {
      browser.close();
    } catch { /* best-effort */ }
    browser = null;
    mode = null;
  }

  state = 'OFFLINE';
}

// Execute a callback with a page reference. Finds or creates a suitable page.
async function withPage(callback) {
  if (state !== 'ONLINE' || (!browser && !context)) {
    throw new Error('Browser automation is OFFLINE.');
  }

  try {
    var ctx;
    if (launched && context) {
      ctx = context;
    } else {
      var contexts = browser.contexts();
      ctx = contexts[0] || await browser.newContext();
    }
    var pages = ctx.pages();
    var page = pages[0] || await ctx.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATE_TIMEOUT_MS);

    return await callback(page, ctx);
  } catch (err) {
    throw new Error('Browser command failed: ' + err.message);
  }
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  withPage,
  launchLocal,
  ensureOnline,
};
