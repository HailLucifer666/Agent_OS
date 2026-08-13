'use strict';

// server/routes/system.js — GET /api/system: real host metrics from Node's own
// `os`/`fs`, for the SYSTEM and CORES widgets.
//
// WHY THIS IS NEW: src/core/sensors/metric.js is named as if it did this, but
// it polls AI-provider health and quota — nothing in the repo had ever read
// os.cpus()/totalmem()/freemem(). /api/status is provider state plus voice
// latency. There was no host-metrics source at all before this route.
//
// WHAT IS DELIBERATELY ABSENT: temperature, power draw, and network
// throughput. design/mythos-living-core.html's System panel showed all three;
// Node has no builtin for any of them and MYTHOS ships no native addon, so
// they are omitted rather than estimated. A widget that cannot get a number
// says "unavailable" (README's honest-inert contract), never a plausible one.
//
// CPU PERCENT IS A DELTA, NOT A SNAPSHOT. os.cpus()[].times are cumulative
// counters since boot. Deriving a percentage from a single read gives
// average-since-boot, which on a long-running process is a nearly-frozen
// number that looks completely convincing and is wrong. The previous sample is
// kept in closure scope and each request reports the change since the last one.
//
// THAT MAKES THIS ENDPOINT STATEFUL: each request consumes the accumulated
// window. Two independent pollers would each see roughly half the other's
// window. ui/public/js/widgets/kinds/system-source.js exists to guarantee a
// single shared poller — see the comment there before adding a third consumer.

const os = require('os');
const fs = require('fs');

// Pure: two os.cpus()-shaped arrays in, per-core busy percentages out.
// Exported for node:test — easy to get subtly wrong, impossible to eyeball.
function cpuDeltaPercent(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return null;
  const out = [];
  for (let i = 0; i < next.length; i++) {
    const a = prev[i] && prev[i].times;
    const b = next[i] && next[i].times;
    if (!a || !b) return null;
    const idleDelta = b.idle - a.idle;
    const totalDelta =
      (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idleDelta;
    // No time elapsed between samples (two requests in the same tick) — report
    // null for this core rather than dividing by zero into a NaN or a 0%.
    out.push(totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : null);
  }
  return out;
}

function average(values) {
  const real = (values || []).filter((v) => Number.isFinite(v));
  if (!real.length) return null;
  return Math.round(real.reduce((sum, v) => sum + v, 0) / real.length);
}

// fs.statfs landed in Node 18.15. Older runtimes get disk:null and the widget
// says "unavailable" — feature-detected rather than version-sniffed.
function readDisk(dirPath) {
  return new Promise((resolve) => {
    if (typeof fs.statfs !== 'function') return resolve(null);
    fs.statfs(dirPath, (err, stats) => {
      if (err || !stats) return resolve(null);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) return resolve(null);
      resolve({ totalBytes, freeBytes });
    });
  });
}

// snapshotSystemMetrics(prevCpus) — the metric math that used to live inline
// in the route handler, pulled out so a second caller (the boot briefing,
// src/core/conversation/briefing.js) can read the same numbers without
// duplicating the delta/average/disk logic. `prevCpus` is the previous
// os.cpus() sample to diff against (omit for a one-off snapshot, which yields
// a null cpu.loadPercent for the same reason a process's very first request
// does — no elapsed window to diff). Returns `{ metrics, nextCpus }`: callers
// that poll repeatedly (the route) keep `nextCpus` as next call's `prevCpus`;
// one-off callers can ignore it.
async function snapshotSystemMetrics(prevCpus) {
  const nextCpus = os.cpus();
  const perCore = cpuDeltaPercent(prevCpus || nextCpus, nextCpus);

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const disk = await readDisk(__dirname);

  const metrics = {
    cpu: {
      // null on the very first request of a process — there is no previous
      // sample to diff against, and inventing one defeats the sampling.
      loadPercent: perCore ? average(perCore) : null,
      perCore: perCore || [],
      model: (nextCpus[0] && nextCpus[0].model) || null,
      count: nextCpus.length,
    },
    mem: {
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 100) : null,
    },
    disk,
    uptimeSec: Math.round(os.uptime()),
    platform: os.platform(),
    arch: os.arch(),
  };

  return { metrics, nextCpus };
}

// sampledSystemMetrics(snapshotFn, gapMs) — the two-sample CPU-delta dance
// factored out of the boot briefing (code review on 18b603a) so any ONE-OFF
// caller with no prevCpus persisted between calls (the briefing itself, and
// now system_status's live effector call) shares one implementation instead
// of duplicating it. A single snapshotSystemMetrics() call has no earlier
// sample to diff against, so cpu.loadPercent self-diffs to a permanent null;
// this takes a first sample, waits gapMs, takes a second sample diffed
// against the first, and returns the second's metrics — a genuine non-zero
// delta. `snapshotFn` defaults to this module's own snapshotSystemMetrics but
// stays a parameter so a caller with its own dependency-injection contract
// (briefing.js: "dependencies are injected, never required internally") can
// hand in its injected/faked snapshot function without this module knowing
// anything about that convention. Deliberately NOT used by the /api/system
// route below — that route keeps its own long-lived prevCpus closure across
// requests and must keep behaving exactly as it does today.
const DEFAULT_SAMPLE_GAP_MS = 150;
async function sampledSystemMetrics(snapshotFn, gapMs) {
  const snap = typeof snapshotFn === 'function' ? snapshotFn : snapshotSystemMetrics;
  const gap = typeof gapMs === 'number' ? gapMs : DEFAULT_SAMPLE_GAP_MS;
  const first = await snap();
  if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
  const second = await snap(first && first.nextCpus);
  return second && second.metrics;
}

function mountSystemRoutes(app, deps) {
  let prevCpus = os.cpus();

  app.get('/api/system', async (req, res) => {
    try {
      const { metrics, nextCpus } = await snapshotSystemMetrics(prevCpus);
      prevCpus = nextCpus;
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountSystemRoutes, cpuDeltaPercent, average, snapshotSystemMetrics, sampledSystemMetrics };
