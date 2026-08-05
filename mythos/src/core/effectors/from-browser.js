'use strict';

// effectors/from-browser.js — CA of app/lib/voice/tools-browser.js (10 tools). Function
// bodies verbatim; only re-pointing is `./browser-agent` -> `adapters/browser-agent`
// (untouched, re-pathed).

const browserAgent = require('../../../adapters/browser-agent');
const { effectorFromTool } = require('./adapter');
const { vaultRelativePath, vaultUrl } = require('./vault-url');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function ok(result) { return { ok: true, result }; }
function fail(reason) { return { ok: false, result: reason }; }

// Set by registerFromBrowser() from ctx.config — used by requireOnline()'s lazy
// auto-connect fallback to find BROWSER_CDP_URL when the env var isn't set.
let config = null;
// REMEDIATION P1-7: set by registerFromBrowser() from ctx.fs — the vault
// fs-store, used to existence-check a /vault/... path before browser_navigate
// forwards it anywhere (same fs.exists() abstraction open_artifact uses).
let vaultFs = null;

// BUG-011 fix 1: lazy auto-connect. Previously this was synchronous and only ever
// reported OFFLINE — nothing ever called browserAgent.ensureOnline(), so browser
// tools stayed stuck OFFLINE forever even after running setup-chrome-debug.ps1.
// Now: if not ONLINE, try ensureOnline() (CDP connect, per adapters/browser-agent's
// own connect-then-launchLocal fallback) before giving up.
async function requireOnline() {
  let status = browserAgent.getStatus();
  if (status.state !== 'ONLINE') {
    // Lazy bring-up: try a CDP connect to an already-running debug Chrome, then
    // fall back to launching one. Passing userDataDir is what actually arms
    // ensureOnline's launch fallback (adapter's launchLocal) — previously only
    // cdpUrl was passed, so ensureOnline could only connect and browser tools
    // stayed OFFLINE whenever no debug Chrome was already running. Safe here:
    // this runs mid-session when a browser tool is actually invoked, so voice/
    // mic init already holds the audio device (that is why boot stays
    // connect-only). launchLocal records the PID for BUG-029 orphan cleanup.
    try {
      await browserAgent.ensureOnline({
        cdpUrl: process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL),
        userDataDir: path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'MYTHOS', 'chrome-debug-profile'),
      });
    } catch { /* fall through to OFFLINE report below */ }
    status = browserAgent.getStatus();
    // BUG-106 fix (b)/(c): source browser identity from the live connection's
    // OWN mode, not just a value this module remembers from a previous call.
    // ensureOnline() either CONNECTED to an endpoint already running
    // (mode:'cdp' — we did not start it, so its identity is unconfirmed and
    // stays null/unknown, same as the "cannot confirm" refusal below already
    // handles) or LAUNCHED one itself (mode:'launched', via launchLocal's
    // chrome-first/edge-fallback — the same default path browser_launch_debug
    // uses for an unnamed request, so it earns the same 'chrome' label). Only
    // touch attachedBrowser when THIS call actually changed connectivity (we
    // are inside the `state !== 'ONLINE'` branch) — an adapter that was
    // already ONLINE has its identity left exactly as it was.
    if (status.state === 'ONLINE') {
      attachedBrowser = status.mode === 'launched' ? 'chrome' : null;
    }
  }
  if (status.state !== 'ONLINE') {
    return fail(`Browser automation is ${status.state}. ${status.hint || 'Run setup-chrome-debug.ps1 first.'}`);
  }
  return null;
}

// ---- Tool implementations ----

