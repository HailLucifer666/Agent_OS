'use strict';

// Regression tests for the read-mutate-write data-loss class (2026-08-02 audit).
//
// fs-store.js exposes two readers: readJSON (lenient — a corrupt file returns the
// fallback, indistinguishable from "empty") and readJSONStrict (throws
// EJSONCORRUPT). Any store that loads a collection, mutates it, and writes it back
// MUST use the strict variant; otherwise one corrupt JSON truncates the whole store
// behind ok:true. This is the same class as the 2026-07-31 reminders fix.
//
// kanban.js, orchestrator.js, and build-runner.js were still on the lenient reader.
// Each test below seeds a store with real rows, corrupts the file, then performs a
// mutation — asserting the mutation REFUSES (throws / surfaces failure) rather than
// silently writing an empty collection over the real data.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createOrchestrator } = require('../src/core/effectors/orchestrator');
const { createBuildRunner } = require('../src/core/effectors/build-runner');

// A real fs-store over a temp vault, so readJSONStrict actually hits the disk.
const { createFsStore } = require('../src/core/memory/fs-store');

function tmpVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-rmw-'));
  const store = createFsStore(() => dir, null);
  return { dir, store };
}

function corrupt(file) {
  // Two real rows then a truncated closing brace — unparseable.
  fs.writeFileSync(file, '{ "cards": [ {"id":"c1"} ], ', 'utf8');
}

describe('read-mutate-write stores refuse to truncate on corrupt JSON', () => {
  it('kanban.addCard throws instead of wiping Kanban.json', () => {
    const { dir, store } = tmpVault();
    const file = path.join(dir, 'Kanban.json');
    corrupt(file);
    const kanban = createKanbanEffector({ fs: store });
    assert.throws(() => kanban.addCard('x'), /unparseable JSON|EJSONCORRUPT|corrupt/i);
    // The corrupt file must NOT have been overwritten with an empty board.
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!/^\{\s*"cards":\s*\[\s*\]/.test(raw), 'kanban truncated the store behind a corrupt read');
  });

  it('orchestrator.init surfaces a corrupt missions.json instead of starting empty', () => {
    const { dir, store } = tmpVault();
    const file = path.join(dir, 'Checkpoints', 'missions.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[ {"id":"m1","status":"done"}, ', 'utf8'); // truncated
    const buildRunner = { onJobUpdate: () => () => {} };
    const agentActions = { assembleKanbanPlan: () => ({ job: { id: 'p1' } }) };
    const kanban = { findCard: () => null };
    const bus = { emit() {} };
    const orch = createOrchestrator({ buildRunner, kanban, agentActions, brain: null, bus, fs: store });
    // init() must not swallow the corruption into a silent fresh start.
    assert.throws(() => orch.init(), /unparseable JSON|EJSONCORRUPT|corrupt|read-failed/i);
  });

  it('build-runner construction surfaces a corrupt build-jobs.json instead of starting empty', () => {
    const { dir, store } = tmpVault();
    const file = path.join(dir, 'Checkpoints', 'build-jobs.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "jobs": [ {"id":"j1","status":"done"}, ', 'utf8'); // truncated
    const bus = { emit() {} };
    const brain = { think: async () => ({ content: '{}' }) };
    // loadPersisted() runs at construction; a corrupt store must not be read as {jobs:[]}.
    assert.throws(
      () => createBuildRunner({ config: {}, brain, bus, vault: store }),
      /unparseable JSON|EJSONCORRUPT|corrupt|load-failed/i
    );
  });
});
