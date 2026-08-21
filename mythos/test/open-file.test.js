'use strict';

// test/open-file.test.js — the open_file verb (2026-08-21 capability audit).
//
// THE GAP, measured rather than assumed. MYTHOS could reveal a folder and it
// could serve a vault build over HTTP, but it had no way to open an ordinary
// file in its associated application. The live vault records both halves:
//   - open_folder refused with "That is a file, not a folder: <the operator's
//     desktop>\capabilities.txt. Use open_artifact..." — and that redirect is a
//     dead end, because open_artifact only serves builds out of the vault over
//     HTTP, not arbitrary files on disk. (The real path is elided here on
//     purpose: the AD-7 gate rejects a drive-letter user path in tracked
//     source, and it is right to — this is an open-source repo.)
//   - the operator, in the 2026-08-20 transcript: "open the file you were just
//     discussing", and MYTHOS: "open that file for you. I'm not sure why it
//     failed, but I can't access the..."
// launch_app takes an app name and explicitly refuses paths, so there was no
// third option. This adds the missing verb.
//
// WHY THE SHELL HOP. Opening a file by association is the OS's job
// (shell.openPath), and that lives in the Electron main process. The route is
// the one BUG-272 already built for open_web(browser:true):
//   effector -> server requestOpenPath() -> fork IPC 'mythos:open-path'
//            -> electron/main.js shell.openPath -> '-ack' -> resolve
// A single pending slot with a 3s timeout, exactly like requestOpenExternal —
// one hand-off at a time, so a reqId-keyed Map would be more machinery than
// the problem needs.
//
// WHAT IS DELIBERATELY NOT VERIFIED. shell.openPath resolves when the OS
// ACCEPTS the request, not when an application renders anything. So a success
// is reported through evidence.unverified() with the step that WAS confirmed,
// never as a bare ok. Claiming "I opened it" when all we know is "the OS took
// it" is the exact dishonesty the evidence contract exists to prevent.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  registerFromComputer, open_file, setOpenPathProvider,
} = require('../src/core/effectors/from-computer');
const { tierOf } = require('../src/core/leash/tiers');
const { DEFAULT_ALLOWLIST } = require('../src/core/voice/live-tools');

function fakeHub() { return { register() {} }; }

let sandbox, savedAllowedDirs;

before(() => {
  savedAllowedDirs = process.env.VOICE_ALLOWED_DIRS;
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-openfile-')));
  process.env.VOICE_ALLOWED_DIRS = sandbox;
  fs.writeFileSync(path.join(sandbox, 'notes.txt'), 'hello', 'utf8');
  fs.writeFileSync(path.join(sandbox, 'installer.exe'), 'MZ', 'utf8');
  fs.mkdirSync(path.join(sandbox, 'subdir'), { recursive: true });
  registerFromComputer(fakeHub(), { config: { MYTHOS_VAULT_ROOT: sandbox } });
});

