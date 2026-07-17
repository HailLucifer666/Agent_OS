'use strict';

// effectors/from-browser.js — CA of app/lib/voice/tools-browser.js (10 tools). Function
// bodies verbatim; only re-pointing is `./browser-agent` -> `adapters/browser-agent`
// (untouched, re-pathed).

const browserAgent = require('../../../adapters/browser-agent');
const { effectorFromTool } = require('./adapter');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function ok(result) { return { ok: true, result }; }
function fail(reason) { return { ok: false, result: reason }; }

// Set by registerFromBrowser() from ctx.config — used by requireOnline()'s lazy
// auto-connect fallback to find BROWSER_CDP_URL when the env var isn't set.
let config = null;

// BUG-011 fix 1: lazy auto-connect. Previously this was synchronous and only ever
// reported OFFLINE — nothing ever called browserAgent.ensureOnline(), so browser
// tools stayed stuck OFFLINE forever even after running setup-chrome-debug.ps1.
// Now: if not ONLINE, try ensureOnline() (CDP connect, per adapters/browser-agent's
// own connect-then-launchLocal fallback) before giving up.
async function requireOnline() {
  let status = browserAgent.getStatus();
  if (status.state !== 'ONLINE') {
    try { await browserAgent.ensureOnline({ cdpUrl: process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL) }); } catch { /* fall through to OFFLINE report below */ }
    status = browserAgent.getStatus();
  }
  if (status.state !== 'ONLINE') {
    return fail(`Browser automation is ${status.state}. ${status.hint || 'Run setup-chrome-debug.ps1 first.'}`);
  }
  return null;
}

// ---- Tool implementations ----

async function browser_navigate({ url }) {
  if (!url) return fail('URL is required.');
  try { new URL(url); } catch { return fail(`Invalid URL: "${url}"`); }
  const guard = await requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    return ok({ url: page.url(), title });
  }).catch(err => fail(err.message));
}

