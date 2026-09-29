#!/usr/bin/env node
'use strict';

// verify-window-sensor.js — live verification harness for Phase4/V8b.
//
// V8b: opt-in active-window sensor (src/core/sensors/window-sensor.js). Reads
// the REAL foreground window via pc-child's 'active_window' command (Win32
// GetForegroundWindow / GetWindowText / GetWindowThreadProcessId, added in
// cf3406c) and emits structured perception.window events so the cortex can
// reason about what the operator is focused on. Exhaustively unit-tested in
// test/phase4d-window-sensor.test.js (9 cases, all against a MOCKED pcChild)
// but never live-verified against a real desktop + real pc-child + real WS
// broadcast pipeline.
//
// This script:
//   1. Boots MYTHOS with WINDOW_AWARENESS_ENABLED=true (opt-in — off by
//      default) on an out-of-the-way port.
//   2. Opens a WS 'perception' subscription and starts capturing broadcasts.
//   3. Drives a REAL foreground-window change using a second, independent
//      pc-child driver instance — launches cmd.exe and forces it to the
//      foreground via the exact launch_app / focus_window commands
//      from-pc.js already uses. GetForegroundWindow is desktop-wide, so
//      MYTHOS's own window-sensor observes whatever this driver does.
//   4. Asserts a perception.window event fires whose text names cmd.exe —
//      proof the full pipeline (Win32 API -> ps-automation.ps1 -> pc-child ->
//      window-sensor hash-gate -> bus -> WS broadcast) is real, not mocked.
//   5. Cleans up: closes cmd.exe, shuts down its own pc-child driver, kills
//      the MYTHOS child by PID.
//
// Requirements:
//   - Windows host (pc-child needs powershell.exe + Handle-ActiveWindow)
//   - cmd.exe resolvable via Start-Process (built into every Windows box)
//
// Usage:
//   node scripts/verify-window-sensor.js

const path = require('path');
const { log, bootMythos, killTree, captureEvents } = require('./verify-lib');

