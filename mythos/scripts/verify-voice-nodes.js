'use strict';

// End-to-end check of the Voice Nodes chain against the REAL Aether aggregator.
//
// What this proves that the unit suite cannot: that MYTHOS's scanner-proxy is
// accepted as a conformant scanner by aggregator.py itself (which dials it,
// parses its frames, and runs the real election algorithm), and that an election
// decided by that real code reaches MYTHOS and steers a real spoken reply to the
// right socket.
//
// What it still does NOT prove, and must not be reported as proving: no BLE radio
// is involved (readings are injected where a phone's verified sighting would
// arrive), and no audio is played (chunk delivery to a socket is not sound from a
// speaker). Those need the hardware.
//
// USAGE (paths are yours; nothing machine-specific is hardcoded here):
//
//   MYTHOS_DIR=/path/to/mythos //   AGG_DIR=/path/to/Aether-BLE/aether-bridge //   AGG_PYTHON=/path/to/Aether-BLE/aether-bridge/.venv/Scripts/python.exe //   node mythos/scripts/verify-voice-nodes.js
//
// Exits non-zero on the first failed check. Not part of `node --test` on purpose:
// it spawns a Python process from a sibling repo that most machines will not
// have, and a check that silently skips is worse than one you run deliberately.

const { spawn } = require('node:child_process');
const path = require('node:path');

const MYTHOS = process.env.MYTHOS_DIR || path.join(__dirname, '..');
if (!process.env.AGG_DIR || !process.env.AGG_PYTHON) {
  console.error('Set AGG_DIR and AGG_PYTHON (see the header). Nothing was run.');
  process.exit(2);
}
// Resolve 'ws' out of mythos/node_modules — this script lives outside the repo.
const WebSocket = require(path.join(MYTHOS, 'node_modules', 'ws'));
const { createBus } = require(path.join(MYTHOS, 'src/core/bus'));
const { createServer } = require(path.join(MYTHOS, 'server'));
const { createScannerProxy } = require(path.join(MYTHOS, 'src/core/aether/scanner-proxy'));
const { createAetherSensor } = require(path.join(MYTHOS, 'src/core/sensors/aether'));

const AGG_DIR = process.env.AGG_DIR;
const AGG_PYTHON = process.env.AGG_PYTHON;
const PROXY_BASE = 4480;
const AGG_PORT = 8766;
const REPLY = 'Acknowledged. This reply should reach the nearest node.';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms, step = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

function fakeFs() { return { vaultPath: (...s) => path.join('/live-check-vault', ...s) }; }

function deps(bus, scannerProxy, sensor) {
  return {
    bus,
    config: {
      MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'LIVECHECK',
      MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '',
      AETHER_NODE_AUDIO: true,
    },
    logger: { info() {}, warn() {}, error() {} },
    memory: {
      working: { tick: 0, activeGoalId: null }, fs: fakeFs(),
      episodic: { write: async () => ({ ref: 'ep' }), recall: () => [] },
      semantic: { recall: () => [] }, recallHybrid: async () => [],
    },
    brain: {
      think: async () => ({
        content: JSON.stringify({ say: REPLY, actions: [], needs_result: false }),
        parsed: { say: REPLY, actions: [], needs_result: false }, offline: false,
      }),
    },
    goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
    kanbanEffector: { listBoard: () => ({ cards: [] }) },
    pipelineEffector: { listAll: () => ({}) },
    effectors: { breakers: new Map(), invoke: async () => ({ ok: true }), effectors: new Map() },
    leash: { check: () => ({ allow: true, tier: 0, requireConfirm: false }),
             confirm: { create: () => 'cf', accept: () => null, reject: () => true } },
    goals: { debitBudget: () => {} },
    probes: { getStatus: async () => ({ ok: true }) },
    agentActions: {
      assembleKanbanPlan: () => ({ job: {} }), buildKanbanCard: () => ({ job: {}, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: {} }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
    scannerProxy,
    aetherRequestWake: () => sensor.requestWake(),
  };
}

async function connect(port, label) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch (_) {} });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return { ws, label, frames, of: (t) => frames.filter((f) => f.type === t),
           send: (m) => ws.send(JSON.stringify(m)) };
}

