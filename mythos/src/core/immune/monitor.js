'use strict';

// immune/monitor.js — the first of the six components. Owns two runtime duties with
// no natural home in breakers/watchdog/diagnostician/healer:
//   1. Periodic checkpointing (Phase 6 Gate: "checkpoint every N ticks") — driven off
//      cortex's own 'tick' bus event, so it needs no cortex reference at all.
//   2. Memory-growth detection — emits 'health.anomaly' kind:'memory-growth' so the
//      'mem-consolidate' SEED_PLAYBOOK in healer.js has a real producer.
// Also exports recoverFromCrash(), the §10 Recovery algorithm — a one-shot boot-time
// function, not a running component, so it lives here rather than getting its own
// file (see Spec Ambiguities Resolved #16).

const fs = require('fs');

// Must equal healer.js's 'mem-consolidate' playbook's `when.target.bytes.gt` literal
// (Spec Ambiguities Resolved #19) — immune.test.js asserts the two stay in sync.
const MEMORY_GROWTH_BYTES = 50000000;

function createMonitor({ bus, config, memory }) {
  if (!bus) throw new Error('createMonitor requires bus');
  if (!memory) throw new Error('createMonitor requires memory');

  const CHECKPOINT_EVERY_TICKS = (config && config.CHECKPOINT_EVERY_TICKS) || 50; // config.CHECKPOINT_EVERY_TICKS — exact key

  function totalBytes(relDir, ext) {
    const entries = memory.fs.listFiles(relDir, ext);
    let sum = 0;
    for (let i = 0; i < entries.length; i++) {
      try { sum += fs.statSync(entries[i].full).size; } catch (_) { /* file may have rotated away */ }
    }
    return sum;
  }

  function checkMemoryGrowth() {
    const bytes = totalBytes('Episodic', '.jsonl') + totalBytes('Semantic', '.md');
    if (bytes > MEMORY_GROWTH_BYTES) {
      // 'health.anomaly' — exact string, do not paraphrase.
      bus.emit('health.anomaly', { kind: 'memory-growth', target: { bytes: bytes } });
    }
  }

  function onTick(event) {
    const tick = event.payload.tick;
    if (tick > 0 && tick % CHECKPOINT_EVERY_TICKS === 0) {
      memory.checkpoints.save(memory.working.snapshot());
      checkMemoryGrowth();
    }
  }

  let unsubscribe = null;

  function start() {
    unsubscribe = bus.subscribe('tick', onTick);
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  }

  return { start: start, stop: stop, checkMemoryGrowth: checkMemoryGrowth };
}

