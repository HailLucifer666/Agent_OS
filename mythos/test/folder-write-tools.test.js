'use strict';

// Folder read-write feature (2026-07-23 bug sweep) — write_file/create_folder/
// delete_file, the write side of the sandboxed folder tools (list_folder/
// read_file are the existing T0 read side). Reuses the existing sandbox
// (resolveSandboxed/allowedRoots), same style as BUG-018's list_folder tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');
const { fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromComputer } = require('../src/core/effectors/from-computer');
const { tierOf, TIER_TABLE } = require('../src/core/leash/tiers');

describe('folder read-write tools: write_file / create_folder / delete_file', () => {
  let hub, scratchDir;

  before(() => {
    const bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    registerFromComputer(hub, {});
    // Inside the project root, which allowedRoots() always includes — a
    // dedicated scratch subfolder so nothing here touches real project files.
    scratchDir = path.resolve(__dirname, '..', '.tmp-folder-write-test');
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('write_file/create_folder/delete_file are registered with danger:true and tier 3', () => {
    ['write_file', 'create_folder', 'delete_file'].forEach((name) => {
      assert.ok(hub.get(name), `${name} is registered`);
      assert.equal(TIER_TABLE[name], 3, `${name} must have an explicit T3 TIER_TABLE entry`);
      assert.equal(tierOf(name), 3);
    });
  });

  it('create_folder succeeds inside an allowed root (creates missing parents)', async () => {
    const target = path.join(scratchDir, 'nested', 'dir');
    const result = await hub.get('create_folder').invoke({ path: target });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(fs.existsSync(target) && fs.statSync(target).isDirectory());
  });

  it('write_file creates a new file inside an allowed root', async () => {
    const target = path.join(scratchDir, 'note.txt');
    const result = await hub.get('write_file').invoke({ path: target, content: 'hello sandbox' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.overwritten, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello sandbox');
  });

  it('write_file overwrites an existing file and reports overwritten:true', async () => {
    const target = path.join(scratchDir, 'note.txt');
    const result = await hub.get('write_file').invoke({ path: target, content: 'updated content' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.overwritten, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'updated content');
  });

  it('write_file rejects a missing content argument', async () => {
    const result = await hub.get('write_file').invoke({ path: path.join(scratchDir, 'x.txt') });
    assert.equal(result.ok, false);
  });

  it('delete_file removes an existing file inside an allowed root', async () => {
    const target = path.join(scratchDir, 'to-delete.txt');
    fs.writeFileSync(target, 'bye', 'utf8');
    const result = await hub.get('delete_file').invoke({ path: target });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(target), false);
  });

  it('delete_file fails honestly when the file does not exist', async () => {
    const result = await hub.get('delete_file').invoke({ path: path.join(scratchDir, 'never-existed.txt') });
    assert.equal(result.ok, false);
  });

  it('delete_file refuses to remove a directory', async () => {
    const result = await hub.get('delete_file').invoke({ path: scratchDir });
    assert.equal(result.ok, false);
    assert.ok(fs.existsSync(scratchDir));
  });

  it('write_file/create_folder/delete_file all fail outside the allowed roots', async () => {
    const outside = 'C:\\Windows\\System32\\mythos-write-test.txt';
    const w = await hub.get('write_file').invoke({ path: outside, content: 'x' });
    assert.equal(w.ok, false);
    const c = await hub.get('create_folder').invoke({ path: 'C:\\Windows\\System32\\mythos-folder-test' });
    assert.equal(c.ok, false);
    const d = await hub.get('delete_file').invoke({ path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    assert.equal(d.ok, false);
  });
});

// REMEDIATION P0-1: sandbox escape via a symlink inside an allowed root.
// resolveSandboxed() only resolves paths LEXICALLY. If a directory inside an
// allowed root is itself a symlink/junction to somewhere outside, the target
// tool must (a) never mutate anything before the real (post-symlink) location
// is confirmed inside an allowed root, and (b) walk up to the nearest EXISTING
// ancestor to do that check — a not-yet-created leaf segment can't itself be a
// symlink, so checking only the immediate (possibly nonexistent) parent misses
// a symlink placed further up the chain.
describe('REMEDIATION: sandbox escape via symlinked directory', () => {
  let hub, sandboxRoot, outsideDir, savedAllowedDirs;

  before(() => {
    const bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });
    registerFromComputer(hub, {});

    savedAllowedDirs = process.env.VOICE_ALLOWED_DIRS;
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-sandbox-root-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-outside-root-'));
    // Override to a deterministic, controlled root — independent of whatever
    // %USERPROFILE% happens to contain on this machine.
    process.env.VOICE_ALLOWED_DIRS = sandboxRoot;

    // A junction (directory symlink, no elevation required on Windows) placed
    // INSIDE the allowed root, pointing OUTSIDE it.
    fs.symlinkSync(outsideDir, path.join(sandboxRoot, 'escape-link'), 'junction');
  });

  after(() => {
    process.env.VOICE_ALLOWED_DIRS = savedAllowedDirs;
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('write_file refuses to write through a symlinked directory, and creates nothing outside the sandbox', async () => {
    const target = path.join(sandboxRoot, 'escape-link', 'newsub', 'evil.txt');
    const result = await hub.get('write_file').invoke({ path: target, content: 'pwned' });
    assert.equal(result.ok, false, 'write_file must refuse a path that escapes via a symlink');
    assert.equal(fs.existsSync(path.join(outsideDir, 'newsub')), false,
      'no directory may be created outside the sandbox even when the final write is refused');
    assert.equal(fs.existsSync(path.join(outsideDir, 'newsub', 'evil.txt')), false);
  });

  it('create_folder refuses a multi-level not-yet-existing path through a symlink further up the chain', async () => {
    // Two new segments below the junction ("a" then "b") — the immediate
    // parent ("escape-link/a") does not exist yet, so a check that only looks
    // at the immediate parent (and fail-opens on ENOENT) misses that
    // "escape-link" itself, a few segments up, is a symlink to outside.
    const target = path.join(sandboxRoot, 'escape-link', 'a', 'b');
    const result = await hub.get('create_folder').invoke({ path: target });
    assert.equal(result.ok, false, 'create_folder must refuse a multi-level path escaping via a symlink');
    assert.equal(fs.existsSync(path.join(outsideDir, 'a')), false,
      'no directory may be created outside the sandbox, even a multi-level one');
  });

  it('delete_file refuses to delete a file reached through a symlinked directory', async () => {
    fs.writeFileSync(path.join(outsideDir, 'real-secret.txt'), 'do not delete me', 'utf8');
    const target = path.join(sandboxRoot, 'escape-link', 'real-secret.txt');
    const result = await hub.get('delete_file').invoke({ path: target });
    assert.equal(result.ok, false, 'delete_file must refuse a path that escapes via a symlink');
    assert.equal(fs.existsSync(path.join(outsideDir, 'real-secret.txt')), true,
      'the file outside the sandbox must survive');
  });
});
