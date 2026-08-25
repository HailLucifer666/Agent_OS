'use strict';

// TASK B1 — "tell the brain what the update changed".
//
// electron/main.js's unfinishedUpdate() reads/clears the single-shot
// update-attempt file on boot and now forwards its result to the server
// child as MYTHOS_UPDATE_RESULT (JSON), read on the other end by
// src/core/identity/update-report.js. This file covers:
//   (a) source-shape: the spawn env includes MYTHOS_UPDATE_RESULT, and
//       unfinishedUpdate() is read BEFORE startChild() in whenReady.
//   (b) update-report.js tolerates absent env, distinguishes it from
//       corrupt/malformed env (must not collapse to the same silent value),
//       and returns the right shape for a valid payload.
//   (c) server/index.js's boot-greeting prompt names both versions in each
//       branch (success / failure), using the existing rearmBootGreeting
//       seam rather than replacing the BUG-178/BUG-112 tests that already
//       cover delivery.
//
// Run: cd mythos && MYTHOS_PORT=4986 EDGE_TTS_PORT=5086 EDGE_TTS_URL=http://127.0.0.1:5086 \
//   node --test test/update-result-env.test.js

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { getUpdateReport } = require('../src/core/identity/update-report');

const MAIN_JS_PATH = path.join(__dirname, '..', '..', 'electron', 'main.js');

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({}) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

describe('B1 source-shape: electron/main.js forwards the update result before forking', () => {
  const src = fs.readFileSync(MAIN_JS_PATH, 'utf8');

  it('the spawn env block sets MYTHOS_UPDATE_RESULT', () => {
    assert.ok(src.indexOf('MYTHOS_UPDATE_RESULT') !== -1,
      'electron/main.js must forward the update result to the child as MYTHOS_UPDATE_RESULT');
  });

  it('unfinishedUpdate() is read before startChild() is called in whenReady', () => {
    const readAt = src.indexOf('const lastUpdate = unfinishedUpdate();');
    assert.ok(readAt !== -1, 'expected the whenReady call site "const lastUpdate = unfinishedUpdate();"');
    const startAt = src.indexOf('startChild();', readAt);
    assert.ok(startAt !== -1 && startAt > readAt,
      'startChild() must be called AFTER unfinishedUpdate() has been read, so the fork() env can carry it');
    // Close together — the very next startChild() call, not some unrelated
    // later restart path (e.g. mythos:restart-server's own startChild()).
    assert.ok(startAt - readAt < 500,
      'expected startChild() to follow the unfinishedUpdate() read closely, in the whenReady block');
  });
});

describe('B1 behavioral: update-report.js parses MYTHOS_UPDATE_RESULT honestly', () => {
  const ORIGINAL = process.env.MYTHOS_UPDATE_RESULT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MYTHOS_UPDATE_RESULT;
    else process.env.MYTHOS_UPDATE_RESULT = ORIGINAL;
  });

  it('returns null when the env var is absent', () => {
    delete process.env.MYTHOS_UPDATE_RESULT;
    assert.equal(getUpdateReport(), null);
  });

  it('returns null when the env var is an empty string', () => {
    process.env.MYTHOS_UPDATE_RESULT = '';
    assert.equal(getUpdateReport(), null);
  });

  it('throws on corrupt/non-JSON env — distinguishable from "absent"', () => {
    process.env.MYTHOS_UPDATE_RESULT = 'not-json-at-all{{{';
    assert.throws(() => getUpdateReport());
  });

  it('throws on valid JSON that is the wrong shape (missing version)', () => {
    process.env.MYTHOS_UPDATE_RESULT = JSON.stringify({ completed: true, from: '0.1.0' });
    assert.throws(() => getUpdateReport());
  });

  it('parses a valid completed-update payload', () => {
    process.env.MYTHOS_UPDATE_RESULT = JSON.stringify({
      completed: true, version: '0.2.0', from: '0.1.9', releaseNotes: 'Fixed the thing.',
    });
    const report = getUpdateReport();
    assert.deepEqual(report, {
      completed: true, version: '0.2.0', from: '0.1.9', releaseNotes: 'Fixed the thing.',
    });
  });

  it('parses a valid incomplete-update payload', () => {
    process.env.MYTHOS_UPDATE_RESULT = JSON.stringify({
      completed: false, version: '0.2.0', from: '0.1.9', releaseNotes: '',
    });
    const report = getUpdateReport();
    assert.equal(report.completed, false);
    assert.equal(report.version, '0.2.0');
    assert.equal(report.from, '0.1.9');
  });
});