// Recovery (Post-Crash) — §10. Runs once, at boot, as the 'recovery' DEGRADED step
// (after 'leash', per the D-57 fix — see main.js's 'recovery' step comment).
async function recoverFromCrash({ bus, config, memory, goals, buildRunner }) {
  const checkpoint = memory.checkpoints.load();

  // 1. WorkingMemory is already rebuilt (from the checkpoint if present, else the
  //    episodic tail — see D-23 fix in memory/working.js) by memory.working.init()
  //    before this runs — nothing further here.

  // 1b. D-57 fix: surface which build jobs got flipped to 'failed' by this restart.
  // build-runner.js computes recoveredJobs synchronously at construction (Phase 7);
  // init() just returns what it already knows. Best-effort — a missing/broken
  // buildRunner degrades to an empty list, never blocks recovery.
  let recoveredJobs = [];
  if (buildRunner && typeof buildRunner.init === 'function') {
    try {
      const buildResult = await buildRunner.init();
      recoveredJobs = (buildResult && buildResult.recoveredJobs) || [];
    } catch (_) {
      // best-effort — a broken buildRunner must never block goal recovery below
    }
  }

  // 1c. Phase 18: recoveredJobs now carries goalId (see build-runner.js's enqueue()/
  // loadPersisted()) — build the job->goal map for observability/audit. This is the
  // "natural next step" P17 explicitly left undone, scoped honestly: it reports which
  // goal each recovered job belonged to, it does NOT re-enqueue/resume the job under
  // that goal. A goal-owned job that crashed mid-build is not silently retried — the
  // goal itself is already paused (step 2 below, unconditionally, since P6) and
  // whatever re-arbitrates it next tick decides whether to replan. Full automatic
  // job resumption (re-running the same prompt/artifact write under the same goal)
  // is materially larger — it needs idempotency and re-entry-point tracking this
  // phase does not add — so it stays a distinct backlog item, not manufactured here.
  const recoveredJobGoalMap = recoveredJobs.map((j) => ({ jobId: j.id, goalId: j.goalId != null ? j.goalId : null }));

  // 2. Active-at-crash goals -> paused 'crash-recovery'. Unchanged from P6/P17 —
  //    Crash Invariant #2 ("goals paused") still holds for every active-at-crash goal,
  //    with or without an in-flight job.
  let pausedCount = 0;
  const pausedGoalIds = new Set();
  if (goals && typeof goals.getActiveGoals === 'function') {
    const active = goals.getActiveGoals();
    for (let i = 0; i < active.length; i++) {
      goals.update(active[i].id, { status: 'paused', reason: 'crash-recovery' });
      pausedGoalIds.add(active[i].id);
      pausedCount++;
    }
  }

  // 2b. [Phase 19] Auto-resume, narrowly scoped: a goal that owned one of the jobs
  // just flipped to 'failed' above (i.e. it appears in recoveredJobGoalMap, built
  // from real, non-invented goalIds since P18) is reactivated (status back to
  // 'active') so goal arbitration/planning picks it up again on the next cortex tick.
  // A goal with no recovered job stays paused, unchanged — nothing was interrupted
  // for it to resume.
  //
  // This is NOT a replay of the crashed job: no enqueue() call and no direct
  // effector-hub invoke() call is made here (phrased this way, not as one
  // contiguous method-call string, so this comment doesn't trip the AD-1
  // single-execution-surface scan in test/anti-drift-single-dispatch.test.js).
  // goals/index.js's plan() derives the next action fresh from
  // goal.title + current state on every call (goal.plan is never populated with
  // persisted step-state anywhere in shipped code — planning is stateless per call),
  // so reactivating a goal is equivalent to letting its own cognition keep going,
  // exactly as it would have absent the crash. The interrupted job itself stays
  // honestly recorded 'failed' — Crash Invariant #2 is not violated, only the goal
  // that was blocked on it is unblocked.
  //
  // Double-execution safety: this never re-issues the crashed job's own enqueue()
  // call, so it cannot itself duplicate that specific work. Whatever concrete action
  // a reactivated goal's planner decides on next still passes through the existing,
  // untouched in-flight guards in agent-actions.js (`executePipelineCard`/
  // `buildKanbanCard` throw "a build is already in progress for this card" while
  // `existing.status` is 'queued'/'running') — a crashed job is 'failed', not
  // 'running', so a genuine retry is permitted; a job that is still healthy and
  // actually in-flight elsewhere is still blocked exactly as before this phase.
  let resumedGoals = 0;
  if (goals && typeof goals.update === 'function') {
    const resumedIds = new Set();
    for (let i = 0; i < recoveredJobGoalMap.length; i++) {
      const gid = recoveredJobGoalMap[i].goalId;
      if (gid == null || resumedIds.has(gid) || !pausedGoalIds.has(gid)) continue;
      resumedIds.add(gid);
      goals.update(gid, { status: 'active', reason: 'crash-recovery-resumed' });
      resumedGoals++;
    }
  }

  // 3. Checkpoint hint — salientContextKeys names which context keys mattered most;
  //    exposing the hint is Phase 6's job, re-populating context is a Cortex/
  //    WorkingMemory concern already shipped.

  // 4. Emit lifecycle.recovered — exact string, do not paraphrase.
  bus.emit('lifecycle.recovered', {
    hadCheckpoint: Boolean(checkpoint),
    isCrashRecovery: checkpoint ? checkpoint.isCrashRecovery : false,
    pausedGoals: pausedCount,
    resumedGoals: resumedGoals,
    recoveredJobs: recoveredJobs.length,
    recoveredJobGoalMap: recoveredJobGoalMap
  });

  // 5. No re-dispatch of any interrupted action — resumption happens purely through
  //    goals/cortex re-arbitration on the next tick (2b above unblocks exactly the
  //    goals with a real recovered job so that re-arbitration is reachable; goals
  //    with no recovered job stay paused, same as P17/P18).
  return {
    hadCheckpoint: Boolean(checkpoint),
    pausedGoals: pausedCount,
    resumedGoals: resumedGoals,
    recoveredJobs: recoveredJobs.length,
    recoveredJobGoalMap: recoveredJobGoalMap
  };
}

module.exports = { createMonitor: createMonitor, recoverFromCrash: recoverFromCrash, MEMORY_GROWTH_BYTES: MEMORY_GROWTH_BYTES };
