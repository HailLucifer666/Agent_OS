'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');

function fakeConfig(overrides) {
  return Object.assign({ MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 }, overrides);
}

describe('identity store', () => {
  let dir, fsStore, store, bus;

  beforeEach(async function() {
    dir = tempVaultDir();
    bus = fakeBus();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config: fakeConfig(), bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('seeds self.md on init', () => {
    assert.ok(fsStore.exists('Identity/self.md'));
    const raw = store.readRaw();
    assert.match(raw, /## Persona\nMYTHOS/);
  });

  it('writes and recalls a learned preference', () => {
    const { ref } = store.write('Prefers dark mode', { source: 'ep-1', confidence: 0.7 });
    assert.ok(ref.startsWith('idn-'));
    const hits = store.recall('dark mode');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'identity');
  });

  it('preserves header when writing a preference', () => {
    store.write('Prefers concise answers', { source: 'ep-2' });
    const raw = store.readRaw();
    assert.match(raw, /## Purpose\nAn autonomous entity/);
  });

  it('consolidate archives low-confidence prefs instead of deleting', () => {
    store.write('Low confidence guess', { confidence: 0.05 });
    store.write('High confidence fact', { confidence: 0.9 });
    const result = store.consolidate({ threshold: 0.2 });
    assert.equal(result.archived, 1);
    assert.ok(fsStore.exists('Identity/_archive.md'));
    assert.match(fsStore.readText('Identity/_archive.md'), /Low confidence guess/);
    const hits = store.recall('confidence');
    assert.equal(hits.filter(h => h.record.text === 'Low confidence guess').length, 0);
  });

  it('stats() returns bare {count} — matches real house convention (D-20), not spec\'s illustrative {count,bytes,lastWrite}', () => {
    store.write('a');
    store.write('b');
    const stats = store.stats();
    assert.deepEqual(Object.keys(stats).sort(), ['count']);
    assert.equal(stats.count, 2);
  });
});

describe('identity module', () => {
  let dir, fsStore, store, identity, bus, config;

  beforeEach(async function() {
    dir = tempVaultDir();
    bus = fakeBus();
    config = fakeConfig();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config, bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    identity = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    await identity.init();
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('loads at boot with fail-safe boundaries when file missing', () => {
    // gate (a): loaded at boot
    assert.equal(identity.getMaxAutonomousTier(), 1); // no boundaries.md seeded in this test → fail-safe default
    const anomaly = bus._lastEvent('health.anomaly');
    assert.equal(anomaly.payload.kind, 'identity-boundaries-malformed');
  });

  it('MYTHOS_NAME override: self.md persona wins over config.MYTHOS_NAME', async () => {
    // gate (c)
    store.writeHeader({ persona: 'GALACTUS' });
    const identity2 = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    await identity2.init();
    assert.match(identity2.persona(), /^You are GALACTUS\./);
  });

  it('falls back to config.MYTHOS_NAME when persona unset', () => {
    assert.match(identity.persona(), /^You are MYTHOS\./);
  });

  it('checkBoundary denies tools on the deny list', () => {
    fsStore.writeText('Identity/boundaries.md', '# MYTHOS Boundaries\n\n## Deny Rules (absolute blocks)\ndeny: kill_session\n');
    const identity3 = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    return identity3.init().then(() => {
      assert.equal(identity3.checkBoundary('kill_session', {}), 'denied by boundaries.md');
      assert.equal(identity3.checkBoundary('navigate', {}), null);
    });
  });

  it('learn() persists via the identity store and refreshes cache', async () => {
    const result = await identity.learn({ signal: null, text: 'Prefers short summaries', sourceEpId: 'ep-42' });
    assert.ok(result.ref);
    const hits = store.recall('short summaries');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].record.sidecar.source, 'ep-42');
  });

  it('constructor throws if a mandatory dependency is missing', () => {
    assert.throws(() => createIdentity({ config, fs: fsStore, identityStore: store }), /bus/);
    assert.throws(() => createIdentity({ bus, fs: fsStore, identityStore: store }), /config/);
    assert.throws(() => createIdentity({ bus, config, identityStore: store }), /fs/);
    assert.throws(() => createIdentity({ bus, config, fs: fsStore }), /identityStore/);
  });
});
