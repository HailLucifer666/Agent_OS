'use strict';

// test/bug-446-autonomy-runs-only-active-goals-with-budget.test.js
//
// BUG-446 (HIGH): at the 2026-09-23 boot, 12-day-old "Commitment:" goals minted
// from MYTHOS's own sentences executed 9 real tool calls, two of them far over
// budget, with nobody speaking. The measured mechanism (premise correction in
// BUGS.md) and the repair are written up in src/core/goals/execution-gate.js.
//
// Four repairs, one describe each:
//   1. the Goals.md checkbox rule (effectors/goals.js sync) — the writer that
//      turned PROPOSED commitments active at boot;
//   2. the execution gate at the shared dispatch — status and budget checked
//      when autonomous work RUNS, with one action reserved before it starts;
//   3. plan()'s pending-step branch honours exhaustion;
//   4. D10 — commitments are never resurfaced unprompted; an explicit ask lists
//      them; a dismissal persists without marking the work done.
// Plus the writer map: every writer of status 'active' is named, so a new one
// fails here and gets read.
//
// RED FIRST, 2026-09-23, against a9fbc9d7 (execution-gate.js present, unwired):
//   (1a) 'a proposed commitment became active at the next boot'
//   (2a) (2c) (2d) (2e) invoke ran for a proposed / over-budget / second-in-flight
//        / since-paused goal
//   (2s) 'a cortex-raised confirm accepted later ran against a paused goal'
//   (2o) the cortex's confirm record carried no origin
//   (3a) 'plan() returned a pending step for an exhausted goal'
//   (4a) read_status still carried openCommitments; (4b)-(4d) the tools did not exist
// Each failed for the reason named.
//
// MUTATIONS, 2026-09-23: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsNode = require('node:fs');
const WebSocket = require('ws');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createGoalSystem } = require('../src/core/goals');
const { createGoalsMdBridge } = require('../src/core/effectors/goals');
const { dispatchAction } = require('../src/core/effectors/dispatch-action');

async function realGoals() {
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const goalSystem = createGoalSystem({ fs, config: {}, bus });
  await goalSystem.init();
  return { dir, fs, bus, goalSystem, bridge: createGoalsMdBridge({ fs, goalSystem, bus }) };
}

// A commitment exactly as logCommitmentIfPresent writes one.
function commitment(goalSystem, phrase) {
  return goalSystem.create({ title: 'Commitment: ' + phrase, drive: 'user-service', status: 'proposed', reason: phrase });
}

// ------------------------------------------------------------------ 1 --

