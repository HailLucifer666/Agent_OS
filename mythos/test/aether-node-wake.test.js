'use strict';

// Voice Nodes Stage 4 — one wake phrase lights exactly one device.
//
// Every node runs its own detector, so a phrase spoken in a hallway is heard by
// several at once. The rule is that nobody local decides: each node REPORTS what
// it heard, MYTHOS asks Aether to rank them (the only component holding every
// scanner's RSSI), and the winner listens while the rest visibly stand down.
//
// Three properties matter more than the happy path, and each has a specific
// failure it prevents:
//
//  - **Debounce.** Four devices reporting one phrase must produce ONE arbitration.
//    Four would each yield a one-shot wakeOutcome, and the later ones would land
//    after the winner began listening — suppressing the device mid-utterance.
//  - **Losers are told.** A node that heard the phrase and receives nothing cannot
//    tell "you lost" from "nobody heard you". It would answer too, or look broken.
//  - **Absence is not consent.** §6.1's `results` lists only PRESENT scanners, so a
//    node that cannot see the beacon appears nowhere. Anything that is not an
//    explicit ACCEPTED must stand down.
//
// And the degradation: with Aether down, arbitration is impossible, so the device
// that heard the phrase answers. Failing closed there would make the whole mesh
// deaf — the worst outcome, and invisible.

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

// ---- the sensor half ---------------------------------------------------------

test('requestWake sends {type:wake} on the live aggregator socket, and false when there is none', async () => {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const sensor = createAetherSensor({
    bus: { emit: () => {} },
    config: { AETHER_WS_URL: `ws://127.0.0.1:${wss.address().port}` },
    logger: SILENT,
  });

  // Before start there is no socket at all — must report false, never throw, so
  // the caller can fall back instead of the mesh going deaf.
  assert.equal(sensor.requestWake(), false);

  sensor.start();
  try {
    assert.ok(await waitFor(() => wss.clients.size === 1, 2000), 'sensor must connect');
    const client = [...wss.clients][0];
    const frames = [];
    client.on('message', (raw) => {
      try { frames.push(JSON.parse(raw.toString())); } catch (_) { /* ignore */ }
    });

    // Wait on the CONDITION, not on a proxy for it. The server accepting the
    // socket and the sensor's own 'open' handler running are two different
    // moments — `connected` flips in the latter — and under full-suite load that
    // gap is wide enough to lose. (It did: this asserted true immediately and
    // failed only in the full run, never in isolation.) Retrying requestWake()
    // is safe: each attempt either sends a frame or reports false, and the
    // assertion below is about what actually arrived.
    assert.ok(await waitFor(() => sensor.requestWake(), 2000),
      'requestWake must succeed once the socket is genuinely open');
    assert.ok(await waitFor(() => frames.length > 0, 2000), 'no wake frame arrived');
    assert.deepEqual(frames[0], { type: 'wake' });
  } finally {
    sensor.stop();
    await new Promise((r) => wss.close(r));
  }
});

test('wakeOutcome is forwarded even when the election carrying it is deduped away', async () => {
  // THE defect this guards. decide()'s dedup gate exists because the aggregator
  // broadcasts every 400ms and the perception queue drains once a second, so it
  // deliberately swallows any election where the owner and RSSI are unchanged.
  // A verdict routed THROUGH that gate would therefore be dropped in the common
  // case — the wake word would appear to work only while the operator happened to
  // be walking, and be silently dead when they stood still.
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));

  const events = [];
  const sensor = createAetherSensor({
    bus: { emit: (name, payload) => events.push({ name, payload }) },
    config: { AETHER_WS_URL: `ws://127.0.0.1:${wss.address().port}` },
    logger: SILENT,
  });
  const verdicts = () => events.filter((e) => e.name === 'aether.wake-outcome');

  sensor.start();
  try {
    assert.ok(await waitFor(() => wss.clients.size === 1, 1000), 'sensor must connect');
    const client = [...wss.clients][0];

    const election = (wakeOutcome) => JSON.stringify({
      type: 'election',
      owner: 'kitchen-phone',
      tick: 1,
      ts: '00:00:00',
      // Byte-identical between sends, so the SECOND one is guaranteed to be
      // deduped by the gate.
      scanners: [{ id: 'kitchen-phone', rssi: -55, smoothedRssi: -55, lastSeenMs: 100, present: true }],
      lastHandoff: null,
      wakeOutcome,
    });

    // First broadcast: acquisition, so the gate lets the perception through too.
    client.send(election(null));
    assert.ok(await waitFor(() => events.some((e) => e.name === 'perception.aether'), 1000),
      'precondition: first acquisition must emit a perception');
    assert.equal(verdicts().length, 0, 'no wake asked for yet, so no verdict');

    // Second broadcast: identical election — the gate swallows the perception —
    // but it carries the one-shot verdict.
    const perceptionsBefore = events.filter((e) => e.name === 'perception.aether').length;
    client.send(election({
      requestedAtTick: 4830,
      ts: '00:00:01',
      owner: 'kitchen-phone',
      results: [
        { id: 'kitchen-phone', outcome: 'ACCEPTED' },
        { id: 'desk-phone', outcome: 'SUPPRESSED' },
      ],
    }));

    assert.ok(await waitFor(() => verdicts().length === 1, 1000),
      'the verdict must survive an election the dedup gate discarded');
    assert.equal(
      events.filter((e) => e.name === 'perception.aether').length,
      perceptionsBefore,
      'precondition: that election really was deduped — otherwise this proves nothing'
    );

    const v = verdicts()[0].payload;
    assert.equal(v.owner, 'kitchen-phone');
    assert.deepEqual(v.results.map((r) => r.id), ['kitchen-phone', 'desk-phone']);
    assert.equal(v.requestedAtTick, 4830);

    // One-shot: a later broadcast without wakeOutcome must not re-emit it, or a
    // single phrase would keep re-triggering the winner every 400ms.
    client.send(election(null));
    await sleep(150);
    assert.equal(verdicts().length, 1, 'wakeOutcome is one-shot (§6.1) and must not repeat');
  } finally {
    sensor.stop();
    await new Promise((r) => wss.close(r));
  }
});