// BROWSER_PAGE_WAIT_MS (schema.js, default 8000): how long waitReady() waits
// for a selector to become visible before click/type/get_text. Read from config
// (set in registerFromBrowser) or env. Less than the adapter's page default so
// a missing element fails here with a clean message, not the raw 15s Playwright
// timeout. See waitReady() for why this replaced the scattered swallowed-catch
// waitForSelector(5000/4000) calls.
function pageWaitMs() {
  const fromConfig = config && config.BROWSER_PAGE_WAIT_MS;
  const n = Number(fromConfig || process.env.BROWSER_PAGE_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

// waitReady(page, selector) — single bounded pre-wait, returns true/false.
// Replaces the THREE swallowed-catch waitForSelector({timeout:5000/4000}) sites
// (click/type/fill_form) AND adds the pre-wait get_text never had. Why it
// exists: a lazy-hydrating SPA (YouTube's ytd-* custom elements upgrade async
// AFTER domcontentloaded) means a click right after navigate hits a not-yet-
// existing node. The old code's empty catch(_) silently swallowed that, then
// page.click rode the full 15s page default → 20s before an honest fail. One
// helper, one behaviour, no retry storm (the comment at the old :96 explicitly
// warned against silent retries; this preserves that — a single bounded wait).
async function waitReady(page, selector) {
  try {
    await page.waitForSelector(selector, { timeout: pageWaitMs(), state: 'visible' });
    return true;
  } catch (_) {
    return false;
  }
}

async function browser_navigate({ url, newTab, browser }) {
  if (!url) return fail('URL is required.');
  // BUG-099: when the operator names a browser, drive THAT one or refuse. The
  // 2026-08-05 session asked for Brave four times and got Chrome every time,
  // narrated as success. Checked before requireOnline() so a mismatch never
  // launches or connects anything.
  const targetObjection = checkBrowserTarget(browser);
  if (targetObjection) return targetObjection;
  // REMEDIATION P1-7: a /vault/... path (or a mistaken file:///vault/... URL)
  // is not a real filesystem path on any machine — resolve it through the
  // same vault-url.js mapping open_artifact uses instead of forwarding it
  // verbatim into a file:// URL that page.goto then fails to load.
  let target = url;
  const relPath = vaultRelativePath(url);
  if (relPath !== null) {
    if (!vaultFs || typeof vaultFs.exists !== 'function' || !vaultFs.exists(relPath)) {
      return fail(`Artifact does not exist: ${url}. Call pipeline_status or job_status to get a real artifact path before navigating to one.`);
    }
    target = vaultUrl(relPath, config);
  }
  try { new URL(target); } catch { return fail(`Invalid URL: "${target}"`); }
  const guard = await requireOnline();
  if (guard) return guard;

  // newTab:true opens a genuinely new tab and loads url into it in one atomic
  // call. This exists so "open X in a new tab" can never be satisfied by
  // creating a blank tab without navigating it (the bug: browser_tabs(new) and
  // browser_navigate were two separate, droppable calls) — one tool call now
  // does both, so a stray blank tab can't be left behind.
  const runner = newTab ? browserAgent.withNewPage : browserAgent.withPage;
  return runner(async (page) => {
    // 'commit' resolves as soon as the network response is received and reading
    // starts — strictly less strict than the old 'domcontentloaded', so a slow
    // initial HTML no longer blocks. Then a BOUNDED best-effort networkidle
    // settle (3s, swallow) gives a lazy SPA (YouTube) a chance to hydrate its
    // custom elements before the brain's next click lands on a not-yet-existing
    // node. Fast/static pages ignore it (networkidle already true → instant).
    await page.goto(target, { waitUntil: 'commit' });
    try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch (_) {}
    const title = await page.title();
    // `browser` is what MYTHOS can actually vouch for — 'unknown' when it
    // attached to a debug endpoint it did not start. Never say Brave on a guess.
    return ok({ url: page.url(), title, newTab: !!newTab, browser: attachedBrowser || 'unknown' });
  }).catch(err => fail(err.message));
}

async function browser_click({ selector }) {
  if (!selector) return fail('CSS selector is required.');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // waitReady replaces the old swallowed-catch waitForSelector(5000): if the
    // element never becomes visible within BROWSER_PAGE_WAIT_MS, fail CLEANLY
    // here (with the selector named) instead of silently falling through to
    // page.click which then rode the 15s page-default timeout. No retry storm.
    if (!(await waitReady(page, selector))) {
      return fail(`Element not ready (not visible within ${pageWaitMs()}ms): ${selector}`);
    }
    await page.click(selector);
    return ok({ clicked: selector, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_type({ selector, text, clearFirst }) {
  if (!selector) return fail('CSS selector is required.');
  if (!text) return fail('Text is required.');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // Same waitReady pre-wait as browser_click — fail cleanly if absent.
    if (!(await waitReady(page, selector))) {
      return fail(`Element not ready (not visible within ${pageWaitMs()}ms): ${selector}`);
    }
    if (clearFirst) await page.fill(selector, text);
    else await page.type(selector, text);
    return ok({ typed: text.length, into: selector, url: page.url() });
  }).catch(err => fail(err.message));
}

// ---- Phase 4: wait-for-element + form-fill ----

async function browser_wait_for({ selector, timeoutMs }) {
  if (!selector) return fail('CSS selector is required.');
  const guard = await requireOnline();
  if (guard) return guard;
  const timeout = (typeof timeoutMs === 'number' && timeoutMs > 0) ? Math.min(timeoutMs, 30000) : 10000;

  return browserAgent.withPage(async (page) => {
    try {
      await page.waitForSelector(selector, { timeout: timeout });
      // Confirm the element is actually present (waitForSelector resolves on visibility too).
      const count = await page.locator(selector).count();
      return ok({ selector: selector, present: true, matched: count, waitedMs: timeout });
    } catch (err) {
      // Honest fail on timeout — do NOT claim the element appeared.
      return fail('Element "' + selector + '" did not appear within ' + timeout + 'ms.');
    }
  }).catch(err => fail(err.message));
}

async function browser_fill_form({ fields }) {
  if (!fields || !Array.isArray(fields) || !fields.length) {
    return fail('fields array is required: [{selector, value}].');
  }
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // Fill each field in sequence. A bad selector reports that field's failure
    // WITHOUT aborting the rest — a form with one missing field still fills the
    // others, and the result reports per-field outcome.
    const results = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || !f.selector || f.value === undefined || f.value === null) {
        results.push({ index: i, selector: f && f.selector, ok: false, error: 'missing selector or value' });
        continue;
      }
      try {
        // waitReady pre-wait per field (replaces the swallowed 4000ms catch).
        // A field that never appears reports its own failure WITHOUT aborting
        // the rest of the form (the per-field contract documented above).
        if (!(await waitReady(page, f.selector))) {
          results.push({ index: i, selector: f.selector, ok: false, error: 'field not visible within ' + pageWaitMs() + 'ms' });
          continue;
        }
        await page.fill(f.selector, String(f.value));
        results.push({ index: i, selector: f.selector, ok: true });
      } catch (err) {
        results.push({ index: i, selector: f.selector, ok: false, error: (err && err.message) || 'fill failed' });
      }
    }
    const filled = results.filter((r) => r.ok).length;
    return ok({ fields: results, filled: filled, total: fields.length, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_screenshot() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const buf = await page.screenshot({ fullPage: false });
    const b64 = buf.toString('base64');
    const title = await page.title();
    return ok({ base64: b64, width: page.viewportSize()?.width || 0, height: page.viewportSize()?.height || 0, title, url: page.url(), sizeKB: Math.round(buf.length / 1024) });
  }).catch(err => fail(err.message));
}

async function browser_get_title() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const title = await page.title();
    return ok({ title, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_get_text({ selector } = {}) {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    let text;
    if (selector) {
      // waitReady pre-wait: previously get_text had NONE, so page.textContent
      // immediately rode the 15s page-default timeout on any not-yet-hydrated
      // SPA element (the operator's exact YouTube ytd-rich-item-renderer error).
      // Fail cleanly here with the selector named, not the raw Playwright timeout.
      if (!(await waitReady(page, selector))) {
        return fail('Element not ready (not visible within ' + pageWaitMs() + 'ms): ' + selector);
      }
      text = await page.textContent(selector);
      if (!text && selector) return fail('Element not found or empty for selector: ' + selector);
    } else {
      text = await page.textContent('body');
      if (!text && !selector) { text = await page.textContent('body'); }
      if (!text) return fail('No text content found on the page.');
    }
    // Truncate to avoid huge payloads
    const truncated = text.length > 4000;
    return ok({ text: text.substring(0, 4000), truncated, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_scroll({ direction }) {
  const dir = direction || 'down';
  if (!['up', 'down'].includes(dir)) return fail('Direction must be "up" or "down".');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const amount = dir === 'down' ? 600 : -600;
    await page.evaluate((y) => window.scrollBy(0, y), amount);
    return ok({ scrolled: dir, amount });
  }).catch(err => fail(err.message));
}

async function listTabs(pages) {
  return Promise.all(pages.map(async (p, i) => ({
    index: i,
    title: await p.title().catch(() => '(error)'),
    url: p.url(),
  })));
}

// Indexes are recomputed fresh every call and shift the instant any tab
// closes. `match` targets a tab by identity (title/url substring) instead of
// a position that may already be stale; every switch/close response also
// returns a fresh tabs list.
async function resolveTabIndex(pages, index, match) {
  if (typeof index === 'number') return { idx: index };
  if (match) {
    const needle = String(match).toLowerCase();
    for (let i = 0; i < pages.length; i++) {
      const title = await pages[i].title().catch(() => '');
      if (title.toLowerCase().includes(needle) || pages[i].url().toLowerCase().includes(needle)) return { idx: i };
    }
    return { idx: -1, error: `No open tab matches "${match}".` };
  }
  return { idx: null };
}

async function browser_tabs({ action, index, match }) {
  const act = action || 'list';
  const validActions = ['list', 'new', 'switch', 'close'];
  if (!validActions.includes(act)) return fail(`Invalid tab action: "${act}". Valid: ${validActions.join(', ')}`);
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page, ctx) => {
    const pages = ctx.pages();

    switch (act) {
      case 'list':
        return ok({
          tabs: await listTabs(pages),
          total: pages.length,
        });
      case 'new': {
        const newPage = await ctx.newPage();
        return ok({ index: pages.length, title: await newPage.title(), url: newPage.url() });
      }
      case 'switch': {
        const resolved = await resolveTabIndex(pages, index, match);
        if (resolved.error) return fail(resolved.error);
        const idx = resolved.idx != null ? resolved.idx : 0;
        if (idx < 0 || idx >= pages.length) return fail(`Tab index ${idx} out of range (0-${pages.length - 1})`);
        await pages[idx].bringToFront();
        return ok({ switched: idx, title: await pages[idx].title(), url: pages[idx].url(), tabs: await listTabs(ctx.pages()) });
      }
      case 'close': {
        const resolved = await resolveTabIndex(pages, index, match);
        if (resolved.error) return fail(resolved.error);
        const idx = resolved.idx != null ? resolved.idx : (pages.length - 1);
        if (idx < 0 || idx >= pages.length) return fail(`Tab index ${idx} out of range (0-${pages.length - 1})`);
        if (pages.length <= 1) return fail('Cannot close the last tab.');
        await pages[idx].close();
        const remaining = ctx.pages();
        return ok({ closed: idx, remaining: remaining.length, title: await remaining[0].title(), url: remaining[0].url(), tabs: await listTabs(remaining) });
      }
      default:
        return fail(`Unknown tab action: ${act}`);
    }
  }).catch(err => fail(err.message));
}

async function browser_go_back() {
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    await page.goBack({ waitUntil: 'domcontentloaded' });
    return ok({ url: page.url(), title: await page.title() });
  }).catch(err => fail(err.message));
}

