'use strict';

// test/setup-android.test.js — Task 9 (Wave 2, ADB phone bridge). Unit tests
// only, on the script's pure argv/URL/path-construction and parsing logic —
// mirrors test/setup-autostart.test.js's precedent of NOT touching the real
// tool (no real adb, no real network download, no real Task Scheduler there;
// no real adb, no real download, no real device here). --install is
// deliberately never invoked by this suite: an unattended ~15MB download of
// Google's platform-tools zip is the operator's decision, not a test's.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const setupAndroid = require('../scripts/setup-android.js');

test('buildDownloadUrl resolves the official Google platform-tools zip per OS, never a script', () => {
  const win = setupAndroid.buildDownloadUrl('windows');
  const mac = setupAndroid.buildDownloadUrl('darwin');
  const linux = setupAndroid.buildDownloadUrl('linux');

  assert.strictEqual(win, 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip');
  assert.strictEqual(mac, 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip');
  assert.strictEqual(linux, 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip');

  // Never a pipe-to-shell installer — a plain, versioned zip download.
  for (const url of [win, mac, linux]) {
    assert.strictEqual(url.endsWith('.zip'), true);
    assert.strictEqual(url.startsWith('https://dl.google.com/'), true);
  }
});

test('INSTALL_DIR / resolvePlatformToolsDir / resolveAdbPath stay inside the repo, never a hardcoded machine path', () => {
  const repoRoot = setupAndroid.REPO_ROOT();
  const installDir = setupAndroid.INSTALL_DIR();
  const ptDir = setupAndroid.resolvePlatformToolsDir();
  const adbPath = setupAndroid.resolveAdbPath();

  assert.strictEqual(installDir, path.join(repoRoot, 'Android Platform Tools'));
  assert.strictEqual(ptDir, path.join(installDir, 'platform-tools'));
  assert.strictEqual(adbPath.startsWith(ptDir), true);
  assert.strictEqual(adbPath.includes('C:\\Users\\'), false);
  // No leading path segment assumes a specific username/drive — everything
  // is derived from __dirname at require time, which is repo-relative.
  assert.strictEqual(installDir.startsWith(repoRoot), true);
});

test('VAULT_DEVICES_PATH resolves under mythos/vault/Identity, not .env (a growing list, not a static secret)', () => {
  const p = setupAndroid.VAULT_DEVICES_PATH();
  assert.strictEqual(p.includes(path.join('vault', 'Identity', 'android-devices.json')), true);
});

test('resolveAdbBin prefers ANDROID_ADB_BIN, falls back to bare "adb" (PATH lookup) when unset and no local install exists', () => {
  const prev = process.env.ANDROID_ADB_BIN;
  try {
    delete process.env.ANDROID_ADB_BIN;
    const resolved = setupAndroid.resolveAdbBin();
    // No local "Android Platform Tools/platform-tools" install exists in
    // this test environment (never created it — --install is never run),
    // so this must fall all the way back to the bare PATH lookup.
    assert.strictEqual(resolved, 'adb');

    process.env.ANDROID_ADB_BIN = '/custom/path/to/adb';
    assert.strictEqual(setupAndroid.resolveAdbBin(), '/custom/path/to/adb');
  } finally {
    if (prev === undefined) delete process.env.ANDROID_ADB_BIN;
    else process.env.ANDROID_ADB_BIN = prev;
  }
});

test('parseDevicesOutput parses an authorized device with model + transport_id', () => {
  const stdout = 'List of devices attached\n' +
    '192.168.1.50:5555\tdevice product:sunfish model:Pixel_4a device:sunfish transport_id:3\n';
  const rows = setupAndroid.parseDevicesOutput(stdout);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].serial, '192.168.1.50:5555');
  assert.strictEqual(rows[0].authState, 'device');
  assert.strictEqual(rows[0].model, 'Pixel_4a');
  assert.strictEqual(rows[0].transportId, '3');
});

test('parseDevicesOutput parses an unauthorized device (no model/transport yet)', () => {
  const stdout = 'List of devices attached\n' +
    '192.168.1.51:5555\tunauthorized\n';
  const rows = setupAndroid.parseDevicesOutput(stdout);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].authState, 'unauthorized');
  assert.strictEqual(rows[0].model, null);
});

test('parseDevicesOutput handles two devices at once (Pro-Plus\'s explicit 2-device requirement)', () => {
  const stdout = 'List of devices attached\n' +
    'emulator-5554\tdevice product:sdk model:Emulator transport_id:1\n' +
    '192.168.1.60:5555\tdevice product:oriole model:Pixel_6 transport_id:2\n';
  const rows = setupAndroid.parseDevicesOutput(stdout);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].serial, 'emulator-5554');
  assert.strictEqual(rows[1].serial, '192.168.1.60:5555');
});

test('parseDevicesOutput returns an empty array for no devices, never throws', () => {
  assert.deepStrictEqual(setupAndroid.parseDevicesOutput('List of devices attached\n'), []);
  assert.deepStrictEqual(setupAndroid.parseDevicesOutput(''), []);
  assert.deepStrictEqual(setupAndroid.parseDevicesOutput(undefined), []);
});

test('buildPairArgs / buildConnectArgs pass ip:port and code through verbatim, no shell-string concatenation', () => {
  assert.deepStrictEqual(setupAndroid.buildPairArgs('192.168.1.50:37831', '123456'), ['pair', '192.168.1.50:37831', '123456']);
  assert.deepStrictEqual(setupAndroid.buildConnectArgs('192.168.1.50:5555'), ['connect', '192.168.1.50:5555']);
});

test('mergeDeviceRecord adds a new device and updates an existing one by address, never duplicates', () => {
  const empty = setupAndroid.mergeDeviceRecord([], { address: '192.168.1.50:5555', connectedAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(empty.length, 1);

  const withSecond = setupAndroid.mergeDeviceRecord(empty, { address: '192.168.1.60:5555', connectedAt: '2026-01-02T00:00:00.000Z' });
  assert.strictEqual(withSecond.length, 2);

  const reconnected = setupAndroid.mergeDeviceRecord(withSecond, { address: '192.168.1.50:5555', connectedAt: '2026-01-03T00:00:00.000Z' });
  assert.strictEqual(reconnected.length, 2, 'reconnecting the same address must update, not duplicate');
  const updated = reconnected.find((d) => d.address === '192.168.1.50:5555');
  assert.strictEqual(updated.connectedAt, '2026-01-03T00:00:00.000Z');
});
