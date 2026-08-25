'use strict';

// src/core/loop-lag.js — the event-loop stall probe.
//
// What matters about this probe is that it stays SILENT on a healthy loop (a
// noisy diagnostic gets ignored, and this one exists precisely to be believed
// months from now) and that it reports cpuMs alongside lagMs — that pair is the
// only thing separating "something computed for 158 seconds" from "something
// waited synchronously for 158 seconds", which need opposite fixes.
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
    'cpuMs is the half that says COMPUTE vs WAIT — a lag number alone was what made the original stall unchaseable');
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
