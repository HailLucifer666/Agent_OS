'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Mock the PC child module before loading from-pc
const pcChildMock = {
  getStatus: () => ({ state: 'ONLINE' }),
  sendCommand: async (cmd) => {
    if (cmd.cmd === 'screen_look') {
      // Return a minimal valid base64-encoded PNG (1x1 pixel, transparent)
      // This is the smallest valid PNG file
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      return { ok: true, result: { png: pngBase64 } };
    }
    return { ok: false, error: 'Unknown command' };
  }
};

// Store original require
const Module = require('node:module');
const originalRequire = Module.prototype.require;

// Mock fs module used in from-pc.js
const fsMock = {
  writeFileSync: (filePath, buffer, encoding) => {
    // Track that writeFileSync was called with the correct parameters
    fsMock.writeFileSync.calls = fsMock.writeFileSync.calls || [];
    fsMock.writeFileSync.calls.push({ filePath, buffer, encoding });
  }
};

test('capture_screenshot saves PNG to vault/Incidents/ directory', async () => {
  // Create a custom require that intercepts module loads
  Module.prototype.require = function(id) {
    if (id === '../../../adapters/pc-child') {
      return pcChildMock;
    }
    if (id === 'fs') {
      return fsMock;
    }
    return originalRequire.apply(this, arguments);
  };

  try {
    // Clear the require cache and load from-pc fresh with mocks
    const fromPcPath = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
    delete require.cache[fromPcPath];
    const fromPc = require(fromPcPath);

    // Mock vault fs-store
    const vaultFsMock = {
      vaultPath: (...segments) => {
        return path.join('/vault/root', ...segments);
      },
      ensureDir: (relDir) => {
        // No-op for test
      }
    };

    // Register with mocked fs-store
    const hubMock = {
      register: () => {} // No-op for test
    };

    fromPc.registerFromPc(hubMock, { brain: null, fs: vaultFsMock });

    // Call capture_screenshot
    const result = await fromPc.capture_screenshot();

    // Verify success
    assert.strictEqual(result.ok, true, 'capture_screenshot should succeed');
    assert(result.result.filename, 'result should have a filename');
    assert(result.result.bytes > 0, 'result should report non-zero byte size');

    // Verify the filename format (ISO timestamp with colons replaced)
    const filenameRegex = /^screenshot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.png$/;
    assert.match(result.result.filename, filenameRegex, 'filename should be in correct ISO format with colons replaced');

    // Verify fs.writeFileSync was called
    assert(fsMock.writeFileSync.calls && fsMock.writeFileSync.calls.length > 0, 'fs.writeFileSync should have been called');

    const writeCall = fsMock.writeFileSync.calls[0];
    assert(writeCall.filePath.includes('Incidents'), 'file should be written to Incidents directory');
    assert.strictEqual(writeCall.filePath.includes('screenshot-'), true, 'filepath should contain screenshot-');
    assert.strictEqual(writeCall.encoding, 'binary', 'should write as binary');
    assert.strictEqual(Buffer.isBuffer(writeCall.buffer), true, 'should write a Buffer');

  } finally {
    // Restore original require
    Module.prototype.require = originalRequire;
  }
});

test('capture_screenshot fails when PC automation is offline', async () => {
  // Create a mock that returns offline status
  const offlinepcChildMock = {
    getStatus: () => ({ state: 'OFFLINE' }),
    sendCommand: async () => {
      return { ok: false, error: 'Offline' };
    }
  };

  Module.prototype.require = function(id) {
    if (id === '../../../adapters/pc-child') {
      return offlinepcChildMock;
    }
    return originalRequire.apply(this, arguments);
  };

  try {
    // Clear cache and reload
    const fromPcPath = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
    delete require.cache[fromPcPath];
    const fromPc = require(fromPcPath);

    const hubMock = { register: () => {} };
    const vaultFsMock = {
      vaultPath: () => '/vault',
      ensureDir: () => {}
    };

    fromPc.registerFromPc(hubMock, { fs: vaultFsMock });
    const result = await fromPc.capture_screenshot();

    assert.strictEqual(result.ok, false, 'should fail when offline');
    assert(result.result.includes('OFFLINE'), 'error should mention offline state');

  } finally {
    Module.prototype.require = originalRequire;
  }
});

test('capture_screenshot fails when vault fs is unavailable', async () => {
  Module.prototype.require = function(id) {
    if (id === '../../../adapters/pc-child') {
      return pcChildMock;
    }
    return originalRequire.apply(this, arguments);
  };

  try {
    const fromPcPath = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
    delete require.cache[fromPcPath];
    const fromPc = require(fromPcPath);

    const hubMock = { register: () => {} };

    // Register with no fs-store (null)
    fromPc.registerFromPc(hubMock, { fs: null });
    const result = await fromPc.capture_screenshot();

    assert.strictEqual(result.ok, false, 'should fail when vault fs is unavailable');
    assert(result.result.includes('Vault'), 'error should mention vault');

  } finally {
    Module.prototype.require = originalRequire;
  }
});
