'use strict';

// Voice Nodes Stage 3 — the reply comes out of the device you are standing next
// to.
//
// MYTHOS still synthesizes; only the delivery address changes. So the assertions
// here are about WHERE frames land, and about the two ways that can go wrong
// invisibly:
//
//  1. The origin connection must receive NO speech-chunk. A text-only copy looks
//     harmless but playNextChunk() speaks any chunk with audioB64:null via
//     speechSynthesis — the laptop would narrate over the phone, which is the
//     BUG-060 two-voices defect wearing a different hat.
//  2. The origin's `done` must still carry `chunked:true`, or voice-loop.js takes
//     its non-chunked branch and speaks the whole reply locally anyway.
//
// Everything is opt-in behind AETHER_NODE_AUDIO, so the default install is
// unaffected — pinned below as well, since "new feature quietly changed the
// default path" is the failure this repo keeps paying for.

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

const REPLY = 'The nearest device should be saying this.';

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

// Same stub-brain harness server.test.js's Aether routing test uses — a real
// server and a real turn, with only the model faked. Without the stub brain (and
// the recallHybrid/semantic seams the voice agent reaches for) an utterance
// completes as an error `done` with no chunks at all, which would make every
// assertion below pass or fail for the wrong reason.
function baseDeps(bus, configOverrides) {
  return {
    bus,
    config: Object.assign({
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      AETHER_NODE_AUDIO: true,
    }, configOverrides || {}),
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null },
      fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep-1' }), recall: () => [] },
      semantic: { recall: () => [] },
      recallHybrid: async () => [],
    },
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: REPLY, actions: [], needs_result: false }),
        parsed: { say: REPLY, actions: [], needs_result: false },
        offline: false,
      }),
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: {
      check: () => ({ allow: true, tier: 0, requireConfirm: false }),
      confirm: { create: () => 'cf-1', accept: () => null, reject: () => true },
    },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  };
}

// A connection that records every frame it is sent.
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch (_) { /* ignore */ }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    frames,
    of: (type) => frames.filter((f) => f.type === type),
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

// Claim a node identity and wait for the ack.
async function identifyAs(conn, nodeId) {
  conn.send({ type: 'identify', role: 'node', nodeId });
  await waitFor(() => conn.of('identified').length > 0, 1000);
  return conn.of('identified').pop();
}

// Drive the election the way the aether sensor does.
function electOwner(bus, owner) {
  bus.emit('perception.aether', {
    ts: Date.now(), kind: 'aether', channel: 'aether',
    summary: `Nearest: ${owner || 'none'}`, salience: 0.5,
    detail: { owner, rssi: -50, scanners: [], connected: owner != null },
  });
}

async function withServer(configOverrides, fn) {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, configOverrides));
  try {
    await server.ready;
    await fn({ bus, server, port: server.httpServer.address().port });
  } finally {
    await server.stop();
  }
}

test('identify registers a node and acks it; a second socket for the same id wins and is flagged', async () => {
  await withServer({}, async ({ bus, port }) => {
    const first = await connect(port);
    const ack = await identifyAs(first, 'kitchen-phone');
    assert.deepEqual(ack, { type: 'identified', ok: true, nodeId: 'kitchen-phone' });

    const anomalies = [];
    bus.subscribe('health.anomaly', (e) => anomalies.push(e.payload));

    const second = await connect(port);
    await identifyAs(second, 'kitchen-phone');
    assert.ok(
      anomalies.some((a) => a.kind === 'voice-node-duplicate-identify'),
      'two live sockets claiming one node id must be reported, not silently accepted'
    );

    first.ws.close();
    second.ws.close();
  });
});

test('identify without a nodeId is refused rather than registering an empty id', async () => {
  await withServer({}, async ({ port }) => {
    const conn = await connect(port);
    conn.send({ type: 'identify', role: 'node' });
    await waitFor(() => conn.of('identified').length > 0, 1000);
    assert.equal(conn.of('identified').pop().ok, false);
    conn.ws.close();
  });
});

test('the elected node receives the audio; the origin gets a caption-only done and NO chunks', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, 'kitchen-phone');

    // A real turn. TTS is not running in tests, so chunks carry text with
    // audioB64:null — which is exactly the case that would make the HUD speak
    // locally if a chunk leaked to it.
    hud.send({ type: 'utterance', reqId: 'r1', text: 'hello there' });

    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r1'), 8000), 'turn never completed');
    const done = hud.of('done').find((d) => d.reqId === 'r1');

    assert.equal(hud.of('speech-chunk').length, 0, 'the origin must receive no speech-chunk at all');
    assert.ok(phone.of('speech-chunk').length > 0, 'the elected node received no audio');
    assert.equal(done.chunked, true, 'a non-chunked done makes voice-loop.js speak the reply locally');
    assert.equal(done.routedToNode, 'kitchen-phone');
    assert.ok(done.say, 'the HUD still needs the reply text to caption it');

    hud.ws.close();
    phone.ws.close();
  });
});

test('with no node elected, everything behaves exactly as before', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, null); // Aether says nobody is present

    hud.send({ type: 'utterance', reqId: 'r2', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r2'), 8000), 'turn never completed');

    assert.ok(hud.of('speech-chunk').length > 0, 'the origin should have spoken this one');
    assert.equal(phone.of('speech-chunk').length, 0);
    assert.equal(hud.of('done').find((d) => d.reqId === 'r2').routedToNode, undefined);

    hud.ws.close();
    phone.ws.close();
  });
});

test('an elected node that never identified does not divert the reply', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    // The aggregator can elect a scanner MYTHOS has no socket for at all — the
    // laptop's own bridge.py, for instance. That must speak locally, not vanish.
    electOwner(bus, 'PC');

    hud.send({ type: 'utterance', reqId: 'r3', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r3'), 8000), 'turn never completed');
    assert.ok(hud.of('speech-chunk').length > 0, 'an unroutable owner must fall back to local audio');

    hud.ws.close();
  });
});

test('a node that disconnects releases the route back to local audio', async () => {
  await withServer({}, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, 'kitchen-phone');

    await new Promise((resolve) => { phone.ws.on('close', resolve); phone.ws.close(); });
    await sleep(50);

    hud.send({ type: 'utterance', reqId: 'r4', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r4'), 8000), 'turn never completed');
    assert.ok(hud.of('speech-chunk').length > 0, 'a dead node must not swallow the reply');

    hud.ws.close();
  });
});

test('AETHER_NODE_AUDIO off: an elected, connected node is ignored', async () => {
  await withServer({ AETHER_NODE_AUDIO: false }, async ({ bus, port }) => {
    const hud = await connect(port);
    const phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');
    electOwner(bus, 'kitchen-phone');

    hud.send({ type: 'utterance', reqId: 'r5', text: 'hello there' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'r5'), 8000), 'turn never completed');
    assert.ok(hud.of('speech-chunk').length > 0, 'the default path must be untouched by an opt-in flag');
    assert.equal(phone.of('speech-chunk').length, 0);

    hud.ws.close();
    phone.ws.close();
  });
});
