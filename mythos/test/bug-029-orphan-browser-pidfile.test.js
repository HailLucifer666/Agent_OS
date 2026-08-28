'use strict';

// BUG-029 — an orphaned automation Chrome kept playing audio after MYTHOS and the
// browser were both closed: invisible in Task Manager, only recoverable by
// restarting. Severity HIGH. The mitigation shipped 2026-07-17 and was hardened
// 2026-07-19, and measured 2026-08-28 it had **no test of any kind** —
// `grep -rl "browser-agent.pid" test/` returned nothing.
//
// Four pieces have to hold together, and the interesting failure is that three of
// them can rot INDEPENDENTLY and silently:
//
//   1. `launchLocal()` writes the launched PID to `.browser-agent.pid`.
//   2. A clean close/disconnect unlinks it, so a stale PID is not left behind.
//   3. `browser_launch_debug`'s DETACHED spawn does not go through
//      `launchLocal()`, so Phase 3 exposed `recordLaunchedPid(pid)` for it. The
//      effector calls it behind `typeof browserAgent.recordLaunchedPid ===
//      'function'` — which means **renaming or dropping the export turns the call
//      into a silent no-op and the orphan gap reopens with nothing failing.**
//      That guard is why this file asserts the export by name.
//   4. `Start Agent OS.bat` tree-kills the PID it finds — but only after proving
//      provenance from the process command line. That check is the safety half:
//      without it a stale pidfile makes the launcher `taskkill /F /T` an
//      arbitrary PID on the operator's machine.
//
// SOURCE-SHAPE, AND DELIBERATELY SO. `recordLaunchedPid` writes to a real path
// derived from a module constant with no injectable seam, and the file is
// gitignored operator state. Calling it here would overwrite the operator's live
// pidfile — the exact destructive-test pattern BUG-346's wakeword race is the
// standing example of, where a test mutated real gitignored data and destroyed
// it invisibly. Presence and wiring are asserted instead; the behaviour of
// `fs.writeFileSync` is not what can rot.
//
// Run: cd mythos && node --test test/bug-029-orphan-browser-pidfile.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');
const ADAPTER = fs.readFileSync(
  path.join(MYTHOS_ROOT, 'adapters', 'browser-agent', 'index.js'), 'utf8');
const EFFECTOR = fs.readFileSync(
  path.join(MYTHOS_ROOT, 'src', 'core', 'effectors', 'from-browser.js'), 'utf8');
const LAUNCHER = fs.readFileSync(path.join(REPO_ROOT, 'Start Agent OS.bat'), 'utf8');

describe('BUG-029 — the orphan pidfile is written, cleared, and killed safely', () => {
  it('the adapter defines the pidfile path and both writes and unlinks it', () => {
    assert.match(ADAPTER, /BROWSER_PID_FILE\s*=\s*path\.join\(/,
      'the pidfile path must still be a module constant');
    assert.match(ADAPTER, /\.browser-agent\.pid/,
      'the filename the launcher reads must not drift');
    assert.match(ADAPTER, /writeFileSync\(BROWSER_PID_FILE/,
      'a launch must record its PID');
    assert.match(ADAPTER, /unlinkSync\(BROWSER_PID_FILE\)/,
      'a clean close must clear it, or every boot tree-kills a dead PID');
  });

  it('recordLaunchedPid is EXPORTED by that exact name', () => {
    // The load-bearing assertion. The effector's call is guarded by
    // `typeof browserAgent.recordLaunchedPid === 'function'`, so a rename makes
    // it a silent no-op — the orphan gap reopens and nothing anywhere fails.
    const api = require('../adapters/browser-agent/index.js');
    assert.equal(typeof api.recordLaunchedPid, 'function',
      'from-browser.js calls this behind a typeof guard; dropping it fails silently');
  });

  it('browser_launch_debug records the detached child PID', () => {
    // Phase 3's whole point: this spawn bypasses launchLocal(), so without an
    // explicit call the pidfile never covers it.
    assert.match(EFFECTOR, /recordLaunchedPid\(\s*child\.pid\s*\)/,
      'the detached spawn must pin its PID the way launchLocal does');
  });

  it('the launcher proves provenance BEFORE tree-killing', () => {
    // The safety half. A stale or hand-edited pidfile must not make the launcher
    // taskkill /F /T an unrelated process.
    assert.match(LAUNCHER, /\.browser-agent\.pid/, 'the launcher must read the pidfile');
    assert.match(LAUNCHER, /Get-CimInstance\s+Win32_Process/,
      'provenance is read from the real process command line');
    assert.match(LAUNCHER, /PROVENANCE_OK/, 'the provenance flag must still gate the kill');
    for (const token of ['MYTHOS', 'chrome-debug-profile']) {
      assert.ok(LAUNCHER.includes(token),
        `the provenance check must still look for ${token}`);
    }
    // The kill must be INSIDE the affirmative branch. Asserting the tokens exist
    // is not enough — an unconditional taskkill would satisfy that and be the
    // defect. Check the ordering.
    const flag = LAUNCHER.indexOf('if "!PROVENANCE_OK!"=="1"');
    const kill = LAUNCHER.indexOf('taskkill /F /T /PID !ORPHAN_PID!');
    assert.notEqual(flag, -1, 'the provenance branch must exist');
    assert.notEqual(kill, -1, 'the tree-kill must exist');
    assert.ok(kill > flag,
      'the tree-kill must sit inside the provenance-OK branch, never before it');
  });

  it('an unverified PID is skipped, not killed, and says why', () => {
    // The else branch is the operator-protecting half and is easy to delete
    // without any other assertion noticing.
    assert.match(LAUNCHER, /Skipping kill to protect the operator/i,
      'the unverified path must refuse the kill and explain itself');
  });

  it('wmic is not used — it is removed from Windows 11', () => {
    // Recorded in the launcher's own comment. A revert to wmic would make the
    // provenance check silently return nothing, which fails OPEN to "skip",
    // leaving the orphan alive rather than killing the wrong thing — a quiet
    // regression of the original HIGH-severity symptom.
    assert.doesNotMatch(LAUNCHER, /^\s*[^A-Za-z]*wmic\s+process/im,
      'wmic was removed from Windows 11; the check must use Get-CimInstance');
  });
});
