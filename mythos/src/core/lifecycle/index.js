'use strict';

// Lifecycle manager: boot sequence runner + graceful shutdown
// 14-step boot with per-step fail policy (FAIL-FAST or DEGRADED)

const { createEvent } = require('../bus/event');

function createLifecycle({ bus, logger, config }) {
  let steps = [];
  let bootIndex = 0;
  let state = 'idle';  // idle | booting | alive | shutting-down | dead
  let shutdownTimer = null;
  let stopServerFn = null; // [Phase 9] registered by the 'server' boot step
  const entityName = (config && config.MYTHOS_NAME) || 'MYTHOS';

  // [Phase 9 — NEW] Server-close is shutdown step 0 (spec Ambiguity #5): stop
  // accepting new WS/HTTP connections and drain in-flight before anything else,
  // matching NOVA's own graceful order (wss.close() -> httpServer.close(cb)).
  function registerStopServer(fn) { stopServerFn = fn; }

  function setSteps(stepList) {
    steps = stepList;
    bootIndex = 0;
  }

  async function boot() {
    state = 'booting';
    logger.info('lifecycle.boot.start', { steps: steps.length });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      bootIndex = i;

      try {
        const result = step.fn();
        if (result && typeof result.then === 'function') {
          await result;
        }
        logger.info('lifecycle.boot.step', { step: step.name, status: 'ok', index: i });
        bus.emit('lifecycle.boot.step', { step: step.name, status: 'ok', index: i });
      } catch (err) {
        const failPolicy = step.fail || 'fast';
        logger.error('lifecycle.boot.step', { step: step.name, status: 'error', error: err.message, policy: failPolicy, index: i });
        bus.emit('lifecycle.boot.step', { step: step.name, status: 'error', error: err.message, policy: failPolicy });

        if (failPolicy === 'fast') {
          state = 'dead';
          logger.error('lifecycle.boot.abort', { step: step.name, reason: err.message });
          throw err;
        } else {
          logger.warn('lifecycle.boot.degraded', { step: step.name, reason: err.message });
        }
      }
    }

    state = 'alive';
    logger.info('lifecycle.alive', { name: entityName });
    bus.emit('lifecycle.alive', {});
  }

  function shutdown(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    if (state === 'shutting-down' || state === 'dead') return;

    state = 'shutting-down';
    logger.info('lifecycle.shutdown.start');

    // Hard exit timer
    shutdownTimer = setTimeout(function() {
      logger.error('lifecycle.shutdown.hard-exit');
      process.exit(1);
    }, timeoutMs);

    function cleanup() {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      state = 'dead';
      logger.info('lifecycle.shutdown.complete');
    }

    // Graceful sequence. Step 0 (Phase 9): stop the HTTP/WS server first —
    // open sockets would otherwise block a clean process.exit(0). Steps 1-5
    // (sensors stop, cortex drain, working->episodic flush, checkpoint write,
    // audit flush) are wired by the phases that own them (D-07 tracks the rest).
    return (async function() {
      if (stopServerFn) {
        try { await stopServerFn(); } catch (_) { /* best-effort — never block exit */ }
      }
      await new Promise(function(resolve) { setImmediate(resolve); });
      cleanup();
    })();
  }

  function registerShutdown() {
    const signals = ['SIGINT', 'SIGTERM'];
    for (let i = 0; i < signals.length; i++) {
      process.on(signals[i], async function() {
        logger.info('lifecycle.signal', { signal: signals[i] });
        await shutdown();
        process.exit(0);
      });
    }
  }

  function getState() { return state; }

  return { setSteps, boot, shutdown, registerShutdown, registerStopServer, getState };
}

module.exports = { createLifecycle };
