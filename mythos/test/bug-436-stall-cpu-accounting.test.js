'use strict';

// BUG-436 — what a `loop.stalled` row's CPU number actually measures.
//
// WHY THIS FILE EXISTS, SEPARATELY FROM ITS SIBLING.
// `bug-436-a-stall-names-what-blocked-it.test.js` is about the TRACE: which
// synchronous call was in flight. This file is about the SAMPLER: how long the
// window was, and how much of it the MAIN THREAD spent computing. Different
// mechanism, different mutations, so a different file.
//
// THE DEFECT THIS PINS, MEASURED 2026-09-11 ON THIS MACHINE (node v26.1.0, 8 cpus).
// `process.cpuUsage()` is PROCESS-wide. It counts every thread — the libuv
// threadpool, onnxruntime's session threads, anything a native addon spawns —
// so it can exceed the wall-clock window it was measured over, and it says
// nothing about whether the event-loop thread was busy. Two runs, same total
// work, opposite causes:
//
//   4x async crypto.pbkdf2 (threadpool; main thread IDLE)
//       wall 496 ms · process CPU 1922 ms (3.88x wall) · MAIN-THREAD CPU 16 ms
//   1x crypto.pbkdf2Sync   (main thread BUSY)
//       wall 331 ms · process CPU  328 ms (0.99x wall) · MAIN-THREAD CPU 328 ms
//
// `cpuMs` alone cannot tell those two apart. `mainCpuMs` separates them at a
// glance, and the pair (cpuMs, sampleWindowMs) makes the arithmetic checkable:
// ONE thread cannot burn more CPU than the window is long, so cpuMs exceeding
// sampleWindowMs is PROOF that the CPU was not the event-loop thread.
//
// That arithmetic is not hypothetical here. BUGS.md's own three worst rows are
// (lagMs/cpuMs) 31,777/77,797 · 29,402/59,610 · 26,393/63,859, and production
// runs at DEFAULT_INTERVAL_MS (src/main.js passes no intervalMs), so no window
// can exceed 1000 + lagMs: 32,777 · 30,402 · 27,393. Every one of the three
// reported MORE CPU than a single thread could spend. The ticket's
// "Compute-bound, not blocked in a syscall" was an inference the instrument
// could not support.
//
// WHAT IS DELIBERATELY NOT TESTED, BECAUSE IT MUST NOT BE DONE.
// There is no assertion anywhere here that classifies the blocking operation
// from a cpuMs/lagMs ratio. The row reports; the reader judges. Naming a cause
// from a ratio is the same mistake in a new suit.
//
// Run: cd mythos && node --test test/bug-436-stall-cpu-accounting.test.js
//
// MUTATION PROOF — MEASURED 2026-09-11, not predicted.
// Every case below was applied to the real source, CONFIRMED present on disk,
// `node --check`ed (a mutation that only breaks the parse proves nothing), run
// under --test-reporter=tap, then restored and re-hashed. All seven restored
// sha256-identical: loop-lag.js 355f78b3455b63b0…, loop-lag-trace.js 64cfe6dd2f3b712f….
// All nine tests here were GREEN before each mutation and the fail counts are
// the actual figures from the run:
//
//   M1 re-anchor the cpu mark with a SECOND cpuUsage() read   -> fail 1  → (a)
//        (this is the ORIGINAL defect, restored on purpose)
//   M2 sampleWindowMs = period instead of measured elapsed    -> fail 4  → (a)(b)(c)(h)
//   M3 drop sampleWindowMs from the row entirely              -> fail 8  → (a)(b)(c)(d)(g)(h)
//        + the sibling file's (h) and loop-lag.test.js's first test
//   M4 emit mainCpuMs as 0 when threadCpuUsage is null        -> fail 2  → (d)(g)
//   M5 log the availability notice every stall, not once      -> fail 1  → (e)
//   M6 measure the window on Date.now() instead of monotonic  -> fail 1  → (c)
//   M7 DEFAULT_MIN_MS = 0 in loop-lag-trace.js                -> fail 1  → (f)
//
// THE ADJACENT CASES THAT MUST KEEP PASSING, so the bounds of these guards are
// written down rather than left to be rediscovered: test (g) — with
// threadCpuUsage present the row still carries every key the old row carried,
// this change ADDS and does not reshape; and test (i) — the only production
// consumer (build-refine.js:347) reads msg and lagMs, and was green both before
// and after the whole change.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startLoopLagProbe } = require('../src/core/loop-lag');
const { createSyncTrace, DEFAULT_MIN_MS } = require('../src/core/loop-lag-trace');

