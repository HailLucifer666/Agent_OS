'use strict';

// Lifecycle manager: boot sequence runner + graceful shutdown
// 14-step boot with per-step fail policy (FAIL-FAST or DEGRADED)

const { createEvent } = require('../bus/event');

// BUG-437 (2026-09-23): what the steps must leave of the shutdown budget for the
// final `complete` line and the exit, and the most the server drain may take.
// The shell sends a 6,000 ms budget (electron/child-exit.js SHUTDOWN_REQUEST_MS)
// and escalates at 7,000, so every step has to be DONE by 5,500.
const SHUTDOWN_RESERVE_MS = 500;
const DRAIN_MAX_MS = 1500;
const TIMED_OUT = Symbol('timed-out');

function createLifecycle({ bus, logger, config, proc: injectedProc, shutdownReserveMs, drainMaxMs }) {
  // BUG-437: `proc` is injectable so registerShutdown()'s handlers can be
  // driven by a test. Production passes nothing and gets the real process.
  const proc = injectedProc || process;
  const reserveMs = Number.isFinite(shutdownReserveMs) ? shutdownReserveMs : SHUTDOWN_RESERVE_MS;
  const drainCapMs = Number.isFinite(drainMaxMs) ? drainMaxMs : DRAIN_MAX_MS;
  let steps = [];
  let bootIndex = 0;
  let state = 'idle';  // idle | booting | alive | shutting-down | dead
  let shutdownTimer = null;
  let shutdownPromise = null;
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

  // BUG-437 (2026-09-23 attended run): a step that never returned (a brain call
  // in reflection-final-pass) held the sequence until the hard exit, so the steps
  // after it — the ones that SAVE — never ran. Every step is now raced against
  // ONE absolute deadline for the whole sequence and handed an AbortSignal; a
  // step that loses the race is logged `timeout` with its elapsed time, aborted,
  // and left behind. A synchronous step that blocks cannot be interrupted by any
  // JavaScript timer — none of the registered steps is one, and that is why.
  async function runBounded(name, fn, budgetMs) {
    const t0 = Date.now();
    if (!(budgetMs > 0)) {
      logger.warn('lifecycle.shutdown.step', { step: name, status: 'skipped', reason: 'no time left before the deadline', elapsedMs: 0 });
      return { step: name, status: 'skipped' };
    }
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise(function(resolve) { timer = setTimeout(function() { resolve(TIMED_OUT); }, budgetMs); });
    try {
      const r = await Promise.race([Promise.resolve().then(function() { return fn({ signal: controller.signal }); }), timeout]);
      const elapsedMs = Date.now() - t0;
      if (r === TIMED_OUT) {
        controller.abort();
        logger.error('lifecycle.shutdown.step', { step: name, status: 'timeout', budgetMs, elapsedMs });
        bus.emit('lifecycle.shutdown.step-failed', { name: name, error: 'timeout after ' + elapsedMs + 'ms' });
        return { step: name, status: 'timeout' };
      }
      logger.info('lifecycle.shutdown.step', { step: name, status: 'ok', elapsedMs });
      return { step: name, status: 'ok' };
    } catch (err) {
      logger.error('lifecycle.shutdown.step', { step: name, status: 'failed', error: err.message, elapsedMs: Date.now() - t0 });
      bus.emit('lifecycle.shutdown.step-failed', { name: name, error: err.message });
      return { step: name, status: 'failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ONE shutdown per process. A second signal (SIGTERM after the IPC request, a
  // repeated quit) gets the SAME promise: it used to get `undefined`, so its
  // handler's exit(0) ran at once — mid-save — while the first sequence was
  // still writing.
  function shutdown(timeoutMs) {
    if (shutdownPromise) return shutdownPromise;
    if (state === 'dead') return Promise.resolve({ clean: true, outcomes: [] });
    timeoutMs = timeoutMs || (config && config.SHUTDOWN_MS) || 10000;
    state = 'shutting-down';
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs - reserveMs;
    logger.info('lifecycle.shutdown.start', { timeoutMs });

    // Hard exit: the backstop for a sequence that cannot finish. `proc`, not the
    // global — a test that injects a process must not have its runner killed.
    shutdownTimer = setTimeout(function() {
      logger.error('lifecycle.shutdown.hard-exit');
      proc.exit(1);
    }, timeoutMs);

    // Graceful sequence. Step 0 (Phase 9): stop the HTTP/WS server first, bounded
    // by drainCapMs — a socket that will not close must not spend the budget the
    // saving steps need. Then the registered steps, in registration order
    // (shutdown-steps.js owns that order: saving steps only).
    shutdownPromise = (async function() {
      const outcomes = [];
      if (stopServerFn) outcomes.push(await runBounded('server-close', stopServerFn, Math.min(drainCapMs, deadline - Date.now())));
      for (let i = 0; i < shutdownSteps.length; i++) {
        outcomes.push(await runBounded(shutdownSteps[i].name, shutdownSteps[i].fn, deadline - Date.now()));
      }
      await new Promise(function(resolve) { setImmediate(resolve); });
      if (shutdownTimer) clearTimeout(shutdownTimer);
      state = 'dead';
      const notOk = outcomes.filter(function(o) { return o.status !== 'ok'; });
      // `complete` alone is not success: `clean` says whether every step finished.
      logger.info('lifecycle.shutdown.complete', { clean: notOk.length === 0, elapsedMs: Date.now() - startedAt,
        notOk: notOk.map(function(o) { return o.step + ':' + o.status; }) });
      return { clean: notOk.length === 0, outcomes: outcomes };
    })();
    return shutdownPromise;
  }

  function registerShutdown() {
    // BUG-422: exit cannot await a stream flush. Synchronous stderr reaches the
    // parent's child log even when no event-loop work remains. No restart policy.
    for (const [event, msg] of [['beforeExit', 'lifecycle.process-before-exit'], ['exit', 'lifecycle.process-exit']]) {
      proc.on(event, (code) => {
        try { require('node:fs').writeSync(2, JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, code }) + '\n'); }
        catch { /* parent stream-error instrumentation records a broken destination */ }
      });
    }
    const signals = ['SIGINT', 'SIGTERM'];
    for (let i = 0; i < signals.length; i++) {
      proc.on(signals[i], async function() {
        logger.info('lifecycle.signal', { signal: signals[i] });
        await shutdown();
        proc.exit(0);
      });
    }
    // BUG-437 (2026-09-16): the Electron shell used to child.kill() this process,
    // which on Windows is TerminateProcess — no signal is delivered, so the
    // handlers above never ran from a GUI quit and none of the registered steps
    // (stop-loops, episodic-flush, checkpoint-write, audit-flush) happened. The
    // shell now sends this message first (electron/child-exit.js) and waits;
    // same body as the signals, so both routes end in exit(0) after
    // lifecycle.shutdown.complete. Only a forked child has process.send — under
    // `npm start` there is no parent and no listener, deliberately.
    if (typeof proc.send === 'function') {
      proc.on('message', function(m) {
      if (!m || m.channel !== 'mythos:shutdown') return;
        logger.info('lifecycle.signal', { signal: 'ipc:mythos:shutdown' });
      Promise.resolve(shutdown(m.timeoutMs)).then(function() { proc.exit(0); });
      });
    }
  }

  function getState() { return state; }

  return { setSteps, boot, shutdown, registerShutdown, registerStopServer, registerShutdownStep, getState };
}

module.exports = { createLifecycle };
