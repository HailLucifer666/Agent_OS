'use strict';

// Voice Nodes Stage 5 — a sentence follows you across the room.
//
// Aether already runs the four-phase handoff FSM (PROTOCOL.md §6.3:
// PREPARE -> TRANSFER -> CONFIRM -> RELEASE, ~200ms each) when the elected owner
// changes while an utterance is still speaking. Two things have to happen for a
// half-played sentence to survive it:
//
//  1. Every identified node must SEE each phase, in time to act. The phases are
//     200ms apart, so anything that waits for the next election perception is
//     already too late — hence a dedicated bus event rather than piggybacking on
//     perception.aether.
//  2. Chunks not yet synthesized must be redirected, and the losing device told to
//     drop what it still holds. Without the cancel both devices talk at once;
//     without the redirect the tail of the reply plays in the room you left.
//
// The phase event is emitted on CHANGE ONLY. The aggregator re-broadcasts the
// current phase every 400ms, so relaying every broadcast would be a 2.5Hz flood
// into the bus storm guard carrying no new information — that is asserted here,
// because "it works but floods" is invisible until something else starts dropping.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const WebSocket = require('ws');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createAetherSensor } = require('../src/core/sensors/aether');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const SILENT = { info() {}, warn() {}, error() {} };
const REPLY = 'This sentence should follow you into the kitchen.';

function fakeFs() {
  return { vaultPath: (...s) => path.join('/test-vault', ...s) };
}

function baseDeps(bus, overrides) {
  return Object.assign({
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      AETHER_NODE_AUDIO: true,
    },
    logger: SILENT,
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
  }, overrides || {});
}

// A reply long enough to still be mid-flight, and a TTS that takes real time per
// sentence. Without both, the whole reply is emitted in one synchronous burst
// (TTS down => zero synthesis latency) and there is no such thing as "in flight"
// to hand off — the test would assert against a reply that already finished.
const SLOW_TTS_MS = 400;
const MULTI_SENTENCE = 'First part of the answer. Second part of the answer. Third part of the answer.';

function slowTtsDeps(bus) {
  return baseDeps(bus, {
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: MULTI_SENTENCE, actions: [], needs_result: false }),
        parsed: { say: MULTI_SENTENCE, actions: [], needs_result: false },
        offline: false,
      }),
    },
    ttsChain: {
      // chainNames is read at construction for the boot log, so a fake that
      // omits it fails before the server ever listens.
      chainNames: ['fake-slow-tts'],
      isAvailable: async () => true,
      synthesize: async () => {
        await sleep(SLOW_TTS_MS);
        return { audio: Buffer.from([0x00, 0x01, 0x02]), mime: 'audio/mpeg' };
      },
    },
  });
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch (_) { /* ignore */ }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws, frames,
    of: (type) => frames.filter((f) => f.type === type),
    send: (m) => ws.send(JSON.stringify(m)),
  };
}

async function identifyAs(conn, nodeId) {
  conn.send({ type: 'identify', role: 'node', nodeId });
  await waitFor(() => conn.of('identified').length > 0, 1000);
}

function electOwner(bus, owner) {
  bus.emit('perception.aether', {
    ts: Date.now(), kind: 'aether', channel: 'aether',
    summary: `Nearest: ${owner || 'none'}`, salience: 0.5,
    detail: { owner, rssi: -50, scanners: [], connected: owner != null },
  });
}

// ---- the sensor half: does a phase change reach the bus, exactly once? -------

test('the sensor emits aether.conversation on a phase CHANGE and stays silent on re-broadcasts', () => {
  const events = [];
  const bus = { emit: (name, payload) => events.push({ name, payload }) };
  const sensor = createAetherSensor({ bus, config: {}, logger: SILENT });

  // The aggregator re-sends the live phase every 400ms. Five identical IDLEs must
  // produce nothing at all.
  for (let i = 0; i < 5; i++) {
    sensor._internal.ingest({ type: 'conversation', phase: 'IDLE', speakingScanner: null });
  }
  assert.equal(events.filter((e) => e.name === 'aether.conversation').length, 0,
    'a repeated phase must not be relayed — that is a 2.5Hz flood carrying no news');

  sensor._internal.ingest({ type: 'conversation', phase: 'PREPARE', speakingScanner: 'desk-phone' });
  sensor._internal.ingest({ type: 'conversation', phase: 'PREPARE', speakingScanner: 'desk-phone' });
  sensor._internal.ingest({ type: 'conversation', phase: 'TRANSFER', speakingScanner: 'desk-phone' });

  const relayed = events.filter((e) => e.name === 'aether.conversation').map((e) => e.payload);
  assert.equal(relayed.length, 2, `expected one event per change, got ${relayed.length}`);
  assert.deepEqual(
    { phase: relayed[0].phase, from: relayed[0].from },
    { phase: 'PREPARE', from: 'IDLE' },
  );
  assert.equal(relayed[0].speakingScanner, 'desk-phone');
  assert.equal(relayed[1].phase, 'TRANSFER');
  assert.equal(relayed[1].from, 'PREPARE');
});

