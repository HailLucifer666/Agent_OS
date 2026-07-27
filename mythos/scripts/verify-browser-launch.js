#!/usr/bin/env node
'use strict';

// verify-browser-launch.js — live verification harness for BUG-011's
// remaining unverified piece: on-demand browser launch.
//
// Context: BUG-011 has two fixes. Fix 2 (param aliasing on browser_evaluate)
// and Fix 1 (lazy CDP auto-connect when a debug browser is ALREADY running)
// are both verified elsewhere. The one thing deliberately left untested was
// the on-demand LAUNCH path — browser_launch_debug spinning up a brand-new
// Chrome/Edge process when nothing is running — because until BUG-029's
// pidfile mitigation existed (and was later confirmed, 2026-07-24, to
// actually write the file), that path risked creating an orphaned Chrome
// process with no cleanup mechanism. That mitigation has since shipped and
// been hardened, so this script exercises the launch path directly for real.
//
// What it checks, against the REAL production code path (the exact
// browser_launch_debug function wired into the effectors hub via
// registerFromBrowser in src/main.js):
//   1. With no debug Chrome already listening on the CDP port, invoking
//      browser_launch_debug() spawns a genuine OS process and reports
//      { ok:true, result:{ launched:true } }.
//   2. mythos/.browser-agent.pid is written with that process's real PID
//      (the BUG-029 orphan-prevention mechanism).
//   3. The PID resolves to a real chrome.exe/msedge.exe process carrying the
//      expected --remote-debugging-port=9222 and chrome-debug-profile
//      flags (the same provenance check "Start Agent OS.bat" itself uses
//      before it will tree-kill a PID).
//   4. The adapter singleton reports state ONLINE and can actually drive a
//      page (navigate + read back a title) — proving the launch produced a
//      controllable browser, not just an orphaned process.
//
// Cleanup: disconnects the adapter AND force-kills the specific PID we
// recorded, so this script never leaves a stray Chrome process behind for
// concurrent sessions on the same machine.
//
// Usage:
//   node scripts/verify-browser-launch.js

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { log } = require('./verify-lib');

const MYTHOS_DIR = path.join(__dirname, '..');
const PID_FILE = path.join(MYTHOS_DIR, '.browser-agent.pid');
const CDP_PORT = 9222;

function checkPortFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    sock.on('connect', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(true));
  });
}

function getProcessInfo(pid) {
  try {
    const psCmd = `$p = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} }; if ($p) { Write-Output ($p.Name + '|' + $p.CommandLine) } else { Write-Output 'NOTFOUND' }`;
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { timeout: 5000, windowsHide: true }).toString().trim();
  } catch (_) {
    return null;
  }
}

function killPid(pid) {
  return new Promise((resolve) => {
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('close', () => resolve());
      k.on('error', () => resolve());
    } catch (_) { resolve(); }
  });
}

