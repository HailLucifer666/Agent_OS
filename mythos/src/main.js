'use strict';

// MYTHOS Phase 0 — boots clean, logs ALIVE, handles SIGINT exit 0

const path = require('path');
const { createLogger } = require('./core/logger');
const { createBus } = require('./core/bus');
const { loadConfig, SCHEMA } = require('./core/config');
const { createLifecycle } = require('./core/lifecycle');
const { createMemory } = require('./core/memory');
const { createBrain } = require('./core/brain');
const { createGoalSystem } = require('./core/goals');
const { createCortex } = require('./core/cortex');
const { createTimerSensor } = require('./core/sensors/timer');
const fs = require('fs');

// Placeholder leash/effectors — P5 (Leash) and P7 (Effectors) ship the real
// modules. Cortex requires both to construct (D-39, fail-closed gating), so
// until those phases land the entity ticks its full OODA loop (observe →
// orient → decide) but every actual action is safely denied/no-op.
function createNullLeash() {
  return { check: function() { return { allow: false, reason: 'leash-not-yet-wired (ships in P5)' }; } };
}

function createNullEffectors() {
  return {
    breakers: { allow: function() { return true; } },
    invoke: async function() { return { ok: false, reason: 'effectors-not-yet-wired (ships in P7)' }; }
  };
}

async function main() {
  // Step 0: .env (DEGRADED — missing .env is not fatal, config falls back to schema defaults)
  require('dotenv').config();

  // Step 1: Config
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error('Config errors:', configResult.errors.join(', '));
    process.exit(1);
  }
  const config = configResult.config;

  // Step 2: Logger
  const logger = createLogger(config.LOG_LEVEL);
  logger.info('config.loaded', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT });

  // Step 3: Bus
  const bus = createBus({
    historySize: config.BUS_HISTORY_SIZE,
    maxDepth: 32,
    storm: { windowMs: 1000, maxPerWindow: config.BUS_STORM_MAX }
  });
  logger.info('bus.created', bus.stats());

  // Step 4: Ensure vault directories
  const vaultDirs = ['Episodic', 'Semantic', 'Skills', 'Identity', 'Audit', 'Checkpoints'];
  const vaultRoot = path.resolve(config.MYTHOS_VAULT_ROOT);
  for (let i = 0; i < vaultDirs.length; i++) {
    const dir = path.join(vaultRoot, vaultDirs[i]);
    fs.mkdirSync(dir, { recursive: true });
  }
  logger.info('vault.dirs.created', { root: vaultRoot, dirs: vaultDirs });

  // Step 5: Lifecycle
  const lifecycle = createLifecycle({ bus, logger, config });

  // Modules constructed by the boot steps below, closed over so shutdown can stop them
  let memory = null;
  let brain = null;
  let goals = null;
  let cortex = null;
  let timerSensor = null;

  // Real boot sequence — wires memory/brain/cortex/goals/sensors (already built)
  // so the entity actually runs its OODA loop end-to-end, not just in unit tests.
  // FAIL-FAST: a broken core module means the entity cannot safely run.
  // DEGRADED: best-effort — the entity should still boot if these are unavailable.
  lifecycle.setSteps([
    { name: 'config',     fn: function() { /* already loaded */ } },
    { name: 'logger',     fn: function() { /* already created */ } },
    { name: 'bus',        fn: function() { /* already created */ } },
    { name: 'vault-dirs', fn: function() { /* already ensured */ } },

    { name: 'memory', fn: async function() {
      brain = createBrain({ config, bus });
      memory = createMemory({ config, bus, logger, brain });
      await memory.init();
      logger.info('memory.ready', memory.stats());
    }},

    { name: 'brain-probe', fail: 'degraded', fn: function() {
      // Fire-and-forget with a timeout — boot never blocks on provider availability.
      // The guard timer is unref'd: it must never hold the process open on its own.
      const timeoutMs = 5000;
      Promise.race([
        brain.probe(),
        new Promise(function(resolve) {
          const t = setTimeout(resolve, timeoutMs);
          if (t.unref) t.unref();
        })
      ]).catch(function(err) {
        logger.warn('brain.probe.failed', { error: err.message });
      });
    }},

    { name: 'goals', fail: 'degraded', fn: async function() {
      goals = createGoalSystem({ fs: memory.fs, config, bus, memory, brain });
      await goals.init();
      logger.info('goals.ready', goals.stats());
    }},

    { name: 'recovery', fail: 'degraded', fn: function() {
      const checkpoint = memory.checkpoints.load();
      if (checkpoint && checkpoint.isCrashRecovery) {
        logger.warn('lifecycle.crash-recovery', { tick: checkpoint.tick, activeGoalId: checkpoint.activeGoalId });
        bus.emit('lifecycle.recovered', { tick: checkpoint.tick, activeGoalId: checkpoint.activeGoalId });
      }
    }},

    { name: 'cortex', fn: function() {
      // Placeholder leash/effectors until P5/P7 ship — see createNullLeash/createNullEffectors above
      cortex = createCortex({
        bus, memory, goals, brain,
        leash: createNullLeash(),
        effectors: createNullEffectors(),
        config
      });
      cortex.start();
      logger.info('cortex.started', { generation: cortex.generation });
    }},

    { name: 'sensors', fail: 'degraded', fn: function() {
      timerSensor = createTimerSensor({ bus, config });
      timerSensor.start();
      logger.info('sensors.timer.started', { intervalMs: config.MYTHOS_TICK_MS });
    }}
  ]);

  // Stop running loops before the lifecycle's own shutdown/exit runs (full graceful
  // shutdown sequencing — drain/flush/audit — is D-07, a non-blocking Known Deviation)
  function stopRunningLoops() {
    if (timerSensor) timerSensor.stop();
    if (cortex) cortex.stop();
  }
  process.on('SIGINT', stopRunningLoops);
  process.on('SIGTERM', stopRunningLoops);

  // Register signal handlers
  lifecycle.registerShutdown();

  // Boot
  await lifecycle.boot();
  logger.info('MYTHOS ALIVE', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT, pid: process.pid });

  // Keep process alive — cortex's tick interval and the timer sensor's interval
  // are both unref'd, so we need something to hold the event loop open.
  return new Promise(function() { /* never resolves — process stays up */ });
}

main().catch(function(err) {
  console.error('Fatal:', err.message);
  process.exit(1);
});