const PERIOD = 1000;
const THRESHOLD = 250;

// A clock the test moves by hand. A FROZEN clock would make every window 0 ms
// and hide the entire mechanism — this repo has that mistake on record.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, at: () => t };
}

// A CPU source that behaves like the real syscall in the one way that matters:
// TIME PASSES BETWEEN CALLS. Every call costs 1 ms of accounted CPU. That is
// what makes the "read it twice per tick" defect visible — the CPU spent
// between the two reads belongs to no sample and silently vanishes.
function cpuSource(c, { perMsOfClock = 1, perCall = 1 } = {}) {
  const base = c.at();
  let calls = 0;
  const fn = () => {
    calls += 1;
    // microseconds, like the real process.cpuUsage()
    return { user: ((c.at() - base) * perMsOfClock + calls * perCall) * 1000, system: 0 };
  };
  fn.calls = () => calls;
  fn.absoluteMs = () => ((c.at() - base) * perMsOfClock + calls * perCall);
  return fn;
}

// A probe driven by a fake timer, so a stall is produced deterministically
// rather than by making the test slow. Date.now is swapped for the fake clock
// because the probe still reports wall-clock lag against wall-clock deadlines;
// monotonicMs is injected separately, which is the whole point of test (c).
function probeRig(c, opts = {}) {
  const rows = [];
  const infos = [];
  const logger = {
    info: (msg, fields) => infos.push({ msg, fields }),
    warn: (msg, fields) => rows.push({ msg, fields }),
    error() {},
  };
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const originalNow = Date.now;
  let tick = null;
  global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  global.clearInterval = () => {};
  Date.now = c.now;
  const restore = () => {
    Date.now = originalNow;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  };
  try {
    const probe = startLoopLagProbe(Object.assign({
      logger,
      intervalMs: PERIOD,
      thresholdMs: THRESHOLD,
      syncTrace: null,
      monotonicMs: c.now,
    }, opts));
    return {
      rows,
      infos,
      stalls: () => rows.filter((r) => r.msg === 'loop.stalled'),
      fire: () => tick(),
      stop: () => { probe.stop(); restore(); },
    };
  } catch (err) {
    restore();
    throw err;
  }
}

