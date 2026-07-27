#!/usr/bin/env node
'use strict';

// verify-compose-reply.js — live verification harness for BUG-002.
//
// BUG-002: typing into the HUD compose bar and pressing Enter used to show
// nothing back (reqId-scoped replies were routed to a handler Map the
// conversation panel never subscribed to, while the compose bar's own
// onCaption prop was an empty no-op). BUGS.md claims this is already fixed
// and live-verified (2026-07-17). This script re-proves it end to end,
// live, in a REAL browser against a REAL running MYTHOS instance — not just
// the server-side WS round trip (verify-lib's sendUtterance already proves
// that part; this script drives the actual compose-bar DOM the way a human
// would: click the input, type, press Enter, read the rendered caption).
//
// What it checks:
//   1. Boots MYTHOS on an isolated test port.
//   2. Launches a real Chromium (via the repo's existing playwright-core
//      dependency — zero new deps) and loads the HUD.
//   3. Clicks #compose-input, types a question, presses Enter.
//   4. Waits for a `.mic-caption[data-kind="reply"]` (or "error") to render
//      inside #compose-caption and asserts it has real reply text.
//
// Usage:
//   node scripts/verify-compose-reply.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { log, bootMythos, killTree } = require('./verify-lib');

const TEST_PORT = 4711; // well away from default 4478; confirmed free before use
const QUESTION = 'What day is it today?';
const REPLY_TIMEOUT_MS = 30000; // real brain call (groq) — give it room

// playwright-core ships in mythos/node_modules already (package.json
// dependency) — no new npm install. It just doesn't bundle a browser binary
// under that exact cached-build number, so we hunt for whichever chromium
// build IS actually present under ms-playwright's cache, falling back to a
// system Chrome install if none is found.
function findChromeExecutable(chromium) {
  const candidates = [];
  try { candidates.push(chromium.executablePath()); } catch (_) {}
  const cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    const entries = fs.readdirSync(cacheDir).filter((e) => e.startsWith('chromium-'));
    entries.sort().reverse(); // prefer newest build number
    entries.forEach((e) => candidates.push(path.join(cacheDir, e, 'chrome-win64', 'chrome.exe')));
  } catch (_) {}
  candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

async function main() {
  log('🧪', 'BUG-002 compose-bar reply verification starting (live browser)');

  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (err) {
    log('⏭️', `playwright-core not resolvable: ${err.message}`);
    console.log('SKIP: playwright-core dependency missing');
    process.exit(3);
  }

  const execPath = findChromeExecutable(chromium);
  if (!execPath) {
    log('⏭️', 'no usable Chromium/Chrome binary found on this machine');
    console.log('SKIP: no Chromium/Chrome executable found (playwright cache empty, no system Chrome)');
    process.exit(3);
  }
  log('ℹ️', `using browser: ${execPath}`);

  let boot;
  try {
    boot = await bootMythos({ port: TEST_PORT });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  let browser;
  let pass = false;
  let evidence = '';
  try {
    browser = await chromium.launch({ executablePath: execPath, headless: true });
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(`http://127.0.0.1:${TEST_PORT}/`, { waitUntil: 'load', timeout: 15000 });

    // Compose bar mounts synchronously in app.js's top-level code, so the
    // input should exist almost immediately — but give the module graph a
    // moment to finish importing/executing.
    await page.waitForSelector('#compose-input', { timeout: 10000 });

    // Record EVERY caption change from here on via a MutationObserver, not a
    // single snapshot read. The HUD's #compose-caption node is a shared
    // single-slot status line (wake-word init, mic errors, etc. all render
    // through the same setCaption() call as the actual reply) — a naive
    // "read it once after waiting" check can catch an unrelated transient
    // status (e.g. wake-word permission errors) instead of our reply. We
    // need the full history to tell those apart from the genuine answer.
    await page.evaluate(() => {
      window.__captions = [];
      const container = document.getElementById('compose-caption');
      const record = () => {
        const el = container.querySelector('.mic-caption');
        if (el) window.__captions.push({ kind: el.getAttribute('data-kind'), text: el.textContent, ts: Date.now() });
      };
      new MutationObserver(record).observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
    });

    log('⌨️', `typing "${QUESTION}" into the real compose bar...`);
    await page.click('#compose-input');
    await page.fill('#compose-input', QUESTION);

    // Confirm the user's own message renders as a "heard" caption immediately
    // (submit()'s setCaption(text, 'heard') call) BEFORE pressing Enter fires it.
    await page.press('#compose-input', 'Enter');

    await page.waitForSelector('#compose-caption .mic-caption[data-kind="heard"]', { timeout: 5000 });
    const heardText = await page.textContent('#compose-caption .mic-caption[data-kind="heard"]');
    log('✅', `"heard" caption rendered: "${heardText}"`);

    // Now wait for a genuine reply to show up ANYWHERE in the observed
    // history (this is the exact bug: reply used to never appear at all).
    log('⏳', `waiting up to ${REPLY_TIMEOUT_MS}ms for a reply caption...`);
    let sawReply = false;
    try {
      await page.waitForFunction(
        () => window.__captions.some((c) => c.kind === 'reply' && c.text && c.text.trim().length > 0),
        { timeout: REPLY_TIMEOUT_MS }
      );
      sawReply = true;
    } catch (_) {
      sawReply = false;
    }

    const captions = await page.evaluate(() => window.__captions);
    log('ℹ️', `full caption history: ${JSON.stringify(captions)}`);

    if (sawReply) {
      const replyEntry = captions.find((c) => c.kind === 'reply' && c.text && c.text.trim().length > 0);
      pass = true;
      evidence = `reply caption rendered: text="${replyEntry.text.trim()}" (full caption history: ${JSON.stringify(captions)})`;
      log('✅', evidence);
    } else {
      evidence = `no "reply" caption ever appeared within ${REPLY_TIMEOUT_MS}ms — caption history: ${JSON.stringify(captions)}`;
      log('❌', evidence);
    }

    if (consoleErrors.length) {
      log('⚠️', `page had JS errors (informational): ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
  } catch (err) {
    evidence = `exception during browser drive: ${err.message}`;
    log('❌', evidence);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    await killTree(boot.child);
  }

  if (pass) {
    log('🎉', `BUG-002 compose-bar reply: PASS — ${evidence}`);
    process.exit(0);
  } else {
    log('💀', `BUG-002 compose-bar reply: FAIL — ${evidence}`);
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