// ---- the server half ---------------------------------------------------------

test('a node-wake asks Aether exactly once, however many nodes report the same phrase', async () => {
  const bus = createBus({ historySize: 50 });
  let askCount = 0;
  const server = createServer(baseDeps(bus, { aetherRequestWake: () => { askCount++; return true; } }));
  const conns = [];
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    for (const id of ['kitchen-phone', 'desk-phone', 'hall-phone']) {
      const c = await connect(port);
      await identifyAs(c, id);
      conns.push({ c, id });
    }

    // All three hear it, near-simultaneously, as they would in a hallway.
    for (const { c, id } of conns) c.send({ type: 'node-wake', nodeId: id });
    await sleep(200);

    assert.equal(askCount, 1,
      'three reports of one phrase must yield ONE arbitration — extra one-shot ' +
      'verdicts would land after the winner started listening and suppress it');
  } finally {
    for (const { c } of conns) { try { c.ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('the verdict reaches every node, winner and losers alike', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, { aetherRequestWake: () => true }));
  let winner;
  let loser;
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    winner = await connect(port);
    loser = await connect(port);
    await identifyAs(winner, 'kitchen-phone');
    await identifyAs(loser, 'desk-phone');

    bus.emit('aether.wake-outcome', {
      owner: 'kitchen-phone',
      results: [
        { id: 'kitchen-phone', outcome: 'ACCEPTED' },
        { id: 'desk-phone', outcome: 'SUPPRESSED' },
      ],
    });

    assert.ok(await waitFor(() => winner.of('wake-outcome').length > 0, 2000), 'winner got no verdict');
    assert.ok(await waitFor(() => loser.of('wake-outcome').length > 0, 2000),
      'a suppressed node MUST be told — silence is indistinguishable from "nobody heard you"');

    const v = winner.of('wake-outcome').pop();
    assert.equal(v.arbitrated, true);
    assert.equal(v.owner, 'kitchen-phone');
    assert.deepEqual(v.results.map((r) => r.outcome), ['ACCEPTED', 'SUPPRESSED']);
  } finally {
    for (const c of [winner, loser]) { if (c) { try { c.ws.close(); } catch (_) {} } }
    await server.stop();
  }
});

test('a node absent from results gets no ACCEPTED — absence is not consent', async () => {
  const bus = createBus({ historySize: 50 });
  const server = createServer(baseDeps(bus, { aetherRequestWake: () => true }));
  let absent;
  try {
    await server.ready;
    absent = await connect(server.httpServer.address().port);
    await identifyAs(absent, 'garage-phone');

    // §6.1: only PRESENT scanners appear in results. A phone that cannot see the
    // beacon is simply missing — and must never read that as permission.
    bus.emit('aether.wake-outcome', {
      owner: 'kitchen-phone',
      results: [{ id: 'kitchen-phone', outcome: 'ACCEPTED' }],
    });

    assert.ok(await waitFor(() => absent.of('wake-outcome').length > 0, 2000), 'no verdict relayed');
    const v = absent.of('wake-outcome').pop();
    assert.equal(v.results.some((r) => r.id === 'garage-phone'), false,
      'the fixture must not contain this node — that is the case under test');
  } finally {
    if (absent) { try { absent.ws.close(); } catch (_) {} }
    await server.stop();
  }
});

test('with Aether down the reporting node is accepted rather than the mesh going deaf', async () => {
  const bus = createBus({ historySize: 50 });
  // No aetherRequestWake at all — Aether disabled, the default install.
  const server = createServer(baseDeps(bus));
  let reporter;
  let other;
  try {
    await server.ready;
    const { port } = server.httpServer.address();
    reporter = await connect(port);
    other = await connect(port);
    await identifyAs(reporter, 'kitchen-phone');
    await identifyAs(other, 'desk-phone');

    reporter.send({ type: 'node-wake', nodeId: 'kitchen-phone' });

    assert.ok(await waitFor(() => reporter.of('wake-outcome').length > 0, 2000),
      'failing closed here would make every node deaf whenever Aether is down');
    const v = reporter.of('wake-outcome').pop();
    assert.equal(v.arbitrated, false, 'it must not claim a verdict it never got');
    assert.deepEqual(v.results, [{ id: 'kitchen-phone', outcome: 'ACCEPTED' }]);

    // The others are told nothing, which leaves them idle rather than suppressed
    // by a decision nobody actually made.
    await sleep(150);
    assert.equal(other.of('wake-outcome').length, 0);
  } finally {
    for (const c of [reporter, other]) { if (c) { try { c.ws.close(); } catch (_) {} } }
    await server.stop();
  }
});

test('a node-wake with no nodeId still arbitrates rather than throwing', async () => {
  const bus = createBus({ historySize: 50 });
  let asked = 0;
  const server = createServer(baseDeps(bus, { aetherRequestWake: () => { asked++; return true; } }));
  let conn;
  try {
    await server.ready;
    conn = await connect(server.httpServer.address().port);
    conn.send({ type: 'node-wake' });
    await sleep(150);
    assert.equal(asked, 1);
    assert.equal(conn.ws.readyState, WebSocket.OPEN);
  } finally {
    if (conn) { try { conn.ws.close(); } catch (_) {} }
    await server.stop();
  }
});