async function browser_evaluate({ script, expression, javascript, query }) {
  // BUG-011 fix 2: param aliasing — callers (voice/dashboard) sometimes send
  // "expression"/"javascript"/"query" instead of "script"; previously only
  // "script" was read, so those calls silently failed with a missing-arg error.
  const code = script || expression || javascript || query;
  if (!code) return fail('JavaScript expression is required (pass as script, expression, javascript, or query).');
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    // Safety: wrap in try-catch on the browser side
    const result = await page.evaluate((code) => {
      try {
        const value = eval(code);
        return { value: String(value), ok: true };
      } catch (err) {
        return { error: err.message, ok: false };
      }
    }, code);

    if (result.ok) return ok({ value: result.value, url: page.url() });
    return fail(`Script error: ${result.error}`);
  }).catch(err => fail(err.message));
}

// BUG (on-demand launcher, Phase 6a): mirrors scripts/setup-chrome-debug.ps1's
// exact search order and launch flags so this tool and the manual script agree
// on where the debug browser lives. Chrome first, then Edge; portability rule
// (repo CLAUDE.md) — the profile dir is derived from process.env.LOCALAPPDATA,
// never a hardcoded path.
// BUG-099: Brave joined the list. The operator asked four times for YouTube in
// Brave; Brave opened (launch_app) but every browser_navigate drove Chrome,
// because this resolver knew only Chrome and Edge and the CDP endpoint is a
// single fixed port. Brave is Chromium, so it speaks the same CDP — nothing
// else in the browser stack needed to change.
const BROWSER_SUBPATHS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
};
// Chrome first — unchanged default, so nothing that relied on the old order moves.
const BROWSER_SEARCH_ORDER = ['chrome', 'brave', 'edge'];
const BROWSER_ALIASES = {
  chrome: 'chrome', 'google chrome': 'chrome', 'google-chrome': 'chrome',
  brave: 'brave', 'brave browser': 'brave', 'brave-browser': 'brave',
  edge: 'edge', msedge: 'edge', 'microsoft edge': 'edge',
};

