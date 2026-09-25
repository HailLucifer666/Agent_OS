'use strict';

// consolidate-gate-and-diagnostics.test.js — fix-plan 3.1 (2026-08-17).
//
// Episodic→semantic distillation never ran in production for two structural
// reasons, both pinned here:
//
//   1. the cortex idle gate tested `perceptions.length === 0`, but
//      sensors/timer.js pushes a kind:'timer' heartbeat EVERY tick, so the
//      branch (and the consolidate inside it) was unreachable — the same gate
//      already proven to block mull() (BUGS.md Phase 4 live-tested-broken
//      note: 45/45 and 65/65 real ticks, never 0 perceptions);
//   2. the active branch's consolidate sat BELOW `if (!decision) return;`, and
//      decide() returns null whenever no goal arbitrates out — the normal
//      state of a purely conversational session, i.e. exactly the sessions
//      that produce distillable memories.
//
// Plus: every skip in memory.consolidate()'s distillation step now emits a
// `memory.consolidate-skip` diagnostic, because "did it ever distill" was
// previously undiagnosable — a silent skip and a dead gate look identical.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fsNode = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createBus } = require('../src/core/bus');
const { createCortex } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/index');

// ---- cortex half: the two gates ----------------------------------------------

function cortexHarness(perceptions) {
  const consolidateCalls = [];
  const working = {
    tick: 0, activeGoalId: null, spendThisTick: 0,
    drainPerceptions: () => perceptions.slice(),
    resetTickState() { this.spendThisTick = 0; },
    addSpend(n) { this.spendThisTick += (n || 0); },
  };
  const memory = {
    working,
    episodic: { write: async () => ({ ref: 'x' }) },
    consolidate: async () => { consolidateCalls.push(working.tick); return {}; },
  };
  const goals = {
    hasActive: () => false,
    arbitrate: () => null, // no goal ever arbitrates out — the conversational norm
    plan: async () => null,
    debitBudget() {},
    markPlanStepDone() {},
  };
  const effectors = {
    invoked: [],
    invoke: async (tool) => { effectors.invoked.push(tool); return { ok: true }; },
    breakers: { allow: () => true },
  };
  const cortex = createCortex({
    bus: createBus({ historySize: 50 }),
    memory, goals, brain: null,
    leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) },
    effectors,
    // CONSOLIDATE_EVERY:1 so the cadence fires on the first tick deterministically;
    // REFLECT_EVERY huge so reflect() stays out of the way.
    config: { ACTION_TIMEOUT_MS: 5000, MYTHOS_TICK_MS: 999999, CONSOLIDATE_EVERY: 1, REFLECT_EVERY: 999999 },
  });
  return { cortex, consolidateCalls, effectors };
}

describe('fix-plan 3.1 — the cortex gates no longer starve consolidation', () => {
  it('a QUIET tick (only the timer heartbeat) is idle again and consolidates on cadence', async () => {
    const h = cortexHarness([{ ts: Date.now(), generation: 1, kind: 'timer', salienceHint: 0.1 }]);
    h.cortex.start();
    await h.cortex.tickOnce();
    h.cortex.stop();
    assert.equal(h.consolidateCalls.length, 1,
      'timer-only perceptions must count as idle — the heartbeat is not an event; before the fix this branch never opened');
  });

  it('a truly empty drain also consolidates (the pre-existing contract, unchanged)', async () => {
    const h = cortexHarness([]);
    h.cortex.start();
    await h.cortex.tickOnce();
    h.cortex.stop();
    assert.equal(h.consolidateCalls.length, 1);
  });

  it('a real perception with NO decision (goalless conversational session) still consolidates', async () => {
    const h = cortexHarness([{ kind: 'conversation', summary: 'user asked about weather', channel: 'voice', salience: 0.6 }]);
    h.cortex.start();
    await h.cortex.tickOnce();
    h.cortex.stop();
    assert.equal(h.consolidateCalls.length, 1,
      'decide() returns null with no goal — the consolidate used to sit below that early-return and never ran');
    assert.deepEqual(h.effectors.invoked, [], 'no goal, no action — only the consolidation moved');
  });

  it('a tick WITH a decision consolidates exactly once, not twice', async () => {
    const perceptions = [{ kind: 'job', summary: 'build done', channel: 'build', salience: 0.7 }];
    const working = {
      tick: 0, activeGoalId: null, spendThisTick: 0,
      drainPerceptions: () => perceptions.slice(),
      resetTickState() { this.spendThisTick = 0; },
      addSpend(n) { this.spendThisTick += (n || 0); },
    };
    const consolidateCalls = [];
    const memory = {
      working,
      episodic: { write: async () => ({ ref: 'x' }) },
      consolidate: async () => { consolidateCalls.push(working.tick); return {}; },
    };
    const cortex = createCortex({
      bus: createBus({ historySize: 50 }),
      memory,
      goals: {
        hasActive: () => true,
        arbitrate: () => ({ id: 'g1' }),
        plan: async () => ({ tool: 'read_status', args: {}, rationale: 'r' }),
        debitBudget() {},
        markPlanStepDone() {},
      },
      brain: null,
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0 }) },
      effectors: {
        invoke: async () => ({ ok: true, result: {} }),
        breakers: { allow: () => true },
      },
      config: { ACTION_TIMEOUT_MS: 5000, MYTHOS_TICK_MS: 999999, CONSOLIDATE_EVERY: 1, REFLECT_EVERY: 999999 },
    });
    cortex.start();
    await cortex.tickOnce();
    cortex.stop();
    assert.equal(consolidateCalls.length, 1,
      'the hoisted site replaced the bottom one — a decision tick must not double-consolidate');
  });
});