async function browser_click({ selector }) {
  if (!selector) return fail('CSS selector is required.');
  const guard = await requireOnline();
  if (guard) return guard;

  // Phase 4 hardening: implicit waitForSelector before click so a not-yet-rendered
  // element doesn't fail the whole click. waitForSelector rejects on timeout, which
  // the .catch turns into a clean fail — no silent retry storm.
  return browserAgent.withPage(async (page) => {
    try { await page.waitForSelector(selector, { timeout: 5000 }); } catch (_) { /* fall through to click, which will fail honestly */ }
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
    // Phase 4 hardening: implicit waitForSelector before typing.
    try { await page.waitForSelector(selector, { timeout: 5000 }); } catch (_) {}
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
        // Wait briefly for the field, then fill (replace existing content).
        try { await page.waitForSelector(f.selector, { timeout: 4000 }); } catch (_) {}
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

async function browser_tabs({ action, index }) {
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
          tabs: await Promise.all(pages.map(async (p, i) => ({
            index: i,
            title: await p.title().catch(() => '(error)'),
            url: p.url(),
          }))),
          total: pages.length,
        });
      case 'new': {
        const newPage = await ctx.newPage();
        return ok({ index: pages.length, title: await newPage.title(), url: newPage.url() });
      }
      case 'switch': {
        const idx = typeof index === 'number' ? index : 0;
        if (idx < 0 || idx >= pages.length) return fail(`Tab index ${idx} out of range (0-${pages.length - 1})`);
        await pages[idx].bringToFront();
        return ok({ switched: idx, title: await pages[idx].title(), url: pages[idx].url() });
      }
      case 'close': {
        const idx = typeof index === 'number' ? index : (pages.length - 1);
        if (idx < 0 || idx >= pages.length) return fail(`Tab index ${idx} out of range (0-${pages.length - 1})`);
        if (pages.length <= 1) return fail('Cannot close the last tab.');
        await pages[idx].close();
        const remaining = ctx.pages();
        return ok({ closed: idx, remaining: remaining.length, title: await remaining[0].title(), url: remaining[0].url() });
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
function findBrowserExecutable() {
  const candidates = [
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// On-demand debug-browser launcher (Phase 6a, user-approved). Boot never
// auto-launches Chrome (main.js's browser-automation step — launching a real
// browser at boot steals the mic/audio device on Windows) — this is the tool
// that turns that CDP-connect-only standby into an actually-online browser
// when the user asks for one, without touching the boot-time prohibition.
async function browser_launch_debug() {
  if (browserAgent.getStatus().state === 'ONLINE') return ok({ alreadyOnline: true });

  const exe = findBrowserExecutable();
  if (!exe) return fail('No Chrome or Edge installation found. Install Google Chrome or Microsoft Edge.');

  const profileDir = path.join(process.env.LOCALAPPDATA, 'MYTHOS', 'chrome-debug-profile');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch (err) { return fail(`Could not create debug profile directory: ${err.message}`); }

  const cdpUrl = process.env.BROWSER_CDP_URL || (config && config.BROWSER_CDP_URL) || 'http://127.0.0.1:9222';
  try {
    const child = spawn(exe, [
      '--remote-debugging-port=9222',
      `--user-data-dir=${profileDir}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
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
  return ok({ launched: true, mode: status.mode, pageCount: status.pageCount });
}

// ---- Tool catalog ----

const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate the browser to a URL.', params: { url: 'string - the URL to navigate to' }, danger: false, fn: browser_navigate, needs_result: true },
  { name: 'browser_click', description: 'Click an element on the page using a CSS selector.', params: { selector: 'string - CSS selector of the element to click' }, danger: false, fn: browser_click },
  { name: 'browser_type', description: 'Type text into an input field. Set clearFirst to true to clear the field first.', params: { selector: 'string - CSS selector of the input field', text: 'string - text to type', clearFirst: 'boolean (optional) - clear field before typing' }, danger: false, fn: browser_type },
  { name: 'browser_screenshot', description: 'Take a screenshot of the current page. Returns base64 PNG.', params: {}, danger: false, fn: browser_screenshot, needs_result: true },
  { name: 'browser_get_title', description: 'Get the title and URL of the current page.', params: {}, danger: false, fn: browser_get_title, needs_result: true },
  { name: 'browser_get_text', description: 'Get the text content of the page or a specific element (CSS selector). Truncated at 4000 chars.', params: { selector: 'string (optional) - CSS selector, defaults to body' }, danger: false, fn: browser_get_text, needs_result: true },
  { name: 'browser_scroll', description: 'Scroll the page up or down by 600 pixels.', params: { direction: 'string - "up" or "down" (default: down)' }, danger: false, fn: browser_scroll },
  { name: 'browser_tabs', description: 'Manage browser tabs. Actions: list (default), new, switch (needs index), close (needs index).', params: { action: 'string (optional) - list, new, switch, close', index: 'number (optional) - tab index for switch/close' }, danger: false, fn: browser_tabs, needs_result: true },
  { name: 'browser_go_back', description: 'Navigate back to the previous page in history.', params: {}, danger: false, fn: browser_go_back },
  { name: 'browser_wait_for', description: 'Wait for an element matching a CSS selector to appear on the page. Fails honestly if it does not appear within the timeout. Use before reading or interacting with a dynamically-loaded element.', params: { selector: 'string - CSS selector to wait for', timeoutMs: 'number (optional) - max wait in ms, default 10000, capped at 30000' }, danger: false, fn: browser_wait_for, needs_result: true },
  { name: 'browser_fill_form', description: 'Fill multiple form fields in one call. Pass fields:[{selector, value}]. Each field is filled (replacing existing content); a bad selector reports that field failure without aborting the rest.', params: { fields: 'array - [{selector: string, value: string}]' }, danger: true, fn: browser_fill_form },
  { name: 'browser_evaluate', description: 'Run a JavaScript expression in the browser and return the result as a string.', params: { script: 'string - JavaScript expression to evaluate' }, danger: true, fn: browser_evaluate },
  { name: 'browser_launch_debug', description: 'Launch the debug-mode browser so browser control comes online. Use when the user asks to open/start the browser or a browser action fails with OFFLINE.', params: {}, danger: false, fn: browser_launch_debug },
];

function registerFromBrowser(hub, ctx) {
  config = (ctx && ctx.config) || null;
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
  browser_launch_debug,
  browser_wait_for, browser_fill_form,
};
