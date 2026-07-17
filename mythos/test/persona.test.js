'use strict';

// Phase-1 Jarvis upgrade: persona levels store + composition + voice tools.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { buildTools } = require('../src/core/effectors/from-persona');

function fakeConfig(overrides) {
  return Object.assign({ MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2 }, overrides);
}

describe('persona levels', () => {
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

  it('defaults to the blend levels when persona.json is absent', () => {
    assert.deepEqual(identity.getPersonaLevels(), {
      humor: 6, warmth: 6, formality: 5, sass: 4, proactivity: 6, terseness: 5, strictness: 4
    });
  });

  it('legacy persona.json files without strictness merge in the default for the missing key', () => {
    // Simulates a persona.json written before this phase (no strictness key).
    fsStore.writeJSON('Identity/persona.json', { humor: 9, warmth: 6, formality: 5, sass: 4, proactivity: 6, terseness: 5 });
    const identity2 = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    return identity2.init().then(() => {
      assert.equal(identity2.getPersonaLevels().humor, 9); // stored value preserved
      assert.equal(identity2.getPersonaLevels().strictness, 4); // missing key defaulted
    });
  });

  it('persona() keeps the "You are X." prefix and appends style + guardrail', () => {
    const p = identity.persona();
    assert.match(p, /^You are MYTHOS\./);
    assert.match(p, /Style: /);
    assert.match(p, /Regardless of style settings/);
  });

  it('setPersonaLevel persists to Identity/persona.json and changes directives', () => {
    const res = identity.setPersonaLevel('humor', 10);
    assert.equal(res.ok, true);
    assert.equal(res.value, 10);
    assert.equal(fsStore.readJSON('Identity/persona.json', {}).humor, 10);
    assert.match(identity.persona(), /Weave in dry wit freely/);
    identity.setPersonaLevel('humor', 0);
    assert.match(identity.persona(), /No jokes/);
  });

  it('setPersonaLevel clamps out-of-range values and rejects unknown traits', () => {
    assert.equal(identity.setPersonaLevel('sass', 15).value, 10);
    assert.equal(identity.setPersonaLevel('sass', -3).value, 0);
    const bad = identity.setPersonaLevel('charisma', 5);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Unknown trait/);
    const nan = identity.setPersonaLevel('humor', 'loud');
    assert.equal(nan.ok, false);
  });

  it('levels survive a re-init (loaded from persona.json)', async () => {
    identity.setPersonaLevel('formality', 9);
    const identity2 = createIdentity({ bus, config, fs: fsStore, identityStore: store });
    await identity2.init();
    assert.equal(identity2.getPersonaLevels().formality, 9);
  });

  it('strictness dial shapes the style directive at each band boundary', () => {
    identity.setPersonaLevel('strictness', 8);
    assert.match(identity.persona(), /Drill-sergeant accountability/);
    identity.setPersonaLevel('strictness', 5);
    assert.match(identity.persona(), /Hold the user to their plan/);
    identity.setPersonaLevel('strictness', 3);
    assert.match(identity.persona(), /Gentle nudges only/);
    identity.setPersonaLevel('strictness', 0);
    assert.doesNotMatch(identity.persona(), /Drill-sergeant|Hold the user to their plan|Gentle nudges only/);
  });

  it('persona() folds in the newest learned preferences (max 5)', async () => {
    for (let i = 1; i <= 7; i++) {
      await identity.learn({ signal: null, text: 'Pref number ' + i, sourceEpId: 'ep-' + i });
    }
    const p = identity.persona();
    assert.match(p, /What you know about the operator:/);
    assert.match(p, /Pref number 7/);   // newest first
    assert.doesNotMatch(p, /Pref number 1/); // older than the top 5
  });
});

describe('from-persona voice tools', () => {
  let dir, fsStore, store, identity, bus, tools;

  function toolByName(name) {
    for (const t of tools) if (t.name === name) return t;
    throw new Error('tool not found: ' + name);
  }

  beforeEach(async function() {
    dir = tempVaultDir();
    bus = fakeBus();
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config: fakeConfig(), bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    identity = createIdentity({ bus, config: fakeConfig(), fs: fsStore, identityStore: store });
    await identity.init();
    tools = buildTools({ identity });
  });

  afterEach(function() { cleanupVaultDir(dir); });

  it('persona_status returns the live levels', () => {
    const res = toolByName('persona_status').fn({});
    assert.equal(res.ok, true);
    assert.equal(res.result.levels.humor, 6);
  });

  it('set_persona_level accepts numeric values and synonyms', () => {
    const res = toolByName('set_persona_level').fn({ trait: 'sarcasm', value: 8 });
    assert.equal(res.ok, true);
    assert.equal(res.result.trait, 'sass');
    assert.equal(res.result.value, 8);
  });

  it('set_persona_level nudges with up/down', () => {
    const up = toolByName('set_persona_level').fn({ trait: 'humor', value: 'up' });
    assert.equal(up.result.value, 8); // 6 + 2
    const down = toolByName('set_persona_level').fn({ trait: 'humor', value: 'down' });
    assert.equal(down.result.value, 6);
  });

  it('inverse synonyms flip direction: "more verbose" lowers terseness', () => {
    const res = toolByName('set_persona_level').fn({ trait: 'verbose', value: 'up' });
    assert.equal(res.ok, true);
    assert.equal(res.result.trait, 'terseness');
    assert.equal(res.result.value, 3); // 5 - 2
  });

  it('unknown trait fails honestly', () => {
    const res = toolByName('set_persona_level').fn({ trait: 'chaos', value: 5 });
    assert.equal(res.ok, false);
  });

  it('strictness synonyms resolve to the canonical trait', () => {
    for (const syn of ['strict', 'strictness', 'coach', 'drill sergeant', 'accountability']) {
      const res = toolByName('set_persona_level').fn({ trait: syn, value: 7 });
      assert.equal(res.ok, true, syn + ' should resolve');
      assert.equal(res.result.trait, 'strictness');
      assert.equal(res.result.value, 7);
    }
  });
});
