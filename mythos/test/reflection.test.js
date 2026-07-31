'use strict';

// Phase-4 Jarvis upgrade: the learning loop — preference extraction from
// conversation episodics via identity.learn(), with dedupe + style mirroring.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createIdentityStore } = require('../src/core/memory/identity');
const { createIdentity } = require('../src/core/identity');
const { createReflection } = require('../src/core/identity/reflection');

function fakeConfig() { return { MYTHOS_NAME: 'MYTHOS', AUTONOMOUS_MAX_TIER: 2, REFLECTION_EVERY_TURNS: 3 }; }

function fakeConvos(n) {
  const hits = [];
  for (let i = 0; i < n; i++) {
    hits.push({ record: { summary: 'User: turn number ' + i + ' | MYTHOS: reply ' + i }, snippet: '' });
  }
  return hits;
}

describe('reflection learning loop', () => {
  let dir, fsStore, store, identity, bus, brainReplies, thinkCalls, reflection;

  function fakeBrain() {
    return {
      async think() {
        thinkCalls += 1;
        const parsed = brainReplies.shift();
        if (!parsed) return { offline: true };
        return { content: JSON.stringify(parsed), parsed, offline: false };
      }
    };
  }

  function fakeMemory(convoCount) {
    return {
      identity: store,
      episodic: { recall: () => fakeConvos(convoCount) }
    };
  }

  beforeEach(async () => {
    dir = tempVaultDir();
    bus = fakeBus();
    thinkCalls = 0;
    brainReplies = [];
    fsStore = createFsStore(() => dir);
    store = createIdentityStore({ fs: fsStore, config: fakeConfig(), bus, logger: { debug(){}, info(){}, warn(){}, error(){} } });
    await store.init();
    identity = createIdentity({ bus, config: fakeConfig(), fs: fsStore, identityStore: store });
    await identity.init();
  });

  afterEach(() => cleanupVaultDir(dir));

  it('writes up to 3 preferences + the style line', async () => {
    brainReplies.push({ preferences: ['Prefers short spoken answers', 'Calls builds "light speed" runs', 'Works late at night'], style: 'Terse, voice-transcribed, uses slang.' });
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    const res = await reflection.runNow('test');
    assert.equal(res.written, 3);
    assert.equal(res.styleUpdated, true);
    assert.match(store.readRaw(), /Prefers short spoken answers/);
    assert.match(identity.persona(), /Operator speaking style/);
    assert.match(identity.persona(), /Prefers short spoken answers/);
  });

  // The durable-facts counterpart to the capped preference list: reflection
  // rewrites the whole profile each pass, so it accumulates without an eviction
  // policy — and a degenerate reply must not blank what is already there.
  it('rewrites the durable operator profile and folds it into persona()', async () => {
    brainReplies.push({
      preferences: [],
      style: '',
      profile: 'Address them as sir.\nDaughter: Mira.\nBuilding MYTHOS on two machines.',
    });
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    const res = await reflection.runNow('test');
    assert.equal(res.profileUpdated, true);
    assert.match(identity.getOperatorProfile(), /Daughter: Mira/);
    assert.match(identity.persona(), /Operator profile \(durable facts/);
  });

  it('a missing or too-short profile field leaves an existing profile intact', async () => {
    identity.setOperatorProfile('Address them as sir.\nDaughter: Mira.');
    brainReplies.push({ preferences: [], style: '', profile: '' });
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    const res = await reflection.runNow('test');
    assert.equal(res.profileUpdated, false);
    assert.match(identity.getOperatorProfile(), /Daughter: Mira/);
  });

  it('second pass skips near-duplicates', async () => {
    brainReplies.push({ preferences: ['Prefers short spoken answers'], style: '' });
    brainReplies.push({ preferences: ['prefers short spoken answers', 'A genuinely new fact about workflow'], style: '' });
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    await reflection.runNow('test');
    const res2 = await reflection.runNow('test');
    assert.equal(res2.written, 1); // duplicate dropped, new fact kept
    const raw = store.readRaw();
    assert.equal((raw.match(/short spoken answers/gi) || []).length, 1);
  });

  it('skips when too few conversations or brain offline', async () => {
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(2), identity, config: fakeConfig() });
    assert.equal((await reflection.runNow('test')).skipped, 'too-few-conversations');
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    assert.equal((await reflection.runNow('test')).skipped, 'brain-unavailable'); // brainReplies empty → offline
  });

  it('noteTurn fires a pass every REFLECTION_EVERY_TURNS turns', async () => {
    brainReplies.push({ preferences: [], style: '' });
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    reflection.noteTurn();
    reflection.noteTurn();
    assert.equal(thinkCalls, 0);
    reflection.noteTurn(); // 3rd turn → fires (config: 3)
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(thinkCalls, 1);
  });

  it('rejects garbage preference shapes (too short/long)', async () => {
    brainReplies.push({ preferences: ['ok', 'x'.repeat(500), 'A perfectly reasonable durable fact'], style: '' });
    reflection = createReflection({ brain: fakeBrain(), memory: fakeMemory(10), identity, config: fakeConfig() });
    const res = await reflection.runNow('test');
    assert.equal(res.written, 1);
  });
});
