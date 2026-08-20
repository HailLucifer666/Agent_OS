'use strict';

// test/bug-280-hosted-dialog-close.test.js -- BUG-280.
//
// MEASURED LIVE 2026-08-20 on main @ 5cfe91a, node -> pc-child round trip
// (a PowerShell-tool probe is UIPI-blocked and measures nothing):
//
//   launch_app main.cpl  -> Mouse Properties opens, hosted by rundll32 pid 11500
//   list_windows         -> {processName:"rundll32", pid:11500, className:"#32770",
//                            title:"Mouse Properties", hwnd:"3343574", visible:true}
//   (Get-Process -Id 11500).MainWindowHandle -> 0
//   close_window pid=11500 -> ok:false, "PID 11500 (rundll32) has no window to
//                             close, and no windowed rundll32 process was found."
//   list_windows after     -> dialog STILL OPEN, same hwnd.
//
// ROOT CAUSE. MainWindowHandle == 0 was treated as ONE condition with ONE cure.
// It is two conditions needing opposite targets:
//   (a) the pid owns no window at all -- a browser renderer/utility child, or a
//       launcher stub. The right target is a SIBLING process of the same
//       executable. That is BUG-103, and Resolve-WindowedProcessByName is it.
//   (b) the pid owns a real visible top-level window that .NET does not classify
//       as "main". Every rundll32-hosted Control Panel dialog is this shape.
// Handle-CloseWindow assumed (a) unconditionally, so for (b) it hunted for a
// windowed rundll32 sibling that cannot exist -- rundll32 IS the host -- and
// reported "nothing to close" about a dialog sitting on the operator's screen.
//
// NOT the same fix as ui_elements (commit 380e5b3). ui_elements needed no handle
// at all, so its MainWindowHandle guard was simply deleted. close_window needs a
// handle to act on, so it needs a real resolution path, not a deletion.
//
// WHAT THIS FILE PINS. The PowerShell side is not reachable from `node --test`,
// so these are source-shape assertions, same as BUG-122's. They are chosen so the
// broken behaviour cannot come back quietly:
//   - the PID-owned window is resolved BEFORE the name-based sibling search
//     (that ORDER is the whole fix -- reversing it restores the bug),
//   - it is resolved the way list_windows resolves it, so the two commands can
//     never disagree about whether a window exists,
//   - the close is WM_CLOSE to that handle with IsWindow as the oracle,
//   - and every hosted-path failure is still a STRING (BUG-223's convention).
//
// LIVE RE-VERIFIED 2026-08-20 with the fix in place, node -> pc-child:
//   close_window pid=23424 -> ok:true {closed:true, resolvedBy:"owned-top-level",
//                             hwnd:"788408"}, and list_windows no longer lists it.
//   charmap  -> ok:true, resolvedBy:"pid"        (unchanged path)
//   PING pid -> ok:false, "has no window to close, and no windowed PING process
//               was found."                       (BUG-103 refusal, unchanged)
//   Brave, 10 processes: all 9 windowless children resolve to NO top-level window
//   in the same UIA enumeration, so a browser child pid still falls through to
//   the sibling branch exactly as before.

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

