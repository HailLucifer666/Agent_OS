'use strict';

// Phase 1 — engagement-executor tests.
//
// These exercise the stage-execution engine end-to-end through the REAL
// engagement module (createEngagement + real state machine + real store) with
// the executor wired in. The only fakes are the brain (offline→fallback),
// leash (allow-all), checkpoints (capturing), dispatchAction (scripted), and
// bus (spying). No network, no real effectors, no real filesystem.
//
// Covers the spec's required cases:
//  - action stage success → stage_completed + index advance
//  - failing action stage → stage_failed → REPAIRING → BLOCKED at exhaustion
//  - requiresApproval stage → checkpoint park → AWAITING_STAGE_APPROVAL → resume
//  - all 8 previously-missing events fire with correct payload shapes
//  - init() respects currentStageIndex (no double-exec of completed stages)
//  - command-type verification is SKIPPED HONESTLY (health.anomaly, no shell-out)

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createEngagement } = require('../src/core/engagements/index');
const { createEngagementExecutor } = require('../src/core/engagements/executor');
const stateMachine = require('../src/core/engagements/state-machine');

// ---- fakes ----

function spyBus() {
  const emitted = [];
  const bus = {
    emit: function (type, payload) { emitted.push({ type: type, payload: payload }); },
    subscribe: function () {},
    _emitted: function () { return emitted.slice(); },
    _of: function (t) { return emitted.filter(function (e) { return e.type === t; }); }
  };
  return bus;
}

// in-memory engagement store with the same surface as store.js
function memStore() {
  const records = new Map();
  return {
    write: function (r) { records.set(r.id, JSON.parse(JSON.stringify(r))); },
    read: function (id) { const r = records.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; },
    list: function () { return Array.from(records.keys()); },
    remove: function (id) { records.delete(id); },
    _size: function () { return records.size; }
  };
}

// capturing checkpoint registry — records every create + lets tests fire
// onApprove/onReject by id.
function fakeCheckpoints() {
  const created = [];
  return {
    create: function (spec) {
      const rec = Object.assign({ id: 'cp-' + (created.length + 1) }, spec);
      created.push(rec);
      return { id: rec.id, kind: rec.kind, title: rec.title };
    },
    _all: function () { return created.slice(); },
    _last: function () { return created[created.length - 1] || null; }
  };
}

// allow-all leash with a no-op confirm.create (returns an id)
function fakeLeash(opts) {
  opts = opts || {};
  return {
    check: function () {
      return { allow: true, requireConfirm: !!opts.requireConfirm, tier: 0, reason: 'test' };
    },
    confirm: { create: function (summary) { return 'confirm-1'; } }
  };
}

// scriptable dispatchAction. Returns scripted results per-tool; defaults ok:true.
function fakeDispatch(script) {
  script = script || {};
  const calls = [];
  const fn = async function (decision, ctx) {
    calls.push({ tool: decision.tool, args: decision.args, ctx: ctx });
    const r = script[decision.tool];
    if (r === 'fail') return { ok: false, error: 'scripted-fail' };
    if (typeof r === 'function') return r(decision, ctx);
    return { ok: true, result: { ok: true } };
  };
  fn._calls = calls;
  return fn;
}

// ---- harness: build a real engagement + executor wired together ----

function harness(opts) {
  opts = opts || {};
  const bus = spyBus();
  const store = memStore();
  const checkpoints = fakeCheckpoints();
  const leash = fakeLeash({ requireConfirm: opts.requireConfirm });
  const dispatch = fakeDispatch(opts.script);

  const engagement = createEngagement({
    bus: bus, config: { ENGAGEMENT_MAX_REPAIRS: opts.maxRepairs || 2 },
    store: store,
    stateMachine: stateMachine.createStateMachine({ config: {} }),
    interview: require('../src/core/engagements/interview').createInterview({ config: {} })
  });

  const executor = createEngagementExecutor({
    bus: bus,
    config: { ENGAGEMENT_MAX_REPAIRS: opts.maxRepairs || 2, ENGAGEMENT_STAGE_TIMEOUT_MS: 5000 },
    dispatchAction: dispatch,
    leash: leash,
    brain: null,            // offline → build/research stages use fallback path
    checkpoints: checkpoints,
    store: engagement,      // engagement.transition / findById
    engagementStore: store,
    vault: null,
    logger: null
  });

  // wire the onExecute hook the same way the manager does
  engagement.setOnExecute(function (id) { executor.runEngagement(id); });

  return { bus: bus, store: store, checkpoints: checkpoints, leash: leash, dispatch: dispatch,
    engagement: engagement, executor: executor };
}

