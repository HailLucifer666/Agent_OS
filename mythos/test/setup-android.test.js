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
// fs/os are for the resolveAdbBin cases below, which build their own temp
// "install" instead of depending on whether this machine has one.
const fs = require('fs');
const os = require('os');
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

test('resolveAdbBin prefers ANDROID_ADB_BIN, then a local install, then bare "adb" (PATH lookup)', () => {
  // This test used to assert the bare-'adb' fallback by relying on the operator
  // NOT having installed platform-tools on whatever machine ran the suite. That
  // premise expires the moment anyone runs `--install`, and on 2026-08-10 a
  // concurrent session did exactly that mid-run: the test began failing
  // deterministically while presenting as an intermittent flake, because
  // "adb.exe exists" flipped between runs. The path is injected now, so all
  // three branches are covered on any machine, installed or not.
  const prev = process.env.ANDROID_ADB_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-resolve-'));
  const absent = path.join(dir, 'not-installed', 'adb.exe');
  const present = path.join(dir, 'adb.exe');
  fs.writeFileSync(present, 'not a real binary');
  try {
    delete process.env.ANDROID_ADB_BIN;
    assert.strictEqual(setupAndroid.resolveAdbBin(absent), 'adb',
      'with no local install, adb must come from PATH');
    assert.strictEqual(setupAndroid.resolveAdbBin(present), present,
      'a local install must win over the PATH lookup');

    process.env.ANDROID_ADB_BIN = '/custom/path/to/adb';
    assert.strictEqual(setupAndroid.resolveAdbBin(present), '/custom/path/to/adb',
      'and an explicit ANDROID_ADB_BIN outranks even a local install');
  } finally {
    if (prev === undefined) delete process.env.ANDROID_ADB_BIN;
    else process.env.ANDROID_ADB_BIN = prev;
  }
});

test('resolveAdbBin with no argument still resolves the real install path (the seam must not become the only path that works)', () => {
  // Guards the wakeword-seam failure mode: an injectable path that quietly stops
  // matching production, so the tests pass while the feature is broken.
  const prev = process.env.ANDROID_ADB_BIN;
  try {
    delete process.env.ANDROID_ADB_BIN;
    const resolved = setupAndroid.resolveAdbBin();
    const real = setupAndroid.resolveAdbPath();
    assert.strictEqual(resolved === real || resolved === 'adb', true,
      'with no injection it must be either the real local install or the PATH fallback — nothing else');
    assert.strictEqual(resolved, fs.existsSync(real) ? real : 'adb',
      'and which one it is must follow whether that real path actually exists');
  } finally {
    if (prev !== undefined) process.env.ANDROID_ADB_BIN = prev;
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
