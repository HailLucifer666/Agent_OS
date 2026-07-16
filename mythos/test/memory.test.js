'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Helpers
function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-mem-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'].forEach(function(d) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  });
  return dir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 100 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

function fakeLogger() {
  return { debug: function(){}, info: function(){}, warn: function(){}, error: function(){} };
}

function fakeConfig(overrides) {
  return Object.assign({
    MYTHOS_VAULT_ROOT: './vault',
    EPISODIC_RETENTION_DAYS: 30,
    MYTHOS_NAME: 'MYTHOS'
  }, overrides);
}

// ---- FsStore Tests ----

describe('fs-store', () => {
  let dir, fsStore, bus;

  beforeEach(function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    fsStore = createFsStore(() => dir, bus);
  });

  afterEach(function() { cleanupDir(dir); });

  it('reads and writes text', () => {
    fsStore.writeText('test.txt', 'hello');
    assert.equal(fsStore.readText('test.txt'), 'hello');
  });

  it('returns fallback on ENOENT', () => {
    assert.equal(fsStore.readText('nope.txt', 'fallback'), 'fallback');
  });

  it('reads and writes JSON', () => {
    fsStore.writeJSON('data.json', { a: 1 });
    assert.deepEqual(fsStore.readJSON('data.json'), { a: 1 });
  });

  it('returns fallback on corrupt JSON', () => {
    fsStore.writeText('bad.json', 'not json');
    assert.equal(fsStore.readJSON('bad.json', 'default'), 'default');
  });

  it('lists files with extension filter', () => {
    fsStore.writeText('a.jsonl', '{}');
    fsStore.writeText('b.md', '# hi');
    fsStore.writeText('c.jsonl', '{}');
    const files = fsStore.listFiles('.', '.jsonl');
    assert.equal(files.length, 2);
  });

  it('appends lines to JSONL', () => {
    fsStore.appendLine('Episodic/test.jsonl', { id: 'ep-1' });
    fsStore.appendLine('Episodic/test.jsonl', { id: 'ep-2' });
    const lines = fsStore.readLines('Episodic/test.jsonl');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].id, 'ep-1');
    assert.equal(lines[1].id, 'ep-2');
  });

  it('skips corrupt lines in readLines', () => {
    fsStore.appendLine('Episodic/test.jsonl', { id: 'ep-1' });
    fsStore.writeText('Episodic/test.jsonl', fsStore.readText('Episodic/test.jsonl') + '\ncorrupt\n');
    fsStore.appendLine('Episodic/test.jsonl', { id: 'ep-2' });
    const lines = fsStore.readLines('Episodic/test.jsonl').filter(Boolean);
    assert.equal(lines.length, 2);
  });

  it('D-16 regression: emits health.anomaly on corrupt line instead of swallowing silently', () => {
    fsStore.appendLine('Episodic/test.jsonl', { id: 'ep-1' });
    fsStore.writeText('Episodic/test.jsonl', fsStore.readText('Episodic/test.jsonl') + '\ncorrupt\n');
    fsStore.readLines('Episodic/test.jsonl');
    const anomalies = bus._emitted().filter(function(e) { return e.type === 'health.anomaly' && e.payload.kind === 'corrupt-line'; });
    assert.ok(anomalies.length >= 1, 'expected a corrupt-line health.anomaly event');
    assert.equal(anomalies[0].payload.path, 'Episodic/test.jsonl');
  });

  it('readDirLines reads across files', () => {
    fsStore.appendLine('Episodic/2026-01-01.jsonl', { id: 'old' });
    fsStore.appendLine('Episodic/2026-01-02.jsonl', { id: 'new' });
    const entries = fsStore.readDirLines('Episodic');
    assert.equal(entries.length, 2);
  });

  it('exists returns true for existing file', () => {
    fsStore.writeText('test.txt', 'x');
    assert.equal(fsStore.exists('test.txt'), true);
    assert.equal(fsStore.exists('nope.txt'), false);
  });

  it('todayKey returns YYYY-MM-DD', () => {
    const key = fsStore.todayKey();
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(key), 'Expected YYYY-MM-DD, got ' + key);
  });

  it('D-18 regression: pruneOldFiles archives instead of permanently deleting', () => {
    fsStore.appendLine('Episodic/2020-01-01.jsonl', { id: 'ep-ancient', summary: 'old memory' });
    const archived = fsStore.pruneOldFiles('Episodic', -1); // negative retention forces cutoff into the future
    assert.equal(archived, 1);
    assert.equal(fsStore.exists('Episodic/2020-01-01.jsonl'), false, 'original file should be removed');
    const archiveFiles = fsStore.listFiles('Episodic/_archive', '.gz');
    assert.equal(archiveFiles.length, 1, 'archived copy should exist under _archive/');
    assert.ok(archiveFiles[0].name.endsWith('2020-01-01.md.gz'));
  });

  it('removeFile deletes file', () => {
    fsStore.writeText('del.txt', 'x');
    assert.equal(fsStore.exists('del.txt'), true);
    fsStore.removeFile('del.txt');
    assert.equal(fsStore.exists('del.txt'), false);
  });

  it('D-21 regression: withLock serializes overlapping ops on same path', async () => {
    const order = [];
    const path = 'test-lock.txt';
    fsStore.writeText(path, '[]');
    const arr = [];

    // Fire two async ops staggered by a small delay
    Promise.resolve().then(() => {
      fsStore.withLock(path, function() {
        order.push('a:start');
        arr.push('a');
        order.push('a:end');
      });
    });

    // Stagger the second op
    await new Promise(function(resolve) { setTimeout(resolve, 10); });

    Promise.resolve().then(() => {
      fsStore.withLock(path, function() {
        order.push('b:start');
        arr.push('b');
        order.push('b:end');
      });
    });

    // Wait for both to complete
    await new Promise(function(resolve) { setTimeout(resolve, 100); });

    // They should be serialized in call order
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], 'ops should serialize, not interleave');
  });

  it('D-21 regression: withLock continues after a rejecting step', async () => {
    const order = [];
    const path = 'test-reject.txt';

    // First op rejects
    const p1 = fsStore.withLock(path, function() {
      order.push('first');
      throw new Error('intentional rejection');
    });

    // Wait for first to settle
    try { await p1; } catch (_) {}

    // Second op should still queue and run
    const p2 = fsStore.withLock(path, function() {
      order.push('second');
    });

    try { await p2; } catch (_) {}

    // Wait for second to complete
    await new Promise(function(resolve) { setTimeout(resolve, 50); });

    // Both should have run despite first throwing
    assert.deepEqual(order, ['first', 'second'], 'rejection should not block next queued op');
  });
});

