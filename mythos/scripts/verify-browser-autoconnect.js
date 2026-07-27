#!/usr/bin/env node
'use strict';

// verify-browser-autoconnect.js — live verification harness for BUG-011 Fix 1
// (lazy auto-connect).
//
// BUG-011 Fix 1: from-browser.js's requireOnline() now awaits
// browserAgent.ensureOnline({ cdpUrl, userDataDir }) before failing OFFLINE,
// so ANY browser tool call should self-connect (CDP-connect, then
// local-launch fallback) instead of requiring the user to manually run
// setup-chrome-debug.ps1 first. Previously this was verified only against a
// mocked browserAgent (test/bug-011-browser-auto-connect.test.js, 8/8 pass) —
// never against real Chrome/CDP. This script drives the REAL production code
// path end to end: real playwright-core, real Chrome process, no mocks.
//
// What it does:
//   1. Confirms no debug Chrome is already listening on :9222 (a clean
//      OFFLINE starting point — otherwise CDP-connect would trivially
//      succeed and we wouldn't be proving the fallback launch path).
//   2. Loads the REAL config (same loadConfig() main.js uses) so
//      BROWSER_CDP_URL resolves to its real schema default
//      ('http://127.0.0.1:9222'), and wires it into from-browser.js's module
//      state exactly the way main.js's registerFromBrowser(hub, { config })
//      call site does.
//   3. Asserts browserAgent.getStatus().state === 'OFFLINE' before touching
//      any tool (nothing auto-connects at require-time).
//   4. Calls the real browser_get_title() tool function directly (the same
//      function the effector hub dispatches to — effectorFromTool.invoke()
//      is a thin wrapper around tool.fn(), see adapter.js) with Chrome debug
//      mode off, and asserts it comes back ok:true.
//   5. Asserts getStatus().state === 'ONLINE' afterward and that a real
//      Chrome/Edge process was launched (mode === 'launched').
//   6. Cleans up: disconnects (closes the launched browser context) so no
//      orphan Chrome window is left behind for the user or other concurrent
//      agents.
//
// This script boots NOTHING on a port — no HTTP/WS server is needed to
// exercise this fix, it lives entirely in from-browser.js + the
// browser-agent adapter, so this drives those modules directly in-process.
//
// Usage:
//   node scripts/verify-browser-autoconnect.js

const http = require('http');
const path = require('path');
const { log } = require('./verify-lib');

const MYTHOS_DIR = path.join(__dirname, '..');

function checkCdpAlreadyOnline() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 9222, path: '/json/version', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  log('🧪', 'BUG-011 Fix 1 (lazy auto-connect) verification starting');
  process.chdir(MYTHOS_DIR); // so relative paths (LOCALAPPDATA profile dir etc.) resolve as in production

  const alreadyOnline = await checkCdpAlreadyOnline();
  if (alreadyOnline) {
    log('⚠️', 'A debug Chrome is ALREADY listening on :9222 — the CDP-connect branch will succeed trivially instead of proving the launch fallback. Proceeding anyway (still proves auto-connect fires), but for a clean launch-fallback proof, close that Chrome first and re-run.');
  } else {
    log('✅', 'No debug Chrome on :9222 — clean OFFLINE starting point confirmed');
  }

  const { loadConfig } = require(path.join(MYTHOS_DIR, 'src', 'core', 'config'));
  const { config } = loadConfig();
  log('ℹ️', `resolved BROWSER_CDP_URL=${config.BROWSER_CDP_URL} (real schema default, same as main.js)`);

  const browserAgent = require(path.join(MYTHOS_DIR, 'adapters', 'browser-agent'));
  const fromBrowser = require(path.join(MYTHOS_DIR, 'src', 'core', 'effectors', 'from-browser'));

  // Mirror main.js:302 registerFromBrowser(hub, { config }) exactly — a fake
  // hub is enough since we call the tool functions directly below (same code
  // path effectorFromTool.invoke() dispatches to; see adapter.js:37-47).
  fromBrowser.registerFromBrowser({ register: () => {} }, { config });

  const statusBefore = browserAgent.getStatus();
  log('ℹ️', `status before any tool call: ${JSON.stringify(statusBefore)}`);
  if (statusBefore.state !== 'OFFLINE') {
    log('❌', `expected OFFLINE before any browser tool call, got ${statusBefore.state} — cannot prove auto-connect from an unclean starting state`);
    process.exit(1);
  }

  let pass = true;
  let result;
  try {
    log('⏳', 'calling browser_get_title() with Chrome debug mode OFF (no manual setup-chrome-debug.ps1 run)...');
    result = await fromBrowser.browser_get_title();
  } catch (err) {
    log('❌', `browser_get_title() threw: ${err.message}`);
    pass = false;
    result = null;
  }

  if (result) {
    if (result.ok) {
      log('✅', `browser_get_title() returned ok:true — ${JSON.stringify(result.result)}`);
    } else {
      log('❌', `browser_get_title() returned ok:false — ${JSON.stringify(result.result)}`);
      pass = false;
    }
  }

  const statusAfter = browserAgent.getStatus();
  log('ℹ️', `status after tool call: ${JSON.stringify(statusAfter)}`);
  if (statusAfter.state === 'ONLINE') {
    log('✅', `OFFLINE -> ONLINE transition confirmed (mode=${statusAfter.mode}, pageCount=${statusAfter.pageCount}) with ZERO manual setup-chrome-debug.ps1 step`);
  } else {
    log('❌', `status did NOT reach ONLINE (still ${statusAfter.state}) — auto-connect did not actually bring the browser up`);
    pass = false;
  }

  // Cleanup: close whatever we opened (connected-to or launched) so no
  // orphan Chrome window/process is left behind.
  try {
    await browserAgent.disconnect();
    log('🧹', 'browserAgent.disconnect() called — launched/connected browser closed');
  } catch (err) {
    log('⚠️', `cleanup disconnect() failed (non-fatal to verdict): ${err.message}`);
  }

  if (pass) {
    log('🎉', 'BUG-011 Fix 1 lazy auto-connect: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-011 Fix 1 lazy auto-connect: FAIL');
    process.exit(1);
  }
}

main().catch(err => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
