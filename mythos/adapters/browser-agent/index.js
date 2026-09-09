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
const browserProcess = require('./browser-process');
// BUG-415: "which browser" is answered once, in browser-target.js. This adapter
// was the third site deriving it independently, and the only one still hardcoding
// a two-entry ladder that could not name the operator's default.
const browserTarget = require('../../src/core/effectors/browser-target');
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

// Playwright's accessors do not yield a process for a persistent context
// (BUG-029, 2026-07-24: ctx.browser() is null and ctx._browser._process is
// undefined), so the launched browser is identified by its unique
// --user-data-dir instead — the same signal the .bat's provenance check uses.
//
// This ran its OWN PowerShell query until 2026-09-09, filtered on
// `$_.Name -eq 'chrome.exe' -or 'msedge.exe'`, and LIVE-VERIFYING BUG-415 found
// it blind: BUG-415 made Brave the first launch attempt on a Brave machine, so
// a real launch produced seven brave.exe processes, "browserPid":null in the
// log, and no .browser-agent.pid — disarming that file's only consumer, `Start
// Agent OS.bat`'s orphan reap. BUG-029's exact symptom, reintroduced for the
// default browser by a fix somewhere else.
//
// The repair is a DELETION: browser-process.js already asks this, with the same
// `--type=` filter and quote escaping, no name filter (so never blind), and a
// harder guard — isMythosDebugProfile refuses anything but
// `.../MYTHOS/<x>-debug-profile`, so no wildcard reaches the `-like` and the
// query cannot be pointed at the operator's real browser. Third copy, only
// broken one. The name list now only IDENTIFIES a row, never filters the query,
// and is derived from BROWSER_SUBPATHS via executableIndex() — the mapping whose
// own comment predicted this: "a hand-written second copy of the same mapping
// would not be [free], and would fail in the fail-open direction".
//
// Null rather than a guess when nothing matches: `--type=` excludes renderers
// but not the crashpad handler, which also carries --user-data-dir. Returning
// its pid would be worse than returning none — the .bat's provenance check
// passes, it tree-kills crashpad, and the orphan survives a reap that reported
// success.
function findChromePidByUserDataDir(userDataDir, deps) {
  try {
    const rows = browserProcess.processesForProfile(userDataDir, deps);
    if (!Array.isArray(rows) || !rows.length) return null;
    const known = browserTarget.executableIndex();
    const row = rows.find((r) => known[String(r.name || '').toLowerCase()]);
    return row && Number.isInteger(row.pid) && row.pid > 0 ? row.pid : null;
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
// BUG-410: the playwright CHANNEL launchLocal actually got ('chrome'|'msedge'),
// or null when we did not launch one. Reported through getStatus() so no caller
// has to guess which browser started — guessing is what that ticket is about.
let launchedChannel = null;
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
  return { state, mode, hint, cdpUrl, pageCount, launchedChannel };
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
      launchedChannel = null;
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

// ---------------------------------------------------------------------------
// BUG-415 — which browser does launchLocal actually start? (2026-09-09)
// ---------------------------------------------------------------------------
//
// MEASURED ON THE OPERATOR'S MACHINE, 2026-09-09, before changing anything:
//
//   osDefaultBrowser()          -> { name:'brave', progId:'BraveHTML', drivable:true }
//   resolveLaunchTarget(null)   -> { name:'brave', source:'os-default' }
//   findBrowserExecutable('brave') -> ...\BraveSoftware\Brave-Browser\...\brave.exe
//   findBrowserExecutable('chrome') -> ...\Google\Chrome\Application\chrome.exe
//   findBrowserExecutable('edge')   -> null    <- Edge is NOT installed here
//
// So the resolver already answers "brave", correctly, and has since BUG-407.
// launchLocal is the one launch site in this codebase that never asks it: it
// tried playwright channel 'chrome' and fell back to 'msedge', full stop. On
// this machine that silently starts CHROME — a browser the operator does not
// use — and on a machine with neither it fails outright while Brave sits
// installed and reachable.
//
// browser-target.js's own header states the rule this violates: "when a change
// derives the same fact twice by different means, point both at the same
// input". Three sites now answer "which browser" and two of them read the
// resolver; this was the third.
//
// WHY A LIST AND NOT ONE ANSWER. resolveLaunchTarget returns the best answer,
// not the only viable one — a UserChoice entry can outlive an uninstall, and a
// browser can be installed but unlaunchable. The old chrome-then-edge ladder
// existed for that reason and is kept as the tail, deduplicated, so the
// resolver's answer is tried FIRST and nothing that used to work stops working.
//
// PROFILE: STILL A FRESH ONE, DELIBERATELY (BUG-415's recorded decision). This
// launcher drives a browser with CDP; pointing it at the operator's real
// profile would put an automated agent inside their logged-in session and,
// worse, browser-process.js's close path is authorised ONLY for a directory
// shaped like MYTHOS/<name>-debug-profile — a real profile could never be
// closed by us, and a mis-scoped close is the failure that guard exists for.
// What DOES change is that the profile now follows the browser:
// debugProfileDir(name) gives brave its own directory instead of handing it the
// one Chrome wrote, which is exactly why that function takes a name. Pinned by
// a test, and the fresh profile is now stated in browser_launch_debug's own
// description rather than left for the operator to discover.
//
// Playwright has channels for chrome and msedge and none for brave, so a
// browser with no channel is launched by executablePath. Same Chromium either
// way; the channel form is kept where it exists so nothing about the two
// browsers that already worked changes.
const PLAYWRIGHT_CHANNELS = { chrome: 'chrome', edge: 'msedge' };

// Pure. The ordered list of launch attempts, so the CHOICE can be tested with
// no Playwright, no registry and no browser installed anywhere.
function planLocalLaunch(userDataDir, deps) {
  const d = deps || {};
  const resolve = d.resolveLaunchTarget || browserTarget.resolveLaunchTarget;
  const findExe = d.findBrowserExecutable || browserTarget.findBrowserExecutable;
  const profileFor = d.debugProfileDir || browserTarget.debugProfileDir;

  const order = [];
  let preferred = null;
  try { preferred = resolve(null); } catch (_) { preferred = null; }
  if (preferred && preferred.name && !preferred.error) order.push(preferred.name);
  for (const name of browserTarget.BROWSER_SEARCH_ORDER) {
    if (order.indexOf(name) === -1) order.push(name);
  }

  const attempts = [];
  for (const name of order) {
    const channel = PLAYWRIGHT_CHANNELS[name] || null;
    let exe = null;
    try { exe = findExe(name); } catch (_) { exe = null; }
    // A channel can start a browser this resolver cannot find on disk (a
    // machine-wide install under a root we do not enumerate), so a channel
    // candidate is kept even with no exe. One with neither is not a candidate.
    if (!channel && !exe) continue;
    let profileDir = userDataDir;
    try { profileDir = profileFor(name) || userDataDir; } catch (_) { profileDir = userDataDir; }
    attempts.push({
      name,
      profileDir,
      options: channel ? { channel } : { executablePath: exe },
      source: name === (preferred && preferred.name) ? (preferred.source || 'resolved') : 'search-order',
    });
  }
  return attempts;
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
  launchedChannel = null;
  mode = null;

  try {
    // BUG-410 (self-review 2026-09-03): RECORD WHICH ONE ACTUALLY STARTED. This
    // function has always known — it is the one that catches the Chrome failure
    // and asks for Edge — and it has never told anyone, so from-browser.js's
    // requireOnline() labelled the result 'chrome' whenever mode was 'launched'.
    // On a machine without Chrome that is Edge, reported as Chrome: the same
    // identity-from-assumption defect BUG-410 fixed in browser_launch_debug, at
    // a site the first pass of that fix did not touch. The launcher answering
    // for itself beats any caller re-deriving it.
    //
    // BUG-415: the ladder is now DERIVED (see planLocalLaunch above) rather than
    // the hardcoded chrome-then-edge pair, so the operator's actual default gets
    // the first attempt and Brave is reachable at all. `launchedChannel` carries
    // the browser NAME now, which browserNameForChannel already normalises — for
    // chrome and edge the value is unchanged.
    const attempts = planLocalLaunch(userDataDir, {});
    if (!attempts.length) {
      throw new Error('no supported browser found ('
        + browserTarget.supportedBrowserList() + ') — install one, or set BROWSER_EXECUTABLE to its path');
    }
    let lastErr = null;
    let profileDir = userDataDir;
    for (const attempt of attempts) {
      try {
        context = await chromium.launchPersistentContext(attempt.profileDir,
          Object.assign({ headless: false, viewport: null }, attempt.options));
        launchedChannel = attempt.name;
        profileDir = attempt.profileDir;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        context = null;
      }
    }
    // Report the LAST browser's failure rather than a generic one: on a machine
    // with none of them installed the operator needs to see a real Playwright
    // message, not "launch failed".
    if (!context) throw (lastErr || new Error('no browser could be launched'));
    launched = true;
    mode = 'launched';
    state = 'ONLINE';
    const browserPid = writeBrowserPidFile(context, profileDir); // BUG-029
    log.info('browser-agent launched local browser',
      { browser: launchedChannel, userDataDir: profileDir, pages: context.pages().length, browserPid });

    context.on('close', function() {
      if (!intentionalDisconnect) {
        state = 'OFFLINE';
        hint = 'Launched browser closed unexpectedly.';
        log.warn('browser-agent launched browser closed unexpectedly');
      }
      clearBrowserPidFile(); // BUG-029: browser gone — pidfile no longer needed
      context = null;
      launched = false;
      launchedChannel = null;
    });

    return true;
  } catch (err) {
    state = 'OFFLINE';
    hint = 'launchLocal failed: ' + err.message;
    context = null;
    launched = false;
    launchedChannel = null;
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
    launchedChannel = null;
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

// BUG-409: disconnect() above is correct for what it is named — it drops OUR
// end. It does NOT stop the browser, and for the CDP path it structurally
// cannot: playwright's own contract for a connected-to browser is "clears all
// created contexts and disconnects from the browser server". `launched` is only
// ever true inside launchLocal(), and browser_launch_debug spawns the process
// itself and then attaches, so every debug browser MYTHOS starts takes the
// connected-to branch and survives its own disconnect, still holding the debug
// port. browser_switch then launched the next browser onto that held port.
//
// This is the closing counterpart, kept SEPARATE rather than folded into
// disconnect(), because disconnect() is also called on shutdown and by
// connect() itself ("already connected, disconnecting first") — terminating the
// browser from there would kill the very session the caller is re-establishing.
// One caller means it: browser_switch.
//
// Only ever called with a MYTHOS debug profile directory; browser-process.js
// refuses anything else, which is what keeps this from being able to name the
// operator's real browser. See that file's header for the measurements.
async function closeLaunchedBrowser(profileDir, deps) {
  // Launched (playwright-owned persistent context) mode already closes the real
  // browser — that is the ONE case the vendor contract does terminate. Reuse
  // the existing path rather than add a second way to close the same thing.
  if (launched && context) {
    await disconnect();
    return { closed: true, method: 'context-close', survivors: [], reason: null };
  }

  const handle = browser;
  // Before the close, so the 'disconnected' listener does not report a
  // deliberate shutdown as "Chrome disconnected unexpectedly".
  intentionalDisconnect = true;

  const verdict = await browserProcess.closeDebugBrowser({
    profileDir,
    sendClose: handle
      ? async function () {
        const session = await handle.newBrowserCDPSession();
        await session.send('Browser.close');
      }
      : null,
    deps,
  });

  try { if (handle) handle.close(); } catch (_) { /* best-effort */ }
  browser = null;
  mode = null;
  state = 'OFFLINE';
  clearBrowserPidFile();
  return verdict;
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
  // BUG-409: disconnect() drops our end; this one stops the browser and proves
  // it stopped. Not interchangeable — see the comment above the function.
  closeLaunchedBrowser,
  // BUG-410: the only trustworthy answer to "which browser is behind the debug
  // port", since Brave reports a plain Chrome/<version> product string over CDP.
  processOnPort: browserProcess.processOnPort,
  identifyBrowserOnPort: browserProcess.identifyBrowserOnPort,
  isMythosDebugProfile: browserProcess.isMythosDebugProfile,
  getStatus,
  withPage,
  withNewPage,
  launchLocal,
  // BUG-415 seam: the CHOICE of browser and profile, separated from the launch
  // so it can be tested with no Playwright, no registry and no browser
  // installed. The launch itself stays untestable here and is named as such.
  planLocalLaunch,
  // Live-verification finding, same day: the pidfile writer knew two browsers
  // while the launcher had learned three. Exported so the lookup can be driven
  // with an injected PowerShell runner and asked the question that matters —
  // "does a Brave profile yield Brave's pid" — instead of a string assertion.
  findChromePidByUserDataDir,
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
  // BUG-366: exported so the capabilities-manifest settle write can be derived
  // from this timeout instead of hardcoding a second copy of the same number.
  // main.js used to schedule its re-write at a literal 10000 — the same value —
  // so the write sampled this adapter at the exact instant its connect was
  // still in flight, and froze `CONNECTING` into the manifest permanently.
  // A consumer that needs to outlast this attempt must READ it, not restate it.
  CONNECT_TIMEOUT_MS,
};
