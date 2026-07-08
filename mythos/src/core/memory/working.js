'use strict';

function createWorkingMemory({ fs, config, bus, logger, episodic }) {
  let tick = 0;
  let lastModel = null;
  let perceptionQueue = [];
  let activeGoalId = null;
  const context = new Map();
  let spendThisTick = 0;

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

  async function flushToEpisodic() {
    // Write current tick state to episodic if there's anything to flush
    if (tick === 0) return;
    // The actual flushing of perception/action records happens elsewhere
    // This just ensures WorkingMemory context is snapshot-able
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

  async function init() {
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
    set, get, addSpend, flushToEpisodic, rebuildFromEpisodic, stats, init
  };
}

module.exports = { createWorkingMemory };
