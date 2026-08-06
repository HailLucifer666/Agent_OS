'use strict';

// bug-133-error-status-honesty.test.js — the catch-all error middleware
// (server/index.js) used to hardcode res.status(500) and throw away the status the
// error already carried. A malformed JSON body arrives from body-parser as an
// http-errors-shaped failure with { status: 400, type: 'entity.parse.failed',
// expose: true }; an oversized one as { status: 413, type: 'entity.too.large' }.
// Blanket-500ing both told the client the SERVER broke when the REQUEST was bad,
// and logged every client mistake at error level as an *unhandled* fault.
//
// Found by scripts/e2e/run-e2e.mjs, not by this suite: 2979 unit tests passed while
// four real POST endpoints answered 500 to garbage. Nothing here sent a malformed
// body over real HTTP, so nothing here could see it.
//
// The fix keys on `expose` — the flag http-errors sets to mark a message
// client-safe — NOT on status alone, because a future throw that merely carries a
// .status would otherwise leak its raw .message to the client. The last two tests
// pin that gate; without them the leak guard could be dropped and everything else
// here would still pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

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

function request(port, method, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON body — assert on raw */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MALFORMED = '{"unterminated":';

async function withServer(overrides, fn) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, overrides));
  try {
    await server.ready;
    await fn(server.httpServer.address().port);
  } finally {
    await server.stop();
  }
}

test('BUG-133: a malformed JSON body answers 400, not 500', async () => {
  await withServer(null, async (port) => {
    const res = await request(port, 'POST', '/api/goals', MALFORMED, JSON_HEADERS);
    assert.equal(res.status, 400, 'a client-side parse failure must not be reported as a server fault');
    assert.ok(res.body, 'the 400 must still be JSON');
    assert.notEqual(res.body.error, 'Internal server error.', 'the generic 500 text must not be reused for a 400');
    assert.ok(res.body.requestId, 'requestId is kept so the response still correlates to the log line');
  });
});

test('BUG-133: the honest status is middleware-wide, not patched per route', async () => {
  await withServer(null, async (port) => {
    // A second, unrelated router proves the fix lives in the catch-all rather than
    // in one route's own body handling.
    const res = await request(port, 'POST', '/api/pipeline/capture', MALFORMED, JSON_HEADERS);
    assert.equal(res.status, 400);
    assert.notEqual(res.body.error, 'Internal server error.');
  });
});

test('BUG-133: an oversized body answers 413, not 500', async () => {
  await withServer(null, async (port) => {
    // express.json({ limit: '1mb' }) — comfortably over it, and valid JSON, so the
    // ONLY thing that can reject this is the size limit.
    const huge = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 4096) });
    const res = await request(port, 'POST', '/api/goals', huge, JSON_HEADERS);
    assert.equal(res.status, 413, 'the 1mb cap is a client error, not a server crash');
    assert.notEqual(res.body && res.body.error, 'Internal server error.');
  });
});

test('BUG-133: a genuine server-side throw still answers a generic 500', async () => {
  const secret = 'internal detail that must never reach a client';
  await withServer({
    goalsEffector: {
      listGoals() { throw new Error(secret); },
      stats: () => ({ total: 0, done: 0, active: 0 }),
    },
  }, async (port) => {
    const res = await request(port, 'GET', '/api/goals');
    assert.equal(res.status, 500, 'an unexpected throw is still a server fault');
    assert.equal(res.body.error, 'Internal server error.');
    assert.ok(!res.raw.includes(secret), 'the raw throw message must not be echoed to the client');
  });
});

test('BUG-133: a 4xx status WITHOUT expose is not trusted — still 500, message withheld', async () => {
  // This is the leak guard. If the fix ever keys on status alone, this test fails:
  // an error can carry a .status without its message being safe to show.
  const secret = 'db://user:password@host/internal';
  await withServer({
    goalsEffector: {
      listGoals() {
        const err = new Error(secret);
        err.status = 400; // set, but expose is NOT — so the message is not client-safe
        throw err;
      },
      stats: () => ({ total: 0, done: 0, active: 0 }),
    },
  }, async (port) => {
    const res = await request(port, 'GET', '/api/goals');
    assert.equal(res.status, 500, 'status alone must not be enough to downgrade to a 4xx');
    assert.equal(res.body.error, 'Internal server error.');
    assert.ok(!res.raw.includes(secret), 'an unexposed message must never be echoed');
  });
});

test('BUG-133: a client error is logged at warn, not as an unhandled server fault', async () => {
  const lines = [];
  await withServer({
    logger: {
      info() {},
      warn(msg, meta) { lines.push({ level: 'warn', msg, meta }); },
      error(msg, meta) { lines.push({ level: 'error', msg, meta }); },
    },
  }, async (port) => {
    await request(port, 'POST', '/api/goals', MALFORMED, JSON_HEADERS);
  });
  const errors = lines.filter((l) => l.level === 'error');
  // Boot and shutdown emit their own unrelated warns, so match the one line this
  // path is responsible for rather than the total count.
  const badRequest = lines.filter((l) => l.level === 'warn' && l.msg === 'bad request');
  assert.equal(errors.length, 0, `a bad client body must not log at error level (got ${JSON.stringify(errors)})`);
  assert.equal(badRequest.length, 1, 'it must still be logged — degrading honestly is not the same as going quiet');
  assert.equal(badRequest[0].meta.status, 400, 'the log line carries the real status');
  assert.ok(badRequest[0].meta.requestId, 'and stays correlatable to the response');
});
