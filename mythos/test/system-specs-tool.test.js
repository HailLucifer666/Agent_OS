'use strict';

// E5 — "what are my system specs" had no answer. screen_look (from-pc.js) has
// NO targeting parameter at all — it always screenshots the primary display —
// so the earlier "wrong screen" theory was wrong: this was a missing
// capability, not a targeting bug. CPU/RAM facts already exist inside MYTHOS's
// own server (os.cpus()/totalmem()/freemem() in server/routes/system.js,
// served at GET /api/system for the dashboard's own widget) but nothing
// exposed any of it to the model — read_status (from-dashboard.js) returns
// only {status, recentJobs, persona} (openCommitments left it for commitment_list, BUG-446).
//
// This file pins the new read_system_specs tool (from-dashboard.js), a
// STATELESS read of static/instantaneous os facts — deliberately NOT the
// same code path as /api/system, which is stateful (cpuDeltaPercent consumes
// an accumulated window; a second independent consumer would corrupt the
// dashboard widget's numbers — see the comment block at the top of
// server/routes/system.js). Because a single os.cpus() read only yields
// average-since-boot (looks convincing, is wrong), this tool never reports a
// CPU utilisation percentage at all — that absence is pinned explicitly below.
//
// os.loadavg() returns [0,0,0] on Windows — not a real reading. The
// honest-inert contract (same doc) says a value that cannot be obtained
// reports as unavailable, never a plausible-looking number, so loadAverage
// must read 'unavailable' on platforms where it isn't real. The os module is
// injected via ctx.os (buildTools' existing DI convention) so this is
// deterministic and does not branch on the actual host platform.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildTools } = require('../src/core/effectors/from-dashboard');

function fakeOs(overrides) {
  return Object.assign({
    cpus: () => [
      { model: 'Fake CPU Model 3000', speed: 2400, times: { user: 100, nice: 0, sys: 50, idle: 900, irq: 0 } },
      { model: 'Fake CPU Model 3000', speed: 2400, times: { user: 110, nice: 0, sys: 40, idle: 890, irq: 0 } }
    ],
    arch: () => 'x64',
    platform: () => 'win32',
    release: () => '10.0.26200',
    totalmem: () => 17179869184, // 16 GiB
    freemem: () => 8589934592, // 8 GiB
    uptime: () => 54321,
    loadavg: () => [0, 0, 0]
  }, overrides);
}

function minimalCtx(overrides) {
  return Object.assign({
    buildRunner: { listJobs: () => [] },
    probes: null,
    goals: null,
    config: {},
    fs: null,
    os: fakeOs()
  }, overrides);
}

function findTool(ctx, name) {
  return buildTools(ctx).TOOLS.find((t) => t.name === name);
}

describe('E5: read_system_specs tool (from-dashboard.js)', () => {
  it('is registered and returns cpu model, core count and total memory', async () => {
    const tool = findTool(minimalCtx(), 'read_system_specs');
    assert.ok(tool, 'read_system_specs tool must be registered');
    assert.equal(tool.danger, false);

    const res = await tool.fn();
    assert.equal(res.ok, true);
    assert.equal(res.result.cpuModel, 'Fake CPU Model 3000');
    assert.equal(res.result.logicalCores, 2);
    assert.equal(res.result.totalMemoryBytes, 17179869184);
  });

  it('reports free memory as a byte count plus a separate human-readable GB field', async () => {
    const tool = findTool(minimalCtx(), 'read_system_specs');
    const res = await tool.fn();
    assert.equal(typeof res.result.freeMemoryBytes, 'number');
    assert.equal(res.result.freeMemoryBytes, 8589934592);
    assert.equal(typeof res.result.freeMemoryGB, 'number');
    assert.equal(res.result.freeMemoryGB, 8);
    // total memory gets the same treatment
    assert.equal(typeof res.result.totalMemoryGB, 'number');
    assert.equal(res.result.totalMemoryGB, 16);
  });

  it('never reports a CPU utilisation percentage (a single os.cpus() read is average-since-boot, not a live percent)', async () => {
    const tool = findTool(minimalCtx(), 'read_system_specs');
    const res = await tool.fn();
    const keys = Object.keys(res.result);
    assert.ok(!keys.some((k) => /cpu.*(percent|usage|util)/i.test(k)),
      'result must not include any cpu utilisation/percent/usage field, got keys: ' + keys.join(', '));
    assert.equal(res.result.cpuPercent, undefined);
    assert.equal(res.result.cpuUsage, undefined);
  });

  it('reports load average as unavailable (not zeros) on a platform where os.loadavg() is not real', async () => {
    const tool = findTool(minimalCtx({ os: fakeOs({ platform: () => 'win32', loadavg: () => [0, 0, 0] }) }), 'read_system_specs');
    const res = await tool.fn();
    assert.equal(res.result.loadAverage, 'unavailable',
      'win32 loadavg is always [0,0,0] — a fake reading, not a real one, so it must say unavailable');
  });

  it('reports a real load average array on a platform where os.loadavg() is real', async () => {
    const tool = findTool(minimalCtx({ os: fakeOs({ platform: () => 'linux', loadavg: () => [0.5, 0.4, 0.3] }) }), 'read_system_specs');
    const res = await tool.fn();
    assert.deepEqual(res.result.loadAverage, [0.5, 0.4, 0.3]);
  });

  it('also reports arch, platform, os release, and process/host uptime', async () => {
    const tool = findTool(minimalCtx(), 'read_system_specs');
    const res = await tool.fn();
    assert.equal(res.result.arch, 'x64');
    assert.equal(res.result.platform, 'win32');
    assert.equal(res.result.osRelease, '10.0.26200');
    assert.equal(res.result.hostUptimeSeconds, 54321);
    assert.equal(typeof res.result.processUptimeSeconds, 'number');
  });
});
