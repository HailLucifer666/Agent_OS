'use strict';

// test/electron-update-handoff.test.js — what electron/main.js must do in the
// seconds before it hands the machine to the NSIS installer, and what it must
// leave behind if that installer never finishes.
//
// WHY THIS FILE EXISTS (operator, 2026-08-13): the 0.1.7 in-app update was
// accepted and the app never came back — white icon, dead double-click, 40+
// minutes. Nothing was corrupt. The installer was deleting ~17.6k files of
// in-tree Hermes venv before it could extract the new payload, with no window,
// no progress bar, and a main process whose log() wrote to a stderr pipe that
// nobody reads in a GUI launch. Three properties came out of that, and all three
// fail SILENTLY, which is why they are pinned here:
//
//   1. log() must reach a file. Diagnosing the above from file timestamps is not
//      a debugging strategy.
//   2. the tools rename must happen BEFORE quitAndInstall(). Order is the entire
//      point — after the handover there is no process left to do it.
//   3. that rename must be inside a try/catch. It crosses volumes on a real
//      operator layout (install on D:, userData on C:) and throws EXDEV there;
//      an optimisation must never be able to block an update.
//
// Source-shape assertions, in the style of test/electron-vault-sync-wiring.test.js:
// root CLAUDE.md establishes these as the only automated guard available for
// main.js, because unit tests inject fakes and are therefore blind to both load
// order and call order, and a green suite cannot tell you the app boots.
//
// Run: cd mythos && node --test test/electron-update-handoff.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readMainJs() {
  return fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');
}

