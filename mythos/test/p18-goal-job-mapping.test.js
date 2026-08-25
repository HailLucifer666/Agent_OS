'use strict';

// P18 — closes the specific, scoped gap P17 documented but left open: "no persisted
// job<->goal mapping mechanism exists anywhere in production code (agent-actions.js's
// enqueue() carries no goalId)". This suite proves, with real instances (not stubs),
// that:
//   1. build-runner.js's enqueue() carries goalId onto the job record, honestly
//      recording null (never a fake value) when no goal is behind the job.
//   2. agent-actions.js's executePipelineCard/assembleKanbanPlan/buildKanbanCard —
//      the real, shipped call sites — thread an optional goalId through to enqueue().
//   3. A crash-recovery scenario: a job enqueued for a real goalId, persisted mid-run,
//      restarted, and recovered via the real recoverFromCrash() surfaces a real
//      job->goal mapping (recoveredJobGoalMap) in both the return value and the
//      'lifecycle.recovered' event — the exact reattachment mechanism P17 said did
//      not exist.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createAgentActions } = require('../src/core/effectors/agent-actions');
const { recoverFromCrash } = require('../src/core/immune/monitor');

function fakeGoals() {
  const goals = new Map();
  return {
    _setActive(g) { goals.set(g.id, g); },
    get(id) { return goals.get(id) || null; },
    getActiveGoals() { return Array.from(goals.values()).filter((g) => g.status === 'active'); },
    update(id, patch) { const g = goals.get(id); if (g) Object.assign(g, patch); }
  };
}

