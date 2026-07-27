#!/usr/bin/env node
'use strict';

// verify-orphan-chrome.js — live verification harness for BUG-029's one
// remaining open question: when a Windows terminal window is closed (the X
// button, NOT Ctrl-C), does MYTHOS's shutdown path actually run, so the
// browser-automation Chrome child process gets torn down instead of
// orphaned invisibly playing audio?
//
// Why this needs a REAL top-level window, not just a spawned process:
// Windows only generates CTRL_CLOSE_EVENT for a console when that console's
// owning window receives an actual close request. There is no supported API
// to synthesize CTRL_CLOSE_EVENT directly: GenerateConsoleCtrlEvent's
// dwCtrlEvent parameter only accepts CTRL_C_EVENT(0)/CTRL_BREAK_EVENT(1) —
// passing CTRL_CLOSE_EVENT(2) fails with ERROR_INVALID_PARAMETER (confirmed
// empirically while building this script, see PROBE_WINDOW_PS below's
// sibling investigation). So the only faithful way to reproduce "user closes
// the terminal window" is to own a real HWND and post WM_CLOSE to it — the
// literal Win32 message the shell sends when you click X.
//
// This script therefore FIRST probes whether the current environment can
// produce a real, closeable top-level window at all. Sandboxed/headless
// automation contexts often cannot: every spawned process (GUI or console)
// comes back with MainWindowHandle=0 and tasklist reports "Window Title:
// N/A" / "Status: Unknown" — there is no window-server surface to close.
// If that probe fails, this reports SKIP with the exact missing
// precondition instead of faking a result. If it succeeds (a human running
// this on a real desktop, or a future non-headless CI runner), it proceeds
// to the full live reproduction: boot MYTHOS in its own console with
// BROWSER_AUTO_LAUNCH enabled (spawns a real debug Chrome ~13s after boot —
// the exact orphan-risk process from BUG-029, via the exact production
// browser_launch_debug() code path), close that console window for real,
// then check whether MYTHOS's shutdown log ran and whether the Chrome
// process survived as an orphan.
//
// Usage: node scripts/verify-orphan-chrome.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');
const { log, MYTHOS_DIR } = require('./verify-lib');

const PID_FILE = path.join(MYTHOS_DIR, '.browser-agent.pid');
const CDP_PORT = 9222;
const PORT_RANGE = { min: 4500, max: 4900 };

