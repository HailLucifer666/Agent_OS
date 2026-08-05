'use strict';

// BUG-112 — four greetings in three minutes, one saying "Good morning" at 5:08 PM.
//
// This file covers the "time honesty" half of the bug: every brain-composed
// greeting-shaped prompt must be handed the ALREADY-COMPUTED salutation and
// forbidden from inventing/contradicting it (same no-fabrication pattern as
// immune/explainer.js's tool-naming clause for BUG-105), and the daily
// planner's canned offline fallback must stop being hardcoded to "Good
// morning" regardless of the actual hour.
//
// Covers:
//   (a) server/index.js's deliverBootGreeting() brain prompt includes the
//       real computed salutation + a no-invention instruction.
//   (a) planner/daily.js's runMorning() brain prompt does the same.
//   (c) planner/daily.js's canned morning fallback is not time-blind.
//
// Run: cd mythos && MYTHOS_PORT=4983 EDGE_TTS_PORT=5083 EDGE_TTS_URL=http://127.0.0.1:5083 \
//   node --test test/bug-112-greeting-time-honesty.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createBus } = require('../src/core/bus');
const { createServer } = require('../server');
const { createDailyPlanner } = require('../src/core/planner/daily');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');

// Mirrors test/server.test.js's baseDeps exactly — minimal deps createServer
// needs to construct without throwing, nothing more.
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
    agentActions: {
      assembleKanbanPlan: () => ({ job: { id: 'j1', status: 'queued' } }),
      buildKanbanCard: () => ({ job: { id: 'j1', status: 'queued' }, board: { cards: [] } }),
      reviewKanbanCard: () => ({ job: { id: 'j1', status: 'queued' } }),
    },
    buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
  }, overrides || {});
}

describe('BUG-112: greeting-shaped brain prompts are time-honest', () => {
  it('deliverBootGreeting\'s brain prompt includes the real computed salutation and forbids inventing a different one', async () => {
    const bus = createBus({ historySize: 50 });
    const calls = [];
    const brain = { think: async (args) => { calls.push(args); return { content: 'A greeting.', offline: false }; } };
    const server = createServer(baseDeps(bus, { brain }));
    await server.ready;

    try {
      // No targetWs -> falls back to broadcastAll (zero clients, no-op) — we
      // only care about the prompt handed to brain.think, not delivery.
      await server._internal.deliverBootGreeting();

      assert.equal(calls.length, 1, 'brain.think must be called exactly once for the boot greeting');
      const prompt = calls[0].messages[0].content;
      const hour = new Date().getHours();
      const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      assert.ok(prompt.indexOf(salutation) !== -1,
        'prompt must include the actual computed salutation ("' + salutation + '"): ' + prompt);
      assert.match(prompt, /do not invent/i,
        'prompt must explicitly forbid the model from inventing/contradicting the time of day: ' + prompt);
    } finally {
      await server.stop();
    }
  });

  it('planner/daily.js runMorning()\'s brain prompt includes the real computed salutation (5pm) and forbids inventing a different one', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const calls = [];
    const brain = { think: async (args) => { calls.push(args); return { content: 'A brief.', offline: false }; } };
    const goals = { arbitrate: () => null, list: () => [], get: () => null };
    // Fixed at 17:00 — exactly BUG-112's reported failure time (17:06-17:09).
    // Per the same hour-bucket rule server/index.js uses (hour<18 => afternoon),
    // 17:00 is "Good afternoon", not "Good evening" — the bug report itself notes
    // the 17:07 boot greeting correctly said "Good afternoon".
    const now = () => new Date(2026, 7, 5, 17, 0, 0, 0).getTime();
    const memory = { fs: createFsStore(() => dir, null) };
    const planner = createDailyPlanner({ bus, config: {}, memory, goals, brain, now });

    await planner.runMorning();

    assert.equal(calls.length, 1);
    const prompt = calls[0].messages[0].content;
    assert.ok(prompt.indexOf('Good afternoon') !== -1,
      'prompt must include the real 5pm salutation "Good afternoon": ' + prompt);
    assert.match(prompt, /do not invent/i,
      'prompt must forbid inventing a different time of day: ' + prompt);

    cleanupVaultDir(dir);
  });

  it('the canned morning-brief fallback does not say "Good morning" at 5pm (brain offline)', async () => {
    const dir = tempVaultDir();
    const bus = fakeBus();
    const goals = { arbitrate: () => null, list: () => [], get: () => null };
    const now = () => new Date(2026, 7, 5, 17, 0, 0, 0).getTime();
    const memory = { fs: createFsStore(() => dir, null) };
    // No brain at all -> brainCompose resolves straight to the canned fallback.
    const planner = createDailyPlanner({ bus, config: {}, memory, goals, brain: null, now });

    const result = await planner.runMorning();

    assert.ok(!/Good morning/i.test(result.text),
      'canned fallback must not say "Good morning" at 5pm: "' + result.text + '"');
    assert.ok(/Good afternoon/i.test(result.text),
      'canned fallback should say "Good afternoon" at 5pm: "' + result.text + '"');

    cleanupVaultDir(dir);
  });
});
