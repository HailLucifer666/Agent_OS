'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('crypto');

const { createEngagement } = require('../../src/core/engagements/index');

function tempDir() {
  const dir = path.join(require('os').tmpdir(), 'mythos-eng-index-' + require('crypto').randomBytes(4).toString('hex'));
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
    _emitted: function() { return emitted.slice(); },
    subscribe: function() {}
  };
}

function createTestStore(dir) {
  return {
    write: function(record) {
      var full = path.join(dir, 'Engagements', record.id + '.json');
      fs.writeFileSync(full, JSON.stringify(record, null, 2));
    },
    read: function(id) {
      try {
        var full = path.join(dir, 'Engagements', id + '.json');
        return JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (err) {
        return null;
      }
    },
    list: function() {
      try {
        return fs.readdirSync(path.join(dir, 'Engagements'))
          .filter(function(f) { return f.endsWith('.json'); })
          .map(function(f) { return f.replace('.json', ''); });
      } catch (err) {
        return [];
      }
    },
    remove: function(id) {
      try { fs.unlinkSync(path.join(dir, 'Engagements', id + '.json')); } catch (_) {}
    }
  };
}

function createStateMachine() {
  return require('../../src/core/engagements/state-machine');
}

describe('engagements/index', () => {
  let dir, store, bus, engagement;

  beforeEach(function() {
    dir = tempDir();
    bus = fakeBus();
    store = createTestStore(dir);
  });

  afterEach(function() { cleanupDir(dir); });

  describe('create', () => {
    it('throws without initialIntent', () => {
      assert.throws(function() {
        createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() }).create({});
      }, /initialIntent required/);
    });

    it('creates an engagement record', () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const result = e.create({ initialIntent: 'build a CLI tool' });

      assert.ok(result.id.startsWith('eng-'));
      assert.equal(result.status, 'DRAFT');
      assert.equal(result.version, 1);
      assert.equal(bus._emitted().length, 1);
      assert.equal(bus._emitted()[0].type, 'engagement.draft');
    });
  });

  describe('findById', () => {
    it('returns null for missing id', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const result = await e.findById('eng-nonexistent');
      assert.equal(result, null);
    });

    it('returns record for existing id', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const created = e.create({ initialIntent: 'test' });
      const found = await e.findById(created.id);
      assert.equal(found.id, created.id);
    });
  });

  describe('list', () => {
    it('returns empty array initially', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const result = await e.list();
      assert.deepEqual(result, []);
    });

    it('lists all engagements', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      e.create({ initialIntent: 'test1' });
      e.create({ initialIntent: 'test2' });
      const result = await e.list();
      assert.equal(result.length, 2);
    });

    it('filters by status', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const eng = e.create({ initialIntent: 'test' });
      // Manually set status
      store.write(Object.assign({}, eng, { status: 'INTERVIEWING' }));

      const result = await e.list({ status: 'INTERVIEWING' });
      assert.equal(result.length, 1);
    });
  });

  describe('transition', () => {
    it('throws without id', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      await assert.rejects(
        async () => e.transition(),
        /engagement id required/
      );
    });

    it('rejects unknown engagement', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      await assert.rejects(
        async () => e.transition('eng-xyz', 'startInterview', {}),
        /not found/
      );
    });

    it('accepts valid transition', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const eng = e.create({ initialIntent: 'test' });

      const result = await e.transition(eng.id, 'startInterview', {});
      assert.equal(result.ok, true);
      assert.equal(result.status, 'INTERVIEWING');
    });
  });

  describe('delete', () => {
    it('throws without id', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      await assert.rejects(
        async () => e.delete(),
        /engagement id required/
      );
    });

    it('removes engagement', async () => {
      const e = createEngagement({ bus: bus, config: {}, store: store, stateMachine: createStateMachine() });
      const eng = e.create({ initialIntent: 'test' });
      await e.delete(eng.id);
      const found = await e.findById(eng.id);
      assert.equal(found, null);
    });
  });
});