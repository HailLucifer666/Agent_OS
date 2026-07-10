'use strict';

// CHAOS DRILL 2 — Cortex-stalled.
// Blocks the event loop synchronously past STALL_MS*5, then proves the real
// pipeline (P6) detects the stall via cortex.lastTickAt.value (watchdog),
// diagnoses it (diagnostician), and heals it (healer's 'stall-restart'
// playbook -> 'restart-cortex' action: stop+start, generation bumps, AND pauses
// the active goal with reason 'cortex-restart'). Watchdog itself never touches
// cortex.stop/start or goals — see P6's Anti-Drift Checklist #6.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fakeBus() {
  const { createBus } = require('../src/core/bus');
  const bus = createBus({ historySize: 200 });
  const emitted = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = function(type, payload, opts) {
    emitted.push({ type: type, payload: payload });
    return origEmit(type, payload, opts);
  };
  bus._emitted = function() { return emitted.slice(); };
  return bus;
}

function fakeMemory() {
  return {
    working: {
      tick: 0,
      activeGoalId: null,
      spendThisTick: 0,
      drainPerceptions: function() { return []; },
      resetTickState: function() { this.spendThisTick = 0; },
      pushPerception: function() {},
      addSpend: function() {}
    },
    episodic: { write: async function() { return { ref: 'ep-x', degraded: false }; } },
    consolidate: async function() {}
  };
}

// Fixed cortex construction requires mandatory leash/effectors (D-39) — minimal
// stubs satisfying the contract, since this drill's seam is cortex<->watchdog<->goals.
function stubLeash() { return { check: function() { return { allow: true, requireConfirm: false, tier: 0 }; } }; }
function stubEffectors() {
  return {
    invoke: async function() { return { ok: true }; },
    breakers: { allow: function() { return true; } }
  };
}