// ---- memory half: skip-reason diagnostics --------------------------------------

let tmpDir;
let hadVaultRoot;

function setupTmpVault() {
  tmpDir = fsNode.mkdtempSync(path.join(os.tmpdir(), 'mythos-consolidate-diag-'));
  hadVaultRoot = process.env.MYTHOS_VAULT_ROOT;
  process.env.MYTHOS_VAULT_ROOT = tmpDir;
  fsNode.mkdirSync(path.join(tmpDir, 'Semantic'), { recursive: true });
  fsNode.mkdirSync(path.join(tmpDir, 'Episodic'), { recursive: true });
}

function teardownTmpVault() {
  if (hadVaultRoot === undefined) delete process.env.MYTHOS_VAULT_ROOT;
  else process.env.MYTHOS_VAULT_ROOT = hadVaultRoot;
  try { fsNode.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

async function memoryWithSkips(brain, writes) {
  const skips = [];
  const bus = createBus({ historySize: 50 });
  bus.subscribe('memory.consolidate-skip', (e) => skips.push(e.payload));
  const memory = createMemory({
    config: { MYTHOS_VAULT_ROOT: tmpDir, CONSOLIDATE_MERGE_MIN: 99, EPISODIC_RETENTION_DAYS: 30 },
    bus,
    logger: { info() {}, warn() {}, error() {} },
    brain: brain || null,
  });
  await memory.init();
  for (const w of (writes || [])) await memory.episodic.write(w);
  await memory.consolidate({});
  return { memory, skips };
}

describe('fix-plan 3.1 — every consolidation skip says why', () => {
  beforeEach(setupTmpVault);
  afterEach(teardownTmpVault);

  it('no brain at all → reason brain-missing', async () => {
    const { skips } = await memoryWithSkips(null);
    assert.ok(skips.some((s) => s.reason === 'brain-missing'),
      'a silent skip is indistinguishable from a dead gate — that is the defect this fixes');
  });

  it('empty episodic tail → reason episodic-tail-empty', async () => {
    const brain = { think: async () => ({ content: 'x', offline: false }) };
    const { skips } = await memoryWithSkips(brain, []);
    assert.ok(skips.some((s) => s.reason === 'episodic-tail-empty'));
  });

  it('entries exist but none high-salience → reason no-high-salience', async () => {
    const brain = { think: async () => ({ content: 'x', offline: false }) };
    const { skips } = await memoryWithSkips(brain, [
      { kind: 'conversation', summary: 'low-salience chatter', salience: 0.2 },
    ]);
    assert.ok(skips.some((s) => s.reason === 'no-high-salience'));
  });

  it('high-salience present but brain offline → reason brain-offline', async () => {
    const brain = { think: async () => ({ offline: true }) };
    const { skips } = await memoryWithSkips(brain, [
      { kind: 'conversation', summary: 'important thing', salience: 0.8 },
    ]);
    assert.ok(skips.some((s) => s.reason === 'brain-offline'));
  });

  it('brain.think throwing → reason think-threw (the old silent catch)', async () => {
    const brain = { think: async () => { throw new Error('provider exploded'); } };
    const { skips } = await memoryWithSkips(brain, [
      { kind: 'conversation', summary: 'important thing', salience: 0.8 },
    ]);
    assert.ok(skips.some((s) => s.reason === 'think-threw' && /provider exploded/.test(s.detail)));
  });

  it('the happy path writes the distilled topic and emits NO skip', async () => {
    const brain = { think: async () => ({ content: 'the user prefers concise answers', offline: false }) };
    const { memory, skips } = await memoryWithSkips(brain, [
      { kind: 'conversation', summary: 'important thing', salience: 0.8 },
    ]);
    // 2026-09-25 (BUG-463): the conversation note-taker (step 3b) is off by default and
    // says so on every pass, as every skip here must. That is the ONLY skip allowed: a
    // successful distillation still emits none of its own.
    assert.deepEqual(skips.map((s) => s.reason), ['auto-user-facts-off'], 'a successful distillation must not emit skip diagnostics');
    const wrote = fsNode.readdirSync(path.join(tmpDir, 'Semantic')).some((n) => /^consolidated-/.test(n));
    assert.ok(wrote, 'the distilled topic lands in Semantic/');
    void memory;
  });
});