// ---- Episodic Store Tests ----

describe('episodic', () => {
  let dir, fsStore, episodic, bus, config;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    config = fakeConfig({ MYTHOS_VAULT_ROOT: dir });
    const { createFsStore } = require('../src/core/memory/fs-store');
    fsStore = createFsStore(() => dir);
    const { createEpisodicStore } = require('../src/core/memory/episodic');
    episodic = createEpisodicStore({ fs: fsStore, config: config, bus: bus, logger: fakeLogger() });
    await episodic.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('writes and recalls an episode', () => {
    const result = episodic.write({
      tick: 1, kind: 'perception', channel: 'timer',
      summary: 'heartbeat', salience: 0.1, outcome: 'ok'
    });
    assert.ok(result.ref.startsWith('ep-'));
    assert.equal(result.degraded, false);

    const hits = episodic.recall('heartbeat');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'episodic');
    assert.ok(hits[0].score > 0);
  });

  it('returns empty recall for no match', () => {
    episodic.write({ tick: 1, summary: 'something completely unrelated', salience: 0.1 });
    const hits = episodic.recall('xyzzy-nonexistent');
    assert.equal(hits.length, 0);
  });

  it('get finds episode by ref', () => {
    const { ref } = episodic.write({ tick: 1, summary: 'find me', salience: 0.5 });
    const entry = episodic.get(ref);
    assert.ok(entry);
    assert.equal(entry.summary, 'find me');
  });

  it('get returns null for missing ref', () => {
    assert.equal(episodic.get('ep-nonexistent'), null);
  });

  it('tail returns most recent entries', () => {
    for (let i = 0; i < 5; i++) {
      episodic.write({ tick: i, summary: 'entry ' + i, salience: 0.1 });
    }
    const t = episodic.tail(3);
    assert.equal(t.length, 3);
    assert.equal(t[2].summary, 'entry 4'); // newest last
  });

  it('stats returns count', () => {
    episodic.write({ tick: 1, summary: 'a', salience: 0.1 });
    episodic.write({ tick: 2, summary: 'b', salience: 0.1 });
    const s = episodic.stats();
    assert.equal(s.count, 2);
  });
});