describe('B1 boot greeting: the update outcome is a first-class fact in the prompt', () => {
  const ORIGINAL = process.env.MYTHOS_UPDATE_RESULT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MYTHOS_UPDATE_RESULT;
    else process.env.MYTHOS_UPDATE_RESULT = ORIGINAL;
  });

  it('success branch names both versions and the release notes', async () => {
    process.env.MYTHOS_UPDATE_RESULT = JSON.stringify({
      completed: true, version: '0.2.0', from: '0.1.9', releaseNotes: 'Fixed the thing.',
    });
    const bus = createBus({ historySize: 50 });
    const calls = [];
    const brain = { think: async (args) => { calls.push(args); return { content: 'A greeting.', offline: false }; } };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;

    try {
      await server._internal.deliverBootGreeting();
      assert.equal(calls.length, 1);
      const prompt = calls[0].messages[0].content;
      assert.ok(prompt.indexOf('0.2.0') !== -1, 'prompt must name the new version: ' + prompt);
      assert.match(prompt, /updated to v0\.2\.0/i, 'prompt must state the update succeeded: ' + prompt);
      assert.ok(prompt.indexOf('Fixed the thing.') !== -1, 'prompt must include the release notes: ' + prompt);
    } finally {
      await server.stop();
    }
  });

  it('failure branch names the target version AND the version still running (from)', async () => {
    process.env.MYTHOS_UPDATE_RESULT = JSON.stringify({
      completed: false, version: '0.2.0', from: '0.1.9', releaseNotes: '',
    });
    const bus = createBus({ historySize: 50 });
    const calls = [];
    const brain = { think: async (args) => { calls.push(args); return { content: 'A greeting.', offline: false }; } };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;

    try {
      await server._internal.deliverBootGreeting();
      assert.equal(calls.length, 1);
      const prompt = calls[0].messages[0].content;
      assert.ok(prompt.indexOf('0.2.0') !== -1, 'prompt must name the target version: ' + prompt);
      assert.ok(prompt.indexOf('0.1.9') !== -1, 'prompt must name the still-running (from) version: ' + prompt);
      assert.match(prompt, /did not complete/i, 'prompt must state the update failed: ' + prompt);
    } finally {
      await server.stop();
    }
  });

  it('records exactly one episodic entry for the update outcome', async () => {
    process.env.MYTHOS_UPDATE_RESULT = JSON.stringify({
      completed: true, version: '0.2.0', from: '0.1.9', releaseNotes: '',
    });
    const bus = createBus({ historySize: 50 });
    const writes = [];
    const memory = {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: (record) => { writes.push(record); } },
      fs: fakeFs(),
    };
    const server = createServer(baseDeps(bus, { memory }));
    await server.ready;

    try {
      const systemWrites = writes.filter((w) => w.kind === 'system' &&
        w.detail && w.detail.version === '0.2.0');
      assert.equal(systemWrites.length, 1,
        'expected exactly one episodic system entry for this update outcome: ' + JSON.stringify(writes));
    } finally {
      await server.stop();
    }
  });

  it('no update-shaped fact is added, and boot does not throw, when the env is absent', async () => {
    delete process.env.MYTHOS_UPDATE_RESULT;
    const bus = createBus({ historySize: 50 });
    const calls = [];
    const brain = { think: async (args) => { calls.push(args); return { content: 'A greeting.', offline: false }; } };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;

    try {
      await server._internal.deliverBootGreeting();
      const prompt = calls[0].messages[0].content;
      assert.ok(!/updated to v/i.test(prompt), 'no success fact should appear without an update result: ' + prompt);
      assert.ok(!/did not complete/i.test(prompt), 'no failure fact should appear without an update result: ' + prompt);
    } finally {
      await server.stop();
    }
  });

  it('boot does not throw when the env is corrupt — it degrades to no fact, not a crash', async () => {
    process.env.MYTHOS_UPDATE_RESULT = 'not-json-at-all{{{';
    const bus = createBus({ historySize: 50 });
    const calls = [];
    const brain = { think: async (args) => { calls.push(args); return { content: 'A greeting.', offline: false }; } };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;

    try {
      await server._internal.deliverBootGreeting();
      const prompt = calls[0].messages[0].content;
      assert.ok(!/updated to v/i.test(prompt), 'a corrupt report must not fabricate a success fact: ' + prompt);
      assert.ok(!/did not complete/i.test(prompt), 'a corrupt report must not fabricate a failure fact: ' + prompt);
    } finally {
      await server.stop();
    }
  });
});
