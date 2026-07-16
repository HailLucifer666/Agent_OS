'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { registerFromComputer } = require('../src/core/effectors/from-computer');

describe('BUG-018: list_folder sandbox verification', () => {
  let dir, hub, bus, projectRoot;

  before(() => {
    dir = tempVaultDir();
    bus = fakeBus();
    hub = createEffectorHub({ bus, config: {} });

    projectRoot = path.resolve(__dirname, '..');

    registerFromComputer(hub, {});
  });

  after(() => cleanupVaultDir(dir));

  it('list_folder with absolute path to project root succeeds', async () => {
    const listFolderEffector = hub.get('list_folder');
    assert.ok(listFolderEffector, 'list_folder effector is registered');

    const result = await listFolderEffector.invoke({
      path: projectRoot
    });

    assert.equal(result.ok, true, `list_folder(projectRoot) returned ok:true (got: ${JSON.stringify(result)})`);
    assert.ok(result.result && typeof result.result === 'object', 'result is an object with path/entries/truncated');
    assert.ok(Array.isArray(result.result.entries), 'entries is an array');
    assert.ok(result.result.entries.length > 0, 'entries is not empty');
  });

  it('list_folder with path relative to cwd inside project succeeds', async () => {
    const listFolderEffector = hub.get('list_folder');
    const srcPath = path.resolve(projectRoot, 'src');

    const result = await listFolderEffector.invoke({
      path: srcPath
    });

    assert.equal(result.ok, true, `list_folder(src) returned ok:true (got: ${JSON.stringify(result)})`);
    assert.ok(result.result && typeof result.result === 'object', 'result is an object');
    assert.ok(Array.isArray(result.result.entries), 'entries is an array');
  });

  it('list_folder with dot "." resolves relative to current directory', async () => {
    const listFolderEffector = hub.get('list_folder');

    // When running from mythos/, '.' resolves to mythos/, which is inside the project root
    const result = await listFolderEffector.invoke({
      path: '.'
    });

    // This should succeed because the test is running in mythos/ which is part of the project
    assert.equal(result.ok, true, `list_folder(".") returned ok:true (got: ${JSON.stringify(result)})`);
    assert.ok(result.result && typeof result.result === 'object', 'result is an object with entries');
  });

  it('list_folder rejects paths outside allowed roots (security boundary)', async () => {
    const listFolderEffector = hub.get('list_folder');

    // Try to list a system directory that should NOT be allowed
    // (project root is allowed, user home might be allowed, but arbitrary system paths should not)
    const result = await listFolderEffector.invoke({
      path: 'C:\\Windows\\System32'
    });

    // This should fail because System32 is not in the allowed roots
    // (unless VOICE_ALLOWED_DIRS was explicitly set to include it, which is unlikely)
    assert.equal(result.ok, false, 'list_folder rejects paths outside allowed roots');
  });
});