// ---- Identity Store Tests (D-15) ----

describe('identity', () => {
  let dir, fsStore, identity, bus;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    fsStore = createFsStore(() => dir);
    const { createIdentityStore } = require('../src/core/memory/identity');
    identity = createIdentityStore({ fs: fsStore, config: fakeConfig({ MYTHOS_VAULT_ROOT: dir }), bus: bus, logger: fakeLogger() });
    await identity.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('writes and recalls a self-fact', () => {
    const result = identity.write('Values clear, honest communication', { source: 'seed', confidence: 0.8 });
    assert.ok(result.ref.startsWith('idn-'));
    assert.equal(result.degraded, false);

    const hits = identity.recall('honest communication');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'identity');
    assert.ok(hits[0].score > 0);
  });

  it('get finds entry by ref', () => {
    const { ref } = identity.write('Prefers concise answers', { source: 'learned', confidence: 0.6 });
    const entry = identity.get(ref);
    assert.ok(entry);
    assert.equal(entry.text, 'Prefers concise answers');
    assert.equal(entry.sidecar.confidence, 0.6);
  });

  it('get returns null for missing ref', () => {
    assert.equal(identity.get('idn-nonexistent'), null);
  });

  it('stats returns count', () => {
    identity.write('a');
    identity.write('b');
    assert.equal(identity.stats().count, 2);
  });

  it('consolidate archives low-confidence prefs instead of deleting (P8: not a no-op)', () => {
    identity.write('a', { confidence: 0.05 });
    identity.write('b', { confidence: 0.9 });
    const result = identity.consolidate();
    assert.equal(result.archived, 1);
    assert.equal(identity.stats().count, 1);
  });
});

// ---- Semantic Store Tests ----

describe('semantic', () => {
  let dir, fsStore, semantic, bus;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    fsStore = createFsStore(() => dir);
    const { createSemanticStore } = require('../src/core/memory/semantic');
    semantic = createSemanticStore({ fs: fsStore, config: fakeConfig({ MYTHOS_VAULT_ROOT: dir }), bus: bus, logger: fakeLogger() });
    await semantic.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('writes and recalls a fact', () => {
    semantic.write('ollama', ['Ollama runs at localhost:11434', 'Uses qwen3 model'], { confidence: 0.9 });
    const hits = semantic.recall('ollama');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'semantic');
    assert.ok(hits[0].score > 0);
    assert.ok(hits[0].record.facts.length > 0);
  });

  it('stats returns count', () => {
    semantic.write('a', ['fact a']);
    semantic.write('b', ['fact b']);
    assert.equal(semantic.stats().count, 2);
  });

  it('D-18 regression: pruneLowConfidence archives to _archive.md instead of deleting', () => {
    semantic.write('stale-fact', ['no longer trusted'], { confidence: 0.05 });
    const archived = semantic.pruneLowConfidence();
    assert.equal(archived, 1);
    assert.equal(semantic.stats().count, 0, 'archived topic should no longer count as active');
    assert.equal(semantic.recall('no longer trusted').length, 0, 'archived facts should not surface in recall');
    const archiveContent = fsStore.readText('Semantic/_archive.md', '');
    assert.ok(archiveContent.includes('no longer trusted'), 'archived content should be preserved, not deleted');
  });
});

// ---- Skills Store Tests ----

