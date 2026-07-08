'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Test helpers — mirrors NOVA's test-helpers pattern

/**
 * Create a temporary vault directory for test isolation.
 * Returns the dir path. Caller must clean up.
 */
function tempVaultDir() {
  const dir = path.join(os.tmpdir(), 'mythos-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });

  // Create subdirectories
  const subdirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
  for (let i = 0; i < subdirs.length; i++) {
    fs.mkdirSync(path.join(dir, subdirs[i]), { recursive: true });
  }

  return dir;
}

/**
 * Remove temp vault directory (best-effort cleanup).
 */
function cleanupVaultDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best-effort — don't throw on cleanup
  }
}

/**
 * Create a fake bus for unit testing.
 * Returns a bus with additional spy helpers.
 */
function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 100 });
  const emitted = [];

  // Wrap emit to record all events
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };

  bus._emitted = function() { return emitted.slice(); };
  bus._lastEvent = function(type) {
    for (let i = emitted.length - 1; i >= 0; i--) {
      if (emitted[i].type === type) return emitted[i];
    }
    return null;
  };

  return bus;
}

module.exports = { tempVaultDir, cleanupVaultDir, fakeBus };