// Drop whole-line PowerShell comments. Several assertions below are about what
// the CODE does, and this file's comments deliberately name the wrong-field and
// wrong-oracle traps they exist to prevent.
function codeOnly(text) {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('BUG-280 -- close_window closes a rundll32-hosted Control Panel dialog', () => {
  test('a PID-owned top-level window is resolved BEFORE the name-based sibling search', () => {
    // THE REGRESSION GUARD. Both resolutions are legitimate and both must stay;
    // what makes the difference between a closed dialog and "nothing to close"
    // is which one runs first. The sibling search can only ever find a DIFFERENT
    // process, so asking it first about a self-hosted dialog is guaranteed to
    // miss -- there is no second rundll32 holding that window.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    const owned = body.indexOf('Resolve-TopLevelWindowByPid $TargetPid');
    const sibling = body.indexOf('Resolve-WindowedProcessByName $proc.ProcessName');
    assert.ok(owned > -1, 'close_window must ask whether the pid itself owns a top-level window');
    assert.ok(sibling > -1, 'the BUG-103 sibling fallback must survive -- a browser renderer child still needs it');
    assert.ok(owned < sibling,
      'the pid-owned window must be resolved first; asking the sibling search first is exactly the BUG-280 defect');
  });

  test('the sibling search is a FALLBACK, not an unconditional second attempt', () => {
    // If both ran unconditionally, a hosted dialog would still be closed but a
    // browser child could be resolved twice with the second answer winning.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    const owned = body.indexOf('$owned = Resolve-TopLevelWindowByPid $TargetPid');
    const elseAt = body.indexOf('} else {', owned);
    const sibling = body.indexOf('Resolve-WindowedProcessByName $proc.ProcessName');
    assert.ok(elseAt > owned && elseAt < sibling,
      'the sibling search must sit in the else branch of the owned-window test');
  });

  test('the pid-owned window is found the way list_windows finds it', () => {
    // list_windows reported this dialog while close_window denied it existed.
    // Resolving both from the SAME enumeration is what makes that disagreement
    // impossible; a second Get-Process/MainWindowHandle scan would just relocate
    // the bug, since MainWindowHandle is the field that is wrong here.
    const body = bodyOf('Resolve-TopLevelWindowByPid($TargetPid)');
    assert.match(body, /AutomationElement\]::RootElement/,
      'same UIA desktop enumeration Handle-ListWindows uses');
    assert.match(body, /TreeScope\]::Children/, 'top-level windows only, as list_windows does');
    assert.match(body, /\$child\.Current\.ProcessId -ne \$TargetPid/, 'matched by pid');
    assert.match(body, /\$child\.Current\.NativeWindowHandle/,
      'the native handle is the thing close_window needs and MainWindowHandle does not give');
    // Comments stripped: the comment here NAMES MainWindowHandle to explain why
    // it is not used, and a guard that reads its own rationale as a violation
    // would fail for the wrong reason.
    assert.ok(!/MainWindowHandle/.test(codeOnly(body)),
      'MainWindowHandle is the field that is wrong for a hosted dialog -- re-reading it here would relocate the bug');
  });

  test('the resolver skips a dead element instead of aborting the sweep', () => {
    // Same stale-handle hazard Handle-ListWindows already guards: a window can
    // close between FindAll() and the property reads, and every .Current access
    // on a dead element throws. One dead window must not hide the live one.
    const body = bodyOf('Resolve-TopLevelWindowByPid($TargetPid)');
    assert.match(body, /\} catch \{ continue \}/,
      'a throwing element is skipped, not fatal to the whole enumeration');
  });

  test('an invisible top-level window is only a fallback, never the first choice', () => {
    // close_window is destructive. A zero-size top-level window (minimized, or a
    // hidden tool window) is a weaker match than one the operator can see.
    const body = bodyOf('Resolve-TopLevelWindowByPid($TargetPid)');
    assert.match(body, /visible = \(\$rect\.width -gt 0 -and \$rect\.height -gt 0\)/);
    assert.match(body, /if \(\$hit\.visible\) \{ return \$hit \}/);
    assert.match(body, /if \(-not \$fallback\) \{ \$fallback = \$hit \}/);
  });

  test('the hosted close posts WM_CLOSE to the handle, via a timeout that cannot wedge the adapter', () => {
    // .NET's CloseMainWindow() posts to MainWindowHandle -- the very handle that
    // is zero here -- so it cannot be reused. SendMessageTimeout rather than
    // SendMessage: one modal dialog would otherwise block this single-threaded
    // adapter for the rest of the session.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /\[NativeInput\]::SendMessageTimeout\(\$hostedHwnd, \[NativeInput\]::WM_CLOSE/);
    assert.match(body, /\[NativeInput\]::SMTO_ABORTIFHUNG/,
      'a hung dialog must abort the send, not block the adapter');
    assert.ok(!/\$proc\.CloseMainWindow\(\)[\s\S]*\$hostedHwnd/.test(body),
      'the hosted path must not route through CloseMainWindow, whose handle is zero here');
  });

  test('the oracle is the window handle, not the send call return value', () => {
    // BUG-103's mistake in a new costume: WaitForExit was the wrong oracle for a
    // browser, and SendMessageTimeout's return is the wrong oracle for a dialog.
    // A dialog can acknowledge WM_CLOSE and stay open on a confirmation prompt.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /if \(-not \[NativeInput\]::IsWindow\(\$hostedHwnd\)\) \{/,
      'the window being gone is the only proof it closed');
    const sendAt = body.indexOf('$sent = [NativeInput]::SendMessageTimeout');
    const oracleAt = body.indexOf('IsWindow($hostedHwnd)');
    assert.ok(sendAt > -1 && oracleAt > sendAt,
      'the handle is checked after the send, and a success is only returned from that check');
  });

  test('the honest-failure contract holds on the hosted path too: a failure is a STRING', () => {
    // BUG-223: the dispatcher reads any hashtable as ok:true. A new close route
    // that returned @{closed=$false} would re-open exactly that hole, and
    // BUG-103's comment #3 in this same handler documents the same trap.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    const hosted = body.slice(body.indexOf('if ($hostedHwnd -ne [IntPtr]::Zero) {'),
      body.indexOf('$targetHwnd = ([string]$proc.MainWindowHandle)'));
    assert.ok(hosted.length > 0, 'the hosted path must sit above the CloseMainWindow path');
    assert.match(hosted, /return \('Window ' \+ \$hostedHwndText/,
      'a hosted close that did not close returns a string');
    assert.ok(!/return @\{[^}]*closed = \$false/.test(hosted),
      'never a hashtable for a window that is still open -- that reads as ok:true');
    assert.equal((hosted.match(/Nothing was closed/g) || []).length, 2,
      'both hosted failure branches (never-acknowledged, and still-open) say so plainly');
  });

  test('the hosted path never force-kills', () => {
    // Consistent with BUG-103: closing an app out from under unsaved state is
    // the operators call, not this handlers.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.ok(!/Stop-Process|\.Kill\(\)/.test(body),
      'a refused close is reported, never escalated to a kill');
  });

  test('NativeInput gained the window-message members, without renaming an existing 0x0010', () => {
    // WM_CLOSE is 0x0010 -- a value this class already carries twice, as
    // MOUSEEVENTF_RIGHTUP and SWP_NOACTIVATE. Those are unrelated constants that
    // happen to share a number; reusing either name for a window message would
    // be a real bug wearing a passing test.
    assert.match(ps, /public const uint WM_CLOSE = 0x0010;/);
    assert.match(ps, /public const uint SMTO_ABORTIFHUNG = 0x0002;/);
    assert.match(ps, /public static extern IntPtr SendMessageTimeout\(/);
    assert.match(ps, /public static extern bool IsWindow\(IntPtr hWnd\);/);
    assert.match(ps, /public const uint MOUSEEVENTF_RIGHTUP = 0x0010;/, 'still its own constant');
    assert.match(ps, /public const uint SWP_NOACTIVATE = 0x0010;/, 'still its own constant');
  });

  test('the BUG-103 browser path is untouched', () => {
    // The sibling resolution, the CloseMainWindow call, its polling oracle and
    // its failure string all predate this change and were live-verified for
    // browsers. This change adds a route; it must not re-plumb the working one.
    const body = bodyOf('Handle-CloseWindow($TargetPid)');
    assert.match(body, /\$resolvedBy = 'windowed-sibling'/);
    assert.match(body, /\$targetHwnd = \(\[string\]\$proc\.MainWindowHandle\)/);
    assert.match(body, /\$proc\.CloseMainWindow\(\) \| Out-Null/);
    assert.match(body, /return \('Window for PID/);
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
