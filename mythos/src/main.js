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
const { createLeash } = require('./core/leash');
const { createTimerSensor } = require('./core/sensors/timer');
const fs = require('fs');

// Temporary stubs for modules that ship in later phases. Lesson #3: gating
// must be MANDATORY, never "if dependency present" — every module that
// requires a not-yet-shipped collaborator gets a real (if minimal) object
// injected here, not a runtime `if (x && typeof x.fn === 'function')` guard
// inside the module itself. Deleted wholesale — not patched — the day the
// real phase ships (see MYTHOS-PHASE-BUILD-SPEC.md Phase 5, Ambiguity #3).

function createIdentityStub(ctx) {
  // [TEMP — remove when Phase 8 ships src/core/identity/index.js]
  return {
    init: async function() {},
    checkBoundary: function() { return null; },   // no denies until boundaries.md exists
    persona: function() { return ctx.config.MYTHOS_NAME; }
  };
}

function createNullEffectors() {
  // [TEMP — remove when Phase 7 ships src/core/effectors/hub.js]
  return {
    get: function() { return undefined; },        // no dangerWhen overrides until Phase 7
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
  let identity = null;
  let goals = null;
  let effectors = null;
  let leash = null;
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

    { name: 'identity', fail: 'degraded', fn: async function() {
      // [Phase 5 — NEW: stub; Phase 8 replaces this call site]
      identity = createIdentityStub({ config });
      await identity.init();
      logger.info('identity.ready', { stub: true });
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

    { name: 'leash', fn: function() {
      // [Phase 5 — NEW] effectors stub built here (immediately before leash,
      // which requires it) rather than inline in the cortex step — see
      // createNullEffectors above; Phase 7 replaces this call site. Boot order
      // is identity -> goals -> effectors -> leash -> cortex, deviating from
      // MYTHOS-PHASE-BUILD-SPEC.md §13's literal step-position numbers on
      // purpose (Phase 5, Ambiguity #5) because leash's constructor deps
      // (identity, goals, effectors) must all exist first. fail-fast: T>=3
      // fail-closed gating depends on the audit writer being live.
      effectors = createNullEffectors();
      leash = createLeash({ bus, config, identity, auditWriter: memory.audit, goals, effectors });
      logger.info('leash.ready', {});
    }},

    { name: 'cortex', fn: function() {
      // [Phase 5 — NEW: receives the real leash + stub effectors constructed
      // above] Per the Phase 4.5 D-39 fix, createCortex throws at construction
      // if either is missing.
      cortex = createCortex({ bus, memory, goals, brain, leash, effectors, config });
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