function normalizeBrowserName(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return BROWSER_ALIASES[key] || null;
}

// Every candidate derives from an environment root — repo portability rule, no
// hardcoded absolute paths in tracked files.
function browserCandidatePaths(name) {
  const wanted = name === undefined || name === null || name === ''
    ? BROWSER_SEARCH_ORDER
    : [normalizeBrowserName(name)].filter(Boolean);
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const out = [];
  for (const browserName of wanted) {
    const sub = BROWSER_SUBPATHS[browserName];
    if (!sub) continue;
    for (const root of roots) {
      if (root) out.push(path.join(root, ...sub));
    }
  }
  return out;
}

function findBrowserExecutable(name) {
  // BROWSER_EXECUTABLE lets an operator point at any Chromium build (a portable
  // install, a non-standard drive) without touching code — same BYO posture as
  // the API keys. Only honored when no specific browser was requested, since a
  // named request must resolve to THAT browser or fail.
  const override = process.env.BROWSER_EXECUTABLE;
  if (override && !name) {
    try { if (fs.existsSync(override)) return override; } catch { /* fall through */ }
  }
  const candidates = browserCandidatePaths(name);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// Which browser MYTHOS itself put behind the CDP endpoint. null means "attached
// to something we did not launch" — an externally-started debug browser, which
// Brave and Chrome are indistinguishable in over CDP (Brave reports a plain
// `Chrome/<version>` product string on purpose). Unknown is reported as
// unknown; it is never assumed to be a match.
let attachedBrowser = null;

// Test seam only — production code sets this exclusively via a real launch.
function __setAttachedBrowserForTest(name) { attachedBrowser = name; }

function supportedBrowserList() { return BROWSER_SEARCH_ORDER.join(', '); }

// Returns null when the request is satisfiable, or a fail() when driving the
// attached browser would NOT be what the caller asked for. This is the whole
// BUG-099 honesty guarantee: silently navigating Chrome for a "in Brave"
// request, then describing it as Brave, is a fabricated success.
//
// BUG-106: attachedBrowser is a module-level flag that only reflects the LAST
// successful launch/connect — it says nothing about whether that browser is
// still the one behind the CDP endpoint right now. The operator can close it
// at any time; the adapter then drops to OFFLINE, and a later reconnect (the
// lazy bring-up in requireOnline(), or the background auto-connect poller) may
// attach to a DIFFERENT browser without ever telling this module. Clearing
// attachedBrowser here, before either check below, whenever the adapter is not
// ONLINE makes that stale window structurally impossible: whatever was
// attached before is gone, so nothing here can vouch for it anymore.
function checkBrowserTarget(requested) {
  const status = browserAgent.getStatus();
  if (status.state !== 'ONLINE') attachedBrowser = null;

  if (requested === undefined || requested === null || requested === '') return null;
  const want = normalizeBrowserName(requested);
  if (!want) {
    return fail(`"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.`);
  }
  if (!attachedBrowser) {
    return fail(`I cannot confirm which browser is attached to the debug port, so I will not claim to be driving ${want}. `
      + `Call browser_launch_debug with browser:"${want}" to start one I can vouch for.`);
  }
  if (attachedBrowser !== want) {
    return fail(`Browser control is attached to ${attachedBrowser}, not ${want}. `
      + `Call browser_switch with browser:"${want}" to close ${attachedBrowser} and switch (it calls browser_launch_debug for you) — `
      + `I will not navigate ${attachedBrowser} and call it ${want}.`);
  }
  return null;
}

// BUG-115: MYTHOS drives the debug browser through a dedicated --user-data-dir
// (chrome-debug-profile / <name>-debug-profile) that has never had any
// extensions installed into it — the operator's ad blocker lives only in
// their REAL browser profile, so every debug-driven page is unfiltered.
// BROWSER_EXTENSIONS (env, semicolon-separated list of unpacked extension
// directory paths, documented in mythos/.env.example) lets the operator load
// their own extensions into the debug profile. Read directly via process.env,
// same BYO convention as BROWSER_EXECUTABLE above — no schema.js entry.
function parseBrowserExtensionsEnv() {
  const raw = process.env.BROWSER_EXTENSIONS;
  if (!raw || !raw.trim()) return [];
  return raw.split(';').map((p) => p.trim()).filter(Boolean);
}

// An unpacked extension directory has a manifest.json at its root — the one
// structural signal that distinguishes a real unpacked extension folder from
// any other directory (a .crx is a single packed file, not a directory, so it
// fails this check honestly instead of being silently "loaded").
function isUnpackedExtensionDir(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs.existsSync(path.join(dir, 'manifest.json'));
  } catch { return false; }
}

