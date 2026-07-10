'use strict';

// CHAOS DRILL 4 — Memory-corrupt.
// fs.appendFileSync's a malformed line into a REAL episodic .jsonl file mid-write,
// then proves recall()/tail() skip the corrupt line, surrounding data survives, a
// health.anomaly fires (D-16 contract — see Spec Ambiguities Resolved #1), and
// checkpoint-restore + WorkingMemory rebuild still work afterward.
//
// P10 BUILD FIX: fs-store.js's real shipped signature is createFsStore(vaultRootFn,
// bus) — bus is a direct positional arg, not an { bus } options object (verified
// against src/core/memory/fs-store.js:11 and its real call sites in memory/index.js:17
// and test/memory.test.js:58). The spec's Ambiguity #1 write-up describes a
// `{bus}={}` shape that doesn't match today's shipped code; using the real signature
// below so corrupt-line detection's bus.emit() call actually fires.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-chaos-corrupt-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Episodic', 'Checkpoints'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

function todayFile(dir) {
  const d = new Date();
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return path.join(dir, 'Episodic', key + '.jsonl');
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

describe('chaos drill: memory-corrupt', () => {
  let dir;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('corrupt line is skipped, surrounding entries survive, health.anomaly fires (D-16 contract)', () => {
    // Real fs-store signature: createFsStore(vaultRootFn, bus) — bus is positional,
    // not { bus }. See file-header note.
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir, bus);
    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });

    episodic.write({ id: 'ep-before-1', summary: 'chaos memory test alpha' });
    episodic.write({ id: 'ep-before-2', summary: 'chaos memory test beta' });

    // Malformed line, injected mid-file exactly like a torn/partial write.
    fs.appendFileSync(todayFile(dir), '{"id":"ep-corrupt", "summary": "truncated mid-lin\n');

    episodic.write({ id: 'ep-after-1', summary: 'chaos memory test gamma' });
    episodic.write({ id: 'ep-after-2', summary: 'chaos memory test delta' });

    const hits = episodic.recall('chaos memory test', { windowDays: 1, limit: 20 });
    assert.equal(hits.length, 4, 'all 4 valid entries must be recallable despite the corrupt line');
    const ids = hits.map((h) => h.ref).sort();
    assert.deepEqual(ids, ['ep-after-1', 'ep-after-2', 'ep-before-1', 'ep-before-2']);

    const tail = episodic.tail(10);
    assert.ok(tail.every((e) => e && e.id !== 'ep-corrupt'), 'tail() must never surface the corrupt line');
    assert.equal(tail.length, 4, 'tail() must return exactly the 4 valid entries, corrupt line excluded from the count');

    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'corrupt-line');
    assert.ok(anomalies.length >= 1, "fs-store must emit health.anomaly{kind:'corrupt-line'} on the skipped line");
  });

  it('checkpoint-restore still works after episodic corruption (separate files, no cross-contamination)', async () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createEpisodicStore } = require('../src/core/memory/episodic');
    const { createCheckpointStore } = require('../src/core/memory/checkpoints');
    const { createWorkingMemory } = require('../src/core/memory/working');

    const bus = fakeBus();
    const fsStore = createFsStore(() => dir, bus);
    const episodic = createEpisodicStore({ fs: fsStore, config: { EPISODIC_RETENTION_DAYS: 30 }, bus: bus, logger: null });
    const checkpoints = createCheckpointStore({ fs: fsStore, config: {}, bus: bus, logger: null });

    episodic.write({ id: 'ep-1', tick: 4, summary: 'pre-corruption' });
    fs.appendFileSync(todayFile(dir), 'not even close to json\n');
    episodic.write({ id: 'ep-2', tick: 5, summary: 'post-corruption' });

    const saveResult = checkpoints.save({ tick: 5, activeGoalId: 'goal-x', contextKeys: ['a'], lastTickAt: Date.now() });
    assert.equal(saveResult.ok, true, 'checkpoint save must succeed independent of episodic corruption');

    const loaded = checkpoints.load();
    assert.ok(loaded, 'checkpoint must be loadable');
    assert.equal(loaded.tick, 5);

    const working = createWorkingMemory({ fs: fsStore, config: {}, bus: bus, logger: null, episodic: episodic });
    await working.init(); // rebuilds from episodic.tail() — must not throw on the corrupt line
    assert.equal(working.tick, 5, 'WorkingMemory rebuild must reach the latest valid tick despite the corrupt line');
  });
});
