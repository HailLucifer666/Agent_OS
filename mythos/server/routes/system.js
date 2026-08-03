'use strict';

// server/routes/system.js — GET /api/system: real host metrics from Node's own
// `os`/`fs`, for the SYSTEM and CORES widgets.
//
// WHY THIS IS NEW: src/core/sensors/metric.js is named as if it did this, but
// it polls AI-provider health and quota — nothing in the repo had ever read
// os.cpus()/totalmem()/freemem(). /api/status is provider state plus voice
// latency. So there was no host-metrics source at all before this route.
//
// WHAT IS DELIBERATELY ABSENT: temperature, power draw, and network throughput.
// design/mythos-living-core.html's System panel showed all three; Node has no
// builtin for any of them and MYTHOS ships no native addon, so they are omitted
// rather than estimated. A widget that cannot get a number says "unavailable"
// (README's honest-inert contract) — it never renders a plausible one.
//
// CPU PERCENT IS A DELTA, NOT A SNAPSHOT. os.cpus()[].times are cumulative
// microsecond counters since boot. Deriving a percentage from a single read
// gives average-since-boot, which on a long-running process is a nearly-frozen
// number that looks completely convincing and is wrong. The previous sample is
// therefore kept in module scope and each request reports the change since the
// last one.

const os = require('os');
const fs = require('fs');

// Pure: two os.cpus()-shaped arrays in, per-core busy percentages out.
// Exported for node:test — this is the part that is easy to get subtly wrong.
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
  const real = values.filter((v) => Number.isFinite(v));
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

function mountSystemRoutes(app, deps) {
  let prevCpus = os.cpus();

  app.get('/api/system', async (req, res) => {
    try {
      const nextCpus = os.cpus();
      const perCore = cpuDeltaPercent(prevCpus, nextCpus);
      prevCpus = nextCpus;

      const totalBytes = os.totalmem();
      const freeBytes = os.freemem();
      const disk = await readDisk(__dirname);

      res.json({
        cpu: {
          // null on the very first request of a process — there is no previous
          // sample to diff against yet, and inventing one would defeat the
          // whole point of sampling.
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
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountSystemRoutes, cpuDeltaPercent, average };
