'use strict';

// confirm-resolved-broadcast.test.js — a T3/T4 confirm now has more than one
// surface that can answer it (the phone renders the same broadcast
// confirm-request the HUD does), so "who was told it is over" stopped being a
// rhetorical question.
//
// The failure this pins is silent by construction: a confirm that has already
// been consumed, swept, or is scoped to another connection resolves NOTHING on
// a second tap, and before `confirm-resolved` existed it also said nothing —
// the sheet closed, the operator believed they had approved, and the message
// was never sent. Nothing in a build or a green suite catches that, so the
// frame's existence, its outcome word, and (critically) the one case where it
// must NOT be broadcast are asserted directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const WebSocket = require('ws');
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
    agentActions: {},
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

async function openClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString())); });
  await new Promise((resolve) => ws.on('open', resolve));
  return { ws, frames, resolved: () => frames.filter((f) => f.type === 'confirm-resolved') };
}

// Long enough for the reply round-trip plus dispatchAction's awaits, short
// enough that four of these don't dominate the suite.
const SETTLE_MS = 120;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

test('an accepted confirm is announced to every open surface, not only the replier', async () => {
  const bus = createBus({ historySize: 50 });
  const action = { tool: 'whatsapp_send', args: { to: 'x', message: 'hi' } };
  const server = createServer(baseDeps(bus, {
    leash: { confirm: { create: () => 'cf-a', accept: (id) => (id === 'cf-a' ? action : null), reject: () => false } },
  }));
  await server.ready;
  const port = server.httpServer.address().port;

  const phone = await openClient(port);
  const hud = await openClient(port);

  phone.ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-a', accept: true }));
  await settle();

  for (const client of [phone, hud]) {
    const seen = client.resolved();
    assert.equal(seen.length, 1, 'both surfaces must be told the confirm is over');
    assert.equal(seen[0].payload.id, 'cf-a');
    assert.equal(seen[0].payload.outcome, 'accepted');
  }

  phone.ws.close(); hud.ws.close();
  await server.stop();
});

test('a rejected confirm is announced as rejected', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    leash: { confirm: { create: () => 'cf-r', accept: () => null, reject: (id) => id === 'cf-r' } },
  }));
  await server.ready;
  const port = server.httpServer.address().port;
  const hud = await openClient(port);

  hud.ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-r', accept: false }));
  await settle();

  assert.deepEqual(hud.resolved().map((f) => f.payload.outcome), ['rejected']);

  hud.ws.close();
  await server.stop();
});

test('a reply to a confirm that is already gone is announced as expired', async () => {
  // Exactly what a late tap on the phone hits: the registry sweeps lapsed
  // entries passively, so accept() returns null and peek() finds nothing. The
  // operator has to be told, or a dead sheet reads as a successful approval.
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    leash: { confirm: { create: () => 'cf-x', accept: () => null, reject: () => false, peek: () => null } },
  }));
  await server.ready;
  const port = server.httpServer.address().port;
  const phone = await openClient(port);

  phone.ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-gone', accept: true }));
  await settle();

  assert.deepEqual(phone.resolved().map((f) => f.payload.outcome), ['expired']);

  phone.ws.close();
  await server.stop();
});

test('a wrong-connection reply tells only the replier, and never dismisses the owner\'s prompt', async () => {
  // T3/T4 confirms are scoped to the connection that raised them, and a
  // mismatched accept deliberately does NOT consume the entry. Broadcasting
  // that as "resolved" would make the phone's failed tap close the DESKTOP's
  // still-live approval — turning a harmless no-op into a lost confirm.
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    leash: {
      confirm: {
        create: () => 'cf-owned',
        accept: () => null,            // never this connection's to accept
        reject: () => false,
        peek: () => ({ summary: 'Send a message', expired: false }), // still pending
      },
    },
  }));
  await server.ready;
  const port = server.httpServer.address().port;

  const phone = await openClient(port);
  const owner = await openClient(port);

  phone.ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-owned', accept: true }));
  await settle();

  assert.deepEqual(phone.resolved().map((f) => f.payload.outcome), ['not-permitted']);
  assert.equal(owner.resolved().length, 0, 'the owning surface must keep its prompt');

  phone.ws.close(); owner.ws.close();
  await server.stop();
});

test('confirm-request carries the server\'s real TTL so a client need not hardcode one', async () => {
  // The phone runs its own expiry clock (nothing announces a lapse until a
  // reply is attempted). Sending the TTL is what stops that clock from being a
  // second copy of LEASH_CONFIRM_TTL_MS that disagrees the moment it is set.
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, {
    leash: {
      confirm: {
        create: () => 'cf-1', accept: () => null, reject: () => true,
        stats: () => ({ pending: 1, ttlMs: 120000 }),
      },
    },
  }));
  await server.ready;
  const port = server.httpServer.address().port;
  const hud = await openClient(port);

  bus.emit('confirm-request', { tool: 'whatsapp_send', confirmId: 'cf-1', summary: 'Send "hi"', tier: 3 });
  await settle();

  const request = hud.frames.find((f) => f.type === 'confirm-request');
  assert.ok(request, 'the request must still reach every surface');
  assert.equal(request.payload.id, 'cf-1', 'outbound field is id; the REPLY field is confirmId');
  assert.equal(request.payload.ttlMs, 120000);
  assert.equal(request.payload.tier, 3);

  hud.ws.close();
  await server.stop();
});

test('a leash with no stats() still broadcasts the request, with a null ttl', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  await server.ready;
  const port = server.httpServer.address().port;
  const hud = await openClient(port);

  bus.emit('confirm-request', { tool: 'gmail_send', confirmId: 'cf-2', summary: 'Send mail', tier: 3 });
  await settle();

  const request = hud.frames.find((f) => f.type === 'confirm-request');
  assert.ok(request);
  assert.equal(request.payload.ttlMs, null, 'absent TTL must be honest, not a fabricated default');

  hud.ws.close();
  await server.stop();
});
