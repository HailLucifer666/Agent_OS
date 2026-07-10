'use strict';

// CHAOS DRILL 3 — Disk-full.
// Monkey-patches fs-store's `appendLine` (the exact function episodic.write() and
// checkpoints.save() use) to reject with ENOSPC, and proves every store degrades
// honestly: { ref: null, degraded: true } / { ok: false, degraded: true }, a
// health.anomaly fires, and nothing crashes.
//
// See Spec Ambiguities Resolved #2: this path already conforms today — each store
// wraps its own fs.* call and emits health.anomaly via its OWN injected bus. No
// fs-store fix is required for this drill.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-chaos-disk-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Episodic', 'Checkpoints'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

function enospcError() {
  const err = new Error('ENOSPC: no space left on device');
  err.code = 'ENOSPC';
  return err;
}

describe('chaos drill: disk-full', () => {
  let dir;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('episodic.write() degrades honestly and emits health.anomaly when appendLine hits ENOSPC', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    // Monkey-patch the EXACT function episodic.write() calls (fs-store.js:appendLine).
    fsStore.appendLine = function() { throw enospcError(); };

    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });
    const result = episodic.write({ kind: 'action', summary: 'disk full test' });

    assert.deepEqual(result, { ref: null, degraded: true }, 'write() must degrade honestly, never throw');
    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly');
    assert.ok(anomalies.length >= 1, 'a health.anomaly event must fire on write failure');
    assert.equal(anomalies[0].payload.store, 'episodic');
  });

  it('checkpoints.save() degrades honestly and emits health.anomaly when writeJSON hits ENOSPC', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createCheckpointStore } = require('../src/core/memory/checkpoints');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    fsStore.writeJSON = function() { throw enospcError(); };

    const checkpoints = createCheckpointStore({ fs: fsStore, config: {}, bus: bus, logger: null });
    const result = checkpoints.save({ tick: 5, activeGoalId: 'goal-x', contextKeys: [], lastTickAt: Date.now() });

    assert.deepEqual(result, { ok: false, degraded: true });
    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'checkpoint-write-failed');
    assert.ok(anomalies.length >= 1);
  });

  it('a subsequent write after disk space frees up succeeds normally (no permanent poisoning)', () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir);
    const realAppendLine = fsStore.appendLine;
    let fail = true;
    fsStore.appendLine = function(relPath, obj) {
      if (fail) throw enospcError();
      return realAppendLine(relPath, obj);
    };

    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });
    const degraded = episodic.write({ kind: 'action', summary: 'still full' });
    assert.equal(degraded.degraded, true);

    fail = false; // disk space freed
    const ok = episodic.write({ kind: 'action', summary: 'space freed' });
    assert.equal(ok.degraded, false, 'a store must recover once the underlying write succeeds again');
    assert.ok(ok.ref, 'a successful write after recovery must return a real ref');
  });
});