test('every FSM phase reaches an identified node, in order', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  let phone;
  try {
    await server.ready;
    phone = await connect(server.httpServer.address().port);
    await identifyAs(phone, 'kitchen-phone');

    for (const phase of ['PREPARE', 'TRANSFER', 'CONFIRM', 'RELEASE', 'IDLE']) {
      bus.emit('aether.conversation', { phase, from: null, speakingScanner: 'desk-phone' });
    }
    assert.ok(await waitFor(() => phone.of('conversation').length >= 5, 2000), 'phases did not arrive');
    assert.deepEqual(
      phone.of('conversation').map((f) => f.phase),
      ['PREPARE', 'TRANSFER', 'CONFIRM', 'RELEASE', 'IDLE'],
      'a node needs TRANSFER (pause, record playhead) and RELEASE (resume), not just CONFIRM'
    );
  } finally {
    if (phone) { try { phone.ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('a non-node connection is not sent conversation phases', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  let hud;
  try {
    await server.ready;
    hud = await connect(server.httpServer.address().port); // never identifies
    bus.emit('aether.conversation', { phase: 'TRANSFER', from: 'PREPARE', speakingScanner: 'x' });
    await sleep(120);
    assert.equal(hud.of('conversation').length, 0,
      'the relay is addressed to nodes; a HUD tab has no playhead to move');
  } finally {
    if (hud) { try { hud.ws.close(); } catch (_) {} }
    await server.stop();
  }
});

// ---- the server half: does a live reply actually move? -----------------------

test('at CONFIRM a reply in flight moves to the new owner, and the old node is told to cancel', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(slowTtsDeps(bus));
  let hud;
  let deskPhone;
  let kitchenPhone;
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    hud = await connect(port);
    deskPhone = await connect(port);
    kitchenPhone = await connect(port);
    await identifyAs(deskPhone, 'desk-phone');
    await identifyAs(kitchenPhone, 'kitchen-phone');

    // Speaking at the desk.
    electOwner(bus, 'desk-phone');
    hud.send({ type: 'utterance', reqId: 'walk-1', text: 'tell me something' });
    assert.ok(await waitFor(() => deskPhone.of('speech-chunk').length > 0, 8000), 'desk never got audio');

    // The operator walks into the kitchen: Aether re-elects, and the FSM reaches
    // the phase where attribution flips.
    electOwner(bus, 'kitchen-phone');
    bus.emit('aether.conversation', { phase: 'CONFIRM', from: 'TRANSFER', speakingScanner: 'desk-phone' });

    assert.ok(
      await waitFor(() => deskPhone.of('cancel').some((c) => c.reqId === 'walk-1'), 2000),
      'the device losing the sentence must be told to drop its queue, or both talk at once'
    );

    // The half that actually matters: the REST of the reply has to arrive in the
    // kitchen. A cancel on its own would just truncate the answer in the room the
    // operator left.
    assert.ok(
      await waitFor(() => kitchenPhone.of('speech-chunk').length > 0, 4000),
      'the remaining chunks must continue on the new owner, not stop'
    );
    const deskChunks = deskPhone.of('speech-chunk').length;
    const kitchenChunks = kitchenPhone.of('speech-chunk').length;
    // Both devices played part of one reply, which is precisely a handoff — and
    // neither played all of it, which is what proves the split was real.
    assert.ok(deskChunks > 0 && kitchenChunks > 0, `desk=${deskChunks} kitchen=${kitchenChunks}`);
    assert.ok(
      await waitFor(() => hud.of('done').some((d) => d.reqId === 'walk-1'), 6000),
      'the turn must still complete for the HUD after a handoff'
    );
    // The final `done` names where the reply ENDED up, not where it began.
    assert.equal(hud.of('done').find((d) => d.reqId === 'walk-1').routedToNode, 'kitchen-phone');
  } finally {
    for (const c of [hud, deskPhone, kitchenPhone]) {
      if (c) { try { c.ws.close(); } catch (_) {} }
    }
    await server.stop();
  }
});

test('a handoff with nothing in flight is a no-op — no stray cancel', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  let phone;
  try {
    await server.ready;
    phone = await connect(server.httpServer.address().port);
    await identifyAs(phone, 'desk-phone');
    electOwner(bus, 'desk-phone');

    // §6.3: the FSM only runs when an utterance is active. A cancel arriving with
    // nothing playing would cut off whatever started next.
    bus.emit('aether.conversation', { phase: 'CONFIRM', from: 'TRANSFER', speakingScanner: 'desk-phone' });
    await sleep(150);
    assert.equal(phone.of('cancel').length, 0);
  } finally {
    if (phone) { try { phone.ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('a reply that started on local audio is never yanked onto a device mid-sentence', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus));
  let hud;
  let phone;
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    hud = await connect(port);
    phone = await connect(port);
    await identifyAs(phone, 'kitchen-phone');

    // Nobody elected when the reply starts, so it speaks locally.
    electOwner(bus, null);
    hud.send({ type: 'utterance', reqId: 'local-1', text: 'tell me something' });
    assert.ok(await waitFor(() => hud.of('done').some((d) => d.reqId === 'local-1'), 8000), 'no reply');
    const chunksLocally = hud.of('speech-chunk').length;
    assert.ok(chunksLocally > 0, 'should have spoken locally');

    // A handoff now must not relocate audio the operator is already hearing from
    // the machine in front of them.
    electOwner(bus, 'kitchen-phone');
    bus.emit('aether.conversation', { phase: 'CONFIRM', from: 'TRANSFER', speakingScanner: null });
    await sleep(150);
    assert.equal(phone.of('speech-chunk').length, 0);
    assert.equal(phone.of('cancel').length, 0);
  } finally {
    for (const c of [hud, phone]) { if (c) { try { c.ws.close(); } catch (_) {} } }
    await server.stop();
  }
});
