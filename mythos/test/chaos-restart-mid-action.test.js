'use strict';

// CHAOS DRILL 6 — Restart-mid-action.
// Starts a build-runner job, "crashes" (drops the in-memory instance without a
// graceful shutdown), then re-inits a FRESH build-runner + goals instance pointed at
// the SAME vault directory. Asserts: the previously-running job flips to 'failed',
// the goal tied to it flips to 'paused' with reason 'crash-recovery', and the audit
// trail stays consistent — no permanently-orphaned 'confirm' entries.
//
// CROSS-PHASE FIX (consistency pass, P7 vs P10): P7's real build-runner.js
// enqueue() is exactly {kind, prompt, run} — no cardId, no goalId (P7 wins per
// its own Anti-Drift Checklist). build-runner's persisted job record carries no
// goal linkage either. That means job<->goal association is NOT build-runner's
// job — it belongs to whichever Phase 7 effector wrapper calls enqueue() on a
// goal's behalf (e.g. agent-actions.js), which must persist that mapping itself,
// separately from build-runner's own jobs.json — the same pattern NOVA's
// agent-actions.js already uses (goal linkage lives at the caller, not the
// orchestrator). This drill simulates that persisted side-mapping directly
// (`Pipeline/job-goal-map.json`) rather than assuming build-runner tracks it.
//
// The recovery composition below (recoveredJobs -> resolve goalId via the side
// map -> goals.update(...) -> expire pending confirms) MUST match main.js's real
// 'recovery' boot step verbatim — see Spec Ambiguities Resolved #7 and the
// Anti-Drift Checklist. It is written here against real fs-store/goals/
// audit-writer/build-runner instances, not fakes.
//
// P10 BUILD FIXES (verified against today's shipped source, not guessed):
// 1. fs-store.js's real signature is createFsStore(vaultRootFn, bus) — bus is a
//    direct positional arg, not { bus } (fs-store.js:11). Fixed below.
// 2. build-runner.js throws at construction if brain.think isn't a function
//    (build-runner.js:13-15 — also asserted directly by
//    test/build-runner.test.js:36-39, "throws in the constructor if brain.think is
//    missing"). The spec's own pasted code passed brain: null for both pre- and
//    post-crash instances, which would throw before the drill's body ever runs.
//    Fixed with the same stub shape test/build-runner.test.js already uses:
//    { think: async () => ({ content: 'ok', offline: false }) }. For buildRunner1
//    this must resolve non-offline so pump() proceeds past the brain call into the
//    hung run() — an offline brain would fail the job immediately (status
//    'failed', not 'running') and never reach the "crash mid-dispatch" state this
//    drill is supposed to simulate.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function tempDir() {
  const dir = path.join(os.tmpdir(), 'mythos-chaos-restart-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  ['Goals', 'Audit', 'Pipeline'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  return createBus({ historySize: 200 });
}

// Real build-runner.js requires a brain with think() at construction time, even
// when no job dispatched through it will ever complete — see file-header fix #2.
function fakeBrain(content) {
  return { think: async function() { return { content: content || 'ok', offline: false, aborted: false }; } };
}

// job-goal-map.json — the persisted side-mapping a real Phase 7 effector (e.g.
// agent-actions.js) is responsible for maintaining, since build-runner.js's own
// job schema carries no goal linkage. { [jobId]: goalId }
function readJobGoalMap(fsStore) {
  return fsStore.readJSON('Pipeline/job-goal-map.json', {});
}
function writeJobGoalMap(fsStore, map) {
  fsStore.writeJSON('Pipeline/job-goal-map.json', map);
}

// Runs the composition main.js's 'recovery' boot step is required to run.
function runRecovery(recoveredJobs, jobGoalMap, goals, auditWriter) {
  for (const rec of recoveredJobs) {
    const goalId = jobGoalMap[rec.id];
    if (!goalId) continue;
    goals.update(goalId, { status: 'paused', reason: 'crash-recovery' });
    const pending = auditWriter.query({ goalId: goalId, decision: 'confirm' });
    for (const entry of pending) {
      const resolved = auditWriter.query({ goalId: goalId, tool: entry.tool }).some(
        (e) => e.decision === 'allow' || e.decision === 'deny' || e.decision === 'expired'
      );
      if (!resolved) {
        auditWriter.write({ tool: entry.tool, goalId: goalId, tier: entry.tier, decision: 'expired' });
      }
    }
  }
}

