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

  // 2. Active-at-crash goals -> paused 'crash-recovery'.
  let pausedCount = 0;
  if (goals && typeof goals.getActiveGoals === 'function') {
    const active = goals.getActiveGoals();
    for (let i = 0; i < active.length; i++) {
      goals.update(active[i].id, { status: 'paused', reason: 'crash-recovery' });
      pausedCount++;
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
    recoveredJobs: recoveredJobs.length,
    recoveredJobGoalMap: recoveredJobGoalMap
  });

  // 5. No re-dispatch of any interrupted action — resumption happens purely through
  //    goals/cortex re-arbitration on the next tick. A goal that owned one of
  //    recoveredJobs is still covered by step 2 above if it was active-at-crash.
  //    [Phase 18] Every enqueue() call site (agent-actions.js/orchestrator.js) now
  //    carries goalId onto the job, so recoveredJobGoalMap (1c above) is a real,
  //    non-invented job->goal cross-reference — surfaced here for observability/audit,
  //    not consumed for a per-job targeted pause/resume (see 1c for why that's scoped
  //    out honestly rather than manufactured).
  return {
    hadCheckpoint: Boolean(checkpoint),
    pausedGoals: pausedCount,
    recoveredJobs: recoveredJobs.length,
    recoveredJobGoalMap: recoveredJobGoalMap
  };
}

module.exports = { createMonitor: createMonitor, recoverFromCrash: recoverFromCrash, MEMORY_GROWTH_BYTES: MEMORY_GROWTH_BYTES };
