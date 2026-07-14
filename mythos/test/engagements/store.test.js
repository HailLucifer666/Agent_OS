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
    vaultPath: function() { return root; },
    ensureDir: function(relPath) {
      var full = path.join(root, relPath || '');
      fs.mkdirSync(full, { recursive: true });
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
        id: 'eng-test-1',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
      };
      await store.create(record);
      const read = store.read('eng-test-1');
      assert.ok(read);
      assert.equal(read.id, 'eng-test-1');
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
        id: 'eng-test-2',
        version: 1,
        status: 'DRAFT',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlMs: 604800000
      };
      await store.create(record);
      const updated = await store.update('eng-test-2', { status: 'INTERVIEWING' });

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
      const lock1 = store.acquireMutex('eng-test-4');
      const lock2 = store.acquireMutex('eng-test-4');

      // Both promises should resolve
      const releases = await Promise.all([lock1, lock2]);
      assert.equal(releases.length, 2);
      assert.equal(typeof releases[0], 'function');
      assert.equal(typeof releases[1], 'function');

      releases[0]();
      releases[1]();
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
      await store.create({ id: 'eng-del', version: 1, status: 'DRAFT', createdAt: Date.now(), updatedAt: Date.now(), ttlMs: 604800000 });
      await store.remove('eng-del');
      assert.equal(store.read('eng-del'), null);
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