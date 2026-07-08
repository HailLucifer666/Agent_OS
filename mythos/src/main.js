'use strict';

// MYTHOS Phase 0 — boots clean, logs ALIVE, handles SIGINT exit 0

const path = require('path');
const { createLogger } = require('./core/logger');
const { createBus } = require('./core/bus');
const { loadConfig, SCHEMA } = require('./core/config');
const { createLifecycle } = require('./core/lifecycle');
const fs = require('fs');

async function main() {
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
  const lifecycle = createLifecycle({ bus, logger });

  // Define boot steps (Phase 0 — minimal)
  lifecycle.setSteps([
    { name: 'config',     fn: function() { /* already loaded */ } },
    { name: 'logger',     fn: function() { /* already created */ } },
    { name: 'bus',        fn: function() { /* already created */ } },
    { name: 'vault-dirs', fn: function() { /* already ensured */ } },
    { name: 'idle-beat',  fn: function() {
      // Demonstrate idle heartbeat — no Brain calls
      let tickCount = 0;
      const timer = setInterval(function() {
        tickCount++;
        bus.emit('tick', { count: tickCount, idle: true });
      }, config.MYTHOS_TICK_MS);
      if (timer.unref) timer.unref();
      logger.info('idle-beat.started', { intervalMs: config.MYTHOS_TICK_MS });
    }}
  ]);

  // Register signal handlers
  lifecycle.registerShutdown();

  // Boot
  await lifecycle.boot();
  logger.info('MYTHOS ALIVE', { name: config.MYTHOS_NAME, port: config.MYTHOS_PORT, pid: process.pid });

  // Keep process alive (timer is unref'd, so we need something)
  // In Phase 0, the idle-beat interval is unref'd — we keep alive via
  // a resolved promise that never settles (event loop stays up via timers
  // in later phases). For Phase 0, we use a simple keepalive.
  return new Promise(function() { /* never resolves — process stays up */ });
}

main().catch(function(err) {
  console.error('Fatal:', err.message);
  process.exit(1);
});
