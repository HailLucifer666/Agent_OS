'use strict';

// Engagement store with atomic persistence and mutex protection
// ENGAGEMENT-SPEC section 2.1 + fs-store patterns

function createEngagementStore({ fs, config, bus }) {
  if (!fs) throw new Error('fs required');
  if (!config) throw new Error('config required');
  // bus is optional but recommended

  // Per-record promise mutex for concurrent writes
  var mutexes = {};

  function vaultPath() {
    return 'Engagements';
  }

  // Async init creates vault/Engagements directory
  async function init() {
    try {
      // BUG: vaultPath() returns the bare relative string 'Engagements', and
      // fs-store's ensureDir() (unlike its readJSON/writeJSON/listFiles,
      // which resolve internally) takes its argument literally — every other
      // fs-store caller resolves via fs.vaultPath() first, then calls
      // ensureDir on the absolute path. This call site skipped that step, so
      // mkdirSync('Engagements') created the directory relative to
      // process.cwd() instead of inside the vault — engagementStore.init()
      // "succeeded" every boot while vault/Engagements/ silently never
      // existed (the dishonest-ok this whole handoff targets).
      fs.ensureDir(fs.vaultPath(vaultPath()));
      if (bus) bus.emit('engagement.store.init', { ok: true });
    } catch (err) {
      if (bus) bus.emit('health.anomaly', {
        kind: 'engagement-store-init-failed',
        error: err.message
      });
      throw err;
    }
  }

  function write(record) {
    if (!record || !record.id) {
      throw new Error('Valid engagement record with id required');
    }
    var relPath = vaultPath() + '/' + record.id + '.json';
    return fs.writeJSON(relPath, record);
  }

  function read(id) {
    var relPath = vaultPath() + '/' + id + '.json';
    return fs.readJSON(relPath, null);
  }

  function list() {
    var files = fs.listFiles(vaultPath(), '.json');
    return files.map(function(f) {
      return f.name.replace('.json', '');
    });
  }

  function acquireMutex(id) {
    var promise = new Promise(function(resolve) {
      if (!mutexes[id]) {
        mutexes[id] = { queue: [], locked: false };
      }

      if (!mutexes[id].locked) {
        mutexes[id].locked = true;
        resolve(createReleaseFunction(id));
      } else {
        mutexes[id].queue.push(resolve);
      }
    });
    return promise;
  }

  function createReleaseFunction(id) {
    return function release() {
      if (!mutexes[id]) return;

      var next = mutexes[id].queue.shift();
      if (next) {
        next(createReleaseFunction(id));
      } else {
        mutexes[id].locked = false;
      }
    };
  }

  function emitEvent(event, payload) {
    if (bus) bus.emit(event, payload);
  }

  // Get engagement by id with validation
  async function get(id) {
    var record = read(id);
    return record;
  }

  // Save engagement record (update version and timestamp)
  async function save(id, patch) {
    var record = read(id);
    if (!record) {
      throw new Error('Engagement not found: ' + id);
    }

    var acquired = await acquireMutex(id);
    try {
      var now = Date.now();
      var updated = Object.assign({}, record, patch, {
        version: record.version + 1,
        updatedAt: now
      });
      write(updated);
      if (bus) bus.emit('engagement.saved', { id: id, version: updated.version });
      return updated;
    } finally {
      acquired();
    }
  }

  // Create new engagement
  async function create(record) {
    var id = record.id;
    if (!id) {
      throw new Error('Engagement must have id');
    }

    // Validate before write
    var validation = require('./schema').validateEngagement(record);
    if (!validation.ok) {
      throw new Error('Invalid engagement: ' + validation.errors.join(', '));
    }

    write(record);
    return record;
  }

  // Delete engagement
  async function remove(id) {
    var acquired = await acquireMutex(id);
    try {
      fs.removeFile(vaultPath() + '/' + id + '.json');
      if (bus) bus.emit('engagement.removed', { id: id });
    } finally {
      acquired();
    }
  }

  // Update engagement (atomic with mutex)
  async function update(id, patch) {
    var acquired = await acquireMutex(id);
    try {
      var record = read(id);
      if (!record) {
        throw new Error('Engagement not found: ' + id);
      }
      var now = Date.now();
      var updated = Object.assign({}, record, patch, {
        version: record.version + 1,
        updatedAt: now
      });
      write(updated);
      return updated;
    } finally {
      acquired();
    }
  }

  return {
    init: init,
    write: write,
    read: read,
    list: list,
    acquireMutex: acquireMutex,
    emitEvent: emitEvent,
    get: get,
    save: save,
    create: create,
    remove: remove,
    update: update,
    vaultPath: vaultPath
  };
}

module.exports = { createEngagementStore };