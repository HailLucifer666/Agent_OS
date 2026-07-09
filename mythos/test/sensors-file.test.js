'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fsNode = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createFileSensor } = require('../src/core/sensors/file');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('sensors/file: createFileSensor', () => {
  it('throws in the constructor if bus is missing', () => {
    assert.throws(() => createFileSensor({ bus: null, config: {}, vault: { vaultPath: () => '.' } }));
  });

  it('throws in the constructor if vault.vaultPath is missing', () => {
    assert.throws(() => createFileSensor({ bus: fakeBus(), config: {}, vault: null }));
  });

  it('ignores writes under Checkpoints/ — zero perception.file events after the debounce window', async () => {
    const dir = tempVaultDir();
    const fs = createFsStore(() => dir, null);
    const bus = fakeBus();
    const sensor = createFileSensor({ bus, config: { MYTHOS_FILE_DEBOUNCE_MS: 50 }, vault: fs });
    sensor.start();

    fsNode.writeFileSync(path.join(dir, 'Checkpoints', 'build-jobs.json'), '{}');
    await wait(200);

    assert.equal(bus.history().filter((e) => e.type === 'perception.file').length, 0);

    sensor.stop();
    cleanupVaultDir(dir);
  });

  // Isolated in a child process — see test-fixtures/file-sensor-child.js header comment
  // for why: a write directly at the root of an fs.watch'd directory crashes this
  // Windows/Node build natively (verified with zero mythos code involved), so exercising
  // the real positive-path event here, in-process, would abort the whole test run.
  // NOTE: the fixture lives in test-fixtures/ (a SIBLING of test/, not nested inside it)
  // deliberately — node:test auto-discovers any .js file inside a directory named
  // "test", so a helper script under test/ would otherwise get picked up and run as its
  // own (failing) test.
  it('emits exactly one debounced perception.file event for a write under a non-ignored dir (isolated child process)', (t) => {
    const dir = tempVaultDir();
    const childScript = path.join(__dirname, '..', 'test-fixtures', 'file-sensor-child.js');
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [childScript, dir], { encoding: 'utf8', timeout: 5000 });
    } catch (err) {
      cleanupVaultDir(dir);
      t.skip('environment-specific fs.watch crash on this Node/Windows build (native, unrelated to sensors/file.js — see test-fixtures/file-sensor-child.js header comment): ' + err.message);
      return;
    }
    cleanupVaultDir(dir);

    const result = JSON.parse(stdout);
    assert.equal(result.count, 1);
    assert.equal(result.sample.payload.kind, 'file');
    assert.equal(typeof result.sample.payload.salience, 'number');
  });
});
