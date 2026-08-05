'use strict';

// test/bug-122-window-close-instrumentation.test.js — BUG-122, instrumentation.
//
// Closing a Brave window was unreliable, and list_windows appeared to report two
// windowed Brave processes for one visible window. Appeared — because nothing in
// either reply could tell two DISTINCT top-level windows apart from two rows
// describing the SAME one. Handle-CloseWindow already has the BUG-103
// windowed-sibling fallback, so the plausible remaining causes are (a) duplicate
// rows for one window, which would make the model pick a phantom pid, or (b) two
// genuinely different windows, which makes the target choice the bug. Those need
// opposite fixes, and no evidence on disk distinguishes them.
//
// So: the native window handle, in both replies. Two rows sharing one hwnd is a
// duplicate to dedupe in list_windows; two rows with different hwnds is a real
// second window and close_window's target selection is what to fix. A failing
// close now names the handle and process it acted on, not just a pid — and a pid
// is exactly the ambiguous thing for a multi-window, multi-process browser.
//
// No dedup is applied yet. That is deliberate: dedupe-by-handle on an unconfirmed
// hypothesis would silently hide a real second window.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const ps = fs.readFileSync(SCRIPT_PATH, 'utf8');

function bodyOf(fnName) {
  const start = ps.indexOf('function ' + fnName);
  assert.ok(start > -1, fnName + ' must exist');
  const rest = ps.slice(start + 1);
  const end = rest.indexOf('\nfunction ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('BUG-122 — list_windows and close_window report the window handle', () => {
  test('every list_windows row carries the native window handle', () => {
    const body = bodyOf('Handle-ListWindows');
    assert.match(body, /NativeWindowHandle/,
      'the handle is the only field that can distinguish a duplicate row from a second window');
    assert.match(body, /hwnd\s*=\s*\(\[string\]\$hwnd\)/,
      'reported as a string — a large HWND must survive the JSON round trip intact');
  });

  test('the handle read is inside the guarded property block, not outside it', () => {
    // A window can close between FindAll() and the property reads; every
    // .Current access on a stale element throws. Reading the handle outside the
    // existing try would abort the whole enumeration for one dead window — the
    // exact failure the guard was added to prevent.
    const body = bodyOf('Handle-ListWindows');
    const guardStart = body.indexOf('$procId = $child.Current.ProcessId');
    const guardEnd = body.indexOf('} catch {', guardStart);
    const handleAt = body.indexOf('$hwnd = $child.Current.NativeWindowHandle');
    assert.ok(handleAt > guardStart && handleAt < guardEnd,
      'the handle read must sit inside the same try that guards the other property reads');
  });

  test('a successful close reports the handle and process it acted on', () => {
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /\$targetHwnd = \(\[string\]\$proc\.MainWindowHandle\)/,
      'the handle must be captured BEFORE CloseMainWindow — afterwards it is zero or gone');
    assert.match(body, /hwnd = \$targetHwnd/, 'and reported in the success reply');
    assert.match(body, /processName = \$targetName/);
  });

  test('a failed close names the handle, the process and how the target was resolved', () => {
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /window handle ' \+ \$targetHwnd/,
      'a failure that names only a pid is exactly what made this unchaseable');
    assert.match(body, /resolved by ' \+ \$resolvedBy/,
      'whether the windowed-sibling fallback fired is half the question');
  });

  test('the honest-failure contract is untouched: a failed close is still a STRING', () => {
    // The dispatcher reads any hashtable as ok:true. BUG-103 fixed a timeout
    // branch that returned one; adding fields to the SUCCESS object must not
    // drift the failure branch back into that shape.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /return \('Window for PID/,
      'the timeout branch must return a string, never a hashtable');
    assert.match(body, /Nothing was closed/);
  });

  test('no dedup was applied on an unconfirmed hypothesis', () => {
    const body = bodyOf('Handle-ListWindows');
    assert.ok(!/Group-Object|Sort-Object -Unique|Select-Object -Unique/.test(body),
      'deduping by handle before the repro would silently hide a real second window');
  });

  test('ps-automation.ps1 still parses (PowerShell parse check)', async () => {
    const errors = await parseCheck(SCRIPT_PATH);
    assert.equal(errors, '', 'PowerShell reported parse errors:\n' + errors);
  });
});

function parseCheck(scriptPath) {
  return new Promise((resolve, reject) => {
    const cmd = '$t=$null;$e=$null;' +
      '[void][System.Management.Automation.Language.Parser]::ParseFile(' +
      "'" + scriptPath.replace(/'/g, "''") + "',[ref]$t,[ref]$e);" +
      'if($e){$e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }}';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve(out.trim()));
  });
}
