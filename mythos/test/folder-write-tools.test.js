'use strict';

// Folder read-write feature (2026-07-23 bug sweep) — write_file/create_folder/
// delete_file, the write side of the sandboxed folder tools (list_folder/
// read_file are the existing T0 read side). Reuses the existing sandbox
// (resolveSandboxed/allowedRoots), same style as BUG-018's list_folder tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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