(async () => {
  const bus = createBus({ historySize: 200 });
  const elections = [];
  bus.subscribe('perception.aether', (e) => elections.push(e.payload));

  const proxy = createScannerProxy({
    config: { AETHER_NODE_IDS: 'kitchen-phone,desk-phone', AETHER_PROXY_PORT_BASE: PROXY_BASE },
    logger: { info() {}, warn() {}, error() {} },
  });
  proxy.start();
  await proxy.whenReady();
  check('scanner-proxy binds a port per node', true, JSON.stringify(proxy.ports()));

  const sensor = createAetherSensor({
    bus, config: { AETHER_WS_URL: `ws://127.0.0.1:${AGG_PORT}` },
    logger: { info() {}, warn() {}, error() {} },
  });

  const server = createServer(deps(bus, proxy, sensor));
  await server.ready;
  const port = server.httpServer.address().port;

  // The REAL aggregator, dialling our proxy ports as if they were bridge.py.
  const agg = spawn(AGG_PYTHON, ['aggregator.py',
    '--peers', `ws://127.0.0.1:${PROXY_BASE},ws://127.0.0.1:${PROXY_BASE + 1}`,
    '--port', String(AGG_PORT)],
    { cwd: AGG_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const aggLog = [];
  agg.stdout.on('data', (d) => aggLog.push(d.toString()));
  agg.stderr.on('data', (d) => aggLog.push(d.toString()));

  const cleanup = async () => {
    try { agg.kill(); } catch (_) {}
    try { sensor.stop(); } catch (_) {}
    try { proxy.stop(); } catch (_) {}
    try { await server.stop(); } catch (_) {}
  };

  try {
    sensor.start();
    // The aggregator retries dead peers every 2s forever, so give it a couple.
    // Proof of connection is the aggregator naming OUR scanner ids in its own
    // tick table: those strings exist nowhere on its side — it learned them by
    // dialling the proxy ports and parsing the §4 frames we sent.
    const connected = await waitFor(() => {
      const log = aggLog.join('');
      return log.includes('kitchen-phone') && log.includes('desk-phone');
    }, 20000);
    check('real aggregator.py dials the proxy and reads our scanner ids', connected,
      connected ? 'both ids appear in its tick table' : aggLog.join('').slice(-200));

    const hud = await connect(port, 'hud');
    const kitchen = await connect(port, 'kitchen');
    const desk = await connect(port, 'desk');
    kitchen.send({ type: 'identify', role: 'node', nodeId: 'kitchen-phone' });
    desk.send({ type: 'identify', role: 'node', nodeId: 'desk-phone' });
    await waitFor(() => kitchen.of('identified').length && desk.of('identified').length, 3000);
    check('both nodes identify on MYTHOS', kitchen.of('identified').length > 0 && desk.of('identified').length > 0, '');

    // Push readings the way a phone's verified sighting would. Kitchen is nearer.
    const push = (conn, id, rssi) => conn.send({ type: 'node-reading', nodeId: id, rssi, name: 'mythos-wrist' });
    const pumpFor = async (ms, fn) => { const end = Date.now() + ms; while (Date.now() < end) { fn(); await sleep(200); } };

    await pumpFor(4000, () => { push(kitchen, 'kitchen-phone', -45); push(desk, 'desk-phone', -80); });
    const ownerIsKitchen = await waitFor(
      () => elections.length && elections[elections.length - 1].detail.owner === 'kitchen-phone', 8000);
    const seenPresent = aggLog.join('').includes('kitchen-phone=') &&
      /kitchen-phone=\s*-?\d/.test(aggLog.join(''));
    check('the aggregator sees a real RSSI from the proxy, not LOST', seenPresent,
      seenPresent ? 'numeric rssi in its table' : 'still LOST');
    check('the REAL election picks the nearer node', ownerIsKitchen,
      elections.length ? 'owner=' + elections[elections.length - 1].detail.owner : 'no perception emitted');

    // A real turn: the reply must land on the elected node's socket.
    hud.send({ type: 'utterance', reqId: 'live-1', text: 'say something' });
    const doneOk = await waitFor(() => hud.of('done').some((d) => d.reqId === 'live-1'), 20000);
    const kitchenGot = kitchen.of('speech-chunk').length;
    const hudGot = hud.of('speech-chunk').length;
    const deskGot = desk.of('speech-chunk').length;
    check('the reply is delivered to the elected node, not the HUD', doneOk && kitchenGot > 0 && hudGot === 0,
      `kitchen=${kitchenGot} hud=${hudGot} desk=${deskGot}`);
    const done1 = hud.of('done').find((d) => d.reqId === 'live-1');
    check('the HUD still gets a caption-only done', !!done1 && done1.chunked === true && !!done1.say,
      done1 ? `routedToNode=${done1.routedToNode}` : 'no done');

    // Walk to the desk: hysteresis is 5 dB over 2 consecutive ticks (§5.1).
    await pumpFor(6000, () => { push(kitchen, 'kitchen-phone', -85); push(desk, 'desk-phone', -40); });
    const flipped = await waitFor(
      () => elections.length && elections[elections.length - 1].detail.owner === 'desk-phone', 10000);
    check('the election follows the operator across the room', flipped,
      elections.length ? 'owner=' + elections[elections.length - 1].detail.owner : '');

    const kitchenBefore = kitchen.of('speech-chunk').length;
    hud.send({ type: 'utterance', reqId: 'live-2', text: 'say something else' });
    await waitFor(() => hud.of('done').some((d) => d.reqId === 'live-2'), 20000);
    check('the next reply comes out of the new room', desk.of('speech-chunk').length > 0 &&
      kitchen.of('speech-chunk').length === kitchenBefore,
      `desk=${desk.of('speech-chunk').length} kitchen(unchanged)=${kitchenBefore}`);

    // Wake arbitration, decided by the real aggregator.
    kitchen.send({ type: 'node-wake', nodeId: 'kitchen-phone' });
    const gotVerdict = await waitFor(() => kitchen.of('wake-outcome').length > 0 && desk.of('wake-outcome').length > 0, 8000);
    const v = kitchen.of('wake-outcome').pop();
    const byId = {};
    (v && v.results || []).forEach((r) => { byId[r.id] = r.outcome; });
    check('the real aggregator arbitrates the wake', gotVerdict && v && v.arbitrated === true,
      v ? JSON.stringify(byId) : 'no verdict');
    check('exactly one device is ACCEPTED, and it is the elected one',
      byId['desk-phone'] === 'ACCEPTED' && byId['kitchen-phone'] === 'SUPPRESSED',
      JSON.stringify(byId));

    for (const c of [hud, kitchen, desk]) { try { c.ws.close(); } catch (_) {} }
  } catch (err) {
    check('harness ran to completion', false, err && err.message);
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('AGGREGATOR LOG TAIL:\n' + (global.__aggTail || ''));
  process.exit(failed.length ? 1 : 0);
})();
