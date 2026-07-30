'use strict';

// test/android-child-adapter.test.js — Task 8 (Wave 2, ADB phone bridge).
// Mirrors test/cua-driver-adapter.test.js's graceful-degradation coverage:
// side-effect-free require, sendCommand() never throwing while offline, a
// bounded settle to a terminal state, and a safe no-op shutdown. Unlike
// cua-driver/pc-child, android-child's startAndroidChild() is synchronous
// (a single spawnSync 'adb version' probe) so there is no async STARTING
// window to poll through — but the bounded-poll assertion is kept anyway so
// this test still passes if that ever changes.
//
// No live `adb` in CI (or on this development machine, confirmed absent from
// PATH) — the settle-to-OFFLINE-with-install-hint branch is what actually
// exercises on every run here; the ONLINE branch is exercised only on a
// machine with adb installed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

describe('adapters/android-child — graceful degradation', function() {
  it('require() is side-effect-free — getStatus() is OFFLINE until start() is called', function() {
    var androidChild = require('../adapters/android-child');
    var status = androidChild.getStatus();
    assert.equal(status.state, 'OFFLINE');
    assert.equal(status.queueDepth, 0);
    assert.deepEqual(status.devices, []);
  });

  it('sendCommand() never throws and resolves ok:false while offline', async function() {
    var androidChild = require('../adapters/android-child');
    var result = await androidChild.sendCommand({ serial: 'emulator-5554', args: ['shell', 'echo', 'mythos-ping'] });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  });

  it('sendCommand() resolves ok:false (never throws) for a global, serial-less command while offline', async function() {
    var androidChild = require('../adapters/android-child');
    var result = await androidChild.sendCommand({ args: ['devices', '-l'] });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  });

  it('shutdownAndroidChild() is safe to call even if nothing was ever started', function() {
    var androidChild = require('../adapters/android-child');
    assert.doesNotThrow(function() { androidChild.shutdownAndroidChild(); });
  });

  it('startAndroidChild() settles to a terminal state — never stuck in STARTING, never throws', async function() {
    var androidChild = require('../adapters/android-child');
    assert.doesNotThrow(function() { androidChild.startAndroidChild(); });

    var status = androidChild.getStatus();
    var deadline = Date.now() + 8000;
    while (status.state !== 'ONLINE' && status.state !== 'OFFLINE' && Date.now() < deadline) {
      await sleep(250);
      status = androidChild.getStatus();
    }
    assert.ok(status.state === 'ONLINE' || status.state === 'OFFLINE', 'must settle, not hang');
    if (status.state === 'OFFLINE') {
      assert.ok(status.hint, 'must carry a hint explaining why it is offline');
      assert.ok(
        status.hint.toLowerCase().indexOf('not found') !== -1 ||
        status.hint.toLowerCase().indexOf('failed') !== -1 ||
        status.hint.toLowerCase().indexOf('timed out') !== -1 ||
        status.hint.toLowerCase().indexOf('exit') !== -1,
        'hint should explain the failure, got: ' + status.hint
      );
    } else {
      assert.equal(status.state, 'ONLINE', 'adb present must complete the version probe');
    }
    androidChild.shutdownAndroidChild();
  });

  // Security-review finding (Task 10 integration): sendCommand's `serial` was
  // being used only as a queue-partition key and never actually reached adb's
  // argv, so a command silently ran against whatever device adb defaulted to
  // instead of the requested one — invisible with exactly one device attached
  // (it "worked" by accident), and outright broken with two (adb refuses to
  // run anything without -s when 2+ devices are attached). `-s <serial>` must
  // precede the subcommand, per `adb -s <serial> shell ...`.
  it('buildAdbArgs prepends "-s <serial>" BEFORE the subcommand when a serial is given', function() {
    var androidChild = require('../adapters/android-child');
    assert.deepEqual(androidChild.buildAdbArgs('emulator-5554', ['shell', 'echo', 'hi']), ['-s', 'emulator-5554', 'shell', 'echo', 'hi']);
    assert.deepEqual(androidChild.buildAdbArgs('emulator-5554', ['exec-out', 'screencap', '-p']), ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p']);
  });

  it('buildAdbArgs leaves global (serial-less) commands untouched — e.g. `adb devices -l`', function() {
    var androidChild = require('../adapters/android-child');
    assert.deepEqual(androidChild.buildAdbArgs(null, ['devices', '-l']), ['devices', '-l']);
    assert.deepEqual(androidChild.buildAdbArgs(undefined, ['version']), ['version']);
  });

  it('per-device queues stay independent — a second device is never blocked by the first (offline reject-fast proves no shared queue head-of-line)', async function() {
    var androidChild = require('../adapters/android-child');
    var [a, b] = await Promise.all([
      androidChild.sendCommand({ serial: 'deviceA', args: ['shell', 'echo', '1'] }),
      androidChild.sendCommand({ serial: 'deviceB', args: ['shell', 'echo', '2'] }),
    ]);
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
  });
});
