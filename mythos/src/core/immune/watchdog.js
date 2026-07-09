'use strict';

// immune/watchdog.js — detects a stalled cortex OODA loop. DETECTION ONLY.
//
// Independent 2s unref'd timer reads cortex.lastTickAt.value directly — no bus
// round-trip for detection, so it still works if the bus itself is degraded.
//
// This module does NOT restart cortex itself (see Spec Ambiguities Resolved #2):
// bus.emit() dispatches to subscribers synchronously, so if this file also called
// cortex.stop()/cortex.start(), every stall would restart cortex twice (once via the
// health.anomaly -> health.diagnosed -> healer 'stall-restart' pipeline, once again
// right here). The actual restart lives in healer.js's 'restart-cortex' action.
//
// getCortex is a thunk, not a direct reference: the boot order builds 'immune' before
// 'cortex' exists (§13), so this module is constructed before cortex is. main.js
// closes getCortex over a `let cortex` binding that the later 'cortex' boot step
// assigns into (see Spec Ambiguities Resolved #1).

function createWatchdog({ getCortex, bus, config }) {
  if (typeof getCortex !== 'function') throw new Error('createWatchdog requires getCortex()');
  if (!bus) throw new Error('createWatchdog requires bus');

  const STALL_MS = (config && config.STALL_MS) || 5000;   // config.STALL_MS — exact key, do not paraphrase
  const CHECK_MS = (config && config.WATCHDOG_MS) || 2000; // config.WATCHDOG_MS — exact key, do not paraphrase

  let timer = null;

  function check() {
    const cortex = getCortex();
    if (!cortex) return; // cortex not constructed yet (early in boot) — nothing to watch

    const elapsed = Date.now() - cortex.lastTickAt.value;
    if (elapsed > STALL_MS) {
      // 'health.anomaly' — exact string, do not paraphrase.
      bus.emit('health.anomaly', { kind: 'cortex-stall', elapsed: elapsed, lastTickAt: cortex.lastTickAt.value });
    }
  }

  function start() {
    timer = setInterval(check, CHECK_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start: start, stop: stop, _internal: { check: check } };
}

module.exports = { createWatchdog: createWatchdog };
