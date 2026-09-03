'use strict';

// browser-process.js — the two questions playwright cannot answer about a
// browser MYTHOS launched: "is it still running?" and "which one is it?".
//
// BUG-409, reproduced live 2026-09-03 on a spawned Brave (pid 13152, port 9223):
//
//     after 3s                    : pid alive = true , port owner = 13152
//     after browser.close()       : pid alive = TRUE , port owner = 13152   <-- the bug
//     after CDP Browser.close     : pid alive = false, port owner = (none)
//
// playwright-core's own types say why, verbatim: "In case this browser is
// obtained using browserType.launch(), closes the browser and all of its
// pages. In case this browser is CONNECTED TO, clears all created contexts
// belonging to this browser and DISCONNECTS FROM THE BROWSER SERVER."
//
// browser_launch_debug spawns the browser itself and then attaches over CDP, so
// `launched` in index.js is false for it and disconnect() always took the
// connected-to branch. browser_switch called that and then launched the next
// browser onto a port the old one was still holding — which is how "sometimes
// two or three browsers open at once" and "it opened YouTube but could not act
// on it" are the same defect: the new window is visible, the CDP session is
// attached to the old one.
//
// SO WHY NOT JUST SEND CDP Browser.close AND BE DONE. Because measured 4/4 on
// cold profiles, IT RESOLVES AND THE BROWSER SURVIVES:
//
//     warm profile, chrome x3  close=resolved  survivors: none
//     warm profile, brave  x3  close=resolved  survivors: none
//     cold profile, chrome x2  close=resolved  survivors: chrome.exe   <-- here
//     cold profile, brave  x2  close=resolved  survivors: none
//
// A first-run Chrome sits on `chrome://intro/default-browser` — its own
// make-me-default flow — and that flow outlives Browser.close while the command
// still reports success. That is /kee class 15 (a resolved call standing in for
// a multi-way outcome) and it is why this module VERIFIES and then ESCALATES
// instead of trusting the ack. `method` on the result says which one worked, so
// a survivor is never reported as a clean close.
//
// THE AUTHORISATION IS THE PROFILE DIRECTORY, AND IT IS STRUCTURAL.
// Nothing here accepts a pid from a caller. Every pid this module can kill was
// produced by asking Windows which top-level process carries a --user-data-dir
// under `%LOCALAPPDATA%\MYTHOS\*-debug-profile`, and isMythosDebugProfile()
// refuses anything else — including the empty string, whose `-like '**'` would
// otherwise match every process on the machine. The operator's real browser
// keeps its profile somewhere else entirely, so it cannot be named by this
// query, let alone killed by it. Making the bad state unrepresentable beats
// checking for it.

const { execFileSync } = require('child_process');
const path = require('path');

const CLOSE_POLL_INTERVAL_MS = 400;
const CLOSE_VERIFY_CEILING_MS = 6000;
const PS_TIMEOUT_MS = 15000;

// Structural authorisation. Deliberately strict on all three parts —
// absolute-ish path, the MYTHOS folder, and the -debug-profile leaf — because
// this predicate is the only thing standing between a profile-scoped query and
// a machine-wide one. `browser-target.js` builds exactly these paths; a test
// pins the two together so the shape cannot drift apart silently.
function isMythosDebugProfile(dir) {
  const s = typeof dir === 'string' ? dir.trim() : '';
  if (s.length < 8) return false;
  if (/[*?"<>|]/.test(s)) return false; // no wildcards can reach the -like filter
  const norm = s.replace(/\//g, path.sep);
  const parts = norm.split(path.sep).filter(Boolean);
  if (parts.length < 3) return false;
  const leaf = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return parent === 'MYTHOS' && /-debug-profile$/.test(leaf);
}

function runPowerShell(script, deps) {
  const exec = (deps && deps.execFileSync) || execFileSync;
  try {
    return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: PS_TIMEOUT_MS, windowsHide: true }).toString().trim();
  } catch (_) {
    // Absent/blocked PowerShell, or a timeout, is reported as "could not tell"
    // by every caller below rather than as "nothing is running" — the
    // fail-closed direction, since the fail-open reading is what lets a
    // survivor be reported as a clean close.
    return null;
  }
}

// Parses the one line shape every query here emits: "<pid>=<name>". Pure, and
// tolerant: an unexpected line is skipped rather than turned into a pid of NaN
// (a NaN pid reaching taskkill would be a very bad kind of surprise).
function parseProcessRows(out) {
  if (typeof out !== 'string' || !out.trim()) return [];
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)=(.*)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, name: m[2].trim() });
  }
  return rows;
}