const PORT = 4733; // away from default 4478 and other concurrently-running agents
const POLL_MS = 5000; // schema minimum for WINDOW_AWARENESS_POLL_MS (keeps the test short)
const CAPTURE_MS = 26000; // long enough for a baseline poll + the driven-change poll

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  if (process.platform !== 'win32') {
    log('⚠️', 'window-sensor requires Windows (pc-child active_window / GetForegroundWindow). Skipping on ' + process.platform);
    process.exit(0);
  }

  log('🧪', `Phase4/V8b window-sensor verification starting (port=${PORT}, pollMs=${POLL_MS})`);

  let boot;
  try {
    boot = await bootMythos({
      port: PORT,
      env: {
        WINDOW_AWARENESS_ENABLED: 'true',
        WINDOW_AWARENESS_POLL_MS: String(POLL_MS),
      }
    });
  } catch (err) {
    log('❌', `boot failed: ${err.message}`);
    process.exit(1);
  }

  // Second, independent pc-child driver — used ONLY to drive a real
  // foreground-window change. This spawns its own powershell.exe, entirely
  // separate from the MYTHOS boot above; Win32's GetForegroundWindow is
  // desktop-wide, so MYTHOS's window-sensor (polling via ITS OWN pc-child)
  // still observes whatever this driver does to the real foreground window.
  const driver = require(path.join('..', 'adapters', 'pc-child'));
  let targetPid = null;
  let pass = true;

  try {
    const capturePromise = captureEvents(PORT, ['perception'], CAPTURE_MS);

    // Let the sensor's first poll fire (captures whatever window currently
    // has focus as a baseline — not asserted on) before driving the change.
    await sleep(POLL_MS + 2000);

    // NOTE: 'notepad' was tried first but Windows 11's System32\notepad.exe
    // is an AppExecutionAlias stub that hands off to the packaged Notepad
    // app and exits within ~1s — the returned pid was already gone by the
    // time focus_window ran. 'cmd' is a genuine, unaliased Win32 executable
    // (cmd.exe) that stays running with a stable pid, so it drives a real,
    // durable foreground-window change instead.
    log('🖱️', 'driving a real foreground-window change: launching cmd.exe via pc-child...');
    driver.startPcChild();
    let launchRes = null;
    try {
      // B2a: pc-child launches only a resolved record. 'command prompt' is the
      // Start Apps name; plain 'cmd' resolves to whatever else contains it (Git CMD).
      const resolvedCmd = await driver.sendCommand({ cmd: 'resolve_app', name: 'command prompt' });
      launchRes = await driver.sendCommand({ cmd: 'launch_app', name: 'cmd', target: resolvedCmd.result });
    } catch (err) {
      log('❌', `launch_app failed: ${err.message}`);
      pass = false;
    }

    if (launchRes && launchRes.ok) {
      log('✅', `cmd.exe launch requested: ${JSON.stringify(launchRes.result)}`);
      targetPid = (launchRes.result && launchRes.result.pid) || null;
      if (targetPid) {
        try {
          const focusRes = await driver.sendCommand({ cmd: 'focus_window', pid: targetPid });
          if (focusRes && focusRes.ok) {
            log('✅', 'focus_window forced cmd.exe to the foreground');
          } else {
            log('⚠️', `focus_window did not report success: ${JSON.stringify(focusRes)} (cmd.exe may still have taken the foreground on launch)`);
          }
        } catch (err) {
          log('⚠️', `focus_window threw: ${err.message}`);
        }
      } else {
        // On this Windows build 'cmd' resolves via Get-StartApps (Windows
        // Terminal's "Command Prompt" profile) — no per-process pid, but the
        // launch itself takes the foreground, so there's nothing to focus.
        log('ℹ️', 'launch_app resolved via Start-Apps (no per-process pid) — relying on the launch itself to take the foreground');
      }
    } else {
      log('❌', `launch_app did not report success: ${JSON.stringify(launchRes)}`);
      pass = false;
    }

    log('⏳', 'waiting for the window-sensor\'s next poll cycle to observe the change...');
    const events = await capturePromise;

    const windowEvents = events.filter((e) => e.type === 'perception' && e.payload && e.payload.kind === 'window');
    if (windowEvents.length === 0) {
      log('❌', 'NO perception.window events fired at all. Likely causes:');
      log('ℹ️', '  - MYTHOS\'s own pc-child failed to spawn / active_window errored');
      log('ℹ️', '  - WINDOW_AWARENESS_ENABLED did not take effect');
      pass = false;
    } else {
      log('✅', `${windowEvents.length} perception.window event(s) fired total`);
      const cmdEvent = windowEvents.find((e) => String(e.payload.text || '').toLowerCase().includes('cmd'));
      if (cmdEvent) {
        log('✅', `sensor observed the driven focus change: "${cmdEvent.payload.text}"`);
      } else {
        log('❌', `none of the ${windowEvents.length} perception.window event(s) mention cmd.exe — sensor did not observe the driven change.`);
        log('ℹ️', `events seen: ${JSON.stringify(windowEvents.map((e) => e.payload.text))}`);
        pass = false;
      }
    }
  } finally {
    // Cleanup: close the cmd.exe window we opened, shut down our driver, kill
    // MYTHOS by PID. If launch_app didn't hand back a pid (Start-Apps path),
    // look it up via list_windows so the spawned window doesn't linger.
    if (!targetPid) {
      try {
        const listRes = await driver.sendCommand({ cmd: 'list_windows' });
        const win = listRes && listRes.ok && listRes.result && Array.isArray(listRes.result.windows)
          ? listRes.result.windows.find((w) => /cmd/i.test(w.title || '') || /windowsterminal/i.test(w.processName || ''))
          : null;
        if (win) targetPid = win.pid;
      } catch (_) { /* best-effort */ }
    }
    if (targetPid) {
      try { await driver.sendCommand({ cmd: 'close_window', pid: targetPid }); } catch (_) { /* best-effort */ }
    }
    try { driver.shutdownPcChild(); } catch (_) { /* best-effort */ }
    await killTree(boot.child);
  }

  if (pass) {
    log('🎉', 'Phase4/V8b window-sensor: PASS');
    process.exit(0);
  } else {
    log('💀', 'Phase4/V8b window-sensor: FAIL (see above)');
    process.exit(1);
  }
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