// Strip `//` line comments before looking for CALLS. The prose in this area is
// dense and says things like "before quitAndInstall" in several places, so a
// naive indexOf finds the comment and reports the order backwards. This repo has
// that bug shape on record more than once (electron-vault-sync-wiring.test.js
// carries the same guard; a `/api/*` inside a `//` comment once blanked a whole
// file for a scanner). A source-shape assertion has to look at code.
function codeOnly(text) {
  return text.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('log() writes to a file under userData, not stderr alone', () => {
  const code = codeOnly(readMainJs());
  const body = code.slice(code.indexOf('function log('), code.indexOf('function safeStringify('));

  assert.ok(/process\.stderr\.write/.test(body),
    'log() must keep writing to stderr — `npm start` from a terminal depends on it');
  assert.ok(/appendFileSync/.test(body),
    'log() must APPEND to a file: a GUI launch writes stderr to a pipe nobody reads, which is '
    + 'why a dying main process used to leave no evidence at all');

  // The file has to be somewhere that survives an update and needs no elevation.
  assert.ok(/getPath\('userData'\)/.test(code.slice(code.indexOf('function mainLogFile('), code.indexOf('function log('))),
    'the log file must live under app.getPath(\'userData\') — the install tree is replaced by every update');
  assert.ok(/main\.log/.test(code), 'the log file is <userData>/logs/main.log');
});

test('the main log is size-capped, so it cannot grow without bound', () => {
  const code = codeOnly(readMainJs());
  assert.ok(/MAIN_LOG_MAX_BYTES/.test(code), 'a cap constant must exist');
  assert.ok(/truncateSync/.test(code),
    'capped by truncation deliberately — one file, no rotation machinery to go wrong');
});

test('logging can never take the app down', () => {
  const body = codeOnly(readMainJs());
  const log = body.slice(body.indexOf('function log('), body.indexOf('function safeStringify('));
  // Two: the stderr write (EPIPE in GUI mode) and the file write (read-only dir,
  // full disk, locked file). Both were already the reason the EPIPE guard exists.
  assert.ok((log.match(/catch/g) || []).length >= 2,
    'both the stderr write and the file write must be individually guarded');
});

test('the tools rename happens BEFORE quitAndInstall — order is the whole point', () => {
  const code = codeOnly(readMainJs());
  const begin = code.indexOf('function beginInstall(');
  assert.ok(begin !== -1, 'beginInstall() is the single handover path');
  const body = code.slice(begin, code.indexOf('\n}', begin));

  const rescueAt = body.indexOf('rescueToolDirs()');
  const installAt = body.indexOf('quitAndInstall');
  assert.ok(rescueAt !== -1, 'beginInstall() must move the tool dirs aside');
  assert.ok(installAt !== -1, 'beginInstall() must then hand over to the installer');
  assert.ok(rescueAt < installAt,
    'rescueToolDirs() must run BEFORE quitAndInstall(): after the handover this process is gone, '
    + 'and the installer is already deleting the tree');
});

test('both install paths go through beginInstall()', () => {
  const code = codeOnly(readMainJs());
  const calls = code.match(/quitAndInstall\(/g) || [];
  assert.equal(calls.length, 1,
    'exactly one quitAndInstall() call site (inside beginInstall) — the HUD button and the dialog '
    + 'must not be able to drift apart');
  assert.ok((code.match(/beginInstall\(/g) || []).length >= 3,
    'the definition plus both call sites: the dialog and the HUD Update button');
});

test('the rename is inside a try/catch and cannot block an update', () => {
  const code = codeOnly(readMainJs());
  const start = code.indexOf('function rescueToolDirs(');
  assert.ok(start !== -1, 'rescueToolDirs() must exist');
  const body = code.slice(start, code.indexOf('\nfunction ', start + 10));

  assert.ok(/renameSync/.test(body),
    'a rename, not a copy: copying a gigabyte here would freeze the main process with the window '
    + 'already closing');
  const tryAt = body.indexOf('try');
  const renameAt = body.indexOf('renameSync');
  assert.ok(tryAt !== -1 && tryAt < renameAt,
    'the rename must be inside a try — it throws EXDEV when userData and the install tree are on '
    + 'different volumes, which is a real operator layout');
  assert.ok(/catch\s*\(\s*\w+\s*\)/.test(body.slice(renameAt)),
    'and the catch must bind the error so the reason reaches the log');
  assert.ok(/installing anyway/i.test(readMainJs().slice(start)),
    'the failure path must say it is proceeding: rescuing the tools is an optimisation, '
    + 'blocking an update is not an option');
});

test('the rescued tools land where MYTHOS_TOOLS_DIR already points', () => {
  const code = codeOnly(readMainJs());
  // From the dir list through the function: the names are a module-scope const.
  const start = code.indexOf('const RESCUABLE_TOOL_DIRS');
  const body = code.slice(start, code.indexOf('\nfunction ', code.indexOf('function rescueToolDirs(') + 10));
  assert.ok(/getPath\('userData'\)/.test(body) && /'tools'/.test(body),
    'destination must be <userData>/tools — the same path startChild() injects as MYTHOS_TOOLS_DIR '
    + 'and build/installer.nsh probes for "already installed"');
  assert.ok(/Hermes Agent/.test(body) && /Android Platform Tools/.test(body),
    'both in-tree tool payloads must be moved');
  assert.ok(/existsSync\(to\)|existsSync\(\s*to\s*\)/.test(body),
    'an existing userData copy must never be clobbered by an older in-tree one');
});

// ---- the ordered handover (2026-08-13) ---------------------------------------
//
// Three 0.1.7 updates failed with "Failed to uninstall old application files
// ...: 2". That 2 is the OLD uninstaller's exit code: on an update it renames
// each file of the install tree into $PLUGINSDIR\old-install, and one failed
// rename makes it restore everything and Abort. The installer retries 5 times,
// ~1s apart, then rolls back — so the app came back on the old version looking
// perfectly healthy, which is why it read as success three times over.
//
// Every rename was racing our own shutdown, and each of the three assertions
// below pins one of the three things that made us lose that race.

test('beginInstall stops the child and WAITS for it before handing over', () => {
  const code = codeOnly(readMainJs());
  const begin = code.indexOf('async function beginInstall(');
  assert.ok(begin !== -1, 'beginInstall must be async — it waits for the child to exit');
  const body = code.slice(begin, code.indexOf('\n}', begin));

  const stopAt = body.indexOf('stopChild()');
  const awaitAt = body.indexOf('awaitChildExit(');
  const installAt = body.indexOf('quitAndInstall');
  assert.ok(stopAt !== -1 && awaitAt !== -1, 'it must stop the child and wait for its exit');
  assert.ok(stopAt < awaitAt && awaitAt < installAt,
    'stopChild -> awaitChildExit -> quitAndInstall, in that order: the child is forked from '
    + 'process.execPath and its cwd is inside the install tree, so while it lives the uninstaller '
    + 'cannot rename either');
  assert.ok(/isQuitting = true/.test(body.slice(0, stopAt)),
    'isQuitting must be set BEFORE stopChild, or the exit handler reschedules the child');
});

test('a stubborn child cannot block an update either', () => {
  const code = codeOnly(readMainJs());
  const start = code.indexOf('function awaitChildExit(');
  assert.ok(start !== -1, 'awaitChildExit must exist');
  const body = code.slice(start, code.indexOf('\nfunction ', start + 10));
  assert.ok(/SIGKILL/.test(body), 'the deadline must escalate to SIGKILL');
  assert.ok(/resolve\(\)/.test(body),
    'and resolve anyway — waiting forever would trade a failed update for a hung one');
});

test('the child is never restarted during shutdown', () => {
  const code = codeOnly(readMainJs());
  const handler = code.slice(code.indexOf("child.on('exit'"), code.indexOf('function stopChild('));
  const guardAt = handler.indexOf('if (isQuitting)');
  const restartAt = handler.indexOf('setTimeout(startChild');
  assert.ok(guardAt !== -1, 'the exit handler must check isQuitting');
  assert.ok(restartAt !== -1 && guardAt < restartAt,
    'the guard must come BEFORE the restart timer: stopChild() during a quit used to schedule a '
    + 'fresh MYTHOS.exe 1s later, inside the very directory the installer was renaming');
  assert.ok(/return;/.test(handler.slice(guardAt, restartAt)), 'and it must return, not fall through');
});

test('before-quit does not repeat the blocking vault push during an update', () => {
  const code = codeOnly(readMainJs());
  const body = code.slice(code.indexOf("app.on('before-quit'"), code.indexOf("app.on('will-quit'"));
  const guardAt = body.indexOf('handedOverToInstaller');
  const pushAt = body.lastIndexOf("syncVault('--push')");
  assert.ok(guardAt !== -1 && pushAt !== -1 && guardAt < pushAt,
    'before-quit must skip the push when beginInstall already did it — it is a BLOCKING spawnSync '
    + 'with a 15s timeout, and the uninstaller only waits ~5s for us to let go');
  assert.ok(/return;/.test(body.slice(guardAt, pushAt)), 'the guard must return before the push');

  // And the push must still happen on the install path — just earlier, where it
  // is not inside the uninstaller's retry window.
  const begin = code.indexOf('async function beginInstall(');
  const install = code.slice(begin, code.indexOf('\n}', begin));
  assert.ok(install.indexOf("syncVault('--push')") !== -1
    && install.indexOf("syncVault('--push')") < install.indexOf('quitAndInstall'),
    'beginInstall must push before quitAndInstall, so no update loses the vault');
});

test("the installer's TEMP is moved onto the install volume", () => {
  const code = codeOnly(readMainJs());
  const start = code.indexOf('function pointInstallerTempAtInstallVolume(');
  assert.ok(start !== -1, 'the redirect must exist');
  const body = code.slice(start, code.indexOf('\nfunction ', start + 10));
  assert.ok(/process\.env\.TEMP =/.test(body) && /process\.env\.TMP =/.test(body),
    'both TEMP and TMP — electron-updater spawns the installer with env: undefined, so it '
    + 'inherits ours, and $PLUGINSDIR follows');
  assert.ok(/process\.resourcesPath/.test(body),
    'derived from the running install, never a hardcoded path (AD-7)');
  assert.ok(/path\.dirname\(installRoot\)/.test(body),
    'the scratch dir must sit BESIDE the install dir, not inside it: the uninstaller renames every '
    + 'entry of $INSTDIR into $PLUGINSDIR\\old-install, so a scratch dir inside $INSTDIR would '
    + 'contain its own destination');
  assert.ok(/try/.test(body) && /catch/.test(body),
    'best-effort: a failed redirect must fall back to %TEMP%, not block the update');

  const begin = code.indexOf('async function beginInstall(');
  const install = code.slice(begin, code.indexOf('\n}', begin));
  assert.ok(install.indexOf('pointInstallerTempAtInstallVolume()') !== -1
    && install.indexOf('pointInstallerTempAtInstallVolume()') < install.indexOf('quitAndInstall'),
    'and it must run before the installer is spawned, or it changes nothing');
});

test('the app version is injected into the child, not derived from a path', () => {
  const code = codeOnly(readMainJs());
  assert.ok(/MYTHOS_APP_VERSION: app\.getVersion\(\)/.test(code),
    'a packaged build has no resources/app.asar.unpacked/package.json, so identity/version.js '
    + 'fell through to mythos/package.json and a 0.1.7 install reported v0.1.0 in the HUD badge');

  const version = fs.readFileSync(
    path.join(REPO_ROOT, 'mythos', 'src', 'core', 'identity', 'version.js'), 'utf8');
  const fn = version.slice(version.indexOf('function readPackageVersion('));
  const envAt = fn.indexOf('MYTHOS_APP_VERSION');
  const fileAt = fn.indexOf('readVersionFrom(');
  assert.ok(envAt !== -1 && envAt < fileAt,
    'the injected version must be preferred over both file lookups');
});

test('an in-tree HERMES_HOME is called out rather than silently defeating the rescue', () => {
  // Measured on the operator's machine, 2026-08-13: a user-level HERMES_HOME
  // pointing into resources/app.asar.unpacked outranks MYTHOS_TOOLS_DIR in
  // setup-hermes.js, so a reinstall puts the whole venv back in the tree and the
  // next update deletes it again. main.js cannot fix an operator env var; it can
  // refuse to be quiet about it.
  const code = codeOnly(readMainJs());
  const start = code.indexOf('function warnIfHermesHomeIsInTheInstallTree(');
  assert.ok(start !== -1, 'the check must exist');
  const body = code.slice(start, code.indexOf('\nfunction ', start + 10));
  assert.ok(/process\.env\.HERMES_HOME/.test(body), 'it reads the operator env var');
  assert.ok(/startsWith/.test(body), 'and compares it against the install root');

  const rescue = code.slice(code.indexOf('function rescueToolDirs('));
  assert.ok(rescue.indexOf('warnIfHermesHomeIsInTheInstallTree(') !== -1
    && rescue.indexOf('warnIfHermesHomeIsInTheInstallTree(') < rescue.indexOf('renameSync'),
    'and runs as part of the handover, before the rename it would otherwise silently undo');
});

test('the dialog no longer promises a fixed half a minute', () => {
  // Comments stripped: the note above the dialog quotes the old wording to
  // explain why it is gone, and that history must stay readable.
  const src = readMainJs();
  const code = codeOnly(src);
  assert.ok(!/half a minute/.test(code),
    'the measured 0.1.7 upgrade took 40+ minutes; a wrong ETA on a silent install is what makes a '
    + 'working update look like a dead app');
  const start = src.indexOf('function promptInstall(');
  const detail = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/progress bar/i.test(detail),
    'the dialog must say there is no visible progress bar — that is what the operator will see');
  assert.ok(/vault, keys and PIN/.test(detail),
    'and must keep the reassurance that an update touches none of them');
});

test('an update attempt is recorded before the handover and read on the next boot', () => {
  const code = codeOnly(readMainJs());
  const begin = code.indexOf('function beginInstall(');
  const body = code.slice(begin, code.indexOf('\n}', begin));
  const recordAt = body.indexOf('recordUpdateAttempt(');
  assert.ok(recordAt !== -1 && recordAt < body.indexOf('quitAndInstall'),
    'the attempt must be written BEFORE quitAndInstall — afterwards there is no process to write it');

  assert.ok(/update-attempt\.json/.test(code), 'the marker file is update-attempt.json');
  assert.ok(/function unfinishedUpdate\(/.test(code), 'and boot must read it back');
  const check = code.slice(code.indexOf('function unfinishedUpdate('), code.indexOf('function beginInstall('));
  assert.ok(/unlinkSync/.test(check),
    'the file must be cleared either way — one report per attempt, not an undismissable banner');
  assert.ok(/app\.getVersion\(\)/.test(check),
    'a completed install is detected by the version having moved, not by anything the installer says');

  // Wired into boot, and before the update check whose events would overwrite it.
  const ready = code.slice(code.indexOf('app.whenReady().then'));
  const reportAt = ready.indexOf('unfinishedUpdate()');
  const checkAt = ready.indexOf('checkForUpdates()');
  assert.ok(reportAt !== -1 && checkAt !== -1 && reportAt < checkAt,
    'the boot report must run before checkForUpdates()');
  assert.ok(/setUpdateState\('incomplete'/.test(ready),
    'and surface through the existing update-status banner path');
});

test("'incomplete' is an accepted update state end to end", () => {
  const code = codeOnly(readMainJs());
  const states = code.slice(code.indexOf('const UPDATE_STATES'), code.indexOf('let updaterRef'));
  assert.ok(/'incomplete'/.test(states),
    "setUpdateState() rejects unknown states, so 'incomplete' must be in UPDATE_STATES or the banner is a silent no-op");

  const banner = fs.readFileSync(
    path.join(REPO_ROOT, 'mythos', 'ui', 'public', 'js', 'update-banner.js'), 'utf8');
  assert.ok(/case 'incomplete':/.test(banner),
    'and the HUD must have copy for it — an unhandled state renders as a blank strip');
});
