'use strict';

// test/update-visible-and-restarts.test.js — "I clicked Restart now, saw a small
// window for a second, and then nothing" (operator, 2026-08-13).
//
// The update had in fact SUCCEEDED. Measured on the machine: MYTHOS.exe carried
// ProductVersion 0.1.9.0 at 04:06, the installer wrote its Start Menu shortcut
// at 04:10 and install-selection.json at 04:14, and logs\main.log recorded
// "auto-update: the update to 0.1.9 completed". Nothing on screen said any of
// that for eight minutes, so it read as a dead app.
//
// Three defects, one symptom:
//
// 1. SILENT MEANS INVISIBLE. beginInstall passed isSilent=true, and /S
//    suppresses every page including the progress bar. The installer window
//    flashes for about a second before NSIS hides it — the "small window" the
//    operator saw — and then a multi-minute install runs with no UI at all.
//
// 2. THE PAGES WERE THE REAL PROBLEM, NOT THE VISIBILITY. Silent was chosen
//    because a non-silent assisted installer showed the full first-install
//    wizard on an update. The template already guards its licence and directory
//    pages with skipPageIfUpdated; this repo's own component page had no guard,
//    and a raw `Page custom` ignores MUI_PAGE_CUSTOMFUNCTION_PRE anyway, so the
//    guard has to be an Abort inside the page function.
//
// 3. THE RELAUNCH CAME UP BEHIND EVERYTHING. NSIS starts the app through
//    StdUtils.ExecShellAsUser, which has no foreground rights, and main.js had
//    no --updated handling and only a bare focus() in second-instance — the
//    same foreground lock that already defeats focus_window in this repo.
//
// main.js requires electron, so it can only be source-shape asserted (the same
// constraint reinstall-asks-again.test.js works under). The behaviour that CAN
// be exercised for real — the in-flight-update peek — is tested through its own
// logic below rather than asserted as a string.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
const NSH = fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8');

describe('1. the update shows a progress bar instead of nothing', () => {
  it('installs non-silently, still forcing the relaunch', () => {
    assert.match(MAIN, /autoUpdater\.quitAndInstall\(false, true\)/,
      'isSilent must be false (the progress bar) and isForceRunAfter true (the relaunch)');
    assert.doesNotMatch(MAIN, /quitAndInstall\(true,/,
      'a silent install is what made an 8-minute update look like a dead app');
  });

  it('the install prompt no longer promises there will be no progress bar', () => {
    assert.doesNotMatch(MAIN, /WITHOUT a progress bar/,
      'the dialog described the old silent behaviour — a stale reassurance is worse than none');
    assert.match(MAIN, /showing a progress bar/, 'say what the operator will actually see');
  });

  it('quotes the measured install time, not a guess', () => {
    // "about half a minute" was wrong by a factor of eighty once already.
    assert.match(MAIN, /took about eight/,
      'the 0.1.9 upgrade took 8 minutes; a wrong ETA is what turns a working update into a dead one');
  });
});

describe('2. no wizard page survives an update', () => {
  it('the component page aborts when the installer was launched by the updater', () => {
    const page = NSH.slice(NSH.indexOf('Function mythosComponentsPage'), NSH.indexOf('FunctionEnd', NSH.indexOf('Function mythosComponentsPage')));
    assert.match(page, /\$\{If\} \$\{isUpdated\}[\s\S]{0,80}Abort/,
      'without this the non-silent update path shows the component page and reads as a reinstall');
  });

  it('the guard runs before the dialog is built, or the page is already on screen', () => {
    const page = NSH.slice(NSH.indexOf('Function mythosComponentsPage'));
    const guard = page.indexOf('${isUpdated}');
    const create = page.indexOf('nsDialogs::Create');
    assert.ok(guard > 0 && create > 0);
    assert.ok(guard < create, 'abort first — creating the dialog and then aborting still flashes a page');
  });

  it('does not rely on skipPageIfUpdated, which a raw Page custom ignores', () => {
    // MUI_PAGE_CUSTOMFUNCTION_PRE only applies to MUI pages. Using the macro
    // here would look correct, compile, and silently do nothing.
    //
    // Directives only — the comment above the guard names the macro on purpose,
    // to explain why it is NOT used, and matching prose would fail on that.
    const directives = NSH.split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith(';'));
    assert.ok(!directives.some((line) => line.startsWith('!insertmacro skipPageIfUpdated')),
      'this page is a `Page custom`; its guard must be the Abort inside the function');
  });
});