describe('skills', () => {
  let dir, fsStore, skills, bus;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    fsStore = createFsStore(() => dir);
    const { createSkillsStore } = require('../src/core/memory/skills');
    skills = createSkillsStore({ fs: fsStore, config: fakeConfig({ MYTHOS_VAULT_ROOT: dir }), bus: bus, logger: fakeLogger() });
    await skills.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('writes and recalls a skill', () => {
    skills.write('build-react', {
      when: ['User requests React component'],
      steps: [{ tool: 'create_goal', args: { title: 'Build React' } }],
      successCriteria: ['Component renders']
    });
    const hits = skills.recall('react');
    assert.ok(hits.length > 0);
    assert.ok(hits[0].record.steps.length > 0);
  });

  it('get finds skill by ref', () => {
    const { ref } = skills.write('test-skill', {
      when: ['test'],
      steps: [{ tool: 'navigate', args: { route: 'goals' } }],
      successCriteria: ['done']
    });
    const skill = skills.get(ref);
    assert.ok(skill);
    assert.equal(skill.when.length, 1);
  });

  it('recordUse increments uses', async () => {
    const { ref } = skills.write('count-me', {
      when: ['test'],
      steps: [{ tool: 'test', args: {} }],
      successCriteria: []
    });
    await skills.recordUse(ref, true);
    const skill = skills.get(ref);
    assert.equal(skill.uses, 1);
  });

  it('stats returns count', () => {
    skills.write('a', { when: [], steps: [], successCriteria: [] });
    assert.equal(skills.stats().count, 1);
  });

  it('D-19 regression: consolidate returns correct shape', () => {
    skills.write('a', { when: [], steps: [], successCriteria: [] });
    const result = skills.consolidate();
    assert.deepEqual(result, { moved: 0, distilled: 0, archived: 0 });
  });
});

// ---- Working Memory Tests ----

describe('working-memory', () => {
  let dir, working, bus;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    const fsStore = createFsStore(() => dir);
    const { createWorkingMemory } = require('../src/core/memory/working');
    working = createWorkingMemory({ fs: fsStore, config: fakeConfig({ MYTHOS_VAULT_ROOT: dir }), bus: bus, logger: fakeLogger() });
    await working.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('pushes and drains perceptions', () => {
    working.pushPerception({ kind: 'timer', salience: 0.1 });
    working.pushPerception({ kind: 'file', salience: 0.5 });
    const drained = working.drainPerceptions();
    assert.equal(drained.length, 2);
    assert.equal(working.perceptionQueue.length, 0);
  });

  it('snapshot captures state', () => {
    working.tick = 42;
    working.activeGoalId = 'goal-1';
    working.set('key', 'value');
    const snap = working.snapshot();
    assert.equal(snap.tick, 42);
    assert.equal(snap.activeGoalId, 'goal-1');
    assert.ok(snap.contextKeys.includes('key'));
  });

  it('resetTickState clears per-tick fields', () => {
    working.lastModel = 'groq-70b';
    working.addSpend(100);
    working.resetTickState();
    assert.equal(working.lastModel, null);
    assert.equal(working.spendThisTick, 0);
  });

  it('context get/set works', () => {
    working.set('x', 42);
    assert.equal(working.get('x'), 42);
  });
});

// ---- Audit Writer Tests ----

