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

// Found live-verifying BUG-029 (2026-07-24, playwright-core 1.61.1): neither
// accessor below actually yields a process on this version — ctx.browser()
// returns null for a persistent context, and ctx._browser._process is
// undefined too — so writeBrowserPidFile silently returned null every time
// ("browserPid":null in the launch log) and .browser-agent.pid was never
// written, leaving Start Agent OS.bat's orphan-cleanup step with no PID to
// check. Fall back to identifying the process by its unique --user-data-dir,
// the same distinguishing signal the .bat's own provenance check already
// uses, instead of depending on Playwright-internal accessors.
function findChromePidByUserDataDir(userDataDir) {
  try {
    const { execFileSync } = require('child_process');
    const escaped = userDataDir.replace(/'/g, "''");
    // Top-level browser process carries --user-data-dir but not --type= (every
    // renderer/gpu-process/utility child process does carry --type=). Single
    // quotes only (no -Filter WQL string) — execSync's shell-string form with
    // nested double quotes silently returned empty output on Windows (cmd.exe
    // mangles the escaping); execFileSync with an args array bypasses the
    // shell entirely, same pattern pc-child/index.js already uses to spawn
    // powershell.exe.
    const psCmd = `(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*${escaped}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1 -ExpandProperty ProcessId)`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 5000, windowsHide: true }).toString().trim();
    const pid = parseInt(out, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function writeBrowserPidFile(ctx, userDataDir) {
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
    if (userDataDir && process.platform === 'win32') {
      const pid = findChromePidByUserDataDir(userDataDir);
      if (pid) {
        fs.writeFileSync(BROWSER_PID_FILE, String(pid), 'utf8');
        return pid;
      }
    }
  } catch (_) { /* best-effort */ }
  return null;
}

function clearBrowserPidFile() {
  try { fs.unlinkSync(BROWSER_PID_FILE); } catch (_) { /* already gone */ }
}

// BUG-029 (Phase 3 hardening): from-browser.js's browser_launch_debug spawns
// a detached Chrome via raw child_process.spawn — that path does NOT go
// through launchLocal(), so it never wrote the pidfile. The .bat cleanup
// therefore missed those orphans. Expose a recorder so the effector can
// pin the PID the same way launchLocal does. Best-effort: never throws.
function recordLaunchedPid(pid) {
  if (!pid) return false;
  try {
    fs.writeFileSync(BROWSER_PID_FILE, String(pid), 'utf8');
    return true;
  } catch (_) { return false; }
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
// FIX-1: the in-flight connect() promise, if any. requireOnline() only guards
// state === 'ONLINE' (not CONNECTING), so a browser_* call that lands while
// the poller's connect() is still awaiting chromium.connectOverCDP (~10s, with
// `browser` still null) previously triggered a SECOND concurrent
// connectOverCDP — leaking one Browser handle (never .close()d) whose live
// 'disconnected' listener later clobbers the active connection's state to
// OFFLINE. connect() now returns this promise instead of dialing again
// whenever one is already in flight, so the poller, ensureOnline(), and
// browser_launch_debug() can never open two sessions.
let connectingPromise = null;

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
  // FIX-1: join an in-flight connect instead of racing chromium.connectOverCDP
  // a second time.
  if (connectingPromise) return connectingPromise;

  if (browser || context) {
    log.info('browser-agent already connected, disconnecting first');
    await disconnect();
  }

  cdpUrl = url;
  state = 'CONNECTING';
  hint = null;
  intentionalDisconnect = false;

  connectingPromise = (async function attemptConnect() {
    try {
      const newBrowser = await chromium.connectOverCDP(url, { timeout: CONNECT_TIMEOUT_MS });

      // FIX-4: shutdown's disconnect() may have run while this connectOverCDP
      // was in flight (it sets intentionalDisconnect + forces state OFFLINE
      // synchronously, since `browser`/`context` are still null mid-connect).
      // Don't resurrect a connection shutdown already tore down — close the
      // handle we just opened and bail without touching state/mode.
      if (intentionalDisconnect) {
        try { newBrowser.close(); } catch (_) { /* best-effort */ }
        return false;
      }

      browser = newBrowser;
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
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
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
    const browserPid = writeBrowserPidFile(context, userDataDir); // BUG-029
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

// Background auto-connect poller. While OFFLINE (and not an intentional
// disconnect), retry connect(url) on an interval so MYTHOS attaches the moment a
// debug Chrome appears, and re-attaches after an unexpected drop — no manual
// "Connect" needed. CDP-connect only: never launches a browser, so there is no
// mic/audio-device risk (that is why this is safe to run from boot, unlike a
// launch). onOnline is invoked once per OFFLINE->ONLINE transition the poller
// causes, so callers can refresh downstream state (e.g. capabilities.md). The
// timer is unref'd so it never keeps the process alive on its own.
let autoConnectTimer = null;

function startAutoConnect(url, intervalMs, onOnline) {
  stopAutoConnect();
  if (!url || !intervalMs || intervalMs <= 0) return;
  autoConnectTimer = setInterval(function () {
    if (intentionalDisconnect) return;
    if (state === 'ONLINE' || state === 'CONNECTING') return;
    connect(url).then(function (ok) {
      if (ok && typeof onOnline === 'function') {
        try { onOnline(); } catch (_) { /* best-effort */ }
      }
    }).catch(function () {
      // FIX-5: defensive only — connect() always resolves (true/false), never
      // rejects (every internal failure path is caught and turned into a
      // `return false`), so this branch is currently unreachable. Left in
      // place as a safety net in case that invariant ever changes.
    });
  }, intervalMs);
  if (autoConnectTimer.unref) autoConnectTimer.unref();
}

function stopAutoConnect() {
  if (autoConnectTimer) {
    clearInterval(autoConnectTimer);
    autoConnectTimer = null;
  }
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
    var ctx, page;

    if (launched && context) {
      // Launched (playwright-managed) mode: one persistent context, whose
      // initial about:blank page we reuse.
      ctx = context;
      page = context.pages()[0] || await context.newPage();
    } else {
      // CDP-attached mode. Reuse an already-open tab instead of opening a second
      // one: a freshly launched Chrome opens a blank new-tab, and its CDP target
      // can lag a moment behind connectOverCDP. Creating a page before that blank
      // tab is enumerated is what left a stray blank tab beside the navigated one
      // ("open youtube" -> tab 1 blank + tab 2 youtube). So look across all
      // contexts for an existing page, briefly waiting for the launch tab to
      // appear, and only open a new tab (in the existing default context, never a
      // fresh window) as a last resort.
      var contexts = browser.contexts();
      if (!contexts.length) contexts = [await browser.newContext()];

      for (var attempt = 0; attempt < 5 && !page; attempt++) {
        for (var i = 0; i < contexts.length; i++) {
          var ps = contexts[i].pages();
          if (ps.length) { ctx = contexts[i]; page = ps[0]; break; }
        }
        if (!page) await new Promise(function (r) { setTimeout(r, 150); });
      }
      if (!page) { ctx = contexts[0]; page = await ctx.newPage(); }
    }

    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATE_TIMEOUT_MS);

    return await callback(page, ctx);
  } catch (err) {
    throw new Error('Browser command failed: ' + err.message);
  }
}

// Execute a callback on a genuinely NEW tab (never the reused current tab).
// Used when the caller explicitly asked to open something in a new tab — a
// single atomic call (create tab + run callback) so the tab can never be left
// blank because a follow-up navigate call was dropped (the bug this fixes: two
// separate browser_tabs(new) + browser_navigate calls let a turn create the
// blank tab and then skip navigating it). Always opens in the existing
// context/window — never a new browser window.
async function withNewPage(callback) {
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
    // FIX D: a cold-start Chrome/Playwright context opens a default about:blank
    // tab; unconditionally creating a genuinely new page here leaves that
    // pre-existing blank tab stranded beside the real one (bug 4/5 — "open
    // youtube in a new tab" -> blank tab + youtube tab). Briefly poll for it —
    // mirrors withPage()'s own blank-tab-reuse guard — and navigate the blank
    // tab instead of opening a second one. If a real page already exists (not
    // blank), preserve the genuine "open in new tab" intent and create new.
    var page = null;
    var existing = ctx.pages();
    for (var attempt = 0; attempt < 5 && !existing.length; attempt++) {
      await new Promise(function (r) { setTimeout(r, 150); });
      existing = ctx.pages();
    }
    if (existing.length === 1) {
      var url0 = (function () { try { return existing[0].url(); } catch (_) { return ''; } })();
      if (url0 === 'about:blank' || url0 === 'chrome://new-tab-page/' || url0 === '') {
        page = existing[0];
      }
    }
    if (!page) page = await ctx.newPage();
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
  withNewPage,
  launchLocal,
  ensureOnline,
  startAutoConnect,    // background CDP auto-connect poller (safe, never launches)
  stopAutoConnect,
  recordLaunchedPid,   // BUG-029 Phase 3 — for from-browser.js browser_launch_debug
};