describe('BUG-446 (1) — a Goals.md checkbox never activates a goal nobody accepted', () => {
  test('(1a) REPRO: a proposed commitment written back to Goals.md stays proposed at the next boot', async () => {
    const h = await realGoals();
    try {
      const g = commitment(h.goalSystem, "let me get us back on YouTube right now");
      h.bridge.writeBack();
      assert.match(h.fs.readText('Goals.md', ''), /- \[ \] Commitment: let me get us back/, 'fixture check: the unchecked row the incident had');
      h.bridge.sync();
      assert.equal(h.goalSystem.get(g.id).status, 'proposed', 'a proposed commitment became active at the next boot');
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(1b) a paused goal with an unchecked row stays paused', async () => {
    const h = await realGoals();
    try {
      const g = h.goalSystem.create({ title: 'Paused thing', drive: 'user-service', status: 'paused' });
      h.bridge.writeBack();
      h.bridge.sync();
      assert.equal(h.goalSystem.get(g.id).status, 'paused');
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(1c) the operator TICKING a proposed row marks it done, and it stays ticked', async () => {
    const h = await realGoals();
    try {
      const g = commitment(h.goalSystem, "I'll check the weather");
      h.bridge.writeBack();
      h.fs.writeText('Goals.md', h.fs.readText('Goals.md', '').replace('- [ ] Commitment', '- [x] Commitment'));
      h.bridge.sync();
      assert.equal(h.goalSystem.get(g.id).status, 'done');
      h.bridge.writeBack();
      assert.match(h.fs.readText('Goals.md', ''), /- \[x\] Commitment: I'll check the weather/);
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(1d) UNTICKING a done row reopens it as active — the one untick that means "do it"', async () => {
    const h = await realGoals();
    try {
      const g = h.goalSystem.create({ title: 'Finish the report', drive: 'user-service', status: 'done' });
      h.bridge.writeBack();
      h.fs.writeText('Goals.md', h.fs.readText('Goals.md', '').replace('- [x] Finish', '- [ ] Finish'));
      h.bridge.sync();
      assert.equal(h.goalSystem.get(g.id).status, 'active');
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(1e) ADJACENT: a row the operator TYPED into Goals.md still starts active', async () => {
    const h = await realGoals();
    try {
      h.fs.writeText('Goals.md', '- [ ] Water the plants · Home · 2026-09-23T10:00:00.000Z\n');
      h.bridge.sync();
      const g = h.goalSystem.list({ drive: 'user-service' }).find((x) => x.title === 'Water the plants');
      assert.equal(g.status, 'active');
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(1f) repeated syncs are idempotent', async () => {
    const h = await realGoals();
    try {
      const g = commitment(h.goalSystem, "I'll look into it");
      h.bridge.writeBack();
      for (let i = 0; i < 3; i++) { h.bridge.sync(); h.bridge.writeBack(); }
      assert.equal(h.goalSystem.get(g.id).status, 'proposed');
      assert.equal(h.goalSystem.list({ drive: 'user-service' }).length, 1, 'no duplicate goal per sync');
    } finally { cleanupVaultDir(h.dir); }
  });
});

// ------------------------------------------------------------------ 2 --

function goalsWith(goal) {
  const debits = [];
  return {
    debits,
    get: (id) => (id === goal.id ? goal : undefined),
    debitBudget: (id, usage) => {
      debits.push({ id, usage });
      goal.spent.tokens += usage.tokens || 0;
      goal.spent.actions += usage.actions || 0;
    },
    markPlanStepDone: () => {},
  };
}
function aGoal(over) {
  return Object.assign({ id: 'g-1', status: 'active', budget: { tokens: 20000, actions: 25 }, spent: { tokens: 0, actions: 0 } }, over);
}
function harness(goal, { invokeDelayMs = 0 } = {}) {
  const invoked = [];
  const events = [];
  const audits = [];
  const goals = goalsWith(goal);
  const ctx = (extra) => Object.assign({
    effectors: {
      invoke: async (tool, args) => {
        invoked.push(tool);
        if (invokeDelayMs) await new Promise((r) => setTimeout(r, invokeDelayMs));
        return { ok: true, result: 'done' };
      },
    },
    bus: { emit: (type, payload) => events.push({ type, payload }) },
    goals,
    memory: { audit: { write: (e) => audits.push(e) } },
    config: {},
    goalId: goal.id,
    tier: 2,
    channel: 'cortex',
  }, extra || {});
  return { invoked, events, audits, goals, ctx };
}

describe('BUG-446 (2) — autonomous work runs only for an active goal with budget left', () => {
  test('(2a) a PROPOSED goal: refused before invoke, and the refusal is recorded', async () => {
    const h = harness(aGoal({ status: 'proposed' }));
    const r = await dispatchAction({ tool: 'launch_app', args: { name: 'brave' } }, h.ctx());
    assert.deepEqual(h.invoked, [], 'invoke ran for a goal nobody accepted');
    assert.equal(r.ok, false);
    assert.equal(r.notExecuted, true);
    const blocked = h.events.find((e) => e.type === 'action.blocked');
    assert.equal(blocked && blocked.payload.reason, 'goal-not-active');
    assert.ok(h.audits.some((a) => a.decision === 'blocked' && /goal-not-active/.test(a.reason)), 'an audit row names the refusal');
  });

  test('(2b) a PAUSED goal is refused', async () => {
    const h = harness(aGoal({ status: 'paused' }));
    await dispatchAction({ tool: 'web_search', args: { q: 'x' } }, h.ctx());
    assert.deepEqual(h.invoked, []);
  });

  test('(2c) an ACTIVE goal already over budget (the crash-recovered case) is refused', async () => {
    const h = harness(aGoal({ spent: { tokens: 36566, actions: 3 } }));
    await dispatchAction({ tool: 'open_web', args: { type: 'youtube' } }, h.ctx());
    assert.deepEqual(h.invoked, [], 'invoke ran for a goal 36,566 tokens into a 20,000 budget');
  });

  test('(2d) two dispatches racing for the LAST action: exactly one runs', async () => {
    const h = harness(aGoal({ spent: { tokens: 0, actions: 24 } }), { invokeDelayMs: 30 });
    const [a, b] = await Promise.all([
      dispatchAction({ tool: 'web_search', args: { q: 'a' } }, h.ctx()),
      dispatchAction({ tool: 'web_search', args: { q: 'b' } }, h.ctx()),
    ]);
    assert.equal(h.invoked.length, 1, 'both ran: the second was admitted while the first was in flight');
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    assert.equal(require('../src/core/goals/execution-gate').inFlight(h.goals, 'g-1'), 0, 'the reservation is released after settling');
  });

  test('(2e) a confirm the cortex raised, accepted after the goal was paused, is refused at execution', async () => {
    const h = harness(aGoal({ status: 'paused' }));
    await dispatchAction({ tool: 'gmail_send', args: {} }, h.ctx({ channel: 'confirm-accept', origin: 'autonomous' }));
    assert.deepEqual(h.invoked, []);
  });

  test('(2f) ADJACENT: a reminder whose anchor goal is PROPOSED still fires — that is its design', async () => {
    const h = harness(aGoal({ status: 'proposed' }));
    await dispatchAction({ tool: 'whatsapp_send', args: {} }, h.ctx({ channel: 'reminder-fire' }));
    assert.deepEqual(h.invoked, ['whatsapp_send']);
  });

  test('(2g) ADJACENT: voice and the operator-accepted confirm of a VOICE action are untouched', async () => {
    const h = harness(aGoal({ status: 'proposed' }));
    await dispatchAction({ tool: 'open_web', args: {} }, h.ctx({ channel: 'voice', goalId: null }));
    await dispatchAction({ tool: 'gmail_send', args: {} }, h.ctx({ channel: 'confirm-accept' }));
    assert.deepEqual(h.invoked, ['open_web', 'gmail_send']);
  });

  test('(2h) mull\'s goal-less propose_goal still runs; any OTHER goal-less autonomous tool is refused', async () => {
    const h = harness(aGoal());
    await dispatchAction({ tool: 'propose_goal', args: { text: 'x' } }, h.ctx({ goalId: null }));
    await dispatchAction({ tool: 'launch_app', args: { name: 'brave' } }, h.ctx({ goalId: null }));
    assert.deepEqual(h.invoked, ['propose_goal']);
  });

  test('(2i) a refusal reserves nothing; a throw releases its reservation and is charged', async () => {
    const goal = aGoal({ spent: { tokens: 0, actions: 23 } });
    const h = harness(goal);
    await dispatchAction({ tool: 'x', args: {} }, h.ctx({ goalId: 'nope' }));
    const gate = require('../src/core/goals/execution-gate');
    assert.equal(gate.inFlight(h.goals, 'g-1'), 0);
    const thrower = h.ctx({ effectors: { invoke: async () => { throw new Error('boom'); } } });
    await assert.rejects(dispatchAction({ tool: 'x', args: {} }, thrower), /boom/);
    assert.equal(gate.inFlight(h.goals, 'g-1'), 0, 'a throw must not leak a reservation');
    assert.equal(goal.spent.actions, 24, 'work that started is charged once');
    await dispatchAction({ tool: 'y', args: {} }, h.ctx());
    assert.deepEqual(h.invoked, ['y'], 'the last action is still available');
  });

  test('(2j) a budget the gate cannot read is refused, not treated as unlimited', async () => {
    const h = harness(aGoal({ budget: {} }));
    await dispatchAction({ tool: 'x', args: {} }, h.ctx());
    assert.deepEqual(h.invoked, []);
  });

  test('(2o) the confirm record the cortex creates carries origin: autonomous', async () => {
    const { createCortex } = require('../src/core/cortex');
    const created = [];
    const leash = {
      check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
      confirm: { create: (summary, payload) => { created.push(payload); return 'cf-o'; }, peek: () => null },
    };
    const memory = {
      working: { tick: 0, activeGoalId: null, spendThisTick: 0, drainPerceptions: () => [{ summary: 'x', channel: 't', salience: 0.9 }],
        resetTickState() {}, pushPerception() {}, addSpend() {} },
      episodic: { write: async () => ({}) }, audit: { write() {} }, consolidate: async () => {},
    };
    const goals = { getActive: () => null, hasActive: () => true, arbitrate: () => ({ id: 'g-1' }),
      plan: async () => ({ tool: 'gmail_send', args: {} }), debitBudget() {} };
    const cortex = createCortex({ bus: fakeBus(), memory, goals, brain: null, leash,
      effectors: { effectors: new Map([['gmail_send', {}]]), count: () => 1, invoke: async () => ({ ok: true }) }, config: { MYTHOS_TICK_MS: 1000 } });
    cortex.start(); await cortex.tickOnce(); cortex.stop();
    assert.equal(created.length, 1, 'fixture check: the confirm branch ran');
    assert.equal(created[0].origin, 'autonomous');
  });
});

// The server half of (2e): the confirm-accept path must hand the record's origin
// to dispatch. Driven through the real createServer and a real WebSocket.
describe('BUG-446 (2) — server: a cortex confirm accepted late is re-checked', () => {
  test('(2s) accepted after the goal was paused -> nothing runs', async () => {
    const { createBus } = require('../src/core/bus');
    const { createServer } = require('../server');
    const bus = createBus({ historySize: 50 });
    const invoked = [];
    const leash = {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'cf-446', peek: () => ({ summary: 'x' }), peekTier: () => 3,
        accept: () => ({ decision: { tool: 'noop_tool', args: {} }, goalId: 'g-1', tier: 3, origin: 'autonomous' }), reject: () => true },
    };
    const deps = {
      bus, logger: { info() {}, warn() {}, error() {} },
      config: { MYTHOS_PORT: 0, MYTHOS_BIND: '127.0.0.1', MYTHOS_NAME: 'T', MYTHOS_IDLE_SALIENCE: 0.3, ACTION_TIMEOUT_MS: 30000, MYTHOS_AUTH_TOKEN: '' },
      memory: { working: { tick: 0, activeGoalId: null }, episodic: { write: async () => ({}), recall: () => [] }, recallHybrid: async () => [],
        fs: { vaultPath: (...s) => path.join('/test-vault', ...s) }, audit: { write: () => ({ ok: true }) } },
      goalsEffector: { listGoals: () => [], stats: () => ({ total: 0, done: 0, active: 0 }) },
      kanbanEffector: { listBoard: () => ({ cards: [] }) }, pipelineEffector: { listAll: () => ({}) },
      effectors: { breakers: { allow: () => true }, invoke: async (t) => { invoked.push(t); return { ok: true }; }, effectors: new Map(), catalog: () => [], get: () => undefined },
      leash,
      goals: goalsWith(aGoal({ status: 'paused' })),
      probes: { getStatus: async () => ({ ok: true }) },
      agentActions: { assembleKanbanPlan: () => ({}), buildKanbanCard: () => ({}), reviewKanbanCard: () => ({}) },
      buildRunner: { getJob: () => null, onJobUpdate: () => () => {} },
      ttsChain: { chainNames: ['fake'], isAvailable: async () => false, synthesize: async () => ({ audio: Buffer.from(''), mime: 'audio/mpeg' }) },
    };
    const server = createServer(deps);
    await server.ready;
    let blocked = null;
    bus.subscribe('action.blocked', (e) => { blocked = e; });
    try {
      const { port } = server.httpServer.address();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'confirm-reply', confirmId: 'cf-446', accept: true, surface: 'click' }));
      const start = Date.now();
      while (!blocked && invoked.length === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 10));
      ws.close();
    } finally { await server.stop(); }
    assert.deepEqual(invoked, [], 'a cortex-raised confirm accepted later ran against a paused goal');
    assert.ok(blocked, 'the refusal must be visible on the bus');
  });
});

// ------------------------------------------------------------------ 3 --

describe('BUG-446 (3) — plan() honours exhaustion on EVERY branch', () => {
  test('(3a) a pending plan step is not returned for an exhausted goal; the goal is paused', async () => {
    const h = await realGoals();
    try {
      const g = h.goalSystem.create({ title: 'x', drive: 'user-service', status: 'active', budget: { tokens: 100, actions: 5 } });
      h.goalSystem.get(g.id).plan = [{ tool: 'web_search', args: {}, status: 'pending' }];
      h.goalSystem.get(g.id).spent = { tokens: 150, actions: 1 };
      const decision = await h.goalSystem.plan(h.goalSystem.get(g.id), {});
      assert.equal(decision, null, 'plan() returned a pending step for an exhausted goal');
      assert.equal(h.goalSystem.get(g.id).status, 'paused');
      assert.equal(h.goalSystem.get(g.id).reason, 'budget-exhausted');
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(3b) ADJACENT: a pending step with budget left is still returned', async () => {
    const h = await realGoals();
    try {
      const g = h.goalSystem.create({ title: 'x', drive: 'user-service', status: 'active' });
      h.goalSystem.get(g.id).plan = [{ tool: 'web_search', args: { q: 1 }, status: 'pending' }];
      const decision = await h.goalSystem.plan(h.goalSystem.get(g.id), {});
      assert.equal(decision.tool, 'web_search');
    } finally { cleanupVaultDir(h.dir); }
  });
});

// ------------------------------------------------------------------ 4 --

describe('BUG-446 (4) / D10 — commitments are listed when asked, never pushed', () => {
  async function calendarTools(goalSystem, fs) {
    const { buildCalendarTools } = require('../src/core/effectors/from-calendar');
    return buildCalendarTools({ fs, bus: fakeBus(), goals: goalSystem });
  }

  test('(4a) read_status no longer carries open commitments into an unrelated turn', () => {
    const src = fsNode.readFileSync(path.join(__dirname, '../src/core/effectors/from-dashboard.js'), 'utf8');
    const body = src.slice(src.indexOf('async function read_status()'), src.indexOf('async function read_system_specs()'));
    assert.ok(body.length > 0, 'fixture check: read_status was found');
    assert.doesNotMatch(body, /openCommitments|listOpenCommitments/, 'read_status still carries openCommitments');
  });

  test('(4b) commitment_list lists undismissed commitments, and nothing else', async () => {
    const h = await realGoals();
    try {
      commitment(h.goalSystem, "I'll check the news");
      h.goalSystem.create({ title: 'Reminder action: x', drive: 'user-service', status: 'proposed' });
      const tools = await calendarTools(h.goalSystem, h.fs);
      const list = tools.find((t) => t.name === 'commitment_list');
      assert.ok(list, 'there is no way to ask what MYTHOS promised');
      const r = await list.fn({});
      assert.equal(r.ok, true);
      assert.deepEqual(r.result.commitments.map((c) => c.text), ["I'll check the news"]);
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(4c) commitment_dismiss persists across a restart and does NOT mark the work done', async () => {
    const h = await realGoals();
    try {
      const g = commitment(h.goalSystem, "I'll read your clipboard");
      const tools = await calendarTools(h.goalSystem, h.fs);
      const dismiss = tools.find((t) => t.name === 'commitment_dismiss');
      assert.ok(dismiss, 'there is no way to dismiss a commitment');
      const r = await dismiss.fn({ id: g.id });
      assert.equal(r.ok, true);
      const reborn = createGoalSystem({ fs: h.fs, config: {}, bus: fakeBus() });
      await reborn.init();
      assert.equal(reborn.get(g.id).status, 'proposed', 'a dismissal is not "done" — nothing was done');
      assert.ok(reborn.get(g.id).dismissedAt, 'the dismissal survived the restart');
      const list = (await calendarTools(reborn, h.fs)).find((t) => t.name === 'commitment_list');
      assert.deepEqual((await list.fn({})).result.commitments, []);
    } finally { cleanupVaultDir(h.dir); }
  });

  test('(4d) dismissing something that is not a commitment is refused and changes nothing', async () => {
    const h = await realGoals();
    try {
      const g = h.goalSystem.create({ title: 'Water the plants', drive: 'user-service', status: 'active' });
      const dismiss = (await calendarTools(h.goalSystem, h.fs)).find((t) => t.name === 'commitment_dismiss');
      const r = await dismiss.fn({ id: g.id });
      assert.equal(r.ok, false);
      assert.equal(h.goalSystem.get(g.id).dismissedAt, undefined);
    } finally { cleanupVaultDir(h.dir); }
  });
});

// ------------------------------------------------------------ writer map --

// Every WRITE of a goal status in the shipped tree that can produce 'active':
// a `.create(`/`.update(` whose `status:` value is the literal 'active', an
// expression containing it, or an expression the scan cannot resolve to a fixed
// non-active literal (a variable — class 4d: what a model of the code cannot read
// it must COUNT, never skip). The execution gate makes each one safe, because it
// checks at execution whatever set the status; this map makes a NEW writer visible
// so it is read before it ships. Reads (`list({ status: 'active' })`) are not writes.
const ACTIVE_WRITERS = {
  'src/core/desktop/controller.js': 2,  // desktop task create + execution running->active: the operator asked for it
  'src/core/effectors/goals.js': 6,     // sync: typed row + reopen of a done row; addGoal; resumeGoal; toggle; acceptProposal — operator acts
  'src/core/immune/monitor.js': 1,      // crash-recovery resume — refused at execution when over budget (2c)
};

function statusWrites(src) {
  const out = [];
  const re = /\.(?:create|update)\(\s*[^;]*?\bstatus\s*:\s*([^,}\n]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const value = m[1].trim();
    const fixedOther = /^'(?:paused|done|proposed|failed)'$/.test(value);
    if (!fixedOther) out.push(value);
  }
  return out;
}

test('BUG-446 writer map — every write that can set status "active" is named', () => {
  const root = path.join(__dirname, '..');
  const found = {};
  (function walk(dir) {
    for (const e of fsNode.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fsNode.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '');
      const n = statusWrites(src).length;
      if (n) found[path.relative(root, p).split(path.sep).join('/')] = n;
    }
  })(path.join(root, 'src'));
  assert.deepEqual(found, ACTIVE_WRITERS, 'a writer of status "active" was added or removed — read it, then update this map');
});

test('ADJACENT: the writer scan counts writes, not reads, and counts a variable it cannot resolve', () => {
  assert.equal(statusWrites("goals.list({ status: 'active' })").length, 0);
  assert.equal(statusWrites("goals.update(id, { status: 'paused', reason: 'x' })").length, 0);
  assert.equal(statusWrites("goals.update(id, { status: 'active' })").length, 1);
  assert.equal(statusWrites("goals.update(id, { status: wantStatus })").length, 1, 'a variable is a writer the scan cannot rule out');
  assert.equal(statusWrites("g.create({\n  drive: 'x',\n  status: row.done ? 'done' : 'active',\n})").length, 1);
});

// MUTATION TABLE, 2026-09-23. Fourteen probes, each applied (sha256 changed), run
// against this file, restored (sha256 equal):
//   M1  sync() activates every unchecked row again (the old rule)   -> (1a) (1f)
//   M2  the gate is not consulted at dispatch                        -> (2a)-(2e) (2h)-(2j) (2s)
//   M3  the gate ignores goal status                                 -> (2a) (2b) (2e)
//   M4  in-flight actions are not counted (no reservation)           -> (2d)
//   M5  the reservation is never settled after the debit             -> (2d)
//   M6  every dispatch treated as autonomous (gate-in-the-leash)     -> (2f) reminder, (2g) voice
//   M7  the cortex confirm record drops its origin                   -> (2o)
//   M8  the server does not forward origin to dispatch               -> (2s)
//   M9  plan()'s budget check removed from the top                   -> (3a)
//   M10 read_status carries open commitments again                   -> (4a)
//   M11 a dismissal marks the commitment done                        -> (4c)
//   M12 the list ignores dismissals                                  -> (4c)
//   M13 an unreadable budget treated as unlimited                    -> (2j)
//   M14 a new writer of status 'active' appears                      -> writer map
// Fixture mutations: the goal SEEDED paused vs proposed ((1a) vs (1b)), and the
// FIRST sync vs the THIRD ((1a) vs (1f)) — both distinguish the old rule.
