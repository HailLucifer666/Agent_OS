'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-eng-store-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'Engagements'), { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function fakeBus() {
  const emitted = [];
  return {
    emit: function(type, payload) {
      emitted.push({ type: type, payload: payload });
    },
    _emitted: function() { return emitted.slice(); }
  };
}

function createTestFsStore(root) {
  return {
    // Mirrors the real fs-store.js contract: vaultPath(...segments) resolves
    // segments against root; ensureDir(absPath) takes an ALREADY-resolved
    // path literally (every real caller resolves via vaultPath() first, then
    // calls ensureDir — this mock previously took ensureDir's arg as
    // relative-to-root instead, which produced a doubled/bogus path once
    // the real store.js started actually calling fs.vaultPath(vaultPath())).
    vaultPath: function() {
      return path.join.apply(path, [root].concat(Array.prototype.slice.call(arguments)));
    },
    ensureDir: function(absPath) {
      fs.mkdirSync(absPath, { recursive: true });
    },
    writeJSON: function(relPath, data) {
      var full = path.join(root, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
    },
    readJSON: function(relPath, fallback) {
      var full = path.join(root, relPath);
      try {
        var raw = fs.readFileSync(full, 'utf8');
        return JSON.parse(raw);
      } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw err;
      }
    },
    listFiles: function(relDir, ext) {
      var full = path.join(root, relDir);
      try {
        return fs.readdirSync(full)
          .filter(function(f) { return !ext || f.endsWith(ext); })
          .map(function(f) { return { name: f, path: path.join(relDir, f) }; });
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
    removeFile: function(relPath) {
      var full = path.join(root, relPath);
      try { fs.unlinkSync(full); } catch (_) {}
    }
  };
}

describe('engagements/store', () => {
  let dir, fsStore, store, bus;

  beforeEach(function() {
    dir = tempDir();
    bus = fakeBus();
    fsStore = createTestFsStore(dir);
    const { createEngagementStore } = require('../../src/core/engagements/store');
    store = createEngagementStore({ fs: fsStore, config: {}, bus: bus });
  });

  afterEach(function() { cleanupDir(dir); });

  describe('init', () => {
    it('creates Engagements directory', async () => {
      const fs2 = createTestFsStore(path.join(os.tmpdir(), 'mythos-eng-init-' + crypto.randomBytes(4).toString('hex')));
      const { createEngagementStore } = require('../../src/core/engagements/store');
      const s = createEngagementStore({ fs: fs2, config: {}, bus: null });
      await s.init();
      // Directory should be created
      assert.ok(fs.existsSync(path.join(fs2.vaultPath(), 'Engagements')));
    });
  });

  describe('create and read', () => {
    it('creates an engagement record', async () => {
      const record = {
        id: 'eng-a1b2c3',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
      };
      await store.create(record);
      const read = store.read('eng-a1b2c3');
      assert.ok(read);
      assert.equal(read.id, 'eng-a1b2c3');
      assert.equal(read.status, 'DRAFT');
    });

    it('read returns null for missing id', () => {
      const result = store.read('nonexistent');
      assert.equal(result, null);
    });
  });

  describe('update', () => {
    it('updates record immutably', async () => {
      const record = {
        id: 'eng-d4e5f6',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
      };
      await store.create(record);
      const updated = await store.update('eng-d4e5f6', { status: 'INTERVIEWING' });

      assert.equal(updated.status, 'INTERVIEWING');
      assert.equal(updated.version, 2);
      assert.ok(updated.updatedAt > record.updatedAt);
    });

    it('throws for missing record', async () => {
      await assert.rejects(
        async () => store.update('nonexistent', { status: 'INTERVIEWING' }),
        /not found/
      );
    });
  });

  describe('mutex', () => {
    it('acquires and releases mutex', async () => {
      const release = await store.acquireMutex('eng-test-3');
      assert.equal(typeof release, 'function');
      release();
      // Should be able to acquire again
      const release2 = await store.acquireMutex('eng-test-3');
      release2();
    });

    it('queues concurrent mutex requests', async () => {
      // A second acquire on the SAME id can only resolve after the first is
      // released (that's the entire point of a mutex) — awaiting both via
      // Promise.all() before releasing either is a deadlock by construction,
      // not a real concurrency test. Acquire the first, confirm the second
      // stays pending, release the first, then confirm the second resolves.
      const release1 = await store.acquireMutex('eng-test-4');
      assert.equal(typeof release1, 'function');

      let secondResolved = false;
      const lock2Promise = store.acquireMutex('eng-test-4').then((release) => {
        secondResolved = true;
        return release;
      });

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(secondResolved, false, 'second acquire must stay queued while the first still holds the mutex');

      release1();
      const release2 = await lock2Promise;
      assert.equal(typeof release2, 'function');
      release2();
    });
  });

  describe('list', () => {
    it('lists all engagement ids', async () => {
      await store.create({ id: 'eng-1', version: 1, status: 'DRAFT', createdAt: Date.now(), updatedAt: Date.now(), ttlMs: 604800000 });
      await store.create({ id: 'eng-2', version: 1, status: 'DRAFT', createdAt: Date.now(), updatedAt: Date.now(), ttlMs: 604800000 });

      const ids = store.list();
      assert.deepEqual(ids.sort(), ['eng-1', 'eng-2'].sort());
    });

    it('returns empty array when no engagements', () => {
      const ids = store.list();
      assert.deepEqual(ids, []);
    });
  });

  describe('remove', () => {
    it('removes an engagement', async () => {
      await store.create({ id: 'eng-fade01', version: 1, status: 'DRAFT', createdAt: Date.now(), updatedAt: Date.now(), ttlMs: 604800000 });
      await store.remove('eng-fade01');
      assert.equal(store.read('eng-fade01'), null);
    });
  });

  describe('H9: back-fill on read — legacy/future-schema records must never throw', () => {
    // Simulates a record written before a nested section existed (or hand-
    // corrupted), bypassing store.create()'s validateEngagement() gate the
    // way store.read()/get()/list()/update() do for every record already on
    // disk — those paths never validated or defaulted before this fix.
    function writeLegacyRecord(id) {
      fsStore.writeJSON('Engagements/' + id + '.json', {
        id: id,
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
        // interview/spec/plan/execution/completion deliberately absent.
      });
    }

    it('read() backfills every missing nested section instead of returning them undefined', () => {
      writeLegacyRecord('eng-legacy1');
      const record = store.read('eng-legacy1');
      assert.ok(record.interview && Array.isArray(record.interview.questions), 'interview must be backfilled');
      assert.ok(record.spec && typeof record.spec.markdown === 'string', 'spec must be backfilled');
      assert.ok(record.plan && Array.isArray(record.plan.stages), 'plan must be backfilled');
      assert.ok(record.execution && Array.isArray(record.execution.stageResults), 'execution must be backfilled');
      assert.ok(record.completion && typeof record.completion.reportMarkdown === 'string', 'completion must be backfilled');
    });

    it('update() on a legacy record does not throw reaching into a missing nested section', async () => {
      writeLegacyRecord('eng-legacy2');
      // Exercises exactly the access pattern engagements/index.js's
      // transitionEngagement() uses on the record update() hands back
      // (record.plan.currentStageIndex, etc.) — must not be undefined.
      const updated = await store.update('eng-legacy2', { status: 'INTERVIEWING' });
      assert.equal(updated.status, 'INTERVIEWING');
      assert.doesNotThrow(() => { updated.plan.currentStageIndex = 0; });
      assert.doesNotThrow(() => { updated.interview.completedAt = Date.now(); });
    });
  });

  describe('emitEvent', () => {
    it('emits event on bus', () => {
      store.emitEvent('engagement.saved', { id: 'eng-1' });
      const emitted = bus._emitted();
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].type, 'engagement.saved');
    });
  });
});