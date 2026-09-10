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
// carries the two facts that separate those guesses: how long the loop was
// blocked, and how much of it was CPU (a compute loop) versus not (a
// synchronous fs/network wait). Bracketed by the ordinary log lines either
// side, that names the phase.
//
// Cheap by construction: one unref'd interval, no allocation per tick, and it
// only ever logs when a threshold is crossed — a healthy boot adds zero lines.
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

function startLoopLagProbe({ logger, intervalMs, thresholdMs, syncTrace = traceFromEnv(logger) } = {}) {
  const period = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  const threshold = Number(thresholdMs) || DEFAULT_THRESHOLD_MS;
  let expected = Date.now() + period;
  let cpuMark = process.cpuUsage();
  let worstLagMs = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    const expectedAt = expected;
    const cpu = process.cpuUsage(cpuMark);
    cpuMark = process.cpuUsage();
    expected = now + period;
    if (lag <= threshold) return;
    if (lag > worstLagMs) worstLagMs = lag;
    // cpuMs vs lagMs is the whole diagnostic value: cpuMs ≈ lagMs means
    // something computed for that long on this thread; cpuMs ≪ lagMs means it
    // waited on a synchronous call instead.
    const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
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
      // exists because the mutation for it survived until the window was tightened.
      // A row with NO lastSync rules the synchronous-I/O family out rather than
      // saying nothing happened.
      const lastSync = syncTrace ? syncTrace.biggestOverlapping(expectedAt, now) : null;
      logger.warn('loop.stalled', Object.assign({ lagMs: lag, cpuMs, thresholdMs: threshold },
        lastSync ? { lastSync } : null));
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