// Validates every configured extension path BEFORE anything is spawned.
// Returns { ok:true, dirs } (dirs is [] when BROWSER_EXTENSIONS is unset/empty
// — unchanged default behavior) or { ok:false, error }. A missing or invalid
// path must fail LOUDLY here, not silently proceed with a blocker that never
// actually loaded — that silent-absence shape is exactly today's bug.
function resolveBrowserExtensions() {
  const configured = parseBrowserExtensionsEnv();
  if (!configured.length) return { ok: true, dirs: [] };
  for (const dir of configured) {
    if (!fs.existsSync(dir)) {
      return { ok: false, error: `BROWSER_EXTENSIONS path does not exist: ${dir}` };
    }
    if (!isUnpackedExtensionDir(dir)) {
      return { ok: false, error: `BROWSER_EXTENSIONS path is not an unpacked extension directory (no manifest.json found): ${dir}` };
    }
  }
  return { ok: true, dirs: configured };
}

// Chromium ignores --load-extension alone in current builds — it also needs
// --disable-extensions-except naming the same list, or the extension silently
// never loads (found live-verifying BUG-115: neither debug profile directory
// has ever had a Default/Extensions folder). Both flags take a single
// comma-separated path list when there is more than one extension.
function buildBrowserLaunchArgs(profileDir, extensionDirs) {
  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
  ];
  if (extensionDirs && extensionDirs.length) {
    const joined = extensionDirs.join(',');
    args.push(`--load-extension=${joined}`);
    args.push(`--disable-extensions-except=${joined}`);
  }
  return args;
}

