'use strict';

// Phase 4 / Area B — V10 consolidate dedup + contradiction handling.
//
// Pre-Phase-4: each consolidation pass wrote a fresh consolidated-<ts> topic
// with no dedup/merge scan. Over time the same fact accumulated N times and
// stale facts never got reconciled. Spec calls this V10.
//
// Phase 4 fix: mergeConsolidatedTopics() scans existing Semantic/consolidated-*.md
// files when >= CONSOLIDATE_MERGE_MIN accumulate, asks the brain to dedup +
// reconcile contradictions, then rewrites them as ONE canonical topic.
//
// We use a real tmpdir + MYTHOS_VAULT_ROOT because createMemory builds its
// own fs store from config (mirrors test/memory.test.js pattern).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fsNode = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { createMemory } = require('../src/core/memory/index');

let tmpDir;
let originalVaultRoot;

function setupTmpVault() {
  tmpDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'mythos-phase4b-'));
  originalVaultRoot = process.env.MYTHOS_VAULT_ROOT;
  process.env.MYTHOS_VAULT_ROOT = tmpDir;
  fsNode.mkdirSync(path.join(tmpDir, 'Semantic'), { recursive: true });
  fsNode.mkdirSync(path.join(tmpDir, 'Episodic'), { recursive: true });
}

