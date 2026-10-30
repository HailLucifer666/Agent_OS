'use strict';

// Phase 5 — the verification sweep's repair path must leave the record in
// VERIFYING before it re-sweeps, and must persist BLOCKED when the repair
// re-run fails.
//
// THE DEFECT (measured on origin/main@abd86c5d):
//   runVerificationSweep fails a stage, runRepair moves REPAIRING→EXECUTING,
//   the stage is re-run, and on retry.ok the sweep recurses without an
//   EXECUTING→VERIFYING transition. state-machine.js allows only stageComplete,
//   stageFailed and fatalError from EXECUTING, so allVerified is rejected;
//   completeEngagement's catch swallows it and the on-disk status stays
//   EXECUTING. blockEngagement likewise transitions only from REPAIRING, so a
//   failed re-run persists nothing from EXECUTING.
//
// NEGATIVE CONTROL: phase1-engagement-executor.test.js:234-250 ("a succeeding
// repair advances the stage") covers the *action*-failure loop, which burns the
// repair budget inside runStages and blocks from REPAIRING. That path is why
// this gap survived; it stays green and is not modified here.
//
// Mutation probes, run 2026-10-30 against the final shape (the terminal paths
// live in verify-repair.js; executor.js only calls them):
//  (a) delete the `stageComplete` transition between upsertStageResult and the
//      recursion → tests 1 and 4 fail on status (EXECUTING, not COMPLETED).
//  (b) delete the EXECUTING branch in blockEngagement → test 2 fails on status
//      (EXECUTING, not BLOCKED).
//  (c) disable the anomaly emission in transitionOrAnomaly → test 3 fails on
//      the missing engagement-completion-transition-failed anomaly.
//  (d) delete the stages[currentStageIndex] guard in transitionEngagement →
//      tests 1 and 4 fail on currentStageIndex (2 and 3 respectively, not 1).
//  (e) make the read guard in blockEngagement rethrow → test 5 rejects with
//      EBUSY instead of emitting the blocked signal.
//
// The store here is the real fs-store over a temp vault, not an in-memory
// double, because the assertion that matters is the persisted status. The
// phase-1 harness is in-memory; phase3-executor-verify-stage.test.js:29-72 is
// the fs-store setup this file follows.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createEngagementStore } = require('../src/core/engagements/store');
const { createStateMachine } = require('../src/core/engagements/state-machine');
const { createInterview } = require('../src/core/engagements/interview');
const { createEngagement } = require('../src/core/engagements');
const { createEngagementExecutor } = require('../src/core/engagements/executor');
const { createVerifyRepair } = require('../src/core/engagements/verify-repair');
const events = require('../src/core/engagements/events');

function setup(opts) {
  opts = opts || {};
  const dir = tempVaultDir();
  const fs = createFsStore(() => dir, null);
  const bus = fakeBus();
  const config = {
    ENGAGEMENT_TTL_MS: 604800000,
    ENGAGEMENT_MAX_REPAIRS: opts.maxRepairs || 3,
    ENGAGEMENT_STAGE_TIMEOUT_MS: 10000,
    RUN_COMMAND_ALLOWLIST: 'node:--version',
    RUN_COMMAND_TIMEOUT_MS: 10000
  };
  const store = createEngagementStore({ fs, config });
  const stateMachine = createStateMachine({ config });
  const interview = createInterview({ config });
  const engagement = createEngagement({ bus, config, store, stateMachine, interview });

  const executor = createEngagementExecutor({
    bus,
    config,
    dispatchAction: opts.dispatchAction || (async function () { return { ok: true, result: { ok: true } }; }),
    leash: {
      check: function () { return { allow: true, requireConfirm: false, tier: 0 }; },
      confirm: { create: function () { return 'cf-fake'; } }
    },
    effectors: null,
    brain: null,
    buildEngine: { generate: async function () { return { offline: true, engine: 'fake', error: 'stub' }; } },
    checkpoints: null,
    store: engagement,
    engagementStore: store,
    vault: fs,
    logger: null
  });

  return { dir, bus, store, engagement, executor };
}

// Seed an engagement directly into EXECUTING with a populated plan. The real
// create() writes the record; the direct write is the same shape phase1 uses.
function seed(h, stages, opts) {
  opts = opts || {};
  const created = h.engagement.create({ initialIntent: 'verify-repair probe' });
  const rec = h.store.read(created.id);
  rec.status = 'EXECUTING';
  rec.plan = { stages: stages, currentStageIndex: 0, approvedAt: Date.now() };
  rec.execution = {
    stageResults: [],
    currentStageId: null,
    repairBudget: { used: 0, max: opts.maxRepairs || 3 }
  };
  h.store.write(rec);
  return rec.id;
}

function buildStage(id) {
  return {
    id: id,
    name: id,
    kind: 'build',
    verification: { type: 'command', cmd: 'node --version' }
  };
}

function actionStage(id) {
  return {
    id: id,
    name: id,
    kind: 'action',
    actions: [{ tool: 'flaky_action', args: {} }],
    verification: { type: 'command', cmd: 'node --version' }
  };
}

// Fail the first `failures` command verifications, then succeed. Every other
// tool succeeds, so a build stage's own work is never the reason for a retry.
function verifyScript(failures) {
  let calls = 0;
  return async function (decision) {
    if (decision.tool === 'run_command') {
      calls += 1;
      if (calls <= failures) return { ok: false, result: { error: 'verify-failed-' + calls } };
      return { ok: true, result: { ok: true, stdout: 'v24' } };
    }
    return { ok: true, result: { ok: true } };
  };
}