async function main() {
  log('🧪', 'BUG-011 on-demand browser launch verification starting');

  if (process.platform !== 'win32') {
    log('⏭️', 'SKIP: this harness relies on Windows-only process introspection (Win32_Process/taskkill)');
    process.exit(3);
  }

  // Precondition: the CDP port must be free before we start. If something is
  // already listening (e.g. a concurrent session's debug browser), we cannot
  // cleanly prove the LAUNCH path — browser_launch_debug would just report
  // {alreadyOnline:true} or, worse, our connect could latch onto someone
  // else's browser. Bail out honestly instead of risking a false PASS.
  const portFreeBefore = await checkPortFree(CDP_PORT);
  if (!portFreeBefore) {
    log('⏭️', `SKIP: port ${CDP_PORT} already has a listener — cannot cleanly exercise a fresh on-demand launch right now (likely a concurrent session's debug browser)`);
    process.exit(3);
  }
  if (fs.existsSync(PID_FILE)) {
    log('⚠️', 'stale .browser-agent.pid found before test — removing so this run\'s write is unambiguous');
    try { fs.unlinkSync(PID_FILE); } catch (_) { /* best-effort */ }
  }

  // Load the REAL production effector — the exact function registerFromBrowser
  // wires into the effectors hub in src/main.js. Side-effect-free at require
  // time; nothing launches or connects until we call it below.
  const fromBrowser = require('../src/core/effectors/from-browser');
  const browserAgent = require('../adapters/browser-agent');

  let pass = true;
  let launchedPid = null;

  try {
    log('▶️', 'invoking browser_launch_debug() — the on-demand launch tool');
    const result = await fromBrowser.browser_launch_debug();
    log('ℹ️', `result: ${JSON.stringify(result)}`);

    if (!result || result.ok !== true || !result.result || result.result.launched !== true) {
      log('❌', `browser_launch_debug did not report a fresh launch: ${JSON.stringify(result)}`);
      pass = false;
    } else {
      log('✅', `browser_launch_debug reports launched:true, mode:${result.result.mode}`);
    }

    // 1. Pidfile assertion (BUG-029 orphan-prevention mechanism)
    if (!fs.existsSync(PID_FILE)) {
      log('❌', '.browser-agent.pid was NOT written');
      pass = false;
    } else {
      const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
      launchedPid = parseInt(raw, 10);
      if (!Number.isInteger(launchedPid) || launchedPid <= 0) {
        log('❌', `.browser-agent.pid contains invalid content: "${raw}"`);
        pass = false;
      } else {
        log('✅', `.browser-agent.pid written with PID ${launchedPid}`);
      }
    }

    // 2. OS-level process provenance — same check Start Agent OS.bat performs
    // before it will tree-kill a PID: real chrome.exe/msedge.exe, carrying
    // our debug flags.
    if (launchedPid) {
      const info = getProcessInfo(launchedPid);
      log('ℹ️', `OS process info for PID ${launchedPid}: ${info}`);
      const looksRight = !!info && /chrome\.exe|msedge\.exe/i.test(info) &&
        /remote-debugging-port=9222/i.test(info) && /chrome-debug-profile/i.test(info);
      if (!looksRight) {
        log('❌', `PID ${launchedPid} does not look like our spawned debug browser (missing expected process name/flags)`);
        pass = false;
      } else {
        log('✅', `PID ${launchedPid} confirmed as a real chrome.exe/msedge.exe process with --remote-debugging-port=9222 + chrome-debug-profile`);
      }
    }

    // 3. Adapter state + functional check — the launch produced a genuinely
    // controllable browser, not just an orphaned process.
    const status = browserAgent.getStatus();
    log('ℹ️', `browserAgent.getStatus(): ${JSON.stringify(status)}`);
    if (status.state !== 'ONLINE') {
      log('❌', `browserAgent reports state=${status.state}, expected ONLINE`);
      pass = false;
    } else {
      log('✅', `browserAgent.getStatus().state === ONLINE (mode=${status.mode})`);
    }

    try {
      const title = await browserAgent.withPage(async (page) => {
        await page.goto('data:text/html,<title>bug-011-verify</title>', { waitUntil: 'domcontentloaded' });
        return page.title();
      });
      if (title === 'bug-011-verify') {
        log('✅', `functional check: navigated a real page and read back its title ("${title}")`);
      } else {
        log('❌', `functional check: unexpected page title "${title}"`);
        pass = false;
      }
    } catch (err) {
      log('❌', `functional check failed: ${err.message}`);
      pass = false;
    }
  } catch (err) {
    log('❌', `browser_launch_debug threw: ${err.stack || err.message}`);
    pass = false;
  } finally {
    // Cleanup — never leave an orphaned browser behind for concurrent sessions.
    log('🧹', 'cleaning up: disconnecting adapter + force-killing the PID we spawned');
    try { await browserAgent.disconnect(); } catch (_) { /* best-effort */ }
    if (launchedPid) {
      await killPid(launchedPid);
      log('🧹', `taskkill issued for PID ${launchedPid}`);
    }
    // disconnect()'s CDP-mode branch (browser truthy, launched false) does
    // NOT clear the pidfile — only the launchLocal/context branch does.
    // Remove it ourselves so we don't leave stale state for other concurrent
    // verification runs (out of scope to fix here; just tidying our own
    // test's footprint).
    try { fs.unlinkSync(PID_FILE); } catch (_) { /* already gone */ }
  }

  if (pass) {
    log('🎉', 'BUG-011 on-demand browser launch: PASS');
    process.exit(0);
  } else {
    log('💀', 'BUG-011 on-demand browser launch: FAIL');
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
