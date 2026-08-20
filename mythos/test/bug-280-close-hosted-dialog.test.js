'use strict';

// test/bug-280-close-hosted-dialog.test.js -- BUG-280.
//
// Measured live 2026-08-20. `launch_app main.cpl` opens Mouse Properties, which is
// HOSTED by rundll32: window class #32770, a real hwnd (1443112), visible:true,
// and list_windows saw it without trouble. `close_window` on that pid did not
// close it across three consecutive probe runs -- the same dialog instance stayed
// open the whole time, which is why a probe's slider edits looked like they had
// "persisted" (they had not; HKCU\Control Panel\Mouse was unchanged -- it was one
// long-lived dialog being re-observed).
//
// Root cause: Handle-CloseWindow read `MainWindowHandle == 0` as "this pid owns no
// window" and fell back to Resolve-WindowedProcessByName, which matches on the
// process NAME. For a hosted dialog there is no OTHER windowed rundll32 to find,
// so it answered "has no window to close" while the window was right there, owned
// by that very pid.
//
// MainWindowHandle is a Win32 notion that says nothing about whether a process
// owns a top-level window UIA/EnumWindows can see. This is the same defect class
// as the ui_elements MainWindowHandle guard -- but that one could be DELETED,
// because its lookup was already by ProcessId. close_window genuinely needs a
// handle to act on, so the fix resolves one from the same source list_windows
// reads, and posts WM_CLOSE to it.
//
// PowerShell handlers are not reachable from `node --test`, so these are
// source-shape assertions plus a real parser run. They are deliberately written
// against the INVARIANTS (which source is consulted, in which order, which oracle
// is used) rather than against formatting, because narrow source windows in this
// repo have broken on unrelated comment edits before.

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