after(() => {
  process.env.VOICE_ALLOWED_DIRS = savedAllowedDirs;
  setOpenPathProvider(null);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('open_file', () => {
  it('is exported and wired as a tool (negative control)', () => {
    // Without this, every assertion below could pass against an undefined
    // import in a suite that reads as green.
    assert.equal(typeof open_file, 'function');
    assert.equal(typeof setOpenPathProvider, 'function');
  });

  it('hands a real file to the shell and reports it as UNVERIFIED, not ok', async () => {
    const asked = [];
    setOpenPathProvider(async (p) => { asked.push(p); return { opened: true, reason: null }; });
    const out = await open_file({ path: path.join(sandbox, 'notes.txt') });
    // Assert the mechanism: the provider was actually called with the resolved
    // path. Returning ok without having asked the shell would be the bug
    // wearing a fix's clothes.
    assert.deepEqual(asked, [path.join(sandbox, 'notes.txt')]);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.unverified, true,
      'the OS accepting a request is not the app rendering the file — must not claim verified');
    assert.ok(out.confirmedStep, 'must say which step WAS confirmed');
    assert.match(out.confirmedStep, /notes\.txt/);
    assert.equal(out.result.opened, path.join(sandbox, 'notes.txt'));
  });

  it('refuses an executable by extension, and says why it is different', async () => {
    let called = false;
    setOpenPathProvider(async () => { called = true; return { opened: true }; });
    const out = await open_file({ path: path.join(sandbox, 'installer.exe') });
    assert.equal(out.ok, false);
    assert.match(out.result, /execute/i, 'the refusal must name the real distinction: run vs display');
    assert.equal(called, false, 'the shell must never be asked to open an executable');
  });

  it('refuses a directory and names open_folder', async () => {
    let called = false;
    setOpenPathProvider(async () => { called = true; return { opened: true }; });
    const out = await open_file({ path: path.join(sandbox, 'subdir') });
    assert.equal(out.ok, false);
    assert.match(out.result, /open_folder/, 'a refusal must name the tool that does work');
    assert.equal(called, false);
  });

  it('passes the sandbox refusal through unchanged', async () => {
    let called = false;
    setOpenPathProvider(async () => { called = true; return { opened: true }; });
    const out = await open_file({ path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    assert.equal(out.ok, false);
    assert.equal(called, false, 'a path outside the sandbox must never reach the shell');
  });

  it('is honest when the desktop shell is absent rather than pretending', async () => {
    setOpenPathProvider(null);
    const out = await open_file({ path: path.join(sandbox, 'notes.txt') });
    assert.equal(out.ok, false);
    assert.match(out.result, /shell/i);
  });

  it('carries the shell’s own reason when the OS refuses', async () => {
    setOpenPathProvider(async () => ({ opened: false, reason: 'no application is associated with .txt' }));
    const out = await open_file({ path: path.join(sandbox, 'notes.txt') });
    assert.equal(out.ok, false);
    assert.match(out.result, /no application is associated/,
      'the OS reason must survive to the operator — a generic failure sends them hunting');
  });

  it('a missing file fails before the shell is troubled', async () => {
    let called = false;
    setOpenPathProvider(async () => { called = true; return { opened: true }; });
    const out = await open_file({ path: path.join(sandbox, 'nope.txt') });
    assert.equal(out.ok, false);
    assert.equal(called, false);
  });
});

describe('open_file is wired into the layers a new tool must reach', () => {
  // Every one of these was a real omission class in this repo: a tool with no
  // tier entry silently falls to T3 fail-safe, and a tool absent from the
  // allowlist is invisible to voice however well it works.
  it('has an explicit leash tier rather than falling through to the T3 default', () => {
    assert.equal(tierOf('open_file'), 2,
      'open_file should be T2, the same class as open_folder');
  });

  it('is reachable from voice', () => {
    assert.ok(DEFAULT_ALLOWLIST.includes('open_file'),
      'the 2026-08-20 transcript is the demand evidence — it must be declarable');
  });

  it('electron/main.js handles the mythos:open-path channel and acks it', () => {
    // No runtime seam: this branch lives inside the Electron main process,
    // which the suite cannot boot. Source-shape assertion is the pattern this
    // repo already uses for it (bug-075, bug-272). Scans the whole file rather
    // than pinning line numbers.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
    assert.match(src, /mythos:open-path'/, 'the request channel must be handled');
    assert.match(src, /mythos:open-path-ack/, 'an unacked request would hang until the 3s timeout');
    assert.match(src, /shell\.openPath/, 'the actual OS call must be present');
  });

  it('the server exposes requestOpenPath and resolves its ack', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.match(src, /function requestOpenPath/);
    assert.match(src, /mythos:open-path-ack/, 'the ack must be resolved, not dropped');
    assert.match(src, /requestOpenPath[,\s}]/, 'it must be exported on the server handle');
  });

  it('src/main.js wires the provider into the effector', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    // Must assert the CALL, not merely the identifier: an earlier version of
    // this test matched /setOpenPathProvider/, which the import line satisfies
    // on its own — so deleting the wiring call left the test green. A guard
    // that a mutation cannot break is not a guard.
    assert.match(
      src, /setOpenPathProvider\(\s*serverHandle\.requestOpenPath\s*\)/,
      'without this wiring call open_file is registered but permanently shell-absent'
    );
  });
});
