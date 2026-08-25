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

function startLoopLagProbe({ logger, intervalMs, thresholdMs } = {}) {
  const period = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  const threshold = Number(thresholdMs) || DEFAULT_THRESHOLD_MS;
  let expected = Date.now() + period;
  let cpuMark = process.cpuUsage();
  let worstLagMs = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
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
      logger.warn('loop.stalled', { lagMs: lag, cpuMs, thresholdMs: threshold });
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

module.exports = { startLoopLagProbe, DEFAULT_INTERVAL_MS, DEFAULT_THRESHOLD_MS };