describe('BUG-280 -- close_window can close a hosted dialog whose host reports no main window', () => {
  test('NativeInput declares WM_CLOSE and the IsWindow oracle', () => {
    assert.match(ps, /public const uint WM_CLOSE = 0x0010;/,
      'the owned-window route posts WM_CLOSE directly; without the constant it cannot');
    assert.match(ps, /public static extern bool IsWindow\(IntPtr hWnd\);/,
      'the process cannot be asked whether the window went away -- its MainWindowHandle '
      + 'was already zero before the close -- so the handle itself is the only oracle');
  });

  test('Get-OwnedTopLevelWindows reads the same UIA source list_windows reads', () => {
    const body = bodyOf('Get-OwnedTopLevelWindows($TargetPid)');
    assert.match(body, /RootElement\.FindAll/,
      'must enumerate top-level windows, not ask Get-Process for a main window');
    assert.match(body, /ProcessIdProperty/,
      'filtered by ProcessId -- the whole point is that the window belongs to THIS pid');
    assert.match(body, /NativeWindowHandle/,
      'the handle is what close_window needs to act; a match with no handle is useless');
  });

  test('it only offers visible windows with a real handle', () => {
    const body = bodyOf('Get-OwnedTopLevelWindows($TargetPid)');
    assert.match(body, /\$h -eq 0/,
      'a UIA element with no native handle cannot be sent WM_CLOSE');
    assert.match(body, /\$rect\.width -le 0 -or \$rect\.height -le 0/,
      'a zero-size window is the same "visible" test list_windows reports, so the two agree');
  });

  test('its property reads are guarded, and a dead element skips rather than aborting', () => {
    // Handle-ListWindows learned this the hard way: a window can close between
    // FindAll() enumerating it and the .Current reads, and every property access
    // on a stale element throws. One dead window must not blank the enumeration.
    const body = bodyOf('Get-OwnedTopLevelWindows($TargetPid)');
    const readAt = body.indexOf('$h = $child.Current.NativeWindowHandle');
    const catchAt = body.indexOf('} catch { continue }');
    assert.ok(readAt > -1 && catchAt > readAt,
      'the .Current reads must sit inside a try whose catch continues the loop');
  });

  test('a failure to enumerate is not a failure to close -- the fallback still runs', () => {
    const body = bodyOf('Get-OwnedTopLevelWindows($TargetPid)');
    assert.match(body, /return @\(\$found\)/,
      'an array on the way out -- though NOT sufficient on its own, see the unrolling test below');
    assert.match(body, /\} catch \{ \}/,
      'an unreachable UIA root means "no owned windows", which lets close_window fall '
      + 'through to the BUG-103 windowed-sibling path instead of erroring out');
  });

  test('the call site re-wraps the result -- PowerShell unrolls a one-element array', () => {
    // MEASURED LIVE, on the first probe run of this very fix, which is why it is
    // pinned rather than left to a reviewer. A PowerShell function returning a
    // one-element array UNROLLS it: the caller receives the bare hashtable, and
    // `$owned.Count` then counts its KEYS (hwnd/title/className = 3) instead of
    // its elements. So the single-window case -- the entire point of this fix --
    // took the >1 ambiguous-refusal branch and told the operator that rundll32
    // owned 3 visible windows when it owned exactly one. The dialog stayed open,
    // which is indistinguishable from the original bug from the outside.
    //
    // Both halves are asserted because neither is sufficient alone: the callee's
    // @() does not survive its own return, and a caller that trusts it is the bug.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /\$owned = @\(Get-OwnedTopLevelWindows \$TargetPid\)/,
      'without the @() at the CALL SITE, .Count is a key count and the fix inverts');
  });

  test('close_window consults the pid\'s OWN windows before matching on process name', () => {
    // This is the whole fix. Resolve-WindowedProcessByName matches on the
    // executable name, so for a hosted dialog it searches for a second windowed
    // rundll32 that does not exist -- and reports "no window to close" about a
    // window that is visible and owned by the pid it was handed.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    // Anchored on the CALL SITES, not on the names: both functions are also named
    // in this handler's comments, and the BUG-280 comment that explains the fix
    // mentions Resolve-WindowedProcessByName first. Matching prose would have made
    // this assertion fail on a correct implementation.
    const ownedAt = body.indexOf('Get-OwnedTopLevelWindows $TargetPid');
    const siblingAt = body.indexOf('$windowed = Resolve-WindowedProcessByName');
    assert.ok(ownedAt > -1, 'the owned-window lookup must exist');
    assert.ok(siblingAt > -1, 'the BUG-103 windowed-sibling fallback must be kept');
    assert.ok(ownedAt < siblingAt,
      'the owned-window lookup must come FIRST -- reversed, the hosted dialog is still '
      + 'answered by a name match that cannot find it');
  });

  test('the windowed-sibling fallback is reached only when this pid owns no window', () => {
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /\$ownedHwnd -eq \[IntPtr\]::Zero\) \{/,
      'BUG-103\'s browser case must stay reachable, but only when there is genuinely '
      + 'no window of this pid\'s own to act on');
  });

  test('the owned-window route posts WM_CLOSE and does not block on the target', () => {
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /PostMessage\(\$ownedHwnd, \[NativeInput\]::WM_CLOSE/,
      'CloseMainWindow cannot act without a main window; WM_CLOSE to the handle can');
    assert.ok(!/SendMessage/.test(body),
      'SendMessage would block this shell until the target message loop answers -- a '
      + 'dialog raising a confirmation prompt would hang the whole pc-child adapter');
    assert.match(body, /\$proc\.CloseMainWindow\(\) \| Out-Null/,
      'the ordinary route must be untouched for every app that does report a main window');
  });

  test('the owned-window route has its OWN oracle, not the zero-handle one', () => {
    // The trap this test exists for: MainWindowHandle is already zero on this
    // route, so the shared `MainWindowHandle -eq Zero` success test would report
    // closed:true on the first poll without the window having gone anywhere --
    // precisely the false success BUG-103 was about.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    const pollAt = body.indexOf('$proc.Refresh()');
    assert.ok(pollAt > -1, 'the poll loop must still exist');
    const poll = body.slice(pollAt);
    assert.match(poll, /IsWindow\(\$ownedHwnd\)/,
      'the handle no longer existing is the only honest oracle for this route');
    const isWindowAt = poll.indexOf('IsWindow($ownedHwnd)');
    const sharedAt = poll.indexOf('$proc.MainWindowHandle -eq [IntPtr]::Zero');
    assert.ok(isWindowAt > -1 && sharedAt > isWindowAt,
      'the handle check must be tested BEFORE the shared zero-handle branch, or the '
      + 'shared branch answers first and always answers "closed"');
    assert.match(poll, /elseif \(\$proc\.HasExited -or \$proc\.MainWindowHandle -eq \[IntPtr\]::Zero\)/,
      'and the two branches must be exclusive -- elseif, not a second if');
  });

  test('the reply names the handle that was actually closed, not a placeholder 0', () => {
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /if \(\$ownedHwnd -ne \[IntPtr\]::Zero\) \{ \$targetHwnd = \(\[string\]\$ownedHwnd\) \}/,
      'BUG-122 added the hwnd field so a close could be traced to a specific window; '
      + 'on this route $proc.MainWindowHandle is zero by definition and would report "0"');
    assert.match(body, /\$resolvedBy = 'owned-window'/,
      'and resolvedBy must say which route ran, so a live failure is diagnosable');
  });

  test('an ambiguous pid refuses instead of guessing, and refuses as a STRING', () => {
    // close_window is addressed by pid, so a caller has no way to say which of
    // several windows it meant. Picking one would be a wrong-target close of
    // something the operator never mentioned. And per BUG-103/BUG-223 the refusal
    // has to be a string: the dispatcher reads any hashtable as ok:true.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /\$owned\.Count -gt 1/, 'the ambiguous case must be handled explicitly');
    const ambiguousAt = body.indexOf('$owned.Count -gt 1');
    const arm = body.slice(ambiguousAt, ambiguousAt + 1200);
    assert.match(arm, /return \('PID /, 'refusal is a string, never a hashtable');
    assert.match(arm, /Nothing was closed/, 'and says plainly that nothing happened');
    assert.match(arm, /hwnd /, 'naming the candidate handles is what makes it actionable');
  });

  test('the BUG-103 honest-failure contract is still intact', () => {
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /return \('Window for PID/,
      'the timeout branch must still return a string, never a hashtable');
    assert.match(body, /Nothing was closed/);
    assert.ok(!/Stop-Process|\.Kill\(\)/.test(body),
      'no force-kill crept in -- closing an app out from under unsaved state is the '
      + 'operator\'s call, not this handler\'s');
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
