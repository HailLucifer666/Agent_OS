'use strict';

// BUG-334 (2026-08-24): refreshDevices() ran spawnSync(adb, ['devices','-l'])
// with a 10s timeout inside an 8s setInterval. A hung adb (wedged USB device,
// adb-server deadlock) therefore froze the ENTIRE Node event loop for up to
// 10s per tick — voice turns stuttered, WS traffic stalled, and sustained it
// tripped the 30s cortex-stall watchdog, whose healer playbook restarts
// cortex and PAUSES THE ACTIVE GOAL. A healthy system degraded by a phone
// cable. The async runAdb() helper existed one function away, written for
// exactly this reason (its own comment says spawn-not-spawnSync).
//
// These tests pin three properties of the poll:
//   1. Starvation — timers keep firing while a device refresh is pending.
//   2. Overlap — a slow refresh must not stack with itself tick over tick.
//   3. Failure visibility — a failing adb logs once per streak instead of
//      returning silently forever (the ghost-device amplifier).
//
// Windows cannot spawn a fake slow "adb.exe" without a shell (Node refuses
// .cmd via plain spawn), so the runner is injected — same rationale as the
// existing exported-for-tests buildAdbArgs. The mutation proof for property 1
// is reverting refreshDevices to the spawnSync body: the injected runner is
// ignored, the loop blocks, and the tick counter collapses.

const test = require('node:test');
const assert = require('node:assert');

const android = require('../adapters/android-child/index.js');

function startWith(opts) {
  android.shutdownAndroidChild();
  android.startAndroidChild(Object.assign({
    adbBin: 'adb-not-needed-for-injected-tests',
    versionProbe: () => ({ status: 0, stdout: '' }), // reach the ONLINE path without a real adb
  }, opts));
}

function stopQuietly() {
  try { android.shutdownAndroidChild(); } catch (_) { /* best-effort */ }
}

function countTicksOver(ms, tickMs) {
  return new Promise((resolve) => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, tickMs);
    setTimeout(() => { clearInterval(timer); resolve(ticks); }, ms);
  });
}

const OK_EMPTY = () => Promise.resolve({ ok: true, stdout: Buffer.from('List of devices attached\r\n\r\n', 'utf8') });

test('property 1: the event loop keeps ticking while a device refresh is in flight', async () => {
  let release;
  const hungRunner = () => new Promise((resolve) => { release = () => resolve(OK_EMPTY()); });
  startWith({ pollMs: 50, devicesRunner: hungRunner });

  try {
    // Old world: spawnSync held the loop for the full timeout — a 10ms ticker
    // managed ~0-1 ticks per blocked second. New world: 300ms of pending
    // refresh must yield roughly 30 ticks. The floor is generous; the point
    // is order-of-magnitude, not precision timing.
    const ticks = await countTicksOver(300, 10);
    assert.ok(ticks >= 15, `event loop starved during device refresh: only ${ticks} ticks in 300ms`);
  } finally {
    if (release) release();
    stopQuietly();
  }
});

test('property 2: a refresh that outlives its poll interval does not stack', async () => {
  let calls = 0;
  let releaseAll = [];
  const slowRunner = () => new Promise((resolve) => {
    calls += 1;
    releaseAll.push(() => resolve(OK_EMPTY()));
  });
  startWith({ pollMs: 20, devicesRunner: slowRunner });

  try {
    await new Promise((r) => setTimeout(r, 90)); // ~4 ticks would fire
    assert.strictEqual(calls, 1, `overlapping refreshes: runner invoked ${calls} times, expected 1 until the first settles`);
  } finally {
    releaseAll.forEach((fn) => fn());
    stopQuietly();
  }
});

test('property 3: a failing adb is logged once per streak, not silently swallowed', async () => {
  const warnings = [];
  const captureLog = {
    info: function () {},
    warn: function (msg, fields) { warnings.push(msg + ' ' + JSON.stringify(fields || {})); },
    error: function () {},
  };
  try {
    let n = 0;
    startWith({
      pollMs: 5,
      log: captureLog,
      devicesRunner: () => { n += 1; return Promise.resolve({ ok: false, error: 'boom ' + n }); },
    });
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    stopQuietly();
  }
  // Many failing ticks fired; the log line must appear at most twice
  // (streak start + one periodic reminder), never once per failure.
  const boomLines = warnings.filter((w) => w.includes('devices-poll-failing'));
  assert.ok(boomLines.length >= 1, 'a persistently failing adb produced no log line at all');
  assert.ok(boomLines.length <= 2, `failure logged every tick (${boomLines.length} lines) — spam, not signal`);
});
