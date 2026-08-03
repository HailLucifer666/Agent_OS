'use strict';

// test/whatsapp-app-reply-error-passthrough.test.js — FIX B: server/index.js's
// sanitizeErrorForClient() used to flatten EVERY message it did not recognize
// (EACCES/ENOSPC/ENOENT/network/all-models-failed) down to the generic
// "An internal error occurred. Check server logs for details." — including an
// effector's own honest fail() text. Concretely: app_reply reporting
// "whatsapp is not open, so there is no conversation to reply to" reached the
// model as the generic string instead, because live-tool-adapter.js's
// sanitizeResultError() routes EVERY effector failure through this exact
// function (wrapped as a bare {message} object with no .stack).
//
// The fix tags the value at its origin: sanitizeResultError now sets
// effectorReason:true, because that call site is the only one that knows the
// value is a fail() string rather than a thrown exception. A tagged message that
// does not look like a leaked path/stack-frame/secret passes through unmodified
// (capped); everything else — a real thrown exception, an untagged hand-built
// error object, or text smuggling a path/secret — still gets genericized.
//
// Deliberately NOT inferred from "this object has no .stack". That inference
// would flip the whole sanitizer from deny-by-default to allow-by-default for
// every hand-built error object in the server, which is not a trade a WS-facing
// sanitizer should make.
//
// This spins up a real (loopback, ephemeral-port) server via createServer,
// matching test/server-auth.test.js's established pattern, and reaches
// sanitizeErrorForClient through the test-only `_internal` export added
// alongside voiceLatencyTracker.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
    logger: { info() {}, warn() {}, error() {} },
    memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => {} }, fs: fakeFs() },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { confirm: { create: () => 'cf-1', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

describe('FIX B — sanitizeErrorForClient lets an effector\'s own honest failure through', () => {
  test('THE RECORDED CASE: a tagged effector reason passes through unmodified', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    try {
      const sanitize = server._internal.sanitizeErrorForClient;
      const appReplyReason = 'whatsapp is not open, so there is no conversation to reply to';
      // This is exactly the shape live-tool-adapter.js's sanitizeResultError builds.
      const out = sanitize({ message: appReplyReason, effectorReason: true });
      assert.equal(out, appReplyReason, 'an honest effector failure reason must reach the caller verbatim');
    } finally {
      await server.stop();
    }
  });

  test('an UNTAGGED hand-built error object is still generalized', async () => {
    // The deny-by-default property. Only the tagged origin gets the passthrough;
    // any other {message} in the server keeps the old, safe behaviour.
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    try {
      const sanitize = server._internal.sanitizeErrorForClient;
      const out = sanitize({ message: 'some internal detail nobody vetted for the client' });
      assert.equal(out, 'An internal error occurred. Check server logs for details.');
    } finally {
      await server.stop();
    }
  });

  test('a genuine thrown exception (has a .stack) still yields the generic message', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    try {
      const sanitize = server._internal.sanitizeErrorForClient;
      let caught;
      try {
        throw new Error('some genuinely unexpected internal failure, cause unknown');
      } catch (err) {
        caught = err;
      }
      const out = sanitize(caught);
      assert.equal(out, 'An internal error occurred. Check server logs for details.',
        'an unexpected real exception must still be generalized, not leaked to the client');
    } finally {
      await server.stop();
    }
  });

  test('a tagged reason that smuggles a filesystem path is STILL genericized', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    try {
      const sanitize = server._internal.sanitizeErrorForClient;
      const out = sanitize({ message: 'failed reading C:\\Users\\real-name\\secrets\\config.json', effectorReason: true });
      assert.equal(out, 'An internal error occurred. Check server logs for details.',
        'the tag grants passthrough, not immunity — run_command hands back raw stderr');
    } finally {
      await server.stop();
    }
  });

  test('known internal-error categories (EACCES, ENOENT, network) still map to their existing safe strings', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus));
    await server.ready;
    try {
      const sanitize = server._internal.sanitizeErrorForClient;
      assert.equal(sanitize({ message: 'ENOENT: no such file' }), 'File not found.');
      assert.equal(sanitize(new Error('EACCES: permission denied')), 'Permission denied — check file permissions.');
    } finally {
      await server.stop();
    }
  });
});