describe('P18: job<->goal mapping (build-runner + agent-actions + crash recovery)', () => {
  let dir;
  afterEach(() => { if (dir) cleanupVaultDir(dir); });

  // BUG-329 found this, and it is a harness defect rather than a product one, so
  // it is fixed here.
  //
  // `dir` is shared and reassigned by every test in this describe, and
  // createFsStore takes a THUNK — `() => dir` reads whichever directory is
  // current at WRITE time, not at construction. The tests below enqueue jobs and
  // do not await them (they only assert what enqueue() returns), so those jobs
  // are still pumping when the next test begins. Every notify() persists, so a
  // leftover job from an earlier test wrote its own job list into the NEXT test's
  // vault, clobbering Checkpoints/build-jobs.json between the crash-recovery
  // test's snapshot and its restart — recoveredJobs came back 0.
  //
  // It survived because it needed a build to take slightly longer: BUG-329 added
  // an awaited preparePrompt hook, which was enough. Binding the directory at
  // construction removes the class rather than the instance — a stray write now
  // lands in the directory it belongs to, wherever the test has got to.
  function vaultAt(root) {
    return createFsStore(() => root);
  }

  it('build-runner.enqueue() carries goalId onto the job record, and honestly records null when absent', async () => {
    dir = tempVaultDir();
    const fs = vaultAt(dir);
    const bus = fakeBus();
    const brain = { think: async () => ({ content: 'ok', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus, vault: fs });

    const withGoal = buildRunner.enqueue({ kind: 'test', goalId: 'goal-abc', prompt: 'p', run: async () => ({}) });
    assert.equal(withGoal.goalId, 'goal-abc');

    const withoutGoal = buildRunner.enqueue({ kind: 'test', prompt: 'p', run: async () => ({}) });
    assert.equal(withoutGoal.goalId, null, 'goal-less jobs must record an honest null, not a fake id');
  });

  it('agent-actions.executePipelineCard/buildKanbanCard/assembleKanbanPlan thread goalId through to the real build-runner job', async () => {
    dir = tempVaultDir();
    const fs = vaultAt(dir);
    const bus = fakeBus();
    const brain = { think: async () => ({ content: '# Deliverable\nbody', offline: false }) };
    const buildRunner = createBuildRunner({ config: {}, brain, bus, vault: fs });
    const pipeline = createPipelineEffector({ fs });
    const kanban = createKanbanEffector({ fs });
    const agentActions = createAgentActions({ fs, pipeline, kanban, buildRunner });

    // executePipelineCard
    const card = pipeline.capture('build a thing', 'voice');
    pipeline.approve(card.id);
    const pipelineResult = agentActions.executePipelineCard(card.id, 'goal-pipeline-1');
    assert.equal(buildRunner.getJob(pipelineResult.job.id).goalId, 'goal-pipeline-1');

    // assembleKanbanPlan
    const planResult = agentActions.assembleKanbanPlan('ship a feature', 'goal-plan-1');
    assert.equal(buildRunner.getJob(planResult.job.id).goalId, 'goal-plan-1');

    // buildKanbanCard
    const kcard = kanban.addCard('a task', 'backlog');
    const buildResult = agentActions.buildKanbanCard(kcard.id, 'goal-build-1');
    assert.equal(buildRunner.getJob(buildResult.job.id).goalId, 'goal-build-1');

    // Omitting goalId (dashboard/voice, no goal behind it) must stay honestly null.
    const kcard2 = kanban.addCard('another task', 'backlog');
    const buildResult2 = agentActions.buildKanbanCard(kcard2.id);
    assert.equal(buildRunner.getJob(buildResult2.job.id).goalId, null);
  });

  it('real crash recovery: a job enqueued for a goal, persisted mid-run, restarted — recoverFromCrash() surfaces a real job->goal map', async () => {
    dir = tempVaultDir();
    const fsA = vaultAt(dir);
    const busA = fakeBus();
    // brain.think() never resolves before we snapshot — we seed the persisted file
    // directly instead of racing a real hung run(), same technique as
    // d57-recovery-boot-order-regression.test.js.
    const buildRunnerA = createBuildRunner({ config: {}, brain: { think: async () => new Promise(() => {}) }, bus: busA, vault: fsA });
    const job = buildRunnerA.enqueue({ kind: 'kanban-build', goalId: 'goal-crashed-1', prompt: 'p', run: async () => ({}) });
    // Let pump() flip it to 'running' before we simulate the crash.
    await new Promise((resolve) => {
      const unsub = buildRunnerA.onJobUpdate((j) => { if (j.id === job.id && j.status === 'running') { unsub(); resolve(); } });
    });

    // Restart: fresh buildRunner over the same vault (loadPersisted() reads the
    // 'running' job back and flips it to 'failed', carrying goalId through).
    const fsB = vaultAt(dir);
    const busB = fakeBus();
    const buildRunnerB = createBuildRunner({ config: {}, brain: { think: async () => ({ content: 'ok' }) }, bus: busB, vault: fsB });

    const goals = fakeGoals();
    goals._setActive({ id: 'goal-crashed-1', status: 'active' });
    const memory = { checkpoints: { load: () => null } };

    const result = await recoverFromCrash({ bus: busB, config: {}, memory, goals, buildRunner: buildRunnerB });

    assert.equal(result.recoveredJobs, 1);
    assert.deepEqual(result.recoveredJobGoalMap, [{ jobId: job.id, goalId: 'goal-crashed-1' }],
      'recoverFromCrash() must reattach the recovered job to the goal that spawned it, by goalId');
    assert.equal(buildRunnerB.getJob(job.id).status, 'failed');
    assert.equal(buildRunnerB.getJob(job.id).goalId, 'goal-crashed-1', 'goalId survives the persist/reload round-trip');

    const recoveredEvent = busB.history().find((e) => e.type === 'lifecycle.recovered');
    assert.ok(recoveredEvent);
    assert.deepEqual(recoveredEvent.payload.recoveredJobGoalMap, [{ jobId: job.id, goalId: 'goal-crashed-1' }],
      'the same job->goal map must ride on the lifecycle.recovered event, not just the return value');
  });

  it('a goal-less recovered job (system job, no goalId) maps to an honest null, never a fabricated goal', async () => {
    dir = tempVaultDir();
    const fs = vaultAt(dir);
    fs.writeJSON('Checkpoints/build-jobs.json', {
      jobs: [{ id: 'job-system-1', kind: 'test', goalId: null, status: 'running', stage: 'generating', artifact: null, error: null, createdAt: Date.now(), finishedAt: null }]
    });
    const bus = fakeBus();
    const buildRunner = createBuildRunner({ config: {}, brain: { think: async () => ({}) }, bus, vault: fs });

    const goals = fakeGoals();
    const memory = { checkpoints: { load: () => null } };
    const result = await recoverFromCrash({ bus, config: {}, memory, goals, buildRunner });

    assert.deepEqual(result.recoveredJobGoalMap, [{ jobId: 'job-system-1', goalId: null }]);
  });
});
