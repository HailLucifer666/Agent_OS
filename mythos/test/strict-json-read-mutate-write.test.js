'use strict';

// test/strict-json-read-mutate-write.test.js — a corrupt store file must not be
// silently rewritten from defaults.
//
// fs-store's readJSON(path, fallback) cannot distinguish a CORRUPT file from a
// MISSING one: both come back as the fallback. That is harmless for a read, and
// destructive for a read-mutate-write, because the write that follows commits
// the fallback over the real data and reports success. memory/documents.js and
// leash/checkpoints.js were migrated to readJSONStrict for exactly this reason;
// planner/daily.js and identity/index.js were not, and they own the day file
// (morning brief, every check-in, the evening review) and the persona dials.
//
// Both suites below seed a genuinely unparseable file and then take the write
// path. The assertion is not "an error was returned" — it is that the bytes on
// disk are still there afterwards.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createDailyPlanner } = require('../src/core/planner/daily');

function seed(dir, relPath, contents) {
  const abs = nodePath.join(dir, relPath.split('/').join(nodePath.sep));
  nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
  nodeFs.writeFileSync(abs, contents, 'utf8');
  return abs;
}

function anomalyKinds(bus) {
  return bus._emitted()
    .filter((e) => e.type === 'health.anomaly' && e.payload && e.payload.kind)
    .map((e) => e.payload.kind);
}

describe('planner/daily: a corrupt day file is never overwritten with a fresh empty day', () => {
  it('surfaces the corruption instead of erasing the day', () => {
    const dir = tempVaultDir();
    try {
      const bus = fakeBus();
      const fsStore = createFsStore(() => dir, bus);
      const planner = createDailyPlanner({
        bus,
        config: {},
        memory: { fs: fsStore },
        goals: { arbitrate: () => null, list: () => [], get: () => null },
        now: () => new Date(2026, 7, 19, 14, 0, 0, 0).getTime(),
      });
      const corrupt = '{"date":"2026-08-19","focus":["the real plan"],';
      const abs = seed(dir, 'Plans/2026-08-19.json', corrupt);

      // tick() is the scheduler's own entry point, and the one that calls
      // loadDay before any of the three run* paths write it back.
      assert.throws(() => planner._internal.tick(), /unparseable JSON/i,
        'a corrupt day file must surface, not be read as "no day yet"');

      assert.equal(nodeFs.readFileSync(abs, 'utf8'), corrupt,
        'the corrupt day file must be left exactly as found — rewriting it destroys the '
        + 'morning brief, every check-in and the evening review');
      assert.ok(anomalyKinds(bus).includes('json-corrupt'),
        'the corruption must be reported as a health anomaly, not swallowed');
    } finally {
      cleanupVaultDir(dir);
    }
  });

  it('still treats a genuinely missing day file as a new day', () => {
    const dir = tempVaultDir();
    try {
      const bus = fakeBus();
      const fsStore = createFsStore(() => dir, bus);
      const planner = createDailyPlanner({
        bus,
        config: {},
        memory: { fs: fsStore },
        goals: { arbitrate: () => null, list: () => [], get: () => null },
        now: () => new Date(2026, 7, 19, 14, 0, 0, 0).getTime(),
      });
      const day = planner._internal.loadDay('2026-08-19');
      assert.equal(day.date, '2026-08-19');
      assert.deepEqual(day.checkins, []);
    } finally {
      cleanupVaultDir(dir);
    }
  });
});

describe('identity: a corrupt persona.json is never rebuilt from defaults', () => {
  async function bootIdentity(dir, bus) {
    const config = { MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 };
    const fsStore = createFsStore(() => dir, bus);
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const store = createIdentityStore({ fs: fsStore, config, bus, logger });
    await store.init();
    const identity = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    await identity.init();
    return identity;
  }

  it('refuses the write and says so, leaving the file untouched', async () => {
    const dir = tempVaultDir();
    try {
      const bus = fakeBus();
      const identity = await bootIdentity(dir, bus);
      const corrupt = '{"humor":9,"warmth":3,';
      const abs = seed(dir, 'Identity/persona.json', corrupt);

      const result = identity.setPersonaLevel('humor', 2);
      assert.equal(result.ok, false, 'the write must be refused, not reported as a success');
      assert.match(result.error, /unreadable/i);
      assert.equal(nodeFs.readFileSync(abs, 'utf8'), corrupt,
        'every dial the operator ever set must survive — the lenient read would have '
        + 'committed DEFAULTS over all of them and kept only the one just changed');
    } finally {
      cleanupVaultDir(dir);
    }
  });

  it('a normal set still writes, so the guard has not disabled the feature', async () => {
    const dir = tempVaultDir();
    try {
      const identity = await bootIdentity(dir, fakeBus());
      const result = identity.setPersonaLevel('humor', 2);
      assert.equal(result.ok, true);
      assert.equal(result.value, 2);
      const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'Identity', 'persona.json'), 'utf8'));
      assert.equal(onDisk.humor, 2);
    } finally {
      cleanupVaultDir(dir);
    }
  });

  it('a persona.json written after boot is merged, not clobbered by the cached defaults', async () => {
    const dir = tempVaultDir();
    try {
      // init() caches levels from an EMPTY vault, i.e. all defaults.
      const identity = await bootIdentity(dir, fakeBus());
      // Something else writes the file afterwards — the operator by hand, or a
      // second process. The cached `levels` is now stale.
      seed(dir, 'Identity/persona.json', JSON.stringify({ sass: 0, warmth: 10 }));

      const result = identity.setPersonaLevel('humor', 3);
      assert.equal(result.ok, true);
      const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'Identity', 'persona.json'), 'utf8'));
      assert.equal(onDisk.humor, 3, 'the requested change must land');
      assert.equal(onDisk.sass, 0, 'a dial written since boot must not be clobbered by the boot-time cache');
      assert.equal(onDisk.warmth, 10, 'same for every other dial in the file');
    } finally {
      cleanupVaultDir(dir);
    }
  });
});
