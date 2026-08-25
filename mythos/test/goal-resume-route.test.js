'use strict';

// BUG-342 (2026-08-24): crash recovery paused EVERY active goal forever and
// the API had no resume path — 7 of 8 vault goals froze (six 'crash-recovery'),
// four of them 'Commitment:' promises with zero tokens spent, and the model
// kept asking "do you want to continue?" about goals nothing could un-pause.
//
// Three layers, tested separately:
//   1. Effector  — resumeGoal(): paused -> active only; anything else no-ops.
//   2. Route     — POST /api/goals/:id/resume: 200 + active on success,
//                  409 naming the current status when it wasn't paused.
//   3. Recovery  — commitment-ledger rows ('Commitment: …') survive
//                  recoverFromCrash's pause-all; real work goals still pause.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const path = require('path');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');
const { mountGoalsRoutes } = '../server/routes/goals.js'.startsWith('/')
  ? {} : require('../server/routes/goals.js');
const { recoverFromCrash } = require('../src/core/immune/monitor');

function makeBridge() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const goalSystem = createGoalSystem({ fs, config: {}, bus });
  return { dir, goalSystem, fsStore: fs, bridgeReady: (async () => { await goalSystem.init(); })(),
    bridge: createGoalsMdBridge({ fs, goalSystem, bus }) };
}

test('effector resumeGoal: paused -> active; resuming an active goal is a listed no-op', async () => {
  const made = makeBridge();
  await made.bridgeReady;
  const { dir, bridge, goalSystem } = made;
  try {
    await bridge.addGoal('Send Dad the recipe', 'Home');
    await bridge.sync();
    const row = bridge.listGoals().find((g) => g.text === 'Send Dad the recipe');
    assert.ok(row && row.id, 'goal created with an id (bridge map populated by sync)');

    // Pause the way budget exhaustion does — direct system update; resume
    // goes through the SAME system so Goals.md stays authoritative.
    goalSystem.update(row.id, { status: 'paused' });
    assert.strictEqual(goalSystem.get(row.id).status, 'paused');

    let list = bridge.resumeGoal(row.id);
    assert.strictEqual(goalSystem.get(row.id).status, 'active', 'resumeGoal must unpause in the system');
    assert.ok(Array.isArray(list) && list.some((g) => g.id === row.id), 'resumeGoal returns the list');

    // Guard: resuming something already active must not throw or mutate.
    list = bridge.resumeGoal(row.id);
    assert.strictEqual(goalSystem.get(row.id).status, 'active');
  } finally {
    cleanupVaultDir(dir);
  }
});

test('route POST /api/goals/:id/resume: 200+active when paused, 409 otherwise', async () => {
  const preStatus = {
    'paused-1': 'paused',
    'active-1': 'active',
  };
  const resumed = [];
  const fakeEffector = {
    getGoal(id) { return { id, status: preStatus[id] || 'unknown' }; },
    resumeGoal(id) {
      resumed.push(id);
      return [{ id, status: 'active', text: 'resumed!' }];
    },
    stats: () => ({ total: 1 }),
  };

  const app = express();
  app.use(express.json());
  mountGoalsRoutes(app, { goalsEffector: fakeEffector, auditRest: () => {}, sanitizeErrorForClient: (e) => e.message });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const call = (method, p2, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p2, method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  try {
    const okRes = await call('POST', '/api/goals/paused-1/resume');
    assert.strictEqual(okRes.status, 200, okRes.body);

    const conflict = await call('POST', '/api/goals/active-1/resume');
    assert.strictEqual(conflict.status, 409, `expected 409 for a goal that was never paused, got ${conflict.status}: ${conflict.body}`);
    assert.match(JSON.parse(conflict.body).error, /not paused/i);
  } finally {
    server.close();
  }
});

test('recovery: a Commitment goal survives crash recovery; a normal goal still pauses', async () => {
  const goals = new Map();
  const fake = {
    _add(g) { goals.set(g.id, Object.assign({ status: 'active' }, g)); },
    get(id) { return goals.get(id) || null; },
    getActiveGoals() { return Array.from(goals.values()).filter((g) => g.status === 'active'); },
    update(id, patch) { const g = goals.get(id); if (g) Object.assign(g, patch); },
  };
  fake._add({ id: 'c1', text: 'Commitment: close Brave', category: 'Op' });
  fake._add({ id: 'w1', text: 'Ship the quarterly build', category: 'Work' });

  await recoverFromCrash({
    bus: fakeBus(),
    config: {},
    memory: { checkpoints: { load: () => null } },
    goals: fake,
    buildRunner: { init: async () => ({ recoveredJobs: [] }) },
  });

  assert.strictEqual(goals.get('w1').status, 'paused', 'normal work goal must still pause');
  assert.strictEqual(goals.get('c1').status, 'active', 'commitment-ledger promises must survive recovery unpause-all');
  assert.notStrictEqual(goals.get('c1').reason, 'crash-recovery');
});
