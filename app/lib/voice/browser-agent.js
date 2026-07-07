// browser-agent.js — lifecycle management for Chrome CDP connection via playwright-core.
// Connects to an already-running Chrome instance (launched via setup-chrome-debug.ps1).
// Side-effect-free require — does NOT launch Chrome or connect at require time.
// Caller (server.js) must call connect() explicitly when BROWSER_CDP_URL is set.
//
// Exposes: connect(), disconnect(), getStatus(), withPage(callback) -> Promise

const { chromium } = require('playwright-core');
const { log } = require('../logger');

const CONNECT_TIMEOUT_MS = 10000;
const PAGE_TIMEOUT_MS = 15000;
const NAVIGATE_TIMEOUT_MS = 30000;

// Module-level singleton state
let browser = null;
let state = 'OFFLINE'; // OFFLINE | CONNECTING | ONLINE
let hint = null;
let intentionalDisconnect = false;
let cdpUrl = null;

function getStatus() {
  let pageCount = 0;
  if (browser) {
    try {
      const contexts = browser.contexts();
      for (const ctx of contexts) {
        pageCount += ctx.pages().length;
      }
    } catch { /* ignore */ }
  }
  return { state, hint, cdpUrl, pageCount };
}

async function connect(url) {
  if (browser) {
    log.info('browser-agent already connected, disconnecting first');
    await disconnect();
  }

  cdpUrl = url;
  state = 'CONNECTING';
  hint = null;
  intentionalDisconnect = false;

  try {
    browser = await chromium.connectOverCDP(url, { timeout: CONNECT_TIMEOUT_MS });
    state = 'ONLINE';
    log.info('browser-agent connected via CDP', { url, contexts: browser.contexts().length });

    // Handle disconnection events
    browser.on('disconnected', () => {
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
    hint = `CDP connect failed: ${err.message}`;
    browser = null;
    log.warn('browser-agent connect failed', { error: err.message });
    return false;
  }
}

async function disconnect() {
  intentionalDisconnect = true;
  if (browser) {
    try {
      browser.close();
    } catch { /* best-effort */ }
    browser = null;
  }
  state = 'OFFLINE';
}

// Execute a callback with a page reference. Finds or creates a suitable page.
async function withPage(callback) {
  if (!browser || state !== 'ONLINE') {
    throw new Error('Browser automation is OFFLINE.');
  }

  try {
    const contexts = browser.contexts();
    const ctx = contexts[0] || await browser.newContext();
    const pages = ctx.pages();
    const page = pages[0] || await ctx.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATE_TIMEOUT_MS);

    return await callback(page, ctx);
  } catch (err) {
    throw new Error(`Browser command failed: ${err.message}`);
  }
}

module.exports = {
  connect,
  disconnect,
  getStatus,
  withPage,
};
