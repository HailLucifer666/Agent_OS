'use strict';

// test/bug-306-session-write-failure-is-logged.test.js — BUG-306.
//
// THE BUG, in one line:
//
//   try { memory.fs.writeJSON(SESSION_PATH, { turns: history, ... }); } catch (_) {}
//
// Every turn of every conversation is written to the vault so the conversation
// survives a restart. If that write fails the error was caught and dropped on
// the floor — no log, no warning, no counter. The next launch simply starts with
// a missing or stale history, which is indistinguishable from a fresh session.
// Nobody would ever know the vault had stopped accepting writes.
//
// BEST-EFFORT IS THE RIGHT DISPOSITION AND IS KEPT. A failed history write must
// not break the running conversation — the operator is mid-sentence. What is not
// acceptable is that it is INVISIBLE. Best-effort and silent are different
// decisions, and only one of them was ever made here.
//
// WHY THE LOGGER IS INJECTED RATHER THAN CAPTURED FROM STDOUT: this repo's
// logger is silent under test, so a test that greps captured output for a log
// line passes whether or not the line is ever emitted. That has already produced
// one guard in this repo that proved nothing for months.
//
// WHY historyAppend IS ON _internal: it is a closure inside createServer, and
// the only production route to it is a full websocket voice turn — model call,
// dispatch, TTS. server/index.js already keeps a documented `_internal` block
// for exactly this, seams for states that cannot be reached from outside. This
// adds one function to it and changes nothing about how production runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createServer } = require('../server/index');
const { createBus } = require('../src/core/bus');

// Deliberately minimal: this file drives one closure, not a conversation.
function deps(overrides) {
  const ov = overrides || {};
  return Object.assign({
    bus: createBus({ historySize: 10 }),
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      recallHybrid: async () => [],
      fs: { vaultPath: (...s) => path.join('test-vault', ...s) },
      audit: { write: () => ({ ok: true }) },
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: {
      breakers: { allow: () => true }, invoke: async () => ({ ok: true }),
      effectors: new Map(), catalog: () => [], get: () => undefined,
    },
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    tts: { isAvailable: async () => false },
  }, ov);
}

function recordingLogger() {
  const lines = [];
  const push = (level) => (event, fields) => lines.push({ level, event, fields });
  return { lines, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

async function withServer(overrides, fn) {
  const server = createServer(deps(overrides));
  try {
    await server.ready;
    return await fn(server);
  } finally {
    await server.stop();
  }
}

test('a failed session-history write is logged, with the path and the reason', async () => {
  const logger = recordingLogger();
  // The error text deliberately does NOT name the file. The first version of
  // this test used 'EACCES: permission denied, open ...session.json' and then
  // matched /session\.json/ against the whole serialised log line — so the
  // assertion was satisfied by the fixture's own error string appearing
  // anywhere, and the test passed with the log statement commented out.
  // Mutation testing caught it. The assertions below read the named FIELDS.
  const boom = new Error('EACCES: permission denied');
  await withServer({
    logger,
    memory: Object.assign(deps().memory, {
      fs: {
        vaultPath: (...s) => path.join('test-vault', ...s),
        readJSON: () => null,
        writeJSON: () => { throw boom; },
      },
    }),
  }, async (server) => {
    server._internal.historyAppend('user', 'does the vault still work');

    const complaint = logger.lines.filter(
      (l) => (l.level === 'warn' || l.level === 'error')
        && l.fields && /session\.json/.test(String(l.fields.path || '')));
    assert.equal(complaint.length, 1,
      'the write failed and nothing named the session file was logged. Next launch the '
      + 'conversation is simply gone, and it looks like a fresh start rather than a broken '
      + 'vault. Lines seen: ' + JSON.stringify(logger.lines));
    const line = complaint[0];
    assert.match(line.event, /session/i, 'the event name must be findable in a log: ' + line.event);
    assert.match(String(line.fields.error), /EACCES|permission denied/,
      'the log must carry the underlying error, not just "write failed": ' + JSON.stringify(line));
  });
});

test('the conversation survives the failed write — best-effort is kept', async () => {
  // The point of the original catch was that a vault problem must not interrupt
  // someone mid-sentence. Making the failure visible must not quietly turn it
  // into a crash.
  const logger = recordingLogger();
  await withServer({
    logger,
    memory: Object.assign(deps().memory, {
      fs: {
        vaultPath: (...s) => path.join('test-vault', ...s),
        readJSON: () => null,
        writeJSON: () => { throw new Error('vault is read-only'); },
      },
    }),
  }, async (server) => {
    assert.doesNotThrow(() => {
      server._internal.historyAppend('user', 'first');
      server._internal.historyAppend('assistant', 'second');
    }, 'a failed history write must not propagate into the turn');

    const history = server._internal.historyGet();
    assert.equal(history.length, 2,
      'the in-memory conversation must continue even when the disk copy fails');
    assert.equal(history[1].content, 'second');
  });
});

test('a successful write says nothing at all', async () => {
  // Every voice turn calls this. A log line per turn on the happy path would
  // bury the one that matters.
  const logger = recordingLogger();
  const written = [];
  await withServer({
    logger,
    memory: Object.assign(deps().memory, {
      fs: {
        vaultPath: (...s) => path.join('test-vault', ...s),
        readJSON: () => null,
        writeJSON: (p, data) => { written.push({ p, data }); },
      },
    }),
  }, async (server) => {
    // Boot has its own opinions — these minimal deps carry no brain, so the
    // server legitimately warns about the voice agent and the announcer. Only
    // what the append itself emits is under test here.
    const beforeAppend = logger.lines.length;
    server._internal.historyAppend('user', 'hello');
    const emittedByAppend = logger.lines.slice(beforeAppend);

    // Only the session file, for the same reason: boot writes other vault files
    // and counting every write would make this about startup, not about the one
    // line under test.
    const sessionWrites = written.filter((w) => /session\.json/.test(String(w.p)));
    assert.equal(sessionWrites.length, 1, 'the turn should still be persisted exactly once');
    assert.deepEqual(emittedByAppend, [],
      'a healthy write must be silent — every voice turn calls this, and a line per turn '
      + 'would bury the one that matters: ' + JSON.stringify(emittedByAppend));
  });
});

test('the catch is no longer empty', () => {
  // A source assertion against the exact shape that caused this: `catch (_) {}`.
  // The behavioural tests above prove the log happens; this one makes the
  // regression obvious in a diff, because the empty-catch idiom is easy to
  // reintroduce while tidying.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(src, /writeJSON\(SESSION_PATH[^\n]*\n?[^\n]*catch \(_\) \{\}/,
    'the session write is silent again');
});