describe('chaos drill: restart-mid-action', () => {
  let dir;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('crash mid-dispatch: job->failed, goal->paused(crash-recovery), no orphaned confirm entries', async () => {
    const { createFsStore } = require('../src/core/memory/fs-store');
    const { createGoalSystem } = require('../src/core/goals');
    const { createAuditWriter } = require('../src/core/memory/audit-writer');
    const { createBuildRunner } = require('../src/core/effectors/build-runner');

    // -- Pre-crash process --
    const bus1 = fakeBus();
    const fs1 = createFsStore(() => dir, bus1);
    const goals1 = createGoalSystem({ fs: fs1, config: {}, bus: bus1, memory: null, brain: null });
    const audit1 = createAuditWriter({ fs: fs1, config: {}, bus: bus1, logger: null });
    await audit1.init();

    const goal = goals1.create({ title: 'Crash-mid-dispatch target', drive: 'user-service', status: 'active' });

    // A tier-4 confirm that never got a human reply before the crash.
    audit1.write({ tool: 'kill_session', goalId: goal.id, tier: 4, decision: 'confirm' });

    const buildRunner1 = createBuildRunner({ config: {}, brain: fakeBrain('long-running build output'), bus: bus1, vault: fs1 });
    await buildRunner1.init();
    // P7's real enqueue() is exactly {kind, prompt, run} — no cardId/goalId.
    const job = buildRunner1.enqueue({
      kind: 'pipeline',
      prompt: 'do something long-running',
      run: async () => { await new Promise(() => {}); } // never resolves — simulates a hung dispatch
    });
    assert.equal(job.status, 'queued', 'enqueue() must always return a job in the queued state');

    // The goal<->job association is persisted OUTSIDE build-runner, by the
    // effector layer that dispatched this job on the goal's behalf — simulating
    // what agent-actions.js (Phase 7) is responsible for doing in real code.
    writeJobGoalMap(fs1, { [job.id]: goal.id });

    // -- CRASH: drop all references without any graceful shutdown --
    // (no buildRunner1.stop(), no goals1 flush, no audit1 flush — simulates SIGKILL)

    // -- Fresh process, same vault --
    const bus2 = fakeBus();
    const fs2 = createFsStore(() => dir, bus2);
    const goals2 = createGoalSystem({ fs: fs2, config: {}, bus: bus2, memory: null, brain: null });
    await goals2.init();
    const audit2 = createAuditWriter({ fs: fs2, config: {}, bus: bus2, logger: null });
    await audit2.init();
    const buildRunner2 = createBuildRunner({ config: {}, brain: fakeBrain(), bus: bus2, vault: fs2 });
    const initResult = await buildRunner2.init();

    assert.ok(Array.isArray(initResult.recoveredJobs) && initResult.recoveredJobs.length >= 1,
      'a fresh build-runner instance must report every job it force-failed on this boot');

    const recovered = buildRunner2.getJob(job.id);
    assert.ok(recovered, 'the crashed job must still be findable after restart');
    assert.equal(recovered.status, 'failed', 'a job caught running/queued at crash time must flip to failed — never fake-resumed');

    // build-runner's own record carries no goalId (P7's real schema) — the
    // recovery step resolves it from the persisted side-map instead.
    const jobGoalMap = readJobGoalMap(fs2);
    assert.equal(jobGoalMap[job.id], goal.id, 'the persisted job-goal-map must survive the crash and still resolve this job to its goal');

    // Apply the recovery composition (must match main.js's real 'recovery' step).
    runRecovery(initResult.recoveredJobs, jobGoalMap, goals2, audit2);

    const refreshedGoal = goals2.get(goal.id);
    assert.equal(refreshedGoal.status, 'paused', 'the goal tied to the crashed job must be paused');
    assert.equal(refreshedGoal.reason, 'crash-recovery', "pause reason must be the exact string 'crash-recovery'");

    // Audit consistency: no 'confirm' entry survives without a resolution.
    const allEntries = audit2.query({ goalId: goal.id });
    const confirms = allEntries.filter((e) => e.decision === 'confirm');
    const resolutions = allEntries.filter((e) => e.decision === 'allow' || e.decision === 'deny' || e.decision === 'expired');
    assert.ok(confirms.length >= 1, 'sanity: the pre-crash confirm entry must actually be present');
    assert.ok(resolutions.length >= confirms.length,
      "every 'confirm' audit entry must have a matching resolution after crash recovery — no orphans");
  });
});