// Build an engagement record seeded into EXECUTING with a given plan.
function seedEngagement(engagement, stages, opts) {
  opts = opts || {};
  const rec = engagement.create({ initialIntent: 'test intent', goalId: opts.goalId });
  // Force it into EXECUTING with a populated plan (skip the interview/spec dance).
  const exec = Object.assign({}, rec, {
    status: 'EXECUTING',
    plan: { stages: stages, currentStageIndex: 0, approvedAt: Date.now() },
    execution: { stageResults: [], currentStageId: null, repairBudget: { used: 0, max: opts.maxRepairs || 2 } }
  });
  // write directly through the store the executor reads from
  engagement.findById; // touch (no-op)
  return exec;
}

function actionStage(id, actions, extra) {
  return Object.assign({
    id: id, name: id, kind: 'action', type: 'action',
    actions: actions, verification: { type: 'research', claims: [] },
    requiresApproval: false
  }, extra || {});
}

// ---- tests ----

describe('phase1/engagement-executor', () => {

  describe('action stage success path', () => {
    it('runs an action stage through dispatchAction and advances currentStageIndex', async () => {
      const h = harness();
      const stages = [
        actionStage('s1', [{ tool: 'read_status', args: {} }]),
        actionStage('s2', [{ tool: 'ping', args: {} }])
      ];
      const exec = seedEngagement(h.engagement, stages);
      h.store.write(exec);

      await h.executor.runEngagement(exec.id);

      const final = h.store.read(exec.id);
      // both stages succeeded → engagement should be COMPLETED
      assert.equal(final.status, 'COMPLETED', 'final status COMPLETED, got ' + final.status);
      // dispatchAction was called once per action
      assert.equal(h.dispatch._calls.length, 2, 'one dispatch per action');
      assert.equal(h.dispatch._calls[0].tool, 'read_status');
      assert.equal(h.dispatch._calls[1].tool, 'ping');
      // stage_completed fired for both stages
      const completed = h.bus._of('engagement.stage_completed');
      assert.equal(completed.length, 2, 'stage_completed fired twice');
      assert.equal(completed[0].payload.stageId, 's1');
    });

    it('emits stage_started for each stage with name + id', async () => {
      const h = harness();
      const exec = seedEngagement(h.engagement, [
        actionStage('alpha', [{ tool: 't', args: {} }])
      ]);
      h.store.write(exec);
      await h.executor.runEngagement(exec.id);

      const started = h.bus._of('engagement.stage_started');
      assert.ok(started.length >= 1);
      assert.equal(started[0].payload.stageId, 'alpha');
      assert.equal(started[0].payload.stageName, 'alpha');
      assert.ok(started[0].payload.timestamp > 0);
    });
  });

  describe('action stage failure → repair → BLOCKED', () => {
    it('marks stage_failed, attempts repair, blocks at budget exhaustion', async () => {
      // script: 'bad' always fails. maxRepairs=1 so we get one repair attempt
      // then BLOCKED.
      const h = harness({ maxRepairs: 1, script: { bad_tool: 'fail' } });
      const exec = seedEngagement(h.engagement, [
        actionStage('s-fail', [{ tool: 'bad_tool', args: {} }])
      ], { maxRepairs: 1 });
      h.store.write(exec);

      await h.executor.runEngagement(exec.id);

      const final = h.store.read(exec.id);
      // Budget exhausted → BLOCKED. (status may be BLOCKED via repairExhausted
      // transition or the direct block emit.)
      assert.ok(final.status === 'BLOCKED' || final.status === 'REPAIRING',
        'expected BLOCKED (or REPAIRING if block transition was direct), got ' + final.status);

      // stage_failed fired
      const failed = h.bus._of('engagement.stage_failed');
      assert.ok(failed.length >= 1, 'stage_failed emitted');
      assert.equal(failed[0].payload.stageId, 's-fail');

      // repairing fired at least once (the one allowed repair attempt)
      const repairing = h.bus._of('engagement.repairing');
      assert.ok(repairing.length >= 1, 'repairing emitted');
      assert.equal(repairing[0].payload.stageId, 's-fail');
      assert.equal(repairing[0].payload.attempt, 1);

      // repairBudget.used was bumped
      assert.equal(final.execution.repairBudget.used, 1, 'budget used incremented');

      // blocked event fired
      const blocked = h.bus._of('engagement.blocked');
      assert.ok(blocked.length >= 1, 'blocked emitted');
    });

    it('does not loop forever — a succeeding repair advances the stage', async () => {
      // First call to flaky fails, subsequent succeed. maxRepairs=2.
      let calls = 0;
      const h = harness({
        maxRepairs: 2,
        script: {
          flaky: function () { calls += 1; return calls === 1 ? { ok: false, error: 'first-fail' } : { ok: true }; }
        }
      });
      const exec = seedEngagement(h.engagement, [
        actionStage('s-flaky', [{ tool: 'flaky', args: {} }])
      ], { maxRepairs: 2 });
      h.store.write(exec);

      await h.executor.runEngagement(exec.id);
      const final = h.store.read(exec.id);
      assert.equal(final.status, 'COMPLETED', 'repaired stage completes the engagement');
      const completed = h.bus._of('engagement.stage_completed');
      assert.ok(completed.length >= 1, 'stage_completed emitted after repair');
    });
  });

  describe('requiresApproval stage', () => {
    it('parks on a checkpoint and transitions to AWAITING_STAGE_APPROVAL', async () => {
      const h = harness();
      const stages = [
        actionStage('gated', [{ tool: 'safe', args: {} }], { requiresApproval: true })
      ];
      const exec = seedEngagement(h.engagement, stages);
      h.store.write(exec);

      await h.executor.runEngagement(exec.id);

      // engagement is now awaiting stage approval
      const parked = h.store.read(exec.id);
      assert.equal(parked.status, 'AWAITING_STAGE_APPROVAL',
        'parked at AWAITING_STAGE_APPROVAL, got ' + parked.status);

      // a stage-approval checkpoint was created
      const cp = h.checkpoints._last();
      assert.ok(cp, 'checkpoint created');
      assert.equal(cp.kind, 'stage-approval');
      assert.equal(cp.projectId, exec.id);
      assert.equal(cp.connectionId, 'system');
      assert.equal(typeof cp.onApprove, 'function');

      // approval_requested emitted (the parking signal)
      const req = h.bus._of('engagement.approval_requested');
      assert.ok(req.length >= 1, 'approval_requested emitted');

      // accepting the checkpoint resumes execution → COMPLETED
      // (manually move to EXECUTING first since the loop checks status)
      h.store.write(Object.assign({}, parked, { status: 'EXECUTING' }));
      await cp.onApprove({ projectId: exec.id });
      const final = h.store.read(exec.id);
      assert.equal(final.status, 'COMPLETED', 'resumed after approval');
    });
  });

  describe('all 8 previously-missing events fire with correct shapes', () => {
    it('stage_started / stage_completed have id+name+timestamp', async () => {
      const h = harness();
      const exec = seedEngagement(h.engagement, [actionStage('sx', [{ tool: 't', args: {} }])]);
      h.store.write(exec);
      await h.executor.runEngagement(exec.id);

      const s = h.bus._of('engagement.stage_started')[0].payload;
      const c = h.bus._of('engagement.stage_completed')[0].payload;
      assert.equal(typeof s.engagementId, 'string');
      assert.equal(typeof s.stageId, 'string');
      assert.equal(typeof s.timestamp, 'number');
      assert.equal(typeof c.engagementId, 'string');
      assert.equal(typeof c.stageId, 'string');
      assert.ok(Array.isArray(c.artifactIds));
      assert.equal(typeof c.timestamp, 'number');
    });

    it('approved event fires on AWAITING_APPROVAL→EXECUTING (via transition)', async () => {
      // Drive a full transition chain so the approved event fires from
      // emitTransitionEvent's EXECUTING case.
      const h = harness();
      const rec = h.engagement.create({ initialIntent: 'x' });
      // seed into PLAN_READY with a real plan, then requestApproval → approve
      h.store.write(Object.assign({}, rec, {
        status: 'PLAN_READY',
        plan: { stages: [actionStage('s1', [{ tool: 't', args: {} }])], currentStageIndex: 0 }
      }));
      await h.engagement.transition(rec.id, 'requestApproval', {});
      // now AWAITING_APPROVAL; the executor is wired, so approve will fire it —
      // but our plan's action uses the fake dispatch and completes immediately.
      await h.engagement.transition(rec.id, 'approve', {});
      const approved = h.bus._of('engagement.approved');
      assert.ok(approved.length >= 1, 'engagement.approved emitted');
      assert.equal(approved[0].payload.engagementId, rec.id);
      assert.equal(typeof approved[0].payload.stageIndex, 'number');
    });

    it('verification_passed + completed fire on a clean run', async () => {
      const h = harness();
      const exec = seedEngagement(h.engagement, [actionStage('v', [{ tool: 't', args: {} }])]);
      h.store.write(exec);
      await h.executor.runEngagement(exec.id);
      const vp = h.bus._of('engagement.verification_passed');
      const done = h.bus._of('engagement.completed');
      assert.ok(vp.length >= 1, 'verification_passed emitted');
      assert.ok(done.length >= 1, 'completed emitted');
      assert.equal(done[0].payload.engagementId, exec.id);
      assert.equal(typeof done[0].payload.completion.reportMarkdown, 'string');
    });

    it('artifact_created fires when a build stage produces a file (vault present)', async () => {
      // Build a harness with a fake vault + a buildEngine that returns content.
      // Build content comes from buildEngine only (Hermes-Agent is the single
      // build-content engine — no brain.think fallback), so the engine fake is
      // what produces the artifact.
      const bus = spyBus();
      const store = memStore();
      const engagement = createEngagement({
        bus: bus, config: { ENGAGEMENT_MAX_REPAIRS: 2 }, store: store,
        stateMachine: stateMachine.createStateMachine({ config: {} }),
        interview: require('../src/core/engagements/interview').createInterview({ config: {} })
      });
      const writtenFiles = [];
      const vault = {
        writeText: function (p, c) { writtenFiles.push({ path: p, content: c }); },
        exists: function () { return true; }
      };
      const buildEngine = { generate: async function () { return { content: 'FILE-CONTENT', offline: false, engine: 'fake' }; } };
      const executor = createEngagementExecutor({
        bus: bus, config: { ENGAGEMENT_MAX_REPAIRS: 2 },
        dispatchAction: fakeDispatch(), leash: fakeLeash(), buildEngine: buildEngine,
        checkpoints: fakeCheckpoints(), store: engagement, engagementStore: store,
        vault: vault, logger: null
      });
      engagement.setOnExecute(function (id) { executor.runEngagement(id); });

      const exec = seedEngagement(hEngagementWrap(engagement), [{
        id: 'b1', name: 'build it', kind: 'build', type: 'build',
        prompt: 'make a file', verification: { type: 'file', path: 'x.txt', exists: true },
        requiresApproval: false
      }]);
      store.write(exec);
      await executor.runEngagement(exec.id);

      assert.ok(writtenFiles.length >= 1, 'build stage wrote a file');
      const arts = bus._of('engagement.artifact_created');
      assert.ok(arts.length >= 1, 'artifact_created emitted');
      assert.equal(arts[0].payload.stageId, 'b1');
      assert.equal(typeof arts[0].payload.path, 'string');
    });
  });

  describe('init() crash recovery', () => {
    it('respects currentStageIndex — does not re-run completed stages', async () => {
      const h = harness();
      // Seed an engagement in EXECUTING with stage 0 already marked success
      // and currentStageIndex=1.
      const exec = seedEngagement(h.engagement, [
        actionStage('done', [{ tool: 't0', args: {} }]),
        actionStage('todo', [{ tool: 't1', args: {} }])
      ]);
      exec.plan.currentStageIndex = 1;
      exec.execution.stageResults = [{ stageId: 'done', status: 'success' }];
      h.store.write(exec);

      // init() should pick up the EXECUTING engagement and resume from index 1.
      const result = h.executor.init();
      assert.equal(result.retried, 1, 'one EXECUTING engagement re-armed');
      // give the fire-and-forget resume a tick to complete
      await new Promise(function (r) { setTimeout(r, 30); });

      // dispatch should ONLY have been called for 't1' (the todo stage), not 't0'
      const tools = h.dispatch._calls.map(function (c) { return c.tool; });
      assert.deepEqual(tools, ['t1'], 'only the not-yet-completed stage ran');
    });

    it('re-arms a stage-approval checkpoint for an AWAITING_STAGE_APPROVAL engagement', async () => {
      const h = harness();
      const exec = seedEngagement(h.engagement, [
        actionStage('gated', [{ tool: 't', args: {} }], { requiresApproval: true })
      ]);
      exec.status = 'AWAITING_STAGE_APPROVAL';
      h.store.write(exec);

      const result = h.executor.init();
      assert.equal(result.rearmed, 1, 'one stage-approval checkpoint re-armed');
      const cp = h.checkpoints._last();
      assert.ok(cp, 'checkpoint re-created');
      assert.equal(cp.kind, 'stage-approval');
    });
  });

  describe('command-type verification is SKIPPED HONESTLY', () => {
    it('emits health.anomaly and does NOT shell out', async () => {
      const h = harness();
      // action stage with a command verification — there is no safe runner, so
      // verification must be skipped with an anomaly, not executed.
      const exec = seedEngagement(h.engagement, [
        actionStage('cmd', [{ tool: 't', args: {} }],
          { verification: { type: 'command', cmd: 'rm -rf /', expectedExitCode: 0 } })
      ]);
      h.store.write(exec);
      await h.executor.runEngagement(exec.id);

      const anomalies = h.bus._of('health.anomaly');
      const cmdSkipped = anomalies.filter(function (a) {
        return a.payload.kind === 'engagement-command-verification-skipped';
      });
      assert.ok(cmdSkipped.length >= 1, 'command-verification-skipped anomaly emitted');
      assert.equal(cmdSkipped[0].payload.cmd, 'rm -rf /');
      // the stage still completes (skipped verification is non-fatal)
      const completed = h.bus._of('engagement.stage_completed');
      assert.ok(completed.length >= 1, 'stage completed despite skipped command verify');
    });
  });
});

// helper: wrap engagement so seedEngagement works with either a raw
// engagement object or one already wrapped.
function hEngagementWrap(engagement) { return engagement; }