describe('BUG-436 — a loop.stalled row says how long its window was, and how much of it was the main thread', () => {
  test('(a) consecutive samples tile the timeline — no CPU falls between two reads', () => {
    const c = clock();
    const cpu = cpuSource(c);
    const rig = probeRig(c, { cpuUsage: cpu, threadCpuUsage: null });
    try {
      const startedAtCpu = cpu.absoluteMs();
      // Three stalling ticks in a row. Every one is over threshold, so every one
      // emits, and the three windows must add up to the whole elapsed stretch
      // with nothing missing in the seams between them.
      c.advance(1400); rig.fire();
      c.advance(1300); rig.fire();
      c.advance(1600); rig.fire();
      const stalls = rig.stalls();
      assert.equal(stalls.length, 3, 'all three ticks are over threshold');

      const windowSum = stalls.reduce((a, r) => a + r.fields.sampleWindowMs, 0);
      assert.equal(windowSum, 4300,
        'the three windows must tile the 4300 ms that actually elapsed, with no gap between samples');

      const cpuSum = stalls.reduce((a, r) => a + r.fields.cpuMs, 0);
      const cpuActual = cpu.absoluteMs() - startedAtCpu;
      assert.equal(cpuSum, cpuActual,
        'every microsecond of CPU must belong to exactly one sample; a second cpuUsage() read per '
        + 'tick drops the CPU spent between the two reads, which is how the original probe lost it');
    } finally { rig.stop(); }
  });

  test('(b) cpuMs covers the WHOLE window, including the period before the tick was due', () => {
    const c = clock();
    // 1 ms of CPU per 1 ms of clock: the main thread is pegged for the entire
    // window, not only for the overdue part.
    const cpu = cpuSource(c, { perMsOfClock: 1, perCall: 0 });
    const rig = probeRig(c, { cpuUsage: cpu, threadCpuUsage: cpu });
    try {
      c.advance(1400);
      rig.fire();
      const row = rig.stalls()[0];
      assert.ok(row, 'a 400 ms overshoot is over the 250 ms threshold');
      assert.equal(row.fields.lagMs, 400, 'lagMs is the overshoot only');
      assert.equal(row.fields.sampleWindowMs, 1400,
        'sampleWindowMs is period + lag — the window cpuMs was actually accumulated over');
      assert.equal(row.fields.cpuMs, 1400,
        'cpuMs covers the whole 1400 ms window, NOT the 400 ms of lag; without sampleWindowMs beside '
        + 'it a reader comparing cpuMs to lagMs is out by a whole period');
      assert.ok(row.fields.sampleWindowMs > row.fields.lagMs,
        'the window is always longer than the lag, which is exactly why the two must not be compared directly');
    } finally { rig.stop(); }
  });

  test('(c) the window is measured on a MONOTONIC clock, not the wall clock', () => {
    const c = clock();          // wall clock, drives Date.now and the lag arithmetic
    const m = clock(500_000);   // monotonic clock, independent
    const rig = probeRig(c, { cpuUsage: cpuSource(c), threadCpuUsage: null, monotonicMs: m.now });
    try {
      // The wall clock jumps 1400 ms; the monotonic clock advances only 900 ms —
      // a clock adjustment (NTP step, DST, a VM resuming) in the middle of the
      // window. lagMs is wall-clock by definition; the WINDOW must not be.
      c.advance(1400);
      m.advance(900);
      rig.fire();
      const row = rig.stalls()[0];
      assert.ok(row, 'the stall is still reported — a clock step must not suppress it');
      assert.equal(row.fields.lagMs, 400, 'lagMs stays wall-clock: it is a deadline overshoot');
      assert.equal(row.fields.sampleWindowMs, 900,
        'sampleWindowMs must come from the monotonic source; taking it from Date.now would import '
        + 'every clock adjustment into the one number cpuMs is normalised against');
    } finally { rig.stop(); }
  });

  test('(d) where threadCpuUsage is unavailable, mainCpuMs is OMITTED and sampleWindowMs is kept', () => {
    const c = clock();
    const rig = probeRig(c, { cpuUsage: cpuSource(c), threadCpuUsage: null });
    try {
      c.advance(1400);
      rig.fire();
      const row = rig.stalls()[0];
      assert.ok(row);
      assert.deepStrictEqual(Object.keys(row.fields).sort(),
        ['cpuMs', 'lagMs', 'sampleWindowMs', 'thresholdMs'],
        'an older runtime loses mainCpuMs and NOTHING else — a row that silently reported 0 would be '
        + 'read as "the main thread was idle", which is the opposite of "we could not measure it"');
      assert.equal(row.fields.mainCpuMs, undefined, 'absent, not zero, not null');
      assert.equal(typeof row.fields.sampleWindowMs, 'number',
        'sampleWindowMs does not depend on threadCpuUsage and must survive its absence');
    } finally { rig.stop(); }
  });

  test('(e) the availability notice is logged ONCE per probe instance, not once per stall', () => {
    const c = clock();
    const rig = probeRig(c, { cpuUsage: cpuSource(c), threadCpuUsage: null });
    try {
      c.advance(1400); rig.fire();
      c.advance(1400); rig.fire();
      c.advance(1400); rig.fire();
      assert.equal(rig.stalls().length, 3, 'three stalls were reported');
      const notices = rig.infos.filter((i) => i.msg === 'loop.lag-main-cpu-unavailable');
      assert.equal(notices.length, 1,
        'three stalls, ONE notice: a diagnostic that repeats itself every tick is a diagnostic '
        + 'nobody reads, and this file already pays for silence on a healthy boot');
      assert.ok(notices[0].fields && typeof notices[0].fields.note === 'string',
        'the notice says what is missing and what it means, for a reader who finds it months later');
    } finally { rig.stop(); }
  });

  test('(f) 30 sub-floor synchronous calls stall the loop and produce NO lastSync', () => {
    const c = clock();
    // Thirty real synchronous calls, each below loop-lag-trace's 20 ms retention
    // floor, together holding the loop for 300 ms. This is the case the trace
    // CANNOT see, and it is why a missing lastSync must never be read as
    // "no synchronous call happened".
    const perCall = 10;
    assert.ok(perCall < DEFAULT_MIN_MS,
      'the premise of this test is that each call is below the retention floor');
    const fsLike = { statSync: (p) => { c.advance(perCall); return { path: p }; } };
    const trace = createSyncTrace({ now: c.now, fsModule: fsLike, childProcessModule: {} });
    trace.install();
    const rig = probeRig(c, { cpuUsage: cpuSource(c), threadCpuUsage: null, syncTrace: trace });
    try {
      for (let i = 0; i < 30; i += 1) fsLike.statSync('/some/path/' + i);
      // 300 ms of that is the synchronous calls themselves; the rest is the loop
      // being late for other reasons. Total 1400 ms, i.e. 400 ms past the 1000 ms
      // deadline, comfortably over the 250 ms threshold.
      c.advance(1400 - (30 * perCall));
      rig.fire();
      const row = rig.stalls()[0];
      assert.ok(row, 'the loop was held for 300 ms of real synchronous I/O plus idle — a stall is reported');
      assert.equal(row.fields.lastSync, undefined,
        'thirty genuine synchronous calls, and the row names none of them: each is under the 20 ms '
        + 'retention floor. A missing lastSync means "no RETAINED INSTRUMENTED call overlapped this '
        + 'window", never "nothing was happening" and never "not synchronous I/O"');
      assert.equal(trace.entries().length, 0, 'nothing was retained, which is the mechanism being pinned');
    } finally { rig.stop(); trace.uninstall(); }
  });

  test('(g) ADJACENT CASE — with threadCpuUsage present the row keeps every key it had before', () => {
    const c = clock();
    const cpu = cpuSource(c);
    const rig = probeRig(c, { cpuUsage: cpu, threadCpuUsage: cpu });
    try {
      c.advance(1400);
      rig.fire();
      const row = rig.stalls()[0];
      assert.ok(row);
      assert.deepStrictEqual(Object.keys(row.fields).sort(),
        ['cpuMs', 'lagMs', 'mainCpuMs', 'sampleWindowMs', 'thresholdMs'],
        'the three original keys are still there — this change ADDS, it does not reshape');
      assert.equal(row.fields.thresholdMs, THRESHOLD);
      assert.equal(row.fields.lagMs, 400);
      assert.equal(typeof row.fields.mainCpuMs, 'number');
      assert.equal(rig.infos.filter((i) => i.msg === 'loop.lag-main-cpu-unavailable').length, 0,
        'no availability notice when the API is available');
    } finally { rig.stop(); }
  });

  test('(h) cpuMs above sampleWindowMs is arithmetic proof the CPU was NOT the event-loop thread', () => {
    const c = clock();
    // Four threads' worth of CPU against one window: 4 ms of process CPU per 1 ms
    // of clock, with the main thread doing nothing. This is the shape measured
    // live on this machine (1922 ms process CPU over a 496 ms wall window, main
    // thread 16 ms) and the shape of BUG-436's three worst production rows.
    const processCpu = cpuSource(c, { perMsOfClock: 4, perCall: 0 });
    const idleThread = cpuSource(c, { perMsOfClock: 0, perCall: 0 });
    const rig = probeRig(c, { cpuUsage: processCpu, threadCpuUsage: idleThread });
    try {
      c.advance(1400);
      rig.fire();
      const row = rig.stalls()[0];
      assert.ok(row);
      assert.equal(row.fields.sampleWindowMs, 1400);
      assert.equal(row.fields.cpuMs, 5600, 'process CPU counts every thread, so it can exceed the window');
      assert.equal(row.fields.mainCpuMs, 0, 'the event-loop thread did nothing at all');
      assert.ok(row.fields.cpuMs > row.fields.sampleWindowMs,
        'ONE thread cannot spend more CPU than the window is long, so this inequality alone rules the '
        + 'event-loop thread out as the consumer — the check BUG-436 needed and did not have');
    } finally { rig.stop(); }
  });

  test('(i) the only production consumer reads two fields, and both still work', () => {
    // build-refine.js:347 does exactly this and nothing else:
    //   if (entry.msg === 'loop.stalled') max = Math.max(max, Number(entry.lagMs) || 0)
    // Adding keys to the row cannot perturb it. Pinned here rather than trusted,
    // because "adding a field is safe" is the kind of claim that is true until a
    // consumer somewhere iterates the object.
    const c = clock();
    const cpu = cpuSource(c);
    const rig = probeRig(c, { cpuUsage: cpu, threadCpuUsage: cpu });
    try {
      c.advance(1400); rig.fire();
      c.advance(2200); rig.fire();
      let maxLoopStallMs = 0;
      for (const r of rig.rows) {
        const entry = Object.assign({ msg: r.msg }, r.fields);
        if (entry.msg === 'loop.stalled') maxLoopStallMs = Math.max(maxLoopStallMs, Number(entry.lagMs) || 0);
      }
      assert.equal(maxLoopStallMs, 1200, 'the consumer still reads the worst lag, unchanged by the new keys');
    } finally { rig.stop(); }
  });
});
