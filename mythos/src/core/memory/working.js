'use strict';

function createWorkingMemory({ fs, config, bus, logger, episodic, checkpoints }) {
  let tick = 0;
  let lastModel = null;
  let perceptionQueue = [];
  let activeGoalId = null;
  const context = new Map();
  let spendThisTick = 0;
  // V1 (Phase 4): per-tick recall cache. orient() hydrates this once per
  // tick when a high-salience perception arrives; decide()/plan() can read
  // it without re-running recallHybrid (which does an embeddings call). The
  // cache clears in resetTickState() so it never leaks across ticks.
  let recallCache = null;

  function drainPerceptions() {
    const drained = perceptionQueue;
    perceptionQueue = [];
    return drained;
  }

  function pushPerception(perception) {
    perceptionQueue.push(perception);
  }

  function resetTickState() {
    lastModel = null;
    spendThisTick = 0;
    recallCache = null;   // V1 (Phase 4): invalidate per-tick
  }

  function snapshot() {
    return {
      tick: tick,
      activeGoalId: activeGoalId,
      contextKeys: Array.from(context.keys()),
      lastTickAt: Date.now()
    };
  }

  function set(key, value) {
    context.set(key, value);
  }

  function get(key) {
    return context.get(key);
  }

  function addSpend(tokens) {
    spendThisTick += tokens;
  }

  // V1 (Phase 4): per-tick recall cache accessors. orient() sets this once
  // when it observes a high-salience perception; later OODA stages read it.
  // Set returns the value passed in so orient can chain it through to the
  // decide() stage without a second read.
  function setRecallCache(hits) { recallCache = hits || null; return recallCache; }
  function getRecallCache() { return recallCache; }

  async function flushToEpisodic() {
    // Persist a working-memory snapshot so recovery can rebuild context on restart
    if (tick === 0 || !episodic) return;
    await episodic.write({
      kind: 'working-snapshot',
      tick: tick,
      activeGoalId: activeGoalId,
      summary: 'working-memory flush at tick ' + tick,
      contextKeys: Array.from(context.keys())
    });
  }

  async function rebuildFromEpisodic() {
    // Read episodic tail and rebuild context
    if (!episodic) return;
    try {
      const tail = episodic.tail(20);
      for (let i = 0; i < tail.length; i++) {
        const entry = tail[i];
        if (!entry) continue;
        if (entry.tick && entry.tick > tick) {
          tick = entry.tick;
        }
        if (entry.goalId) {
          activeGoalId = entry.goalId;
        }
      }
    } catch (_) {
      // Best-effort rebuild
    }
  }

  function stats() {
    return {
      tick: tick,
      perceptionQueueLength: perceptionQueue.length,
      activeGoalId: activeGoalId,
      contextSize: context.size,
      spendThisTick: spendThisTick
    };
  }

  // D-23 fix: rebuild from the checkpoint when one exists — it is the more precise,
  // less lossy source (episodic tail is a best-effort proxy for what a checkpoint
  // already recorded exactly: tick + activeGoalId). Only fall back to the episodic
  // tail scan when no checkpoint is present at all (first boot, or checkpoints
  // cleared) — matches immune/monitor.js's recoverFromCrash() comment #1, which
  // already assumed this behavior existed.
  async function init() {
    if (checkpoints && typeof checkpoints.load === 'function') {
      const checkpoint = checkpoints.load();
      if (checkpoint) {
        tick = checkpoint.tick || 0;
        activeGoalId = checkpoint.activeGoalId || null;
        return;
      }
    }
    await rebuildFromEpisodic();
  }

  return {
    // Properties
    get tick() { return tick; },
    set tick(v) { tick = v; },
    get lastModel() { return lastModel; },
    set lastModel(v) { lastModel = v; },
    get activeGoalId() { return activeGoalId; },
    set activeGoalId(v) { activeGoalId = v; },
    get perceptionQueue() { return perceptionQueue; },
    get spendThisTick() { return spendThisTick; },

    // Methods
    drainPerceptions, pushPerception, resetTickState, snapshot,
    set, get, addSpend, setRecallCache, getRecallCache,
    flushToEpisodic, rebuildFromEpisodic, stats, init
  };
}

module.exports = { createWorkingMemory };