// Evidence-contract seam (repo rule: an effector result must carry an
// oracle-backed field, never a bare ok:true with no evidence). extensionsLoaded
// is exactly the dirs resolveBrowserExtensions() verified present on disk and
// passed to Chromium — [] when none were configured, never a guess and never
// "active" for a profile that loaded none.
function buildLaunchResult(browserName, status, profileDir, extensionDirs) {
  return {
    launched: true,
    browser: browserName,
    mode: status.mode,
    pageCount: status.pageCount,
    profileDir,
    extensionsLoaded: extensionDirs,
  };
}

// On-demand debug-browser launcher (Phase 6a, user-approved). Boot never
// auto-launches Chrome (main.js's browser-automation step — launching a real
// browser at boot steals the mic/audio device on Windows) — this is the tool
// that turns that CDP-connect-only standby into an actually-online browser
// when the user asks for one, without touching the boot-time prohibition.
async function browser_launch_debug(args) {
  // BUG-099: an explicit browser name. Unsupported names fail before anything
  // is spawned — the model must not get a launched Chrome for a "brave" ask.
  const requested = args && args.browser;
  let want = null;
  if (requested !== undefined && requested !== null && requested !== '') {
    want = normalizeBrowserName(requested);
    if (!want) return fail(`"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.`);
  }

  const status0 = browserAgent.getStatus();
  if (status0.state === 'ONLINE') {
    // One CDP port, one browser. If a different one already owns it, say so
    // instead of "launched" — the debug port cannot be shared.
    if (want && attachedBrowser && attachedBrowser !== want) {
      return fail(`${attachedBrowser} already owns the debug port. Close it first, then launch ${want}.`);
    }
    return ok({ alreadyOnline: true, browser: attachedBrowser || 'unknown' });
  }
  if (status0.state === 'CONNECTING') {
    // FIX-1: a connect is already in flight (poller tick or a concurrent
    // caller) — join it via ensureOnline()/connect()'s connectingPromise guard
    // instead of spawning a second Chrome process on top of it.
    const cdpUrl0 = process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL) || 'http://127.0.0.1:9222';
    const joined = await browserAgent.ensureOnline({ cdpUrl: cdpUrl0 }).catch(() => false);
    if (joined) {
      const s = browserAgent.getStatus();
      return ok({ launched: false, mode: s.mode, pageCount: s.pageCount });
    }
    return fail('A browser connection attempt is already in progress and did not complete — try again in a moment.');
  }

  const exe = findBrowserExecutable(want);
  if (!exe) {
    return want
      ? fail(`No ${want} installation found. Install it, or set BROWSER_EXECUTABLE to its path.`)
      : fail(`No supported browser found (${supportedBrowserList()}). Install one, or set BROWSER_EXECUTABLE to its path.`);
  }

  // A named browser gets its own profile dir so switching browsers does not
  // hand Brave a profile Chrome wrote. Unnamed keeps the historical path.
  const profileDir = want && want !== 'chrome'
    ? path.join(process.env.LOCALAPPDATA, 'MYTHOS', want + '-debug-profile')
    : path.join(process.env.LOCALAPPDATA, 'MYTHOS', 'chrome-debug-profile');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (err) { return fail(`Could not create debug profile directory: ${err.message}`); }

  // BUG-115: validate BEFORE spawning anything — a bad/missing path must fail
  // loudly here, not launch a browser that quietly has no extensions.
  const extensionsResult = resolveBrowserExtensions();
  if (!extensionsResult.ok) return fail(extensionsResult.error);
  const extensionDirs = extensionsResult.dirs;

  const cdpUrl = process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL) || 'http://127.0.0.1:9222';
  try {
    const child = spawn(exe, buildBrowserLaunchArgs(profileDir, extensionDirs), { detached: true, stdio: 'ignore' });
    child.unref();
    // BUG-029 (Phase 3 hardening): this detached spawn is the orphan risk.
    // Record the PID the same way launchLocal() does, so Start Agent OS.bat's
    // cleanup step catches it on the next boot if Windows swallows the
    // shutdown signal. Best-effort — recordLaunchedPid never throws.
    if (child && child.pid && typeof browserAgent.recordLaunchedPid === 'function') {
      browserAgent.recordLaunchedPid(child.pid);
    }
  } catch (err) {
    return fail(`Failed to launch browser: ${err.message}`);
  }

  // Give Chrome/Edge a moment to open its debug port before the first CDP
  // connect attempt — ensureOnline() itself has its own connect timeout, this
  // is just the cold-start window before the port exists at all.
  await new Promise((r) => setTimeout(r, 2000));

  const connected = await browserAgent.ensureOnline({ cdpUrl }).catch(() => false);
  if (!connected) return fail('Browser launched but CDP connect did not come online — it may still be starting; try again in a moment.');
  const status = browserAgent.getStatus();
  // BUG-099: record WHICH browser is behind the endpoint. This is the only
  // trustworthy source — over CDP, Brave reports a plain `Chrome/<version>`
  // product string, so a version probe cannot tell them apart.
  attachedBrowser = want || 'chrome';
  return ok(buildLaunchResult(attachedBrowser, status, profileDir, extensionDirs));
}

