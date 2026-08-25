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

// BROWSER_PAGE_TIMEOUT_MS (schema.js) overrides the per-page action timeout so
// the operator can raise it for a slow SPA without code. Read from process.env
// at CALL time (config lives in env after loadConfig) — the constant stays as
// the fallback. Kept as a getter so env changes mid-session take effect.
function pageTimeoutMs() {
  const n = Number(process.env.BROWSER_PAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : PAGE_TIMEOUT_MS;
}

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

// connect(url, {quiet})
//
// `quiet` suppresses ONLY the failure log line, never the state change or the
// hint — getStatus() still reports the failure verbatim, so nothing becomes
// invisible. It exists for the auto-connect poller, whose repeated failure is a
// standing condition rather than news; see startAutoConnect's backoff below.
async function connect(url, opts) {
  const quiet = Boolean(opts && opts.quiet);
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
      // The hint above is always set, so a quiet failure is still fully
      // reportable through getStatus() — only the log line is withheld.
      if (!quiet) log.warn('browser-agent connect failed', { error: err.message });
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

// ---- poller backoff (operator, 2026-08-11) -------------------------------------
//
// THE LOG SPAM: on the installed build, mythos-server.log carried
// "browser-agent connect failed … ECONNREFUSED 127.0.0.1:9222" every 15 seconds,
// forever, each with a full Playwright stack. No debug browser was running and
// none was going to be — the operator had not asked for one — so this was 5,760
// stack traces a day burying every real line in the file, on the one machine
// where a diagnosable log mattered most.
//
// The poller's BEHAVIOUR is right and stays: it must keep watching, because a
// debug Chrome the operator starts by hand ten minutes from now should be picked
// up without a restart, and it must never launch a browser itself.
//
// So this changes the CADENCE and the VOLUME, not the semantics:
//   - the interval timer still ticks at intervalMs (setInterval, unref'd — the
//     FIX-5 contract), but an attempt is only made every `factor` ticks — this
//     is the FLOOR of the backoff, set by the caller (main.js passes
//     config.BROWSER_RECONNECT_MS, default 15000ms — the exact cadence the
//     operator was seeing spam at, kept as the responsive starting point);
//   - `factor` doubles (BACKOFF_MULTIPLIER) after each failed attempt up to
//     MAX_BACKOFF_FACTOR, so a 15s poller settles at one attempt every
//     15s * 32 = 8 minutes — an idle hour costs at most ~7-8 attempts past
//     the ceiling instead of 240;
//   - each ramp-up attempt (factor climbing 1 -> 2 -> 4 ... -> 32) still logs
//     its own warn — "at most once per window" is automatically true because
//     there is only ever one attempt per window — so a handful of warns marks
//     the ramp, not hundreds. The attempt that first finds `factor` already at
//     the ceiling additionally logs one 'browser-agent.giving-up' line: from
//     that point on, connect() is called with quiet:true forever, so logging
//     stops (this is what "giving up" means — giving up on frequent retries
//     AND on logging each one) while the retries themselves never stop;
//   - everything resets the moment a connect succeeds, so a browser that
//     appears (or reappears after a later unexpected drop) is still picked up
//     promptly, at the floor cadence, not wherever the backoff had climbed to.
//
// On-demand launch (ensureOnline/launchLocal/browser_launch_debug) is untouched:
// it never went through this poller.
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_FACTOR = 32;

let autoConnectTicks = 0;      // ticks since the last attempt
let autoConnectFactor = 1;     // attempt every N ticks
let autoConnectFailures = 0;   // consecutive failures, for the log policy
let autoConnectAtCeiling = false;

function resetAutoConnectBackoff() {
  autoConnectTicks = 0;
  autoConnectFactor = 1;
  autoConnectFailures = 0;
  autoConnectAtCeiling = false;
}

// One "tick" of the poller: the unit of work setInterval invokes below.
// Pulled out as its own function (rather than an inline setInterval callback)
// so tests can drive the whole backoff sequence by calling this directly, in
// a plain loop, with no real timer involved at all — the previous version of
// this test inlined the logic in the interval callback and drove it with a
// tiny real setInterval, which is exactly the wall-clock dependency that made
// it flaky under full-suite CPU contention: a 5ms interval assumes the event
// loop gets back to it within a few ms, which does not hold when hundreds of
// other test files are scheduling their own timers concurrently. Calling
// autoConnectTick() directly has no such assumption — each call is just an
// async function invocation, resolved by microtasks (the mocked
// connectOverCDP rejects/resolves immediately), so the whole 6-attempt ramp
// to the ceiling runs in however long the CPU actually takes, however long
// that is, with no dependency on any timer firing on schedule.
async function autoConnectTick(url, onOnline, intervalMs) {
  if (intentionalDisconnect) return;
  if (state === 'ONLINE' || state === 'CONNECTING') return;

  autoConnectTicks += 1;
  if (autoConnectTicks < autoConnectFactor) return; // backing off
  autoConnectTicks = 0;

  // quiet:true only once the ceiling has been reached and announced —
  // every ramp-up attempt still warns (there's only one attempt per
  // window, so that's already "at most once per window"); giving up on
  // logging each one is exactly what the ceiling transition below means.
  let ok;
  try {
    ok = await connect(url, { quiet: autoConnectAtCeiling });
  } catch (_) {
    // FIX-5: defensive only — connect() always resolves (true/false), never
    // rejects (every internal failure path is caught and turned into a
    // `return false`), so this branch is currently unreachable. Left in
    // place as a safety net in case that invariant ever changes.
    return;
  }

  if (ok) {
    resetAutoConnectBackoff();
    if (typeof onOnline === 'function') {
      try { onOnline(); } catch (_) { /* best-effort */ }
    }
    return;
  }

  autoConnectFailures += 1;
  if (autoConnectFactor < MAX_BACKOFF_FACTOR) {
    autoConnectFactor = Math.min(autoConnectFactor * BACKOFF_MULTIPLIER, MAX_BACKOFF_FACTOR);
  } else if (!autoConnectAtCeiling) {
    autoConnectAtCeiling = true;
    // The one line that makes "still retrying, just quietly" discoverable.
    // Never repeated — retries continue at the ceiling cadence forever,
    // but silently, per the contract above.
    log.info('browser-agent.giving-up', {
      url,
      everyMs: intervalMs ? intervalMs * MAX_BACKOFF_FACTOR : undefined,
      failures: autoConnectFailures,
    });
  }
}

function startAutoConnect(url, intervalMs, onOnline) {
  stopAutoConnect();
  if (!url || !intervalMs || intervalMs <= 0) return;
  resetAutoConnectBackoff();
  autoConnectTimer = setInterval(function () {
    autoConnectTick(url, onOnline, intervalMs);
  }, intervalMs);
  if (autoConnectTimer.unref) autoConnectTimer.unref();
}

function stopAutoConnect() {
  if (autoConnectTimer) {
    clearInterval(autoConnectTimer);
    autoConnectTimer = null;
  }
  resetAutoConnectBackoff();
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

    page.setDefaultTimeout(pageTimeoutMs());
    page.setDefaultNavigationTimeout(NAVIGATE_TIMEOUT_MS);

    return await callback(page, ctx);
  } catch (err) {
    throw new Error('Browser command failed: ' + err.message);
  }
}

// A page is Chrome's/Playwright's default cold-start new-tab page — never a
// real navigated page — regardless of which context or how many other pages
// sit alongside it.
function isBlankPageUrl(url) {
  return url === 'about:blank' || url === 'chrome://new-tab-page/' || url === '';
}

function findBlankPage(pages) {
  for (var i = 0; i < pages.length; i++) {
    var url;
    try { url = pages[i].url(); } catch (_) { url = ''; }
    if (isBlankPageUrl(url)) return pages[i];
  }
  return null;
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
    var ctx, page = null;

    if (launched && context) {
      ctx = context;
      page = findBlankPage(context.pages());
    } else {
      // REMEDIATION P2-7: a cold-start Chrome/Playwright context opens a
      // default about:blank tab; unconditionally creating a genuinely new
      // page leaves that pre-existing blank tab stranded beside the real one
      // (bug 4/5 — "open youtube in a new tab" -> blank tab + youtube tab).
      // Mirror withPage()'s own multi-context poll — search ALL contexts,
      // not just the first — and reuse a blank page found ANYWHERE, however
      // many other (real) pages coexist alongside it in the same context.
      var contexts = browser.contexts();
      if (!contexts.length) contexts = [await browser.newContext()];

      for (var attempt = 0; attempt < 5 && !page; attempt++) {
        for (var i = 0; i < contexts.length; i++) {
          var found = findBlankPage(contexts[i].pages());
          if (found) { ctx = contexts[i]; page = found; break; }
        }
        if (!page) {
          // No blank page anywhere yet — but if some context already has a
          // real (non-blank) page, a blank one isn't going to appear later;
          // stop waiting and fall through to creating a genuinely new tab.
          var anyPages = contexts.some(function (c) { return c.pages().length > 0; });
          if (anyPages) break;
          await new Promise(function (r) { setTimeout(r, 150); });
        }
      }
      if (!ctx) ctx = contexts[0];
    }

    if (!page) page = await ctx.newPage();
    page.setDefaultTimeout(pageTimeoutMs());
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
  // Test seam (Task D2): the poller's per-tick unit of work and its backoff
  // reset, exposed so backoff behaviour can be driven directly — call after
  // call, with no real timer — instead of depending on a real setInterval to
  // fire on schedule under test load. Not meant to be called from production
  // code; startAutoConnect wires autoConnectTick to the real interval itself.
  autoConnectTick,
  resetAutoConnectBackoff,
};