function teardownTmpVault() {
  if (originalVaultRoot === undefined) delete process.env.MYTHOS_VAULT_ROOT;
  else process.env.MYTHOS_VAULT_ROOT = originalVaultRoot;
  try { fsNode.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

function writeTopic(name, facts) {
  var content = '## ' + name + '\n\n<!-- {"id":"sem-' + name + '","ts":' + Date.now() + ',"confidence":0.6} -->\n' +
    facts.map(function (f) { return '- ' + f; }).join('\n') + '\n';
  fsNode.writeFileSync(path.join(tmpDir, 'Semantic', name + '.md'), content);
}

function listConsolidated() {
  return fsNode.readdirSync(path.join(tmpDir, 'Semantic'))
    .filter(function (n) { return /^consolidated-/.test(n); });
}

function fakeBrain(mergedFacts, droppedNote) {
  return {
    think: async function (opts) {
      if (opts.source === 'memory:consolidate-merge') {
        var payload = { facts: mergedFacts };
        if (droppedNote) payload.dropped = [droppedNote];
        return { content: 'ok', parsed: payload, offline: false };
      }
      // Other brain calls in consolidate (distill, user-facts) — return offline
      // so they no-op and we isolate the merge path.
      return { content: null, parsed: null, offline: true };
    }
  };
}

async function makeMemory(opts) {
  var memory = createMemory({
    config: Object.assign({
      MYTHOS_VAULT_ROOT: tmpDir,
      CONSOLIDATE_MERGE_MIN: 3,
      EPISODIC_RETENTION_DAYS: 30
    }, opts.config || {}),
    bus: opts.bus || { emit: function () {} },
    logger: { info: function () {}, warn: function () {}, error: function () {} },
    brain: opts.brain || null
  });
  await memory.init();
  return memory;
}

describe('Phase 4 / Area B — mergeConsolidatedTopics (V10)', function () {

  beforeEach(setupTmpVault);
  afterEach(teardownTmpVault);

  it('skips silently when fewer than CONSOLIDATE_MERGE_MIN topics exist (idle-skip)', async function () {
    writeTopic('consolidated-1', ['fact one']);
    writeTopic('consolidated-2', ['fact two']);
    var brainCalls = 0;
    var brain = { think: async function (opts) {
      if (opts.source === 'memory:consolidate-merge') brainCalls++;
      return { offline: true };
    } };
    var memory = await makeMemory({ brain: brain });
    await memory.consolidate({});
    assert.equal(brainCalls, 0, 'brain must not be called when below threshold');
    assert.equal(listConsolidated().length, 2, 'nothing merged');
  });

  it('fires the merge brain call when >= CONSOLIDATE_MERGE_MIN topics exist', async function () {
    writeTopic('consolidated-1', ['user likes dark mode']);
    writeTopic('consolidated-2', ['user prefers dark mode']);
    writeTopic('consolidated-3', ['user uses vim']);
    var brain = fakeBrain(['user prefers dark mode', 'user uses vim']);
    var memory = await makeMemory({ brain: brain });
    await memory.consolidate({});
    var remaining = listConsolidated();
    assert.equal(remaining.length, 1, 'all old consolidated-* files collapse into one');
    var mergedContent = fsNode.readFileSync(path.join(tmpDir, 'Semantic', remaining[0]), 'utf8');
    assert.ok(mergedContent.indexOf('user prefers dark mode') !== -1);
    assert.ok(mergedContent.indexOf('user uses vim') !== -1);
  });

  it('emits memory.merged with input/output counts', async function () {
    writeTopic('consolidated-1', ['a', 'b']);
    writeTopic('consolidated-2', ['a', 'c']);
    writeTopic('consolidated-3', ['d']);
    var events = [];
    var bus = { emit: function (n, p) { events.push({ name: n, payload: p }); } };
    var brain = fakeBrain(['a', 'b', 'c', 'd']);
    var memory = await makeMemory({ brain: brain, bus: bus });
    await memory.consolidate({});
    var merged = events.find(function (e) { return e.name === 'memory.merged'; });
    assert.ok(merged, 'memory.merged event must fire');
    assert.equal(merged.payload.inputTopics, 3);
    assert.equal(merged.payload.inputFacts, 5);   // 2 + 2 + 1 across the three topics
    assert.equal(merged.payload.outputFacts, 4);
  });

  it('does NOT touch non-consolidated topic files (user-facts, named topics)', async function () {
    writeTopic('consolidated-1', ['a']);
    writeTopic('consolidated-2', ['b']);
    writeTopic('consolidated-3', ['c']);
    writeTopic('user-facts', ['important operator fact']);
    writeTopic('deploy-procedure', ['step one']);
    var brain = fakeBrain(['a', 'b', 'c']);
    var memory = await makeMemory({ brain: brain });
    await memory.consolidate({});
    assert.ok(fsNode.existsSync(path.join(tmpDir, 'Semantic', 'user-facts.md')), 'user-facts.md must survive');
    assert.ok(fsNode.existsSync(path.join(tmpDir, 'Semantic', 'deploy-procedure.md')), 'named topics must survive');
  });

  it('returns silently when brain is null (no infrastructure)', async function () {
    writeTopic('consolidated-1', ['a']);
    writeTopic('consolidated-2', ['b']);
    writeTopic('consolidated-3', ['c']);
    var memory = await makeMemory({ brain: null });
    await memory.consolidate({});
    assert.equal(listConsolidated().length, 3, 'nothing merged when brain absent');
  });

  it('returns silently when brain returns offline (no provider available)', async function () {
    writeTopic('consolidated-1', ['a']);
    writeTopic('consolidated-2', ['b']);
    writeTopic('consolidated-3', ['c']);
    var brain = { think: async function () { return { content: null, offline: true }; } };
    var memory = await makeMemory({ brain: brain });
    await memory.consolidate({});
    assert.equal(listConsolidated().length, 3, 'nothing merged when brain offline');
  });

  it('respects a higher CONSOLIDATE_MERGE_MIN threshold from config', async function () {
    writeTopic('consolidated-1', ['a']);
    writeTopic('consolidated-2', ['b']);
    writeTopic('consolidated-3', ['c']);
    var brainCalls = 0;
    var brain = { think: async function (opts) {
      if (opts.source === 'memory:consolidate-merge') brainCalls++;
      return { offline: true };
    } };
    var memory = await makeMemory({ brain: brain, config: { CONSOLIDATE_MERGE_MIN: 5 } });
    await memory.consolidate({});
    assert.equal(brainCalls, 0, 'brain must not fire below the configured threshold');
  });

});
