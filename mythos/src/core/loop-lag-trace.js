'use strict';

// Names the synchronous call that blocked the event loop.
//
// WHY THIS EXISTS, AND WHY IT IS ONLY A MEASUREMENT. The 2026-09-10 attended
// run of 0.1.12 logged 18 `loop.stalled` rows in 32 minutes, lagMs 286 to 9102,
// cpuMs mostly under 150.
//
// The reasoning that used to sit here — "cpuMs far below lagMs is a thread that
// WAITED, not one that computed" — was CORRECTED on 2026-09-11 and is kept only
// as a warning. It is wrong twice over. cpuMs is PROCESS-wide, so it counts the
// libuv threadpool and every native thread and says nothing about this thread;
// and it is accumulated over period + lag while lagMs covers only lag, so the
// two were never directly comparable in the first place. loop-lag.js now emits
// mainCpuMs and sampleWindowMs, which are the numbers that answer it — see that
// file's "HOW TO READ A ROW" block for the measurement behind this.
//
// This repo has twice mis-diagnosed voice by naming a cause it had not measured,
// and the sentence above is a third instance, caught in review rather than in
// production. So this file adds no policy, changes no threshold, and heals
// nothing — it answers one question: which synchronous call was in flight while
// the loop was blocked.
//
// DERIVED, NOT ENUMERATED. The set of calls to watch comes from the reason
// ("blocked on synchronous I/O, not computing"), so it is read off the modules
// themselves: every own function on `fs` whose name ends in `Sync`, plus
// child_process's three synchronous spawners. A hand-typed list would go stale
// the first time Node adds a Sync method, which is the failure mode this repo
// has recorded three times.
//
// COST. Off by default, behind LOOP_LAG_TRACE. When on, one Date.now() pair and
// one ring-slot write per synchronous call, and only calls at or above `minMs`
// are kept — a 250ms stall cannot be explained by a 1ms stat, and a ring full of
// 1ms stats would push the real culprit out before anyone read it. Nothing is
// allocated per call except the retained entries.
//
// NOT THE WHOLE TRUTH, DELIBERATELY, AND LOSSY IN TWO WAYS. A stall caused by a
// long CPU loop, a native addon, a blocking DNS resolution inside a library, or
// an async operation starved behind a microtask queue is invisible here and will
// show up as a row with no `lastSync`.
//
// So will a stall made ENTIRELY of synchronous I/O, and that is the correction
// of 2026-09-11. This trace retains a call only if it ran for at least
// DEFAULT_MIN_MS (20 ms), and it keeps only the newest DEFAULT_RING (32) of
// those. Thirty 10 ms stats hold the loop for 300 ms and leave the row
// completely silent; so does a storm of 33 slow calls, whose first is evicted
// before anyone reads it. The first case is pinned as test (f) in
// test/bug-436-stall-cpu-accounting.test.js.
//
// A missing `lastSync` therefore means exactly one thing: NO RETAINED
// INSTRUMENTED CALL OVERLAPPED THIS WINDOW. It does not rule the
// synchronous-I/O family out, and it does not mean nothing was happening.

const DEFAULT_RING = 32;
// A synchronous call has to be big enough to matter next to the 250ms stall
// threshold loop-lag.js uses. 20ms keeps a slow spawn or a cold stat of a
// network path and drops the thousands of warm reads a boot performs.
const DEFAULT_MIN_MS = 20;
// A path can be long and can carry the operator's account name. The tail is the
// part that identifies the call site; the head is the part that identifies the
// person, so the head is what gets dropped.
const ARG_HINT_MAX = 60;

function argHintOf(args) {
  for (const a of args) {
    if (typeof a === 'string' && a) {
      return a.length > ARG_HINT_MAX ? '...' + a.slice(-ARG_HINT_MAX) : a;
    }
    if (a && typeof a === 'object' && typeof a.toString === 'function' && a instanceof URL) {
      return String(a).slice(-ARG_HINT_MAX);
    }
  }
  return null;
}

function syncMethodNames(mod) {
  const out = [];
  for (const key of Object.keys(mod)) {
    if (!key.endsWith('Sync')) continue;
    if (typeof mod[key] !== 'function') continue;
    out.push(key);
  }
  return out;
}

function createSyncTrace({ now = Date.now, ringSize = DEFAULT_RING, minMs = DEFAULT_MIN_MS,
  fsModule = null, childProcessModule = null } = {}) {
  const ring = new Array(ringSize).fill(null);
  let writes = 0;
  const restores = [];
  let installed = false;

  function record(name, startedAt, ms, hint) {
    if (ms < minMs) return;
    ring[writes % ringSize] = { name, startedAt, ms, argHint: hint };
    writes += 1;
  }

  function wrap(mod, label, names) {
    for (const key of names) {
      const original = mod[key];
      if (typeof original !== 'function') continue;
      const wrapped = function (...args) {
        const startedAt = now();
        try {
          return original.apply(this, args);
        } finally {
          // In the finally block on purpose: a call that THREW still blocked the
          // loop for as long as it ran, and an ENOENT on a slow network path is
          // exactly the shape being hunted. Recording only successes would hide
          // the interesting half.
          record(label + '.' + key, startedAt, now() - startedAt, argHintOf(args));
        }
      };
      // Keep the descriptor writable/configurable the way Node's own are, so
      // uninstall() can always put the original back.
      mod[key] = wrapped;
      restores.push(() => { mod[key] = original; });
    }
  }

  return {
    install() {
      if (installed) return false;
      installed = true;
      const fs = fsModule || require('fs');
      const cp = childProcessModule || require('child_process');
      wrap(fs, 'fs', syncMethodNames(fs));
      wrap(cp, 'child_process', ['spawnSync', 'execSync', 'execFileSync']);
      return true;
    },
    uninstall() {
      while (restores.length) restores.pop()();
      installed = false;
    },
    isInstalled: () => installed,
    entries() { return ring.filter(Boolean); },
    // The BIGGEST overlapping call, not the most recent. When two synchronous
    // calls both touch the stall window, the one that could have caused a 9s
    // lag is the 9s one; the 20ms one beside it is noise that happens to be
    // later. Ties keep the earlier start, which is the one that began the stall.
    biggestOverlapping(windowStart, windowEnd) {
      let best = null;
      for (const e of ring) {
        if (!e) continue;
        if (e.startedAt + e.ms <= windowStart) continue;
        if (e.startedAt >= windowEnd) continue;
        if (!best || e.ms > best.ms) best = e;
      }
      return best;
    },
  };
}

module.exports = { createSyncTrace, DEFAULT_RING, DEFAULT_MIN_MS, ARG_HINT_MAX };
