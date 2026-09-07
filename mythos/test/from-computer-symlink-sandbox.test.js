'use strict';

// Security remediation (LOW, from the Task 10 Android-bridge review): resolveSandboxed()
// only resolved a path LEXICALLY against allowedRoots(). A junction/symlink already
// planted inside an allowed root and pointing outside it was therefore accepted as
// "inside" by every caller that used resolveSandboxed() ALONE — set_wallpaper
// (from-pc.js), read_file/list_folder/open_folder/search_files (from-computer.js),
// summarize_document (from-documents.js), and any future tool (phone_file_pull /
// phone_file_push). write_file & friends were already protected because they
// additionally call isInsideAllowedRoots(). These tests pin the protection into the
// SHARED helper so a new call site cannot reintroduce the gap.
//
// Junctions are used (not file symlinks) because creating a junction on Windows needs
// no elevation and no Developer Mode; file symlinks do.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureComputerModule = require('../test-fixtures/fixture-computer-module');
let resolveSandboxed, isInsideAllowedRoots;

describe('resolveSandboxed: symlink/junction escape from an allowed root', () => {
  let sandboxRoot, outsideDir, savedAllowedDirs;

  before(() => {
    savedAllowedDirs = process.env.VOICE_ALLOWED_DIRS;
    // realpathSync so the configured root is in the same (long, canonical) form the
    // real-path check produces — on Windows os.tmpdir() is often an 8.3 short path
    // (a tilde-abbreviated segment) while realpath returns the long name.
    sandboxRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-sbx-root-')));
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-sbx-outside-')));
    process.env.VOICE_ALLOWED_DIRS = sandboxRoot;
    ({ resolveSandboxed, isInsideAllowedRoots } = fixtureComputerModule(sandboxRoot));
    fs.symlinkSync(outsideDir, path.join(sandboxRoot, 'escape-link'), 'junction');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'exfiltrate me', 'utf8');
    fs.writeFileSync(path.join(sandboxRoot, 'legit.txt'), 'fine', 'utf8');
  });

  after(() => {
    if (savedAllowedDirs === undefined) delete process.env.VOICE_ALLOWED_DIRS;
    else process.env.VOICE_ALLOWED_DIRS = savedAllowedDirs;
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects an existing file reached through a junction inside the allowed root', () => {
    const through = path.join(sandboxRoot, 'escape-link', 'secret.txt');
    const result = resolveSandboxed(through);
    assert.equal(result.ok, false, 'a path whose real target is outside the sandbox must be rejected');
  });

  it('rejects the junction directory itself', () => {
    const result = resolveSandboxed(path.join(sandboxRoot, 'escape-link'));
    assert.equal(result.ok, false);
  });

  it('rejects a not-yet-existing leaf below the junction (write target)', () => {
    const target = path.join(sandboxRoot, 'escape-link', 'newsub', 'evil.txt');
    const result = resolveSandboxed(target);
    assert.equal(result.ok, false, 'the nearest EXISTING ancestor is the junction — must be rejected');
    assert.equal(fs.existsSync(path.join(outsideDir, 'newsub')), false, 'the check must not create anything');
  });

  it('still accepts a real path inside the allowed root', () => {
    const result = resolveSandboxed(path.join(sandboxRoot, 'legit.txt'));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.resolved, path.join(sandboxRoot, 'legit.txt'));
  });

  it('still accepts a not-yet-existing path inside the allowed root', () => {
    const result = resolveSandboxed(path.join(sandboxRoot, 'nope', 'deeper', 'new.txt'));
    assert.equal(result.ok, true, result.reason);
  });

  it('isInsideAllowedRoots agrees with resolveSandboxed on both cases', () => {
    assert.equal(isInsideAllowedRoots(path.join(sandboxRoot, 'escape-link', 'x')), false);
    assert.equal(isInsideAllowedRoots(path.join(sandboxRoot, 'nope', 'deeper')), true);
  });
});

// An allowed root supplied in a non-canonical form (Windows 8.3 short path, or a root
// that itself lives under a junction) must still match its own contents — otherwise
// making the check real-path-aware would lock legitimate callers out of their sandbox.
describe('resolveSandboxed: allowed root given in non-canonical form', () => {
  let realRoot, linkRoot, savedAllowedDirs;

  before(() => {
    savedAllowedDirs = process.env.VOICE_ALLOWED_DIRS;
    realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-sbx-real-')));
    // The root the user configures is a junction pointing AT the real root.
    linkRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
    fs.symlinkSync(realRoot, linkRoot, 'junction');
    process.env.VOICE_ALLOWED_DIRS = linkRoot;
    ({ resolveSandboxed, isInsideAllowedRoots } = fixtureComputerModule(realRoot));
    fs.writeFileSync(path.join(realRoot, 'inside.txt'), 'ok', 'utf8');
  });

  after(() => {
    if (savedAllowedDirs === undefined) delete process.env.VOICE_ALLOWED_DIRS;
    else process.env.VOICE_ALLOWED_DIRS = savedAllowedDirs;
    try { fs.rmSync(linkRoot, { recursive: true, force: true }); } catch { /* junction already gone */ }
    fs.rmSync(realRoot, { recursive: true, force: true });
  });

  it('accepts a file inside the configured (junctioned) root', () => {
    const result = resolveSandboxed(path.join(linkRoot, 'inside.txt'));
    assert.equal(result.ok, true, result.reason);
  });

  it('accepts the same file addressed by its real path', () => {
    const result = resolveSandboxed(path.join(realRoot, 'inside.txt'));
    assert.equal(result.ok, true, result.reason);
  });
});
