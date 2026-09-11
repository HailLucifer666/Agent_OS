'use strict';

// Event-loop stall probe.
//
// Why this exists: on 2026-08-11 a PACKAGED install reported server.ready in
// 850ms and then answered nothing — curl timed out, Playwright timed out on
// domcontentloaded — while the process accumulated ~158s of CPU, and served a
// request in 2.6ms the moment it finished. The observation was solid; the cause
// was not identifiable afterwards, because the only record of that window is a
// log whose lines are all 5s-cadence heartbeats. Nothing in it says "the loop
// was busy here", so the culprit (adblock engine build? model load? a
// synchronous vault scan?) stayed a list of guesses.
//
// This is deliberately a MEASUREMENT, not a fix. A stall this probe reports
// carries the facts that separate those guesses: how long the loop was blocked,
// how long the window it was measured over actually was, how much CPU the whole
// PROCESS spent in it, and how much of that was THIS thread. Bracketed by the
// ordinary log lines either side, that names the phase.
//
// Cheap by construction: one unref'd interval, no allocation per tick, and it
// only ever logs when a threshold is crossed — a healthy boot adds zero lines.
//
// ---------------------------------------------------------------------------
// HOW TO READ A ROW. Corrected 2026-09-11 (BUG-436), because the previous
// version of this comment was wrong twice and a wrong reading was already
// written into the ticket as a conclusion.
//
//   lagMs           how late this tick was: (now - expectedAt).
//   sampleWindowMs  how long the window was, measured on a MONOTONIC clock.
//                   It is period + lag, NOT lag. cpuMs is accumulated over ALL
//                   of it, including the period before the tick came due.
//   cpuMs           CPU for the WHOLE PROCESS over sampleWindowMs — every
//                   thread: the libuv threadpool, onnxruntime session threads,
//                   anything a native addon spawns.
//   mainCpuMs       CPU for THIS thread — the event-loop thread — over the same
//                   window. Absent when the runtime has no process.threadCpuUsage.
//   lastSync        the biggest RETAINED INSTRUMENTED synchronous call
//                   overlapping the window; see loop-lag-trace.js.
//
// TWO MISTAKES THIS SHAPE EXISTS TO PREVENT.
//
// (1) "cpuMs ≈ lagMs means something computed for that long." Wrong by a whole
//     period: cpuMs covers period + lag while lagMs covers only lag. At the
//     production cadence that is a 1000 ms offset on every row, and until
//     2026-09-11 no field on the row let a reader correct for it.
//
// (2) "cpuMs far below lagMs means the thread WAITED; cpuMs above it means it
//     COMPUTED." Wrong, because process CPU is not thread CPU. Measured on this
//     machine (node v26.1.0, 8 cpus) — same total work, opposite causes:
//         4x async crypto.pbkdf2 (threadpool, main thread IDLE)
//             wall 496 ms · process CPU 1922 ms (3.88x wall) · this thread 16 ms
//         1x crypto.pbkdf2Sync   (main thread BUSY)
//             wall 331 ms · process CPU  328 ms (0.99x wall) · this thread 328 ms
//     `cpuMs` is identical in kind for both and cannot separate them. mainCpuMs
//     can, and one inequality settles it without any judgement call:
//
//         cpuMs > sampleWindowMs  =>  the CPU was NOT this thread.
//
//     One thread cannot spend more CPU than the window is long. BUG-436's three
//     worst production rows are exactly this shape — (lagMs/cpuMs) 31,777/77,797,
//     29,402/59,610 and 26,393/63,859, against windows that cannot exceed 32,777,
//     30,402 and 27,393 ms — so the ticket's "Compute-bound, not blocked in a
//     syscall" was an inference the instrument could not support.
//
//     THE BOUND ON THAT INEQUALITY, measured 2026-09-11 rather than assumed.
//     process.threadCpuUsage() accounts in SCHEDULER QUANTA on Windows, not
//     continuously: over 400 one-millisecond spins the only non-zero deltas it
//     returned were 15 ms and 16 ms. A 5 ms spin reports 0 ms; a 40 ms spin
//     reports 47 ms, i.e. 6.97 ms MORE than the wall time it took. So both
//     mainCpuMs and cpuMs carry up to about one quantum of error in either
//     direction.
//
//     At the production cadence this changes nothing: a 16 ms quantum against a
//     1000 ms+ window is under 2% noise, and the three rows above exceed their
//     windows by 137%, 96% and 133%. But do NOT apply the inequality to a SHORT
//     window — at the 20 ms cadence the tests use, a single quantum is most of
//     the window, and a tiny mainCpuMs there is not evidence of an idle thread
//     either. Judge these numbers over seconds, not milliseconds.
//
// DO NOT CLASSIFY THE BLOCKING OPERATION FROM A RATIO. The row reports; the
// reader judges. Naming a cause from a number that was never measured is how
// this repo mis-diagnosed voice twice, and a ratio is a number that was never
// measured wearing a disguise.
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 1000;
// 250ms is well past ordinary GC/IO jitter but far below anything a human would
// call a hang, so a real stall is caught while it is still small.
const DEFAULT_THRESHOLD_MS = 250;