// Top-level browser processes carrying this profile dir. `--type=` is excluded
// because every renderer/gpu/utility child also inherits --user-data-dir on its
// command line — the same distinguishing signal findChromePidByUserDataDir in
// index.js already relies on, and the reason it is a WHERE clause rather than a
// process-name list (this one works for brave.exe, which that older query never
// covered).
//
// null means "could not determine", [] means "none running". The caller must
// not collapse those: one is ignorance, the other is a fact.
function processesForProfile(profileDir, deps) {
  if (!isMythosDebugProfile(profileDir)) return [];
  const esc = String(profileDir).replace(/'/g, "''");
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*"
    + esc + "*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { \"$($_.ProcessId)=$($_.Name)\" }";
  const out = runPowerShell(script, deps);
  if (out === null) return null;
  return parseProcessRows(out);
}

// BUG-410: which browser is ACTUALLY behind the debug port. Over CDP, Brave
// reports a plain `Chrome/<version>` product string on purpose, so no protocol
// probe can tell them apart — measured 2026-09-03, a Brave on the port answered
// Browser.getVersion with product "Chrome/152.0.7977.65". The listening
// process's executable path can, and does.
//
// Returns { pid, exe } or null when it cannot be determined.
function processOnPort(port, deps) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
  const script = '$c = Get-NetTCPConnection -LocalPort ' + p
    + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; '
    + 'if ($c) { $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; '
    + 'if ($pr) { "$($c.OwningProcess)=$($pr.Path)" } }';
  const out = runPowerShell(script, deps);
  if (out === null) return null;
  const rows = parseProcessRows(out);
  if (!rows.length) return null;
  return { pid: rows[0].pid, exe: rows[0].name };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Only ever called with a pid this module itself resolved from a MYTHOS debug
// profile. /T so the renderer children go with it: a browser whose top-level
// process is killed alone leaves orphaned renderers holding the profile lock,
// and the NEXT launch then fails in a way that looks nothing like this one.
function killProcess(pid, deps) {
  const exec = (deps && deps.execFileSync) || execFileSync;
  try {
    exec('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true });
    return true;
  } catch (_) {
    return false;
  }
}

// Close the browser MYTHOS launched into `profileDir`, and PROVE it closed.
//
//   1. ask it to close over CDP (graceful — it flushes its own session state);
//   2. poll the profile-scoped process query until it is gone;
//   3. if it survives the ceiling, kill the pids that query returned;
//   4. report which step worked, and report survivors as survivors.
//
// `sendClose` is injected (index.js supplies the live CDP session) so this
// module never touches playwright and node:test can drive every branch,
// including the one that matters most: the close that resolves and does
// nothing.
//
// Returns { closed, method: 'cdp'|'kill'|'none'|'refused'|'unknown',
//           survivors: [{pid,name}], reason }.
async function closeDebugBrowser(opts) {
  const o = opts || {};
  const profileDir = o.profileDir;
  const deps = o.deps || {};
  const wait = deps.sleep || sleep;
  const ceiling = Number.isFinite(deps.ceilingMs) ? deps.ceilingMs : CLOSE_VERIFY_CEILING_MS;
  const interval = Number.isFinite(deps.intervalMs) ? deps.intervalMs : CLOSE_POLL_INTERVAL_MS;
  const list = deps.processesForProfile || processesForProfile;
  const kill = deps.killProcess || killProcess;

  if (!isMythosDebugProfile(profileDir)) {
    return {
      closed: false,
      method: 'refused',
      survivors: [],
      reason: 'refusing to close by profile directory: ' + JSON.stringify(String(profileDir || ''))
        + ' is not a MYTHOS debug profile, and a profile-scoped kill is the only kind this is allowed to do',
    };
  }

  // ATTACKING THIS FIX BEFORE SHIPPING IT (2026-09-03). The first draft went
  // straight to sendClose and then polled for survivors, so an EMPTY survivor
  // list meant "closed" — including when the list was empty because nothing was
  // ever there. That is the fail-open reading, and it had a live caller: the
  // operator can start their own Chrome with --remote-debugging-port on their
  // REAL profile, MYTHOS attaches to it, and browser_switch would then have
  // reported a clean close of a browser it never touched and launched a second
  // one onto a port the first was still holding — i.e. it would have rebuilt
  // BUG-409 through the fix for BUG-409. Look FIRST, so "nothing of ours is
  // running here" is its own answer.
  const before = list(profileDir, deps);
  if (before !== null && !before.length) {
    return {
      closed: false,
      method: 'not-ours',
      survivors: [],
      reason: 'no browser is running on ' + profileDir + ', so whatever holds the debug port is not one MYTHOS launched'
        + ' — it cannot be closed from here, and closing it would be closing someone else\'s window',
    };
  }

  let cdpError = null;
  if (typeof o.sendClose === 'function') {
    try { await o.sendClose(); } catch (err) { cdpError = (err && err.message) || String(err); }
  } else {
    cdpError = 'no CDP session was available to ask';
  }

  // Verify. The ack is not the evidence — the process table is.
  const deadline = Date.now() + ceiling;
  let survivors = list(profileDir, deps);
  while (survivors !== null && survivors.length && Date.now() < deadline) {
    await wait(interval);
    survivors = list(profileDir, deps);
  }

  if (survivors === null) {
    // Could not read the process table. Do NOT report a clean close: the CDP
    // ack alone is exactly the evidence measured to be wrong on cold profiles.
    return {
      closed: false,
      method: 'unknown',
      survivors: [],
      reason: 'asked the browser to close but could not verify it exited (the process list could not be read)'
        + (cdpError ? ' — the close itself reported: ' + cdpError : ''),
    };
  }

  if (!survivors.length) {
    return { closed: true, method: 'cdp', survivors: [], reason: null };
  }

  // Escalate. This is the cold-profile Chrome case: close resolved, intro flow
  // still holding the process open.
  const killed = [];
  for (const proc of survivors) {
    if (kill(proc.pid, deps)) killed.push(proc);
  }
  await wait(interval);
  const remaining = list(profileDir, deps) || [];
  if (!remaining.length) {
    return {
      closed: true,
      method: 'kill',
      survivors: [],
      reason: 'the browser acknowledged the close but stayed running (a first-run profile does this), so it was terminated: '
        + killed.map((p) => p.name + ' pid ' + p.pid).join(', '),
    };
  }
  return {
    closed: false,
    method: 'none',
    survivors: remaining,
    reason: 'the browser did not close and could not be terminated: '
      + remaining.map((p) => p.name + ' pid ' + p.pid).join(', '),
  };
}


// BUG-410: the two halves of one answer, kept together. processOnPort says
// WHICH PROCESS owns the debug port; this says which BROWSER that is. Returns a
// name or null, and null means "could not tell" — never "no mismatch". Moved
// here from from-browser.js during the BUG-410 self-review: it was one file
// away from its own data source, and from-browser.js is at its size ceiling.
//
// Non-throwing by contract: it runs on the launch path, so a failure to
// identify must degrade to "assumed", never fail the launch.
function identifyBrowserOnPort(cdpUrl, deps) {
  try {
    const port = Number(new URL(String(cdpUrl)).port);
    if (!Number.isInteger(port) || port <= 0) return null;
    const owner = (deps && deps.processOnPort ? deps.processOnPort : processOnPort)(port, deps);
    if (!owner || !owner.exe) return null;
    // browser-target.js owns exe -> name, derived from BROWSER_SUBPATHS. Required
    // lazily so this module stays cheap to require from the adapter index.
    return require('../../src/core/effectors/browser-target').identifyBrowserByExecutable(owner.exe);
  } catch (_) {
    return null;
  }
}
module.exports = {
  isMythosDebugProfile,
  identifyBrowserOnPort,
  parseProcessRows,
  processesForProfile,
  processOnPort,
  killProcess,
  closeDebugBrowser,
  CLOSE_POLL_INTERVAL_MS,
  CLOSE_VERIFY_CEILING_MS,
};