function anomalies(h) {
  return h.bus._emitted()
    .filter(function (e) { return e.type === 'health.anomaly'; })
    .map(function (e) { return e.payload; });
}

describe('phase5/engagement verification repair', () => {

  it('a repaired verification completes the engagement and persists COMPLETED', async () => {
    const h = setup({ dispatchAction: verifyScript(2) });
    try {
      const id = seed(h, [buildStage('s1')]);
      await h.executor.runEngagement(id);

      const final = h.store.read(id);
      assert.equal(final.status, 'COMPLETED', 'on-disk status after one verify-fail-repair cycle');
      assert.ok(final.completion && final.completion.completedAt, 'completion fields were written');
      assert.equal(final.plan.currentStageIndex, 1, 'index is stages.length, not past it');
      // FALSE-POSITIVE CONTROLS for tests 2 and 3: a legitimate completion is
      // neither a swallowed transition nor a blocked engagement.
      assert.equal(anomalies(h).filter(function (a) {
        return a.kind === 'engagement-completion-transition-failed';
      }).length, 0, 'a legitimate completion is not reported as a swallowed transition');
      assert.equal(h.bus._emitted().filter(function (e) {
        return e.type === 'engagement.blocked';
      }).length, 0, 'a successful repair does not signal blocked');
    } finally {
      cleanupVaultDir(h.dir);
    }
  });

  it('a failed repair re-run blocks the engagement instead of leaving it EXECUTING', async () => {
    let actionCalls = 0;
    const dispatch = async function (decision) {
      if (decision.tool === 'flaky_action') {
        actionCalls += 1;
        return actionCalls === 1
          ? { ok: true, result: { ok: true } }
          : { ok: false, error: 'retry-action-failed' };
      }
      if (decision.tool === 'run_command') return { ok: false, result: { error: 'verify-failed' } };
      return { ok: true, result: { ok: true } };
    };
    const h = setup({ dispatchAction: dispatch, maxRepairs: 2 });
    try {
      const id = seed(h, [actionStage('s1')], { maxRepairs: 2 });
      await h.executor.runEngagement(id);

      const final = h.store.read(id);
      assert.equal(final.status, 'BLOCKED', 'on-disk status after the repair re-run itself failed');

      const blocked = h.bus._emitted().filter(function (e) { return e.type === 'engagement.blocked'; });
      assert.ok(blocked.length >= 1, 'the blocked signal still reaches the UI');
    } finally {
      cleanupVaultDir(h.dir);
    }
  });

  it('a second completion emits an anomaly and does not regress COMPLETED', async () => {
    const h = setup();
    try {
      const created = h.engagement.create({ initialIntent: 'double completion probe' });
      const rec = h.store.read(created.id);
      rec.status = 'COMPLETED';
      rec.plan = {
        stages: [{ id: 's1', name: 's1', kind: 'build', verification: { type: 'research', claims: [] } }],
        currentStageIndex: 1
      };
      rec.completion = {
        reportMarkdown: 'first completion',
        artifactRefs: [],
        verificationSummary: { passed: 1, failed: 0, repaired: 0 },
        completedAt: Date.now()
      };
      h.store.write(rec);

      // Must not throw. The allVerified transition is invalid from COMPLETED;
      // the catch is a documented tolerance, but it must not be silent.
      await h.executor.runVerificationSweep(rec.id);

      const final = h.store.read(rec.id);
      assert.equal(final.status, 'COMPLETED', 'no status regression on a double completion');

      const double = anomalies(h).filter(function (a) {
        return a.kind === 'engagement-completion-transition-failed';
      });
      assert.equal(double.length, 1, 'the swallowed completion transition is named');
      assert.equal(double[0].status, 'COMPLETED', 'the anomaly names the current status');
    } finally {
      cleanupVaultDir(h.dir);
    }
  });

  it('two verify-fail-repair cycles keep currentStageIndex at stages.length', async () => {
    const h = setup({ dispatchAction: verifyScript(4), maxRepairs: 3 });
    try {
      const id = seed(h, [buildStage('s1')], { maxRepairs: 3 });
      await h.executor.runEngagement(id);

      const final = h.store.read(id);
      assert.equal(final.status, 'COMPLETED', 'two cycles still complete');
      assert.equal(final.plan.currentStageIndex, 1,
        'one bump for the final stage; each re-complete must be a no-op for the index');
    } finally {
      cleanupVaultDir(h.dir);
    }
  });

  it('a store read failure still emits the blocked signal', async () => {
    // The original blockEngagement wrapped the read and the transition in one
    // best-effort try/catch, so the UI always got a terminal signal. Moving the
    // function must not trade that away: readText rethrows EBUSY/EPERM.
    const bus = fakeBus();
    const repair = createVerifyRepair({
      store: { transition: async function () { throw new Error('unreachable'); } },
      engagementStore: { read: function () { throw new Error('EBUSY'); } },
      events: events,
      bus: bus,
      anomaly: function () {}
    });
    await repair.blockEngagement('eng-x', 's1', 'read failed');

    const blocked = bus._emitted().filter(function (e) { return e.type === 'engagement.blocked'; });
    assert.equal(blocked.length, 1, 'the UI still gets a terminal signal when the record cannot be read');
  });
});