// BUG-436: the trace is armed HERE, not in main.js, and reads the environment
// rather than the config schema. Both of those are the file-size ratchet talking:
// src/main.js and config/schema.js are each at their recorded ceiling, and the
// ratchet exists to push new code out of oversized files instead of letting a
// number be raised. Reading process.env directly follows the GOOGLE_API_KEY
// precedent in server/index.js (a value the schema deliberately does not own),
// and it suits a diagnostic that is read exactly once at boot: the config object
// is frozen there anyway, so a schema key would still have needed a restart.
// Documented in .env.example next to the other switches.
function traceFromEnv(logger) {
  if (String(process.env.LOOP_LAG_TRACE || '').toLowerCase() !== 'true') return null;
  const trace = require('./loop-lag-trace').createSyncTrace();
  trace.install();
  if (logger && typeof logger.info === 'function') {
    logger.info('loop.lag-trace-armed', { note: 'synchronous fs and child_process calls are timed from here on' });
  }
  return trace;
}

// A monotonic millisecond source. Date.now() is the wrong clock for a WINDOW:
// an NTP step, a DST change or a VM resuming moves it, and that adjustment would
// land in the one number cpuMs is normalised against. lagMs stays on Date.now()
// because a deadline overshoot IS a wall-clock quantity — the two clocks measure
// two different things and both are needed.
function defaultMonotonicMs() {
  const [s, ns] = process.hrtime();
  return (s * 1000) + (ns / 1e6);
}

// process.threadCpuUsage() landed in Node 23. Resolved once, here, so a caller
// can pass `threadCpuUsage: null` explicitly to exercise the unsupported path —
// a default parameter only fires on `undefined`, so an explicit null survives.
function defaultThreadCpuUsage() {
  return typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : null;
}

