'use strict';

// test/bug-292-name-the-rejected-ws-client.test.js — BUG-292.
//
// MEASURED, mythos-server.log 2026-08-20: `ws-upgrade-rejected` 147 times, and
// every single one carried the same one-field reason — "bad or missing token".
// That is a client retrying forever against a server that is correctly refusing
// it, and there is nothing in 147 identical log lines that says WHICH client.
//
// The server is not the defect. MYTHOS_AUTH_TOKEN is mandatory for the phone
// node and is known to kill the HUD socket when set — a real, recorded tension
// in this repo — so verifyClient must NOT be loosened. The defect is that the
// rejection is unactionable: you cannot give the right client a token, or stop
// the wrong one retrying, until you can name it. So this is a logging change
// first, on purpose, and the second half of the ticket is whatever the named
// client turns out to be.
//
// Q2 — DOES THIS HIDE EVIDENCE / CREATE NEW EXPOSURE? The opposite of the first
// and very much the risk on the second: a fix for an auth problem must not turn
// into a credential leak in a log file. So the fingerprint records only that a
// credential was PRESENTED and WHERE it came from — header or query string —
// never its value, and the logged path is truncated at '?' so a `?token=` can
// never ride in on the URL either. Both of those are asserted below with a
// canary string, not assumed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

const TOKEN = 'bug-292-real-token-do-not-reuse';
// Distinctive on purpose: if this string appears anywhere in the captured log
// lines, a wrong credential has been written to disk.
const WRONG_TOKEN = 'WRONGTOKEN-canary-9f3a-must-never-be-logged';

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Captures logger.warn so the assertions are about what actually reaches the
// log, not about what the source looks like. (The repo's logger is silent under
// test, so grepping test output would prove nothing.)
function rig() {
  const warns = [];
  const bus = createBus({ historySize: 50 });
  const server = createServer({
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: TOKEN,
    },
    logger: { info() {}, error() {}, warn(event, fields) { warns.push({ event, fields: fields || {} }); } },
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
  });
  return { server, warns };
}

function connect(url, opts) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, opts);
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('unexpected-response', () => resolve('rejected'));
    ws.on('error', () => resolve('rejected'));
  });
}

function rejections(warns) {
  return warns.filter((w) => w.event === 'ws-upgrade-rejected');
}

describe('BUG-292: a rejected WS upgrade names the client', () => {
  test('the rejection carries the remote peer, the user-agent and the path', async () => {
    const { server, warns } = rig();
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const outcome = await connect(`ws://127.0.0.1:${port}/ws`,
        { headers: { 'User-Agent': 'okhttp/4.12.0' } });
      assert.equal(outcome, 'rejected', 'the premise: no token must still be refused');
      const rej = rejections(warns);
      assert.equal(rej.length, 1, 'exactly one rejection should have been logged');
      const f = rej[0].fields;
      assert.equal(f.reason, 'bad or missing token', 'the existing reason must survive');
      assert.match(String(f.remote), /127\.0\.0\.1:\d+/,
        'without a remote peer, 147 rejections cannot be attributed to any client');
      assert.equal(f.userAgent, 'okhttp/4.12.0',
        'the user-agent is what distinguishes a phone node from the HUD');
      assert.equal(f.path, '/ws');
    } finally { await server.stop(); }
  });

  test('the log says WHERE a credential came from, so a client that sends none is tellable apart', async () => {
    const { server, warns } = rig();
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      await connect(`ws://127.0.0.1:${port}/ws`);
      await connect(`ws://127.0.0.1:${port}/ws?token=${WRONG_TOKEN}`);
      await connect(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${WRONG_TOKEN}` } });
      const rej = rejections(warns);
      assert.equal(rej.length, 3);
      assert.deepEqual(rej.map((r) => r.fields.credential), ['none', 'query', 'header'],
        'a client sending nothing and a client sending the wrong secret are different problems');
    } finally { await server.stop(); }
  });

  // Q2. The whole point of a presence-only field.
  test('the credential VALUE never reaches the log, from either channel', async () => {
    const { server, warns } = rig();
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      await connect(`ws://127.0.0.1:${port}/ws?token=${WRONG_TOKEN}`);
      await connect(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${WRONG_TOKEN}` } });
      const serialised = JSON.stringify(warns);
      assert.ok(!serialised.includes(WRONG_TOKEN),
        'a fix for an auth problem must not become a credential leak in a log file');
      assert.ok(!serialised.includes('Bearer'),
        'the raw Authorization header must not be logged either');
      assert.ok(!serialised.includes(TOKEN), 'and certainly not the real token');
    } finally { await server.stop(); }
  });

  test('the logged path is truncated at the query string, so ?token= cannot ride in on it', async () => {
    const { server, warns } = rig();
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      await connect(`ws://127.0.0.1:${port}/ws?token=${WRONG_TOKEN}`);
      const f = rejections(warns)[0].fields;
      assert.equal(f.path, '/ws', 'a path with the query string attached is the leak wearing a different name');
    } finally { await server.stop(); }
  });

  test('an ACCEPTED upgrade logs no rejection — the fingerprint is not a new per-connection log', async () => {
    const { server, warns } = rig();
    await server.ready;
    const { port } = server.httpServer.address();
    try {
      const outcome = await connect(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
      assert.equal(outcome, 'opened', 'the correct token must still be accepted — verifyClient is NOT loosened');
      assert.deepEqual(rejections(warns), []);
    } finally { await server.stop(); }
  });

  // Q1/Q4 — WHAT ELSE MATCHES THIS? There are five reject branches in
  // verifyClient (rate limit, foreign origin, no-origin non-loopback, node-trust
  // token, bad-or-missing token) and only two of them are cheap to drive from a
  // test. A fingerprint on two of five would be the same partial-coverage defect
  // BUG-273 was, so this counts the call sites instead of trusting them.
  test('every ws-upgrade-rejected call site carries the fingerprint', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const sites = src.match(/logger\.warn\('ws-upgrade-rejected'[^\n]*/g) || [];
    assert.ok(sites.length >= 5, `expected at least the five known reject branches, found ${sites.length}`);
    for (const site of sites) {
      assert.match(site, /upgradeCallerFingerprint\(/,
        `a ws-upgrade-rejected log without the fingerprint is an unattributable rejection: ${site}`);
    }
  });
});
