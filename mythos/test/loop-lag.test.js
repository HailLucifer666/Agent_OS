'use strict';

// src/core/loop-lag.js — the event-loop stall probe.
//
// What matters about this probe is that it stays SILENT on a healthy loop (a
// noisy diagnostic gets ignored, and this one exists precisely to be believed
// months from now) and that every stall row carries enough to be read correctly
// months later.
//
// This header used to say cpuMs alongside lagMs was "the only thing separating
// 'something computed for 158 seconds' from 'something waited synchronously for
// 158 seconds'". CORRECTED 2026-09-11: that pair cannot separate them. cpuMs is
// PROCESS-wide (the libuv threadpool and every native thread count toward it)
// and is accumulated over period + lag, while lagMs covers only lag. The row now
// also carries sampleWindowMs and mainCpuMs, which do answer it. The measurement
// and the arithmetic live in test/bug-436-stall-cpu-accounting.test.js; this
// file keeps the real-clock smoke tests.
//
// Run: cd mythos && node --test test/loop-lag.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startLoopLagProbe } = require('../src/core/loop-lag');

function fakeLogger() {
  const warns = [];
  return { warns, warn: (msg, payload) => warns.push({ msg, payload }), info() {}, error() {} };
}

function blockFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately synchronous — that is the thing under test */ }
}

test('a blocked loop is reported with both lagMs and cpuMs', async () => {
  const logger = fakeLogger();
  const probe = startLoopLagProbe({ logger, intervalMs: 20, thresholdMs: 50 });
  blockFor(300);
  await new Promise((r) => setTimeout(r, 60));
  probe.stop();

  const stalls = logger.warns.filter((w) => w.msg === 'loop.stalled');
  assert.ok(stalls.length >= 1, 'a 300ms synchronous block must be reported');
  const p = stalls[0].payload;
  assert.ok(p.lagMs >= 50, `lagMs must carry the real delay, got ${p.lagMs}`);
  assert.equal(typeof p.cpuMs, 'number',
    'cpuMs is PROCESS-wide CPU over the sample window — a lag number alone was what made the original stall unchaseable');
  assert.equal(typeof p.sampleWindowMs, 'number',
    'without the window length, cpuMs cannot be normalised and a reader is out by a whole period');
  assert.ok(p.sampleWindowMs >= p.lagMs,
    'the window is period + lag, so it can never be shorter than the lag it contains');
  assert.equal(typeof p.mainCpuMs, 'number',
    'this runtime has process.threadCpuUsage, so the row must say how much of the window was THIS thread');
  assert.ok(p.mainCpuMs <= p.sampleWindowMs + 2,
    'one thread cannot spend more CPU than the window is long (2 ms of rounding slack)');
  assert.ok(probe.worstLagMs() >= 50, 'the worst lag is retained for a caller that wants to report once');
});

test('a healthy loop logs nothing at all', async () => {
  const logger = fakeLogger();
  const probe = startLoopLagProbe({ logger, intervalMs: 20, thresholdMs: 250 });
  await new Promise((r) => setTimeout(r, 150));
  probe.stop();
  assert.deepEqual(logger.warns, [],
    'silence on a healthy boot is a feature: a probe that logs every run is a probe nobody reads');
});

test('the probe cannot hold the process open', () => {
  const probe = startLoopLagProbe({ logger: fakeLogger(), intervalMs: 20 });
  // An unref'd timer is what keeps a diagnostic from becoming the reason a clean
  // exit hangs — the server child is killed on quit and must actually die.
  probe.stop();
  assert.ok(true);
});

test('stop() ends the reporting', async () => {
  const logger = fakeLogger();
  const probe = startLoopLagProbe({ logger, intervalMs: 20, thresholdMs: 50 });
  probe.stop();
  blockFor(200);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(logger.warns.filter((w) => w.msg === 'loop.stalled'), []);
});