describe('chaos drill: cortex-stalled', () => {
  it('watchdog detects stall (detection-only), healer restarts cortex + pauses active goal with reason cortex-restart', async () => {
    const { createCortex } = require('../src/core/cortex');
    const { createWatchdog } = require('../src/core/immune/watchdog');
    const { createDiagnostician } = require('../src/core/immune/diagnostician');
    const { createHealer } = require('../src/core/immune/healer');
    const { createGoalSystem } = require('../src/core/goals');

    const bus = fakeBus();
    const memory = fakeMemory();
    const fs = { writeJSON: function() {}, ensureDir: function() {}, listFiles: function() { return []; }, removeFile: function() {} };
    const config = {
      // MYTHOS_TICK_MS is deliberately >> WATCHDOG_MS, and by a WIDE margin.
      // The busy-wait below freezes the ENTIRE event loop, so cortex's own
      // tick timer and watchdog's poll timer both become simultaneously
      // overdue the instant it unblocks — Node's timer heap fires whichever
      // has the chronologically earlier next-deadline first, and that
      // deadline's distance from "now" is effectively phase-random within
      // each timer's own period (a function of exact wall-clock jitter
      // before the block, not something the test controls directly). So the
      // collision probability that cortex's random phase happens to land
      // within watchdog's period is roughly WATCHDOG_MS/MYTHOS_TICK_MS — a
      // narrow gap (empirically tried at 5/40, ~1-in-8 odds) reproduced the
      // same failure ~25-30% of the time; a wide gap (5/300, ~1-in-60 odds)
      // is what actually makes this reliable. This doesn't eliminate the
      // race in principle — no fixed config can, since it's a genuine
      // shared-event-loop-block race — but it pushes residual flakiness to
      // a negligible level. An earlier, much narrower attempt (10/15, i.e.
      // cortex FASTER than watchdog) had the ratio backwards entirely and
      // failed the majority of the time.
      MYTHOS_TICK_MS: 300,
      STALL_MS: 600,      // exact config key: STALL_MS — comfortably > MYTHOS_TICK_MS so normal tick jitter never false-positives
      WATCHDOG_MS: 5,     // exact config key: WATCHDOG_MS
      MAX_ACTIVE_GOALS: 5,
      // P10 BUILD FIX: cortex/index.js reads config.ACTION_TIMEOUT_MS with no inline
      // fallback (schema-guaranteed key, see cortex/index.js:21-24) — this drill's
      // goal never reaches act() (no plan step, brain:null), so it's not load-bearing
      // here, but every other real test that constructs cortex sets it (house
      // convention — cortex-goals.test.js, immune.test.js) and omitting it is a latent
      // trap if this drill's fixture ever grows a plan step.
      ACTION_TIMEOUT_MS: 30000
    };

    const goals = createGoalSystem({ fs: fs, config: config, bus: bus, memory: null, brain: null });
    const activeGoal = goals.create({ title: 'Chaos target', drive: 'user-service', status: 'active' });

    const cortex = createCortex({
      bus: bus, memory: memory, goals: goals, brain: null,
      leash: stubLeash(), effectors: stubEffectors(), config: config
    });
    // Watchdog is detection-only — a getCortex thunk, no goals param — per P6's
    // real contract. It never calls cortex.stop()/start() itself.
    const watchdog = createWatchdog({ getCortex: function() { return cortex; }, bus: bus, config: config });
    const diagnostician = createDiagnostician({ bus: bus });
    const healer = createHealer({
      bus: bus, config: config, memory: memory,
      getCortex: function() { return cortex; },
      getGoals: function() { return goals; }
    });

    cortex.start();

    // Wait for cortex's FIRST real tick before starting the immune components.
    // cortex.lastTickAt.value initializes to 0 (epoch) — if watchdog starts
    // polling before cortex has ticked even once, elapsed = now - 0 is
    // trivially > STALL_MS, and watchdog fires a spurious stall/restart
    // against a cortex that was simply still booting, not actually stalled.
    // That's a real boot-order edge case (not something this drill is meant
    // to exercise), and it would burn the healer's 30s cooldown before the
    // drill's own INTENTIONAL stall ever happens. Starting the immune
    // components only once lastTickAt is real avoids conflating "cortex
    // hasn't ticked yet" with "cortex stalled after ticking normally."
    while (cortex.lastTickAt.value === 0) { await sleep(5); }

    diagnostician.start();
    healer.start();
    watchdog.start();

    await sleep(50); // brief settle right after the first real tick
    const genBefore = cortex.generation;
    assert.ok(cortex.lastTickAt.value > 0, 'cortex should have ticked at least once before the stall');

    // Synchronous busy-wait — genuinely blocks the event loop, including cortex's
    // own setInterval AND the watchdog's setInterval, comfortably past STALL_MS.
    const stallUntil = Date.now() + (config.STALL_MS + 200);
    while (Date.now() < stallUntil) { /* intentional busy-block */ }

    // Give the now-free event loop time for watchdog's detection AND the
    // diagnostician->healer pipeline it triggers to run. Fixed, generous
    // margin rather than WATCHDOG_MS-derived — the pipeline's total latency
    // doesn't scale down just because the poll interval got shorter.
    await sleep(150);

    const anomalies = bus._emitted().filter((e) => e.type === 'health.anomaly' && e.payload.kind === 'cortex-stall');
    assert.ok(anomalies.length >= 1, "watchdog must emit health.anomaly{kind:'cortex-stall'} (detection only — no restart here)");

    assert.ok(cortex.generation > genBefore, "healer's 'stall-restart' playbook must bump cortex generation via its 'restart-cortex' action, not the watchdog directly");

    const healed = bus._emitted().filter((e) => e.type === 'health.healed' && e.payload.playbookId === 'stall-restart');
    assert.ok(healed.length >= 1, "healer must report the 'stall-restart' playbook as applied");

    const refreshedGoal = goals.get(activeGoal.id);
    assert.equal(refreshedGoal.status, 'paused', 'active goal must be paused after a detected stall (via restart-cortex action, not watchdog)');
    assert.equal(refreshedGoal.reason, 'cortex-restart', "pause reason must be the exact string 'cortex-restart'");

    watchdog.stop();
    diagnostician.stop();
    healer.stop();
    cortex.stop();
  });
});