describe('3. the window comes back to the front', () => {
  it('raiseWindow pulses alwaysOnTop rather than only calling focus()', () => {
    const fn = MAIN.slice(MAIN.indexOf('function raiseWindow'), MAIN.indexOf('function raiseWindow') + 900);
    assert.match(fn, /setAlwaysOnTop\(true\)/);
    assert.match(fn, /setAlwaysOnTop\(false\)/);
    assert.match(fn, /\.focus\(\)/);
    assert.match(fn, /isMinimized\(\)[\s\S]{0,40}restore\(\)/, 'a minimized window must be restored first');
  });

  it('a post-update launch raises itself', () => {
    assert.match(MAIN, /process\.argv\.includes\('--updated'\)[\s\S]{0,300}raiseWindow\(mainWindow\)/,
      'NSIS starts us via ExecShellAsUser with no foreground rights, so the window opens behind everything');
  });

  it('clicking the shortcut while running raises the existing window', () => {
    // The handler used to be a single `raiseWindow(mainWindow)` call, which this
    // test pinned literally. BUG-225's silent-relaunch half made it resolve a
    // LIVE window first (null or destroyed both mean "nothing to raise", and
    // raiseWindow returns silently on either), so the assertion is on the intent
    // — a real window still gets raised — rather than on the old spelling.
    // electron-second-instance-never-noops.test.js owns the no-window branch.
    const from = MAIN.indexOf("app.on('second-instance'");
    const handler = MAIN.slice(from, MAIN.indexOf('\n  });', from));
    assert.match(handler, /mainWindow && !mainWindow\.isDestroyed\(\)/,
      'the handler must establish that a raisable window exists before raising it');
    assert.match(handler, /raiseWindow\(win\)/,
      'the resolved live window is what gets raised');
    assert.doesNotMatch(handler, /mainWindow\.focus\(\)/,
      'a bare focus() is what the foreground lock denies — that is the "nothing happens" report');
  });

  it('raising can never take the boot down', () => {
    const fn = MAIN.slice(MAIN.indexOf('function raiseWindow'), MAIN.indexOf('function raiseWindow') + 900);
    assert.match(fn, /try \{[\s\S]*catch/, 'a window we cannot raise is still clickable in the taskbar');
  });
});

describe('4. a launch during an install does not fight the installer', () => {
  it('peeks at the attempt marker without clearing it', () => {
    const fn = MAIN.slice(MAIN.indexOf('function updateAttemptInFlight'), MAIN.indexOf('function unfinishedUpdate'));
    assert.ok(fn.length > 0, 'updateAttemptInFlight must exist');
    assert.doesNotMatch(fn, /unlinkSync/,
      'clearing here would consume the report unfinishedUpdate() exists to make');
  });

  it('expires, so a crashed installer cannot lock the operator out forever', () => {
    const fn = MAIN.slice(MAIN.indexOf('const UPDATE_IN_FLIGHT_MS'), MAIN.indexOf('function unfinishedUpdate'));
    assert.match(fn, /UPDATE_IN_FLIGHT_MS = \d+ \* 60 \* 1000/);
    assert.match(fn, /age > UPDATE_IN_FLIGHT_MS[\s\S]{0,40}return null/,
      'a stale marker must read as "no install in flight", never as a permanent block');
  });

  it('treats "already running the target version" as landed, not in flight', () => {
    const fn = MAIN.slice(MAIN.indexOf('function updateAttemptInFlight'), MAIN.indexOf('function unfinishedUpdate'));
    assert.match(fn, /target === app\.getVersion\(\)[\s\S]{0,40}return null/,
      'the post-update relaunch IS the target version — it must never be asked to wait for itself');
  });

  it('asks rather than enforces, and defaults to waiting', () => {
    const block = MAIN.slice(MAIN.indexOf('const inFlight = updateAttemptInFlight()'), MAIN.indexOf("syncVault('--pull')"));
    assert.match(block, /'Wait for it', 'Open anyway'/, 'the operator can always override');
    assert.match(block, /defaultId: 0/, 'waiting is the default');
    assert.match(block, /app\.quit\(\)/);
  });

  it('the check runs before the server child is forked', () => {
    const check = MAIN.indexOf('const inFlight = updateAttemptInFlight()');
    const start = MAIN.indexOf('startChild();', check);
    assert.ok(check > 0 && start > check,
      'booting first would fork a server inside the directory NSIS is renaming');
  });
});
