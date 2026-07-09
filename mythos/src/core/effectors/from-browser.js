'use strict';

// effectors/from-browser.js — CA of app/lib/voice/tools-browser.js (10 tools). Function
// bodies verbatim; only re-pointing is `./browser-agent` -> `adapters/browser-agent`
// (untouched, re-pathed).

const browserAgent = require('../../../adapters/browser-agent');
const { effectorFromTool } = require('./adapter');

function ok(result) { return { ok: true, result }; }
function fail(reason) { return { ok: false, result: reason }; }

function requireOnline() {
  const status = browserAgent.getStatus();
  if (status.state !== 'ONLINE') {
    return fail(`Browser automation is ${status.state}. ${status.hint || 'Run setup-chrome-debug.ps1 first.'}`);
  }
  return null;
}

// ---- Tool implementations ----

async function browser_navigate({ url }) {
  if (!url) return fail('URL is required.');
  try { new URL(url); } catch { return fail(`Invalid URL: "${url}"`); }
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    return ok({ url: page.url(), title });
  }).catch(err => fail(err.message));
}

async function browser_click({ selector }) {
  if (!selector) return fail('CSS selector is required.');
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    await page.click(selector);
    return ok({ clicked: selector, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_type({ selector, text, clearFirst }) {
  if (!selector) return fail('CSS selector is required.');
  if (!text) return fail('Text is required.');
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    if (clearFirst) await page.fill(selector, text);
    else await page.type(selector, text);
    return ok({ typed: text.length, into: selector, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_screenshot() {
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const buf = await page.screenshot({ fullPage: false });
    const b64 = buf.toString('base64');
    const title = await page.title();
    return ok({ base64: b64, width: page.viewportSize()?.width || 0, height: page.viewportSize()?.height || 0, title, url: page.url(), sizeKB: Math.round(buf.length / 1024) });
  }).catch(err => fail(err.message));
}

async function browser_get_title() {
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    const title = await page.title();
    return ok({ title, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_get_text({ selector } = {}) {
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    let text;
    if (selector) {
      text = await page.textContent(selector);
    } else {
      text = await page.textContent('body');
    }
    // Truncate to avoid huge payloads
    const truncated = text.length > 4000;
    return ok({ text: text.substring(0, 4000), truncated, url: page.url() });
  }).catch(err => fail(err.message));
}

async function browser_scroll({ direction }) {
  const dir = direction || 'down';
  if (!['up', 'down'].includes(dir)) return fail('Direction must be "up" or "down".');
  const guard = requireOnline();
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
  const guard = requireOnline();
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
  const guard = requireOnline();
  if (guard) return guard;

  return browserAgent.withPage(async (page) => {
    await page.goBack({ waitUntil: 'domcontentloaded' });
    return ok({ url: page.url(), title: await page.title() });
  }).catch(err => fail(err.message));
}

async function browser_evaluate({ script }) {
  if (!script) return fail('JavaScript expression is required.');
  const guard = requireOnline();
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
    }, script);

    if (result.ok) return ok({ value: result.value, url: page.url() });
    return fail(`Script error: ${result.error}`);
  }).catch(err => fail(err.message));
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
  { name: 'browser_evaluate', description: 'Run a JavaScript expression in the browser and return the result as a string.', params: { script: 'string - JavaScript expression to evaluate' }, danger: true, fn: browser_evaluate },
];

function registerFromBrowser(hub) {
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
};
