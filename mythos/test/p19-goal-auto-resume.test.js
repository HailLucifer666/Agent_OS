'use strict';

// P19 — closes the backlog item P18 explicitly deferred: "reports which goal each
// recovered job belonged to, it does NOT re-enqueue/resume the job under that goal."
// This suite proves, with real instances (not stubs), that:
//   1. A goal whose own in-flight build job gets flipped to 'failed' by crash
//      recovery is automatically reactivated (status back to 'active') so cortex/
//      goal arbitration can pick it up again on the next tick — not left paused
//      forever requiring a manual operator un-pause.
//   2. A goal with no recovered job (nothing was interrupted for it) stays paused,
//      exactly as P17/P18 already behaved — no regression.
//   3. Auto-resume never itself re-issues the crashed job: recoverFromCrash() makes
//      no enqueue()/effectors.invoke() call, so the specific interrupted work is
//      never silently duplicated. And the real, pre-existing in-flight guard in
//      agent-actions.js (`buildKanbanCard`/`executePipelineCard` throw while a job
//      for the same card is 'queued'/'running') still blocks a genuine double-run —
//      a crashed job is 'failed', so a retry is allowed, but a still-healthy in-flight
//      job for the same card is still refused, proving resume cannot double-execute.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tempVaultDir, cleanupVaultDir, fakeBus } = require('./helpers');
const { createFsStore } = require('../src/core/memory/fs-store');
const { createBuildRunner } = require('../src/core/effectors/build-runner');
const { createKanbanEffector } = require('../src/core/effectors/kanban');
const { createPipelineEffector } = require('../src/core/effectors/pipeline');
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

describe('P19: crash-recovered jobs auto-resume their owning goal, without double-execution', () => {
  let dir;
  afterEach(() => { if (dir) cleanupVaultDir(dir); });

  it('a goal with an in-flight job at crash time is reactivated (not left paused) on the next boot', async () => {
    dir = tempVaultDir();
    const fsA = createFsStore(() => dir);
    const busA = fakeBus();
    // Never-resolving brain — job stays 'running' until we simulate the crash by
    // restarting over the same persisted vault (same technique as p18's suite).
    const buildRunnerA = createBuildRunner({ config: {}, brain: { think: async () => new Promise(() => {}) }, bus: busA, vault: fsA });
    const job = buildRunnerA.enqueue({ kind: 'kanban-build', goalId: 'goal-crashed-1', prompt: 'p', run: async () => ({}) });
    await new Promise((resolve) => {
      const unsub = buildRunnerA.onJobUpdate((j) => { if (j.id === job.id && j.status === 'running') { unsub(); resolve(); } });
    });

    // Restart: fresh buildRunner over the same vault — loadPersisted() flips the
    // 'running' job to 'failed', carrying goalId through (P18).
    const fsB = createFsStore(() => dir);
    const busB = fakeBus();
    const buildRunnerB = createBuildRunner({ config: {}, brain: { think: async () => ({ content: 'ok' }) }, bus: busB, vault: fsB });

    const goals = fakeGoals();
    goals._setActive({ id: 'goal-crashed-1', status: 'active' });
    const memory = { checkpoints: { load: () => null } };

    const result = await recoverFromCrash({ bus: busB, config: {}, memory, goals, buildRunner: buildRunnerB });

    assert.equal(result.pausedGoals, 1, 'the goal is still paused first, per Crash Invariant #2');
    assert.equal(result.resumedGoals, 1, 'a goal with a real recovered job must be auto-resumed');
    assert.equal(goals.get('goal-crashed-1').status, 'active', 'the goal ends recovery active again, not stuck paused forever');

    const recoveredEvent = busB.history().find((e) => e.type === 'lifecycle.recovered');
    assert.ok(recoveredEvent);
    assert.equal(recoveredEvent.payload.resumedGoals, 1, 'resumedGoals must ride on the lifecycle.recovered event too');
  });

  it('a goal that was active-at-crash but owned no recovered job stays paused (no regression)', async () => {
    dir = tempVaultDir();
    const fs = createFsStore(() => dir);
    const bus = fakeBus();
    const buildRunner = createBuildRunner({ config: {}, brain: { think: async () => ({}) }, bus, vault: fs });

    const goals = fakeGoals();
    goals._setActive({ id: 'goal-idle-1', status: 'active' }); // no job was ever enqueued for this goal
    const memory = { checkpoints: { load: () => null } };

    const result = await recoverFromCrash({ bus, config: {}, memory, goals, buildRunner });

    assert.equal(result.pausedGoals, 1);
    assert.equal(result.resumedGoals, 0, 'nothing was interrupted for this goal — it must not be auto-resumed');
    assert.equal(goals.get('goal-idle-1').status, 'paused');
  });

  it('auto-resume cannot double-execute: the crashed job is never re-enqueued by recovery, and a genuinely still-in-flight card build is still blocked', async () => {
    dir = tempVaultDir();
    const fs = createFsStore(() => dir);
    const bus = fakeBus();
    const buildRunner = createBuildRunner({ config: {}, brain: { think: async () => new Promise(() => {}) }, bus, vault: fs });
    const kanban = createKanbanEffector({ fs });
    const pipeline = createPipelineEffector({ fs });
    const agentActions = createAgentActions({ fs, pipeline, kanban, buildRunner });

    const card = kanban.addCard('a task', 'backlog');
    const first = agentActions.buildKanbanCard(card.id, 'goal-inflight-1');

    const goals = fakeGoals();
    goals._setActive({ id: 'goal-inflight-1', status: 'active' });
    const memory = { checkpoints: { load: () => null } };

    // Crash recovery runs while the job is still genuinely 'running' in this same
    // process (no restart) — recoverFromCrash() itself never calls enqueue()/
    // buildKanbanCard(), so build-runner's own job count cannot have grown from it.
    const jobCountBefore = buildRunner.listJobs().length;
    const result = await recoverFromCrash({ bus, config: {}, memory, goals, buildRunner });
    assert.equal(buildRunner.listJobs().length, jobCountBefore, 'recoverFromCrash() must not itself enqueue any job');
    assert.equal(result.resumedGoals, 0, 'the job here never crashed (still running, no restart) so nothing is recovered/resumed');

    // And the pre-existing in-flight guard still refuses a genuine duplicate attempt
    // on the same card while its job is still 'queued'/'running'.
    assert.throws(() => agentActions.buildKanbanCard(card.id, 'goal-inflight-1'), /already in progress/);
    void first;
  });
});
