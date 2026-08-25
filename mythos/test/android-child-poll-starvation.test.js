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
// existing exported-for-tests buildAdbArgs.
//
// Property 1 used to be proved by a wall-clock throughput floor (a 10ms
// setInterval had to fire >= 15 times in 300ms). That measured host load as
// much as it measured the code: on 2026-08-25 the same tree reported ok in a
// standalone run and not ok in the pre-commit hook's run minutes later, while
// a 1.3GB installer was being written and virus-scanned on the same machine.
// It is now proved structurally instead — see the test's own comments. The
// mutation proof is still reverting refreshDevices to a blocking body; what
// changed is that the failure is now deterministic rather than statistical.

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

// Generous enough that ordinary host load (a parallel installer build, a
// virus scan, another test file's child processes) can never reach it;
// small enough that the bug this pins -- a blocking adb probe holding the
// loop for its 10s timeout -- always does.
const MAX_TOLERATED_STALL_MS = 2000;

// The number of event-loop turns the test observes. Every one of them is
// awaited, so the COUNT is fixed by the test and cannot be eroded by load;
// all load can change is how long each individual turn takes.
const OBSERVED_LOOP_TURNS = 20;

const OK_EMPTY = () => Promise.resolve({ ok: true, stdout: Buffer.from('List of devices attached\r\n\r\n', 'utf8') });

test('property 1: the event loop keeps ticking while a device refresh is in flight', async () => {
  // The property is structural, not statistical: refreshDevices() must hand
  // control back to the event loop BEFORE the device probe settles. A
  // spawnSync body cannot do that at all -- there is no window in which the
  // probe is outstanding and the loop is still turning -- so the proof is
  // the existence of that window, plus the absence of a multi-second stall
  // inside it. Neither of those is a throughput measurement.
  let release = null;
  let probeStarts = 0;
  let probeStartedAt = 0;
  let settled = false;
  const hungRunner = () => {
    probeStarts += 1;
    probeStartedAt = Date.now();
    return new Promise((resolve) => {
      release = () => { settled = true; resolve(OK_EMPTY()); };
    });
  };
  // pollMs is deliberately longer than the observation window: the initial
  // refresh startAndroidChild() fires is the one under test, and no second
  // tick should muddy it (property 2 owns the overlap case).
  startWith({ pollMs: 5000, devicesRunner: hungRunner });

  try {
    // 1. Control came back to us with the probe still outstanding. A
    //    spawnSync poll body cannot reach this line: it either never touches
    //    the injected runner at all (probeStarts stays 0) or does not return
    //    until the probe has finished (settled is already true).
    assert.strictEqual(probeStarts, 1, `the poll started ${probeStarts} device probes through the injected runner, expected exactly 1`);
    assert.strictEqual(settled, false, 'the device probe settled before control came back — the refresh is synchronous');

    // 2. It did not merely start the probe asynchronously and then block on
    //    something else before yielding. Wall clock is used only as a
    //    ceiling here, never as a floor, so load cannot fail it.
    const handBackMs = Date.now() - probeStartedAt;
    assert.ok(handBackMs < MAX_TOLERATED_STALL_MS, `the poll held the event loop for ${handBackMs}ms after starting the device probe`);

    // 3. The loop keeps turning for as many turns as we ask for, and the
    //    probe is still outstanding at every one of them — i.e. the turns
    //    genuinely happened DURING the refresh, not after it.
    const gapsMs = [];
    let prev = Date.now();
    for (let i = 0; i < OBSERVED_LOOP_TURNS; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      const now = Date.now();
      gapsMs.push(now - prev);
      prev = now;
      assert.strictEqual(settled, false, `the device probe settled after ${i + 1} loop turns — nothing but release() should settle it`);
    }

    // 4. No single one of those turns stalled the way a blocking probe does.
    const worstGapMs = Math.max.apply(null, gapsMs);
    assert.ok(worstGapMs < MAX_TOLERATED_STALL_MS, `the event loop stalled ${worstGapMs}ms in a single turn while a device refresh was in flight`);
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
