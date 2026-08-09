'use strict';

// BUG-178 — the boot greeting was delivered to whichever socket connected
// first, and a phone voice node can be that socket.
//
// Voice nodes share the dashboard's /ws path and only reveal themselves with
// {type:'identify', role:'node'} AFTER the upgrade completes, so "the first
// connection this boot" is not the same question as "the dashboard". A phone
// reconnecting at boot (the normal case per NodeLink.kt — sleep, Wi-Fi roam, a
// server restart) therefore won the race: the entire greeting went to the
// phone and the HUD that connected a second later got nothing at all. No
// error, no log line — exactly the "MYTHOS never greets me on this machine"
// shape, live-verified 2026-08-10 with a headless probe.
//
// Speaking through a phone is a real feature, but an ELECTION-gated one:
// nodeSpeechTarget() requires AETHER_NODE_AUDIO *and* an elected aetherOwner.
// The greeting bypassed that gate entirely by picking a socket rather than a
// device, so an unelected node could capture it.
//
// Run: cd mythos && MYTHOS_PORT=4987 EDGE_TTS_PORT=5087 EDGE_TTS_URL=http://127.0.0.1:5087 \
//   node --test test/bug-178-boot-greeting-node-race.test.js

const { describe, it } = require('node:test');
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
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000,
      // Deliberately OFF. This test is about the greeting picking the wrong
      // socket, not about node audio routing — leaving it off proves an
      // unelected node captured the greeting with the feature disabled.
      AETHER_NODE_AUDIO: false,
    },
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
    brain: { think: async () => ({ content: 'Good evening, sir. MYTHOS online.', offline: false }) },
  }, overrides || {});
}

function collect(ws) {
  const received = [];
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch (_) { /* not our frame */ }
  });
  return received;
}

function waitFor(received, predicate, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const timer = setInterval(() => {
      if (received.some(predicate) || Date.now() > deadline) { clearInterval(timer); resolve(); }
    }, 10);
  });
}

const isGreeting = (m) => m.type === 'proactive-speech';

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return ws;
}

describe('BUG-178: the boot greeting belongs to the dashboard, not to whoever connects first', () => {
  it('a phone node connecting first does not consume the greeting — the HUD that connects after still gets it', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const port = server.httpServer.address().port;
    // NODE_TEST_CONTEXT pre-fires the gate (the real 2.5s timer would outlive
    // the test file), so arm it explicitly and shorten the delay — the race
    // being tested is unreachable from outside otherwise.
    server._internal.setBootGreetingDelayMs(40);
    server._internal.rearmBootGreeting();

    const node = await connect(port);
    const nodeFrames = collect(node);
    node.send(JSON.stringify({ type: 'identify', role: 'node', nodeId: 'test-phone', caps: ['live-audio'] }));
    await waitFor(nodeFrames, (m) => m.type === 'identified' && m.ok === true, 2000);
    assert.equal(nodeFrames.some((m) => m.type === 'identified' && m.ok === true), true,
      'the node must be registered before the greeting timer fires, which is the real race');

    // Well past the (shortened) greeting delay. Before the fix the greeting was
    // already gone by now — delivered to the node.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const hud = await connect(port);
    const hudFrames = collect(hud);

    try {
      await waitFor(hudFrames, isGreeting, 3000);
      assert.equal(hudFrames.filter(isGreeting).length, 1,
        'the dashboard must receive exactly one boot greeting');
      assert.equal(nodeFrames.some(isGreeting), false,
        'the greeting must never be delivered to a voice node that was merely first to connect — ' +
        'node speech is election-gated (AETHER_NODE_AUDIO + an elected aetherOwner)');
    } finally {
      node.close();
      hud.close();
      await server.stop();
    }
  });

  it('a dashboard connecting first still gets the greeting immediately — the guard must not cost the normal case', async () => {
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const port = server.httpServer.address().port;
    server._internal.setBootGreetingDelayMs(40);
    server._internal.rearmBootGreeting();

    const hud = await connect(port);
    const hudFrames = collect(hud);

    try {
      await waitFor(hudFrames, isGreeting, 3000);
      assert.equal(hudFrames.filter(isGreeting).length, 1,
        'the ordinary single-dashboard boot is unchanged by the node guard');
    } finally {
      hud.close();
      await server.stop();
    }
  });

  it('a dashboard that connected DURING the node window still gets the greeting — re-arming alone loses it', async () => {
    // The case the first cut of this fix missed, found by live probe rather than
    // by this file: the HUD connects while the node's timer is still pending, so
    // it sees bootGreetingFired === true and never arms a timer of its own.
    // Re-arming at fire time is too late for it, and the greeting is lost by
    // both devices — which is indistinguishable from the original bug.
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const port = server.httpServer.address().port;
    server._internal.setBootGreetingDelayMs(600);
    server._internal.rearmBootGreeting();

    const node = await connect(port);
    const nodeFrames = collect(node);
    node.send(JSON.stringify({ type: 'identify', role: 'node', nodeId: 'test-phone', caps: [] }));
    await waitFor(nodeFrames, (m) => m.type === 'identified' && m.ok === true, 2000);

    // Inside the node's still-pending window, not after it.
    const hud = await connect(port);
    const hudFrames = collect(hud);

    try {
      await waitFor(hudFrames, isGreeting, 3000);
      assert.equal(hudFrames.filter(isGreeting).length, 1,
        'the already-connected dashboard must be handed the greeting when the node is skipped');
      assert.equal(nodeFrames.some(isGreeting), false, 'and the node still must not receive it');
    } finally {
      node.close();
      hud.close();
      await server.stop();
    }
  });

  it('the greeting is spoken once, not once per dashboard tab, after a node has been skipped', async () => {
    // The re-arm must hand the greeting to the NEXT dashboard, not to every
    // dashboard: re-opening the gate is only correct if the first real
    // dashboard closes it again.
    const bus = createBus({ historySize: 50 });
    const server = createServer(baseDeps(bus, {}));
    await server.ready;
    const port = server.httpServer.address().port;
    server._internal.setBootGreetingDelayMs(40);
    server._internal.rearmBootGreeting();

    const node = await connect(port);
    const nodeFrames = collect(node);
    node.send(JSON.stringify({ type: 'identify', role: 'node', nodeId: 'test-phone', caps: [] }));
    await waitFor(nodeFrames, (m) => m.type === 'identified' && m.ok === true, 2000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const tabA = await connect(port);
    const framesA = collect(tabA);
    await waitFor(framesA, isGreeting, 3000);
    const tabB = await connect(port);
    const framesB = collect(tabB);

    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(framesA.filter(isGreeting).length, 1, 'the first dashboard gets the greeting');
      assert.equal(framesB.some(isGreeting), false,
        'a second tab must not trigger a second greeting — two overlapping voices is the BUG-112 shape');
    } finally {
      node.close();
      tabA.close();
      tabB.close();
      await server.stop();
    }
  });
});