// BUG-107: the wrong-browser refusal above ("attached to Brave, not Chrome")
// used to be a dead end — correct and honest, then nothing. This is the
// remedy: disconnect the current browser, launch the requested one, and
// re-attach — in one call instead of "close Brave yourself, then ask again."
async function browser_switch(args) {
  const requested = args && args.browser;
  if (requested === undefined || requested === null || requested === '') {
    return fail('browser is required — name which browser to switch to (chrome, brave, or edge).');
  }
  const want = normalizeBrowserName(requested);
  if (!want) return fail(`"${requested}" is not a browser I can drive. Supported: ${supportedBrowserList()}.`);

  const status = browserAgent.getStatus();
  if (status.state === 'ONLINE') {
    if (attachedBrowser === want) {
      return ok({ switched: false, alreadyOnline: true, browser: want });
    }
    if (!attachedBrowser) {
      // BUG-106 made attachedBrowser non-null EXACTLY when MYTHOS itself
      // launched the current browser. null here means we only ever CDP-
      // attached to something already running — closing that could kill the
      // operator's own browser window. Refuse honestly instead of silently
      // no-op'ing through browser_launch_debug's alreadyOnline branch, which
      // would otherwise report success without actually switching anything.
      return fail(`Browser control is attached to a browser MYTHOS did not launch, so I cannot confirm its identity or safely close it. `
        + `Close it yourself, then call browser_launch_debug with browser:"${want}".`);
    }
    // Only ever close a browser MYTHOS itself launched — reuses the same
    // disconnect() every other shutdown path uses, no second close mechanism.
    await browserAgent.disconnect();
  }

  attachedBrowser = null;
  // Route through the SAME launch logic browser_launch_debug already uses —
  // no second launch code path to keep in sync with it.
  return browser_launch_debug({ browser: want });
}

// ---- Tool catalog ----