function runPS(scriptText, timeoutMs) {
  const tmp = path.join(os.tmpdir(), `verify-orphan-chrome-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, scriptText, 'utf8');
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      timeout: timeoutMs || 8000, windowsHide: true,
    }).toString().trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
  }
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    sock.on('connect', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(true));
  });
}

async function findFreePort() {
  for (let p = PORT_RANGE.min; p <= PORT_RANGE.max; p += 37) {
    if (await checkPortFree(p)) return p;
  }
  throw new Error(`no free port found in ${PORT_RANGE.min}-${PORT_RANGE.max}`);
}

function pollHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true); else setTimeout(tick, 500);
      });
      req.on('error', () => setTimeout(tick, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(tick, 500); });
    };
    tick();
  });
}

// Probe: can this environment produce a real, closeable top-level window?
//
// A naive check (spawn notepad.exe, read Process.MainWindowHandle back from
// the PID Start-Process returned) gives a FALSE NEGATIVE on modern Windows:
// packaged apps (notepad.exe is an app-execution-alias on Windows 11) and
// console apps under the Windows-11 terminal hand-off feature both run as a
// stub/host process that hands off to a DIFFERENT real process — the real
// window belongs to that other process, not the one Start-Process gave us
// (confirmed empirically while building this script). The only reliable
// signal is: did a NEW visible top-level window appear system-wide right
// after we spawned something? Diff EnumWindows before/after.
const WIN32_ENUM_PS = `
Add-Type -Name Win32EnumShared -Namespace VerifyOrphan -MemberDefinition @'
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
function Get-VisibleWindows {
  $r = New-Object System.Collections.Generic.List[string]
  $cb = {
    param($hWnd, $lParam)
    if ([VerifyOrphan.Win32EnumShared]::IsWindowVisible($hWnd)) {
      $procId = 0
      [VerifyOrphan.Win32EnumShared]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
      $sb = New-Object System.Text.StringBuilder 512
      [VerifyOrphan.Win32EnumShared]::GetWindowText($hWnd, $sb, 512) | Out-Null
      $r.Add("$hWnd|$procId|$($sb.ToString())")
    }
    return $true
  }
  [VerifyOrphan.Win32EnumShared]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $r
}
`;

function probeWindowCapability() {
  const out = runPS(`${WIN32_ENUM_PS}
$before = Get-VisibleWindows
$p = Start-Process notepad.exe -PassThru
Start-Sleep -Milliseconds 1200
$after = Get-VisibleWindows
$newOnes = Compare-Object $before $after | Where-Object { $_.SideIndicator -eq "=>" }
foreach ($n in $newOnes) { Write-Output "NEW:$($n.InputObject)" }
try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
foreach ($n in $newOnes) {
  $parts = $n.InputObject -split '\\|', 3
  try { Stop-Process -Id ([int]$parts[1]) -Force -ErrorAction SilentlyContinue } catch {}
}
`, 10000);
  const capable = /^NEW:/m.test(out);
  return { capable, raw: out };
}

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

function processExists(pid) {
  const out = runPS(`
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($p) { Write-Output "ALIVE" } else { Write-Output "GONE" }
`, 6000);
  return out.indexOf('ALIVE') !== -1;
}

function findChildNodePid(parentPid) {
  const out = runPS(`
$c = Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid} AND Name='node.exe'" | Select-Object -First 1 -ExpandProperty ProcessId
if ($c) { Write-Output "PID=$c" }
`, 6000);
  const m = /PID=(\d+)/.exec(out);
  return m ? parseInt(m[1], 10) : null;
}

// Close the console window carrying our unique title — the literal Win32
// message a user's click on the X button sends. Matching by a unique title
// (set via the `title` command when we spawned the launcher) rather than by
// walking process trees is deliberate: on Windows 11 the terminal hand-off
// feature reroutes a plain console spawn into a WindowsTerminal.exe-owned
// window that is NOT a child of the process we spawned (confirmed
// empirically), so PID-based lookups can't find it — and in a machine with
// other concurrent sessions' terminal windows open, anything less precise
// than an exact, unique title risks closing someone else's window.
function closeConsoleWindowByTitle(uniqueTitle) {
  const out = runPS(`${WIN32_ENUM_PS}
Add-Type -Name Win32Post -Namespace VerifyOrphan -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
'@
$windows = Get-VisibleWindows
$match = $windows | Where-Object { $_ -like "*|${uniqueTitle}*" } | Select-Object -First 1
if (-not $match) { Write-Output "NOT_FOUND"; exit }
$hwnd = [IntPtr]([int64]($match -split '\\|')[0])
$WM_CLOSE = 0x0010
$posted = [VerifyOrphan.Win32Post]::PostMessage($hwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output "POSTED=$posted hwnd=$hwnd match=$match"
`, 8000);
  return out;
}

// Synchronous on purpose: Node ties a non-detached spawned child to a job
// object bound to THIS process on Windows, so a fire-and-forget spawn() here
// gets killed by Windows the instant our own process.exit() runs right
// after — before taskkill can finish tearing down the target tree (found
// live while building this script: it left the very Chrome process this
// harness is supposed to clean up still running). execFileSync blocks until
// taskkill is actually done.
function killTreeByPid(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch (_) { /* best-effort — already gone is fine */ }
}

async function main() {
  log('🧪', 'BUG-029 orphan-Chrome-on-terminal-close verification starting');

  if (process.platform !== 'win32') {
    log('⏭️', 'SKIP: this check is specific to Windows console-close signal delivery');
    return process.exit(3);
  }

  log('▶️', 'probing whether this environment can produce a real, closeable top-level window');
  const probe = probeWindowCapability();
  log('ℹ️', `probe result: ${JSON.stringify(probe)}`);
  if (!probe.capable) {
    log('⏭️', 'SKIP: no real interactive window/desktop surface available in this environment — ' +
      'no new visible top-level window appeared anywhere on the system after spawning one. ' +
      'This check requires a human (or a non-headless session) to open MYTHOS, click the X on ' +
      'its terminal window, and confirm no orphan Chrome survives — it cannot be synthesized ' +
      'here because Windows has no API to generate CTRL_CLOSE_EVENT programmatically ' +
      '(GenerateConsoleCtrlEvent rejects it with ERROR_INVALID_PARAMETER; only a real window close ' +
      'request produces it).');
    return process.exit(3);
  }

  const exe = findBrowserExecutable();
  if (!exe) {
    log('⏭️', 'SKIP: no Chrome or Edge installation found — cannot reproduce the orphan-browser scenario without a real browser to launch');
    return process.exit(3);
  }

  const cdpFree = await checkPortFree(CDP_PORT);
  if (!cdpFree) {
    log('⏭️', `SKIP: port ${CDP_PORT} already has a listener — likely a concurrent session's debug browser; cannot cleanly reproduce a fresh launch right now`);
    return process.exit(3);
  }
  if (fs.existsSync(PID_FILE)) {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  }

  const port = await findFreePort();
  const logFile = path.join(os.tmpdir(), `mythos-verify-orphan-chrome-${port}.log`);
  try { fs.unlinkSync(logFile); } catch (_) {}

  log('▶️', `launching MYTHOS in its own console (port ${port}), BROWSER_AUTO_LAUNCH enabled`);

  // Launch via PowerShell's Start-Process, NOT Node's own child_process.spawn
  // ('cmd.exe', ...) — the latter silently produced no process at all when
  // driven from this harness's own execution context (confirmed empirically
  // while building this script: no error, no log file, no window, nothing).
  // Start-Process is also simply the standard, correct way to launch a new
  // console-owning process on Windows. `title` sets a token unique to this
  // run so we can find and close exactly this window later without ever
  // touching another concurrent session's terminal. BROWSER_AUTO_LAUNCH_
  // DELAY_MS must exceed browser-agent's own CONNECT_TIMEOUT_MS (10s) —
  // shorter values race the boot-time CDP connect attempt and the
  // auto-launch silently joins that (failing) attempt instead of actually
  // spawning Chrome (also confirmed empirically).
  const titleToken = `VERIFY-BUG029-${Date.now()}`;
  const launchScript = `
$env:MYTHOS_PORT = "${port}"
$env:MYTHOS_BIND = "127.0.0.1"
$env:BOOT_GREETING = "false"
$env:BROWSER_AUTOMATION = "true"
$env:BROWSER_AUTO_LAUNCH = "true"
$env:BROWSER_AUTO_LAUNCH_DELAY_MS = "13000"
$cmdArg = 'title ${titleToken} & node src\\main.js > "${logFile}" 2>&1'
$p = Start-Process -FilePath cmd.exe -ArgumentList @('/c', $cmdArg) -WorkingDirectory "${MYTHOS_DIR}" -PassThru
Write-Output "CMDPID=$($p.Id)"
`;
  const launchOut = runPS(launchScript, 8000);
  const cmdPidMatch = /CMDPID=(\d+)/.exec(launchOut);
  if (!cmdPidMatch) throw new Error(`failed to launch MYTHOS via Start-Process: ${launchOut}`);
  const cmdPid = parseInt(cmdPidMatch[1], 10);
  log('ℹ️', `launcher (cmd.exe) pid=${cmdPid}, window title token=${titleToken}`);

  let verdict = null;
  let evidence = [];
  let nodePid = null;
  let launchedChromePid = null;

  // NOTE: every early-exit path below THROWS instead of using a bare
  // `return` — a `return` inside this try would resolve the whole async
  // main() function once `finally` completes, skipping the verdict-logging
  // and process.exit() code that follows this try/catch/finally block
  // entirely (a real bug caught by running this script and noticing it
  // exited 0 with no verdict ever printed). Throwing keeps control inside
  // this same catch, which falls through normally afterward.
  try {
    const booted = await pollHealth(port, 30000);
    if (!booted) throw new Error('MYTHOS never answered /health within 30s');
    log('✅', 'MYTHOS booted');
    nodePid = findChildNodePid(cmdPid);
    log('ℹ️', `resolved node.exe pid under launcher: ${nodePid}`);

    // Wait for BROWSER_AUTO_LAUNCH's timer (13s, set above) + Chrome
    // cold-start + CDP connect, then confirm the pidfile (BUG-029's own
    // tracking mechanism).
    const pidDeadline = Date.now() + 28000;
    while (Date.now() < pidDeadline && !fs.existsSync(PID_FILE)) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!fs.existsSync(PID_FILE)) {
      throw new Error('BROWSER_AUTO_LAUNCH never wrote .browser-agent.pid within 28s — auto-launch did not fire or failed; log tail: ' +
        (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-1500) : '(no log)'));
    }
    launchedChromePid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    log('✅', `.browser-agent.pid written: ${launchedChromePid}`);
    if (!processExists(launchedChromePid)) {
      throw new Error(`pidfile PID ${launchedChromePid} is not a live process right after launch — cannot proceed`);
    }
    log('✅', `confirmed PID ${launchedChromePid} is a live process (the launched debug browser)`);

    // The real action: close the console window exactly as a user would.
    log('▶️', `closing the console window titled "${titleToken}" (simulates clicking X)`);
    const closeResult = closeConsoleWindowByTitle(titleToken);
    log('ℹ️', `closeConsoleWindowByTitle result: ${closeResult}`);
    if (closeResult.indexOf('POSTED=True') === -1) {
      throw new Error(`could not post WM_CLOSE to the launcher's console window: ${closeResult}`);
    }

    // Give Windows its real grace period (it allows ~5-10s before force-
    // terminating an unresponsive console app) plus margin, then check what
    // actually happened.
    await new Promise((r) => setTimeout(r, 15000));

    const cmdGone = !processExists(cmdPid);
    const nodeGone = nodePid ? !processExists(nodePid) : null;
    const chromeGone = !processExists(launchedChromePid);
    const logTail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const sawShutdownSignal = /lifecycle\.signal/.test(logTail);

    evidence.push(`15s after WM_CLOSE: launcher(cmd) gone=${cmdGone}, node gone=${nodeGone}, chrome gone=${chromeGone}, shutdown-signal-logged=${sawShutdownSignal}`);
    log('ℹ️', evidence[evidence.length - 1]);

    if (!chromeGone) {
      verdict = 'FAIL';
      evidence.push('Chrome (the browser-automation child process) SURVIVED after the console window was closed — exactly the BUG-029 orphan scenario. ' +
        (sawShutdownSignal ? '' : 'MYTHOS never logged a lifecycle.signal shutdown step, confirming SIGINT/SIGTERM (the only signals main.js listens for) did not fire on window close.'));
    } else {
      verdict = 'PASS';
      evidence.push('Chrome terminated along with MYTHOS after the console window was closed — no orphan.' +
        (sawShutdownSignal ? ' MYTHOS logged a lifecycle.signal shutdown step, so the graceful path ran.' : ' No lifecycle.signal was logged, so this happened via some other OS-level cleanup, not the graceful shutdown path — still no orphan, so PASS on the observable behavior.'));
    }
  } catch (err) {
    verdict = 'FAIL';
    evidence.push(`harness error: ${err.message}`);
  } finally {
    log('🧹', 'cleaning up any surviving processes from this test run');
    if (launchedChromePid) killTreeByPid(launchedChromePid);
    if (nodePid) killTreeByPid(nodePid);
    if (cmdPid) killTreeByPid(cmdPid);
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    try { fs.unlinkSync(logFile); } catch (_) {}
  }

  log(verdict === 'PASS' ? '🎉' : '💀', `BUG-029 orphan-Chrome-on-terminal-close: ${verdict}\n${evidence.join('\n')}`);
  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  log('💥', `harness crashed: ${err.stack || err.message}`);
  process.exit(2);
});