function startLoopLagProbe({
  logger,
  intervalMs,
  thresholdMs,
  syncTrace = traceFromEnv(logger),
  // Injected rather than called directly so a test can drive them from a fake
  // clock. All three return ABSOLUTE values and this file does its own
  // subtraction — see the single-read note below.
  cpuUsage = () => process.cpuUsage(),
  threadCpuUsage = defaultThreadCpuUsage(),
  monotonicMs = defaultMonotonicMs,
} = {}) {
  const period = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  const threshold = Number(thresholdMs) || DEFAULT_THRESHOLD_MS;
  let expected = Date.now() + period;
  // ONE read per source per tick, and the value read becomes the next mark.
  // The previous version called process.cpuUsage() TWICE — once to diff against
  // the mark, once to re-anchor it — so the CPU burned between those two
  // syscalls belonged to no sample at all and consecutive samples did not tile
  // the timeline. Reading absolutes and subtracting here fixes it and costs one
  // syscall fewer.
  let cpuMark = cpuUsage();
  let threadMark = threadCpuUsage ? threadCpuUsage() : null;
  let windowMark = monotonicMs();
  let worstLagMs = 0;
  // The availability notice is emitted at most once for the life of this probe,
  // and only on a tick that would otherwise have carried mainCpuMs. A notice
  // fired at construction would break this file's own rule that a healthy boot
  // adds zero lines; one fired every tick would bury the rows it annotates.
  let announcedMainCpuUnavailable = false;

  const timer = setInterval(() => {
    const now = Date.now();
    const monoNow = monotonicMs();
    const lag = now - expected;
    const expectedAt = expected;

    const cpuNow = cpuUsage();
    const cpuMs = Math.round(((cpuNow.user - cpuMark.user) + (cpuNow.system - cpuMark.system)) / 1000);
    cpuMark = cpuNow;

    let mainCpuMs = null;
    if (threadCpuUsage) {
      const threadNow = threadCpuUsage();
      mainCpuMs = Math.round(((threadNow.user - threadMark.user) + (threadNow.system - threadMark.system)) / 1000);
      threadMark = threadNow;
    }

    const sampleWindowMs = Math.round(monoNow - windowMark);
    windowMark = monoNow;

    expected = now + period;
    if (lag <= threshold) return;
    if (lag > worstLagMs) worstLagMs = lag;

    // Log only, no bus event. An unplaybooked health.anomaly is SPOKEN ALOUD at
    // the operator, and a stall is a diagnostic for whoever reads the log later,
    // not something to interrupt a conversation with — the same mistake that had
    // MYTHOS narrating raw event names mid-sentence on 2026-08-10.
    if (logger && typeof logger.warn === 'function') {
      // BUG-436: with LOOP_LAG_TRACE on, name the synchronous call that was in
      // flight during the stall window. The window is [expectedAt, now] and not a
      // moment wider: the tick was DUE at expectedAt and did not run until now, so
      // only a call overlapping that interval can have held the loop. A first cut
      // used [expectedAt - period, now], which reaches back over a period the loop
      // was demonstrably free and would name an innocent earlier call — test (c)
      // of the sibling file exists because the mutation for it survived until the
      // window was tightened.
      //
      // A row with NO lastSync does NOT rule the synchronous-I/O family out. The
      // trace is lossy in two ways by design: it drops any call under its 20 ms
      // floor, and its 32-slot ring evicts. Thirty 10 ms stats hold the loop for
      // 300 ms and leave the row completely silent — pinned as test (f) in
      // test/bug-436-stall-cpu-accounting.test.js. Read a missing lastSync as
      // "no RETAINED INSTRUMENTED call overlapped this window", nothing more.
      const lastSync = syncTrace ? syncTrace.biggestOverlapping(expectedAt, now) : null;
      const row = { lagMs: lag, cpuMs, sampleWindowMs, thresholdMs: threshold };
      // Absent, never 0. A zero here would read as "the event-loop thread was
      // idle", which is the opposite of "this runtime could not tell us".
      if (mainCpuMs !== null) row.mainCpuMs = mainCpuMs;
      else if (!announcedMainCpuUnavailable && logger && typeof logger.info === 'function') {
        announcedMainCpuUnavailable = true;
        logger.info('loop.lag-main-cpu-unavailable', {
          note: 'process.threadCpuUsage() is unavailable on this runtime, so loop.stalled rows carry no '
            + 'mainCpuMs. cpuMs is process-wide and includes every thread, so it cannot on its own say '
            + 'whether the event-loop thread was computing.',
        });
      }
      logger.warn('loop.stalled', lastSync ? Object.assign(row, { lastSync }) : row);
    }
  }, period);
  // Never hold the process open, and never make a stall probe the reason a
  // clean exit hangs.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() { clearInterval(timer); },
    worstLagMs: () => worstLagMs,
  };
}

module.exports = { startLoopLagProbe, traceFromEnv, DEFAULT_INTERVAL_MS, DEFAULT_THRESHOLD_MS };
