'use strict';

// BUG-069 (Stage 3 of 7) — the healer must not claim it fixed something it
// didn't touch.
//
// healer.js's onDiagnosed emits 'health.healed' on EVERY diagnosis outcome —
// 'applied' (a playbook ran), but also 'no-match' (nothing recognized the
// anomaly), 'cooldown', and 'error'. server/index.js's subscriber used to
// ignore the `outcome` field entirely and always write an episodic record
// labeled 'healed: <kind>' and mark the HUD's anomalyLog entry healed:true —
// 36 such no-match pairs were found in the episodic logs, each claiming a fix
// that never happened. probes.js's own 'provider-recovered' event (a genuine
// down->up transition) carries NO `outcome` field, so its absence must still
// mean "yes, this recovered" — only an EXPLICIT non-'applied' outcome means
// no corrective action was taken.
//
// Real bus + real server (same pattern as server.test.js's existing
// 'health.healed ... marked healed:true' test) so this is proven against the
// actual subscriber wiring, not a reimplementation of it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');

function fakeFs() {
  return { vaultPath: (...segments) => path.join('/test-vault', ...segments) };
}

function baseDeps(bus, memory) {
  return {
    bus,
    config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'TEST', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000 },
    logger: { info() {}, warn() {}, error() {} },
    memory,
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
  };
}

async function withHealthBroadcast(payload) {
  const bus = createBus({ historySize: 50 });
  const writes = [];
  const memory = {
    working: { tick: 0, activeGoalId: null },
    episodic: { write: async (rec) => { writes.push(rec); } },
    fs: fakeFs(),
  };
  const server = createServer(baseDeps(bus, memory));
  await server.ready;
  const addr = server.httpServer.address();
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  const received = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'health') resolve(msg);
    });
  });

  bus.emit('health.healed', payload);
  const msg = await received;
  const entry = msg.payload.anomalies[msg.payload.anomalies.length - 1];

  ws.close();
  await server.stop();
  return { entry, writes };
}

test('BUG-069: a no-match diagnosis is labeled unhandled, not healed', async () => {
  const { entry, writes } = await withHealthBroadcast({
    kind: 'build-engine-failed', target: 'forge', outcome: 'no-match', playbookId: null,
  });
  assert.equal(entry.healed, false, 'the HUD card must not show a no-match as a heal');
  assert.equal(writes[0].outcome, 'unhandled', 'the episodic record must not claim outcome:healed for a no-match');
  assert.match(writes[0].summary, /^unhandled:/, 'the summary must not say "healed:" for something that was not');
  assert.doesNotMatch(writes[0].summary, /^healed:/);
});

test('Wave 0 (2026-08-13): a cooldown-suppressed diagnosis is labeled cooldown, not unhandled', async () => {
  // Superseded BUG-069's original assertion (outcome:'unhandled' for cooldown
  // too) — a cooldown is the healer intentionally throttling a playbook it
  // already ran, not a fix attempt that failed, and lumping it in with
  // no-match/error made a healthy suppression read as a standing problem.
  const { entry, writes } = await withHealthBroadcast({
    kind: 'quota-low', target: 'openai', outcome: 'cooldown', playbookId: 'quota-guard',
  });
  assert.equal(entry.healed, false, 'cooldown is still not a heal for the HUD card');
  assert.equal(writes[0].outcome, 'cooldown');
  assert.match(writes[0].summary, /^cooldown:/);
});

test('BUG-069 (regression guard): a genuinely applied playbook is still labeled healed', async () => {
  const { entry, writes } = await withHealthBroadcast({
    kind: 'cortex-stalled', target: null, outcome: 'applied', playbookId: 'stall-restart',
  });
  assert.equal(entry.healed, true);
  assert.equal(writes[0].outcome, 'healed');
  assert.match(writes[0].summary, /^healed:/);
});

test('BUG-069 (regression guard): probes.js\'s provider-recovered event (no outcome field) still counts as healed', async () => {
  const { entry, writes } = await withHealthBroadcast({
    kind: 'provider-recovered', target: 'mistral',
  });
  assert.equal(entry.healed, true, 'a genuine down->up transition carries no outcome field and must still read as healed');
  assert.equal(writes[0].outcome, 'healed');
});
