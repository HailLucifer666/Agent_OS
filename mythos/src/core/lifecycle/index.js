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
  let shutdownSteps = []; // [D-07] registered via registerShutdownStep(), run after stopServerFn()
  const entityName = (config && config.MYTHOS_NAME) || 'MYTHOS';

  // [Phase 9 — NEW] Server-close is shutdown step 0 (spec Ambiguity #5): stop
  // accepting new WS/HTTP connections and drain in-flight before anything else,
  // matching NOVA's own graceful order (wss.close() -> httpServer.close(cb)).
  function registerStopServer(fn) { stopServerFn = fn; }

  // [D-07 — NEW] Register a named graceful-shutdown step (e.g. stop-loops,
  // episodic-flush, checkpoint-write, audit-flush). Steps run in registration
  // order, after stopServerFn(). A throwing step never blocks the rest of the
  // sequence — it's logged/emitted as an anomaly and shutdown continues.
  function registerShutdownStep(name, fn) { shutdownSteps.push({ name: name, fn: fn }); }

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
    timeoutMs = timeoutMs || (config && config.SHUTDOWN_MS) || 10000;
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
    // open sockets would otherwise block a clean process.exit(0). Steps 1-N
    // (D-07): registered shutdown steps (sensors stop, working->episodic
    // flush, checkpoint write, audit flush) run in registration order — a
    // throwing step is logged/emitted and never blocks the rest of the
    // sequence or the final process exit.
    return (async function() {
      if (stopServerFn) {
        try { await stopServerFn(); } catch (_) { /* best-effort — never block exit */ }
      }

      for (let i = 0; i < shutdownSteps.length; i++) {
        const step = shutdownSteps[i];
        try {
          const result = step.fn();
          if (result && typeof result.then === 'function') {
            await result;
          }
          logger.info('lifecycle.shutdown.step', { step: step.name, status: 'ok' });
        } catch (err) {
          logger.error('lifecycle.shutdown.step', { step: step.name, status: 'error', error: err.message });
          bus.emit('lifecycle.shutdown.step-failed', { name: step.name, error: err.message });
        }
      }

      await new Promise(function(resolve) { setImmediate(resolve); });
      cleanup();
    })();
  }

  function registerShutdown() {
    // BUG-422: exit cannot await a stream flush. Synchronous stderr reaches the
    // parent's child log even when no event-loop work remains. No restart policy.
    for (const [event, msg] of [['beforeExit', 'lifecycle.process-before-exit'], ['exit', 'lifecycle.process-exit']]) {
      process.on(event, (code) => {
        try { require('node:fs').writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, code }) + '\n'); }
        catch { /* parent stream-error instrumentation records a broken destination */ }
      });
    }
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

  return { setSteps, boot, shutdown, registerShutdown, registerStopServer, registerShutdownStep, getState };
}

module.exports = { createLifecycle };
