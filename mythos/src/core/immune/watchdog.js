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
// BUG-273 — TWO QUESTIONS, NOT ONE. Until 2026-08-19 this asked a single question,
// "how long since a tick began", and treated a large answer as a stall. But a tick
// body holds the reentrancy guard across every await inside it, so a cortex that is
// merely THINKING — mull()'s reasoning-lane call, decide()'s planner call,
// consolidate(), act()'s dispatch (bounded at ACTION_TIMEOUT_MS = 30s) — is
// indistinguishable from one that is dead. On the operator's machine that produced
// a false stall every 300 ticks, i.e. every ~5 minutes, each one restarting the
// cortex and pausing the active goal, each one announced aloud.
//
// It had been 'fixed' before by raising STALL_MS's default from 5000 to 30000 (see
// config/schema.js) — but STALL_MS is operator config, and a .env copied before
// that change silently restores the old value, which is exactly what happened. A
// fix a config file can revert is not a fix, so the measurement is corrected here.
//
// A tick in flight  -> alive; only a wedge ceiling (TICK_WEDGED_MS) applies.
// No tick in flight -> the timer must be firing; STALL_MS applies.
//
// Both still emit the SAME kind, so the diagnostician and the stall-restart
// playbook are untouched. `mode` is the machine-readable discriminator; `reason`
// stays PROSE, because the immune explainer speaks an unplaybooked anomaly from
// reason/target and nothing else — overloading it would have traded a blank vault
// row for a spoken slug. A cortex with no
// inFlightSince (an old stub) reads as idle and gets the pre-BUG-273 behaviour.

// getCortex is a thunk, not a direct reference: the boot order builds 'immune' before
// 'cortex' exists (§13), so this module is constructed before cortex is. main.js
// closes getCortex over a `let cortex` binding that the later 'cortex' boot step
// assigns into (see Spec Ambiguities Resolved #1).

function createWatchdog({ getCortex, bus, config }) {
  if (typeof getCortex !== 'function') throw new Error('createWatchdog requires getCortex()');
  if (!bus) throw new Error('createWatchdog requires bus');

  const STALL_MS = (config && config.STALL_MS) || 5000;   // config.STALL_MS — exact key, do not paraphrase
  const CHECK_MS = (config && config.WATCHDOG_MS) || 2000; // config.WATCHDOG_MS — exact key, do not paraphrase
  // config.TICK_WEDGED_MS — exact key, do not paraphrase. See the two-question
  // note above; deliberately NOT derived from STALL_MS.
  const WEDGED_MS = (config && config.TICK_WEDGED_MS) || 120000;

  let timer = null;

  function check() {
    const cortex = getCortex();
    if (!cortex) return; // cortex not constructed yet (early in boot) — nothing to watch

    const now = Date.now();
    // A tick is running right now: the loop is alive by definition, however long
    // this one is taking. Only a body past the wedge ceiling is a real fault.
    const busySince = cortex.inFlightSince ? cortex.inFlightSince.value : 0;
    if (busySince) {
      const busyMs = now - busySince;
      if (busyMs > WEDGED_MS) {
        // 'health.anomaly' — exact string, do not paraphrase.
        bus.emit('health.anomaly', { kind: 'cortex-stall', target: 'tick-loop',
          mode: 'tick-wedged',
          reason: 'a cortex tick has been running for ' + Math.round(busyMs / 1000)
            + 's without finishing', elapsed: busyMs, lastTickAt: cortex.lastTickAt.value });
      }
      return;
    }
    // Nothing in flight: the interval timer itself should have started a tick by
    // now. This is the original fault the watchdog was built for.
    const elapsed = now - cortex.lastTickAt.value;
    if (elapsed > STALL_MS) {
      bus.emit('health.anomaly', { kind: 'cortex-stall', target: 'tick-loop',
        mode: 'no-tick',
        reason: 'no cortex tick has started for ' + Math.round(elapsed / 1000) + 's',
        elapsed: elapsed, lastTickAt: cortex.lastTickAt.value });
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