const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate the browser to a URL. Set newTab:true to open it in a new tab instead of reusing the current one. If the user named a specific browser (Chrome, Brave, Edge), pass it as `browser` — the call then FAILS rather than driving a different one, and the response says which browser was actually used.', params: { url: 'string - the URL to navigate to', newTab: 'boolean (optional) - open in a new tab instead of the current one', browser: 'string (optional) - chrome, brave or edge; only when the user asked for a specific browser' }, danger: false, fn: browser_navigate, needs_result: true },
  { name: 'browser_click', description: 'Click an element on the page using a CSS selector.', params: { selector: 'string - CSS selector of the element to click' }, danger: false, fn: browser_click },
  { name: 'browser_type', description: 'Type text into an input field. Set clearFirst to true to clear the field first.', params: { selector: 'string - CSS selector of the input field', text: 'string - text to type', clearFirst: 'boolean (optional) - clear field before typing' }, danger: false, fn: browser_type },
  { name: 'browser_screenshot', description: 'Take a screenshot of the current page. Returns base64 PNG.', params: {}, danger: false, fn: browser_screenshot, needs_result: true },
  { name: 'browser_get_title', description: 'Get the title and URL of the current page.', params: {}, danger: false, fn: browser_get_title, needs_result: true },
  { name: 'browser_get_text', description: 'Get the text content of the page or a specific element (CSS selector). Truncated at 4000 chars.', params: { selector: 'string (optional) - CSS selector, defaults to body' }, danger: false, fn: browser_get_text, needs_result: true },
  { name: 'browser_scroll', description: 'Scroll the page up or down by 600 pixels.', params: { direction: 'string - "up" or "down" (default: down)' }, danger: false, fn: browser_scroll },
  { name: 'browser_tabs', description: 'Manage browser tabs. Actions: list (default), new, switch (needs index), close (needs index). switch/close accept either index (indexes shift after any tab closes — re-list first if unsure) or match (substring of the target tab\'s title or URL; safer than a cached index). Every switch/close response includes a fresh tabs list.', params: { action: 'string (optional) - list, new, switch, close', index: 'number (optional) - tab index for switch/close', match: 'string (optional) - substring of the target tab\'s title or URL, an alternative to index for switch/close' }, danger: false, fn: browser_tabs, needs_result: true },
  { name: 'browser_go_back', description: 'Navigate back to the previous page in history.', params: {}, danger: false, fn: browser_go_back },
  { name: 'browser_wait_for', description: 'Wait for an element matching a CSS selector to appear on the page. Fails honestly if it does not appear within the timeout. Use before reading or interacting with a dynamically-loaded element.', params: { selector: 'string - CSS selector to wait for', timeoutMs: 'number (optional) - max wait in ms, default 10000, capped at 30000' }, danger: false, fn: browser_wait_for, needs_result: true },
  { name: 'browser_fill_form', description: 'Fill multiple form fields in one call. Pass fields:[{selector, value}]. Each field is filled (replacing existing content); a bad selector reports that field failure without aborting the rest.', params: { fields: 'array - [{selector: string, value: string}]' }, danger: true, fn: browser_fill_form },
  { name: 'browser_evaluate', description: 'Run a JavaScript expression in the browser and return the result as a string.', params: { script: 'string - JavaScript expression to evaluate' }, danger: true, fn: browser_evaluate },
  { name: 'browser_launch_debug', description: 'Launch the debug-mode browser so browser control comes online. Use when the user asks to open/start the browser or a browser action fails with OFFLINE. Pass browser:"brave" (or chrome/edge) when the user named one — the debug port holds exactly one browser at a time.', params: { browser: 'string (optional) - chrome (default), brave or edge' }, danger: false, fn: browser_launch_debug },
  { name: 'browser_switch', description: 'Switch the debug browser to a different one (chrome, brave, or edge) when browser control is already attached to a different browser than the one requested. Disconnects the current MYTHOS-launched browser, launches the requested one, and re-attaches — the remedy for a "browser control is attached to X, not Y" refusal.', params: { browser: 'string - chrome, brave or edge to switch to' }, danger: false, fn: browser_switch },
];

function registerFromBrowser(hub, ctx) {
  config = (ctx && ctx.config) || null;
  vaultFs = (ctx && ctx.fs) || null;
  for (var i = 0; i < TOOLS.length; i++) {
    hub.register(effectorFromTool(TOOLS[i]));
  }
  return TOOLS.length;
}

module.exports = {
  registerFromBrowser,
  TOOLS,
  browser_navigate, browser_click, browser_type, browser_screenshot, browser_get_title,
  browser_get_text, browser_scroll, browser_tabs, browser_go_back, browser_evaluate,
  browser_launch_debug, browser_switch,
  browser_wait_for, browser_fill_form,
  // BUG-099 seams: pure helpers so the browser-target guarantee is testable
  // without requireOnline() launching a real browser on the test machine.
  findBrowserExecutable, browserCandidatePaths, normalizeBrowserName, checkBrowserTarget,
  __setAttachedBrowserForTest,
  // BUG-115 seams: pure helpers so the extension-loading guarantee is testable
  // without browser_launch_debug spawning a real browser on the test machine.
  parseBrowserExtensionsEnv, resolveBrowserExtensions, buildBrowserLaunchArgs, buildLaunchResult,
};
