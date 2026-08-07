'use strict';

// Voice Nodes Stage 1 — the server's transport half.
//
// The server owns none of the Aether protocol here; its whole job is to turn a
// phone's inbound {type:'node-reading'} into scannerProxy.updateReading() and
// {type:'node-lost'} into markLost(). Two things are worth pinning:
//
//  1. It forwards nodeId/rssi/name faithfully and does not crash when no proxy
//     is configured (the default install — AETHER_PROXY_ENABLED is false, so
//     `scannerProxy` is undefined and every phone message must be a no-op).
//  2. Proximity telemetry is NOT operator activity. `lastActiveWs` is set on any
//     inbound message and is what proactive speech (reminders, nudges, health
//     remarks) targets. A phone pushes readings several times a second whenever
//     it can see the beacon, so without an exclusion it would permanently pin
//     that target to a socket with no HUD and no speech-chunk player — silently
//     starving the tab the operator is actually looking at.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Records what the server asked of the proxy, without any real ports.
function recordingProxy() {
  const calls = [];
  return {
    calls,
    updateReading: (nodeId, reading) => { calls.push({ fn: 'updateReading', nodeId, reading }); return true; },
    markLost: (nodeId) => { calls.push({ fn: 'markLost', nodeId }); return true; },
  };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
    },
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

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

test('node-reading is forwarded to the scanner-proxy with nodeId, rssi and name intact', async () => {
  const bus = createBus({ historySize: 50 });
  const proxy = recordingProxy();
  const server = createServer(baseDeps(bus, { scannerProxy: proxy }));
  let ws;
  try {
    await server.ready;
    ws = await connect(server.httpServer.address().port);
    ws.send(JSON.stringify({ type: 'node-reading', nodeId: 'kitchen-phone', rssi: -61.5, name: 'Pixel Watch' }));
    assert.ok(await waitFor(() => proxy.calls.length > 0, 1000), 'proxy never heard the reading');
    assert.deepEqual(proxy.calls[0], {
      fn: 'updateReading',
      nodeId: 'kitchen-phone',
      reading: { rssi: -61.5, name: 'Pixel Watch' },
    });
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('node-lost is forwarded as markLost', async () => {
  const bus = createBus({ historySize: 50 });
  const proxy = recordingProxy();
  const server = createServer(baseDeps(bus, { scannerProxy: proxy }));
  let ws;
  try {
    await server.ready;
    ws = await connect(server.httpServer.address().port);
    ws.send(JSON.stringify({ type: 'node-lost', nodeId: 'desk-phone' }));
    assert.ok(await waitFor(() => proxy.calls.length > 0, 1000), 'proxy never heard the loss');
    assert.deepEqual(proxy.calls[0], { fn: 'markLost', nodeId: 'desk-phone' });
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('with no proxy configured (the default install) a node message is a harmless no-op', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus)); // scannerProxy undefined
  let ws;
  try {
    await server.ready;
    ws = await connect(server.httpServer.address().port);
    ws.send(JSON.stringify({ type: 'node-reading', nodeId: 'kitchen-phone', rssi: -61 }));
    await sleep(100);
    // Still alive and still serving — the only assertion that matters.
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    if (ws) { try { ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('proximity telemetry does not steal the proactive-speech target from the HUD', async () => {
  const bus = createBus({ historySize: 50 });
  const proxy = recordingProxy();
  const server = createServer(baseDeps(bus, { scannerProxy: proxy }));
  let hud;
  let phone;
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    hud = await connect(port);
    phone = await connect(port);

    // The HUD does something real — this is what makes it the active surface.
    hud.send(JSON.stringify({ type: 'subscribe', channels: ['health'] }));
    assert.ok(await waitFor(() => server._internal.getLastActiveWs() !== null, 1000), 'HUD never became active');
    const afterHud = server._internal.getLastActiveWs();

    // Now the phone pushes a burst of readings, as it does continuously in real
    // use. None of them is operator activity.
    for (let i = 0; i < 5; i++) {
      phone.send(JSON.stringify({ type: 'node-reading', nodeId: 'kitchen-phone', rssi: -60 - i }));
    }
    assert.ok(await waitFor(() => proxy.calls.length >= 5, 1000), 'readings did not arrive');
    assert.equal(server._internal.getLastActiveWs(), afterHud,
      'a phone pushing proximity readings must not become the proactive-speech target');

    // But a real utterance from the phone IS activity, and must take the target
    // — otherwise a phone could never be answered on the socket that asked.
    phone.send(JSON.stringify({ type: 'utterance', reqId: 'r1', text: '' }));
    assert.ok(await waitFor(() => server._internal.getLastActiveWs() !== afterHud, 2000),
      'a real utterance from a node must still count as activity');
  } finally {
    if (hud) { try { hud.close(); } catch (_) {} }
    if (phone) { try { phone.close(); } catch (_) {} }
    await server.stop();
  }
});