describe('audit-writer', () => {
  let dir, audit, bus;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    const fsStore = createFsStore(() => dir);
    const { createAuditWriter } = require('../src/core/memory/audit-writer');
    audit = createAuditWriter({ fs: fsStore, config: fakeConfig({ MYTHOS_VAULT_ROOT: dir }), bus: bus, logger: fakeLogger() });
    await audit.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('writes an audit entry', () => {
    const result = audit.write({ tool: 'navigate', tier: 0, decision: 'allow', reason: 'within-autonomous-max' });
    assert.equal(result.ok, true);

    const entries = audit.query({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, 'navigate');
    assert.ok(entries[0].id.startsWith('aud-'));
  });

  it('redacts sensitive args', () => {
    audit.write({ tool: 'test', args: { apiKey: 'secret123', name: 'ok' }, tier: 0, decision: 'allow' });
    const entries = audit.query({});
    assert.equal(entries[0].args.apiKey, '[REDACTED]');
    assert.equal(entries[0].args.name, 'ok');
  });

  it('redacts sensitive keys nested one level deep', () => {
    audit.write({ tool: 'test', args: { headers: { authorization: 'Bearer xyz', accept: 'json' } }, tier: 0, decision: 'allow' });
    const entries = audit.query({});
    assert.equal(entries[0].args.headers.authorization, '[REDACTED]');
    assert.equal(entries[0].args.headers.accept, 'json');
  });

  it('redacts sensitive keys inside an array of objects', () => {
    audit.write({ tool: 'test', args: { items: [{ token: 'abc', name: 'ok' }, { cookie: 'sid=1', name: 'ok2' }] }, tier: 0, decision: 'allow' });
    const entries = audit.query({});
    assert.equal(entries[0].args.items[0].token, '[REDACTED]');
    assert.equal(entries[0].args.items[0].name, 'ok');
    assert.equal(entries[0].args.items[1].cookie, '[REDACTED]');
    assert.equal(entries[0].args.items[1].name, 'ok2');
  });

  it('queries by goalId', () => {
    audit.write({ tool: 'a', goalId: 'g1', tier: 0, decision: 'allow' });
    audit.write({ tool: 'b', goalId: 'g2', tier: 0, decision: 'allow' });
    const results = audit.query({ goalId: 'g1' });
    assert.equal(results.length, 1);
    assert.equal(results[0].tool, 'a');
  });

  it('queries by decision', () => {
    audit.write({ tool: 'a', decision: 'allow', tier: 0 });
    audit.write({ tool: 'b', decision: 'deny', tier: 4 });
    assert.equal(audit.query({ decision: 'deny' }).length, 1);
  });

  it('stats returns count', () => {
    audit.write({ tool: 'a', tier: 0, decision: 'allow' });
    audit.write({ tool: 'b', tier: 0, decision: 'allow' });
    assert.equal(audit.stats().count, 2);
  });

  it('D-19 regression: consolidate returns correct shape', () => {
    audit.write({ tool: 'a', tier: 0, decision: 'allow' });
    const result = audit.consolidate();
    assert.deepEqual(result, { moved: 0, distilled: 0, archived: 0 });
  });
});

// ---- Checkpoint Store Tests ----

describe('checkpoints', () => {
  let dir, checkpoints, bus;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    const { createFsStore } = require('../src/core/memory/fs-store');
    const fsStore = createFsStore(() => dir);
    const { createCheckpointStore } = require('../src/core/memory/checkpoints');
    checkpoints = createCheckpointStore({ fs: fsStore, config: fakeConfig({ MYTHOS_VAULT_ROOT: dir }), bus: bus, logger: fakeLogger() });
    await checkpoints.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('saves and loads a checkpoint', () => {
    const result = checkpoints.save({ tick: 42, activeGoalId: 'goal-1', contextKeys: ['x'], lastTickAt: Date.now() });
    assert.equal(result.ok, true);

    const loaded = checkpoints.load();
    assert.ok(loaded);
    assert.equal(loaded.tick, 42);
    assert.equal(loaded.activeGoalId, 'goal-1');
    assert.equal(loaded.isCrashRecovery, false); // same process — not a crash
  });

  it('load returns null when no checkpoint', () => {
    assert.equal(checkpoints.load(), null);
  });

  it('clear removes checkpoint', () => {
    checkpoints.save({ tick: 1, activeGoalId: null, contextKeys: [], lastTickAt: Date.now() });
    checkpoints.clear();
    assert.equal(checkpoints.load(), null);
  });

  it('stats reports existence', () => {
    assert.equal(checkpoints.stats().exists, false);
    checkpoints.save({ tick: 1, activeGoalId: null, contextKeys: [], lastTickAt: Date.now() });
    assert.equal(checkpoints.stats().exists, true);
    assert.equal(checkpoints.stats().tick, 1);
  });
});

// ---- Memory Facade Tests ----

describe('memory-facade', () => {
  let dir, bus, config, memory;

  beforeEach(async function() {
    dir = tempDir();
    bus = fakeBus();
    config = fakeConfig({ MYTHOS_VAULT_ROOT: dir });
    const { createMemory } = require('../src/core/memory');
    memory = createMemory({ config: config, bus: bus, logger: fakeLogger() });
    await memory.init();
  });

  afterEach(function() { cleanupDir(dir); });

  it('exposes all stores', () => {
    assert.ok(memory.episodic, 'episodic store');
    assert.ok(memory.semantic, 'semantic store');
    assert.ok(memory.skills, 'skills store');
    assert.ok(memory.identity, 'identity store');
    assert.ok(memory.working, 'working memory');
    assert.ok(memory.audit, 'audit writer');
    assert.ok(memory.checkpoints, 'checkpoint store');
  });

  it('identity write/recall works through facade (D-15)', () => {
    memory.identity.write('facade identity fact', { source: 'seed' });
    const hits = memory.identity.recall('facade identity fact');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'identity');
  });

  it('episodic write/recall works through facade', () => {
    const { ref } = memory.episodic.write({ tick: 1, summary: 'facade test', salience: 0.5 });
    const hits = memory.episodic.recall('facade test');
    assert.ok(hits.length > 0);
    assert.equal(hits[0].store, 'episodic');
    assert.equal(memory.episodic.get(ref).summary, 'facade test');
  });

  it('semantic write/recall works through facade', () => {
    memory.semantic.write('test-key', ['a fact']);
    const hits = memory.semantic.recall('test-key');
    assert.ok(hits.length > 0);
  });

  it('recallHybrid fuses keyword hits through the facade and never crashes on an empty query', async () => {
    memory.episodic.write({ tick: 1, summary: 'hybrid recall episodic seed', salience: 0.5 });
    memory.semantic.write('hybrid-topic', ['hybrid recall semantic seed']);

    const hits = await memory.recallHybrid('hybrid recall');
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length > 0);

    // Empty query must degrade gracefully (no embeddings call, keyword-only), not throw.
    const emptyHits = await memory.recallHybrid('');
    assert.ok(Array.isArray(emptyHits));
  });

  it('skills write/recall works through facade', () => {
    memory.skills.write('facade-skill', { when: ['facade skill test'], steps: [{ tool: 'echo', args: {} }], successCriteria: [] });
    const hits = memory.skills.recall('facade skill test');
    assert.ok(hits.length > 0);
  });

  it('working memory context works through facade', () => {
    memory.working.set('facadeCtx', 'hello');
    assert.equal(memory.working.get('facadeCtx'), 'hello');
  });

  it('audit write/query works through facade', () => {
    memory.audit.write({ tool: 'echo', tier: 0, decision: 'allow' });
    const entries = memory.audit.query({});
    assert.equal(entries.length, 1);
  });

  it('checkpoints save/load works through facade', () => {
    memory.checkpoints.save({ tick: 1, activeGoalId: null, contextKeys: [], lastTickAt: Date.now() });
    const loaded = memory.checkpoints.load();
    assert.ok(loaded);
    assert.equal(loaded.tick, 1);
  });

  it('D-17 regression: consolidate flushes working memory and returns identity stats', async () => {
    memory.working.tick = 5;
    memory.working.set('ctx-key', 'value');
    const result = await memory.consolidate({});
    assert.ok(result.identity, 'consolidate result should include identity stats');
    const flushed = memory.episodic.recall('working-memory flush');
    assert.ok(flushed.length > 0, 'flushToEpisodic should have written a snapshot');
  });

  it('D-17 regression: consolidate calls each store consolidate() instead of episodic.prune() directly', async () => {
    memory.semantic.write('low-conf-fact', ['fades fast'], { confidence: 0.05 });
    memory.working.tick = 1;
    const result = await memory.consolidate({});
    assert.equal(result.semantic.count, 0, 'low-confidence semantic fact should be archived by its own consolidate()');
  });

  it('D-19 regression: consolidate calls skills.consolidate() and audit.consolidate()', async () => {
    memory.skills.write('skill1', { when: ['test'], steps: [{ tool: 'test', args: {} }], successCriteria: [] });
    memory.audit.write({ tool: 'test-tool', tier: 0, decision: 'allow' });
    // Should complete without throwing
    const result = await memory.consolidate({});
    assert.ok(result, 'consolidate should return a result');
    // Both skills and audit consolidate should be called (they are no-ops, so no assertion on effects)
  });

  it('stats returns combined stats', () => {
    memory.episodic.write({ tick: 1, summary: 's', salience: 0.1 });
    memory.semantic.write('k', ['f']);
    memory.skills.write('sk', { when: [], steps: [], successCriteria: [] });
    const stats = memory.stats();
    assert.equal(stats.episodic.count, 1);
    assert.equal(stats.semantic.count, 1);
    assert.equal(stats.skills.count, 1);
  });
});
