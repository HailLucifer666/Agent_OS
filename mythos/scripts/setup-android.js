#!/usr/bin/env node
'use strict';

// scripts/setup-android.js — Task 9 (Wave 2, ADB phone bridge): install,
// pair, and connect Android devices for android-child's ADB bridge.
// Modeled on setup-dsh.js's --check/--install shape.
//
// WHAT IT DOES
//   --check (default)   resolve adb (ANDROID_ADB_BIN, then every install
//                        location, then PATH), run `adb version` + `adb
//                        devices -l`, print per-device pairing status and
//                        the smoke-test command to run. On failure it names
//                        every path it looked in.
//   --install            download Google's OFFICIAL platform-tools zip for
//                        this OS into the install dir and unzip it there. A
//                        plain versioned zip download — never `curl | bash` /
//                        `iex (irm …)`. Requires NO follow-up .env edit: the
//                        runtime finds the result by searching (BUG-360).
//   --pair <ip:port> <code>   `adb pair` (Android 11+ Wireless Debugging).
//                        The pairing code is shown on the phone's own
//                        Developer Options screen — a manual on-phone step
//                        no script can automate; this just relays it to adb.
//   --connect <ip:port>  `adb connect`, then persists the address to
//                        vault/Identity/android-devices.json — a growing
//                        device list, not a static secret, so vault rather
//                        than .env.
//
// EVERYTHING STAYS INSIDE THE PROJECT. Downloads land in
// <repo>/Android Platform Tools/ (gitignored — mirrors the build engine's own
// /DeepSeek Harness/ convention: a full third-party tool tree never belongs
// in git, contributors fetch their own copy).

const { spawnSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIR_NAME = 'Android Platform Tools';
const REPO_INSTALL_DIR = path.join(REPO_ROOT, DIR_NAME);
// Two different strings, deliberately. ADB_EXE is a FILENAME inside an install
// tree ('adb.exe' on Windows); DEFAULT_ADB_BIN is the bare COMMAND handed to
// spawn so the OS resolves it on PATH — and it stays 'adb' on Windows too,
// because that is what a PATH lookup wants. Conflating them is how you get a
// spawn of 'adb.exe' that misses a PATH entry, or a file probe for 'adb' that
// misses the real binary. Kept in sync with android-child's own constant of the
// same name, and a test asserts they agree.
const DEFAULT_ADB_BIN = 'adb';
const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
const VAULT_DEVICES_PATH = path.resolve(__dirname, '..', 'vault', 'Identity', 'android-devices.json');

// Installer parity (2026-08-11): in a PACKAGED install, <repo>/Android Platform
// Tools resolves inside the install tree — which an update replaces wholesale, so
// every upgrade would silently un-install adb and take every phone_* effector
// with it. MYTHOS_TOOLS_DIR is injected by electron/main.js as <userData>/tools,
// beside the models directory and for the same three reasons: writable without
// elevation, survives an update, survives a reinstall. A dev checkout sets nothing
// and keeps the historical in-repo location, so existing installs are untouched.
function toolsInstallDir(env) {
  const e = env || process.env;
  if (!e.MYTHOS_TOOLS_DIR) return null;
  return path.join(path.resolve(e.MYTHOS_TOOLS_DIR), DIR_NAME);
}

// A WRITE goes to userData/tools when Electron told us where that is, else the
// repo root — unchanged behaviour, but resolved when CALLED rather than when
// required. It used to be a module-level const, which meant whichever value
// process.env held at require time was frozen in; the adapter that now asks this
// question is required during boot wiring, so a const would have answered for
// the wrong tree.
function resolveInstallDir(env) {
  return toolsInstallDir(env) || REPO_INSTALL_DIR;
}

// BUG-360 (2026-08-26): every READ must consider BOTH locations, most-preferred
// first. This is the half that was missing, and it took all 14 phone_* tools with
// it. --install wrote adb correctly (this machine has it in BOTH
// %APPDATA%\MYTHOS\tools\ and <repo>\Android Platform Tools\), but resolution
// looked in exactly one place — whichever MYTHOS_TOOLS_DIR selected — so a dev
// run could not see a packaged install's copy and vice versa. Same defect,
// same shape, and the same fix as the one doctor.js already records for the
// build engine: "Both sides search userData/tools (MYTHOS_TOOLS_DIR) first and
// the repo second." setup-dsh.js's dshSearchHomes() is the precedent this
// mirrors deliberately, rather than inventing a second convention.
function androidSearchDirs(env) {
  const dirs = [];
  const tools = toolsInstallDir(env);
  if (tools) dirs.push(tools);
  dirs.push(REPO_INSTALL_DIR);
  return dirs.filter(function(d, i) { return dirs.indexOf(d) === i; });
}

// The first installed adb across every search dir, or null. Returns a real path
// that exists — never a plausible-looking guess, because the caller's next move
// is to spawn it and report OFFLINE on ENOENT.
function findInstalledAdb(env, dirs) {
  const candidates = dirs || androidSearchDirs(env);
  for (let i = 0; i < candidates.length; i++) {
    const candidate = path.join(candidates[i], 'platform-tools', ADB_EXE);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* unreadable dir — try the next */ }
  }
  return null;
}

function platformToken() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

// Google's official platform-tools download, documented at
// https://developer.android.com/tools/releases/platform-tools#downloads.
// "latest" is a stable alias Google itself maintains (the artifact behind it
// carries its own internal version) — not a script, a real zip. Never
// curl|bash / iex(irm).
function buildDownloadUrl(platform) {
  return 'https://dl.google.com/android/repository/platform-tools-latest-' + platform + '.zip';
}

// Both describe the WRITE target — where --install puts things. Read paths go
// through findInstalledAdb(), which considers every search dir.
function resolvePlatformToolsDir(env) {
  return path.join(resolveInstallDir(env), 'platform-tools');
}

function resolveAdbPath(env) {
  return path.join(resolvePlatformToolsDir(env), ADB_EXE);
}

// Resolution order: explicit env override -> the project-local install this
// script's own --install step produces -> bare 'adb' (PATH lookup).
// `localAdbPath` is an injectable-path seam, and it exists for the same reason
// routes/config.js's wakewordModelsDir does: the test for this function used to
// assert the bare-'adb' fallback by relying on the operator NOT having installed
// platform-tools on the machine running the suite. That premise silently expires
// the first time anyone runs `--install` (or a concurrent session does), and then
// the test fails deterministically while looking like a flake — which is exactly
// what happened here on 2026-08-10. Production passes nothing and resolves the
// real path; the test passes a path it controls and can therefore cover BOTH
// branches instead of whichever one the machine happens to be in.
function resolveAdbBin(localAdbPath, env) {
  const e = env || process.env;
  if (e.ANDROID_ADB_BIN) return e.ANDROID_ADB_BIN;
  if (localAdbPath) {
    // Injected seam: check exactly the path the caller named, nothing else, so a
    // test asking for the not-installed branch gets it on a machine that DOES
    // have an install.
    try {
      if (fs.existsSync(localAdbPath)) return localAdbPath;
    } catch (_) { /* fall through to PATH */ }
    return DEFAULT_ADB_BIN;
  }
  return findInstalledAdb(e) || DEFAULT_ADB_BIN;
}

// Pure parser for `adb devices -l` output — no adb call, so it's testable
// without a real binary or device.
function parseDevicesOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).slice(1); // skip "List of devices attached"
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const modelMatch = /model:(\S+)/.exec(trimmed);
    const transportMatch = /transport_id:(\S+)/.exec(trimmed);
    out.push({
      serial: parts[0],
      authState: parts[1] || 'unknown',
      model: modelMatch ? modelMatch[1] : null,
      transportId: transportMatch ? transportMatch[1] : null,
    });
  }
  return out;
}

function buildPairArgs(ipPort, code) {
  return ['pair', ipPort, code];
}

function buildConnectArgs(ipPort) {
  return ['connect', ipPort];
}

// Merge a connected device into the persisted list, keyed by address so a
// reconnect updates the existing record instead of duplicating it.
function mergeDeviceRecord(existingList, entry) {
  const list = Array.isArray(existingList) ? existingList.slice() : [];
  const idx = list.findIndex(function(d) { return d && d.address === entry.address; });
  if (idx === -1) {
    list.push(entry);
  } else {
    list[idx] = Object.assign({}, list[idx], entry);
  }
  return list;
}

function readDeviceList() {
  try {
    const raw = fs.readFileSync(VAULT_DEVICES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeDeviceList(list) {
  fs.mkdirSync(path.dirname(VAULT_DEVICES_PATH), { recursive: true });
  fs.writeFileSync(VAULT_DEVICES_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function check() {
  const adb = resolveAdbBin();
  const version = spawnSync(adb, ['version'], { encoding: 'utf8', timeout: 5000 });
  if (version.error || version.status !== 0) {
    console.log('adb: NOT FOUND (' + adb + ')');
    // Name the places that were looked in. "NOT FOUND (adb)" alone cannot
    // distinguish "never installed" from "installed somewhere this build does
    // not search", and that ambiguity is exactly what hid BUG-360 — adb was
    // present in two directories the whole time.
    console.log('  searched: ' + androidSearchDirs().map(function(d) {
      return path.join(d, 'platform-tools', ADB_EXE);
    }).join('\n            '));
    console.log('  then PATH (as "' + DEFAULT_ADB_BIN + '")');
    console.log('  run: node mythos/scripts/setup-android.js --install');
    return 1;
  }
  console.log('adb: OK (' + adb + ')');
  console.log('  ' + String(version.stdout || '').trim().split(/\r?\n/)[0]);

  const devices = spawnSync(adb, ['devices', '-l'], { encoding: 'utf8', timeout: 10000 });
  if (devices.status !== 0) {
    console.log('adb devices -l: failed');
    return 1;
  }
  const rows = parseDevicesOutput(devices.stdout);
  if (rows.length === 0) {
    console.log('\nNo devices paired or connected.');
    console.log('  Wireless Debugging (Android 11+):');
    console.log('    1. node mythos/scripts/setup-android.js --pair <ip:port> <code>');
    console.log('       (the code is shown on the phone: Settings > Developer options >');
    console.log('        Wireless debugging > Pair device with pairing code)');
    console.log('    2. node mythos/scripts/setup-android.js --connect <ip:port>');
    return 0;
  }
  console.log('\nDevices:');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log('  ' + row.serial + '  ' + row.authState + (row.model ? '  model:' + row.model : ''));
    if (row.authState === 'device') {
      console.log('    smoke test: adb -s ' + row.serial + ' shell echo mythos-ping');
    } else if (row.authState === 'unauthorized') {
      console.log('    ACTION NEEDED: accept the debugging-authorization prompt on the phone itself.');
    }
  }
  return 0;
}

function downloadFile(url, destPath) {
  return new Promise(function(resolve, reject) {
    const file = fs.createWriteStream(destPath);
    https.get(url, { headers: { 'User-Agent': 'mythos-setup-android' } }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        downloadFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error('download failed: HTTP ' + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on('finish', function() { file.close(function() { resolve(); }); });
    }).on('error', function(err) {
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(err);
    });
  });
}

// Extraction shells out to the OS's own unzip tool (Windows' built-in
// Expand-Archive, or `unzip` elsewhere) rather than adding a new npm
// dependency for a one-time, operator-invoked install step.
function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    return spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + destDir + "' -Force",
    ], { encoding: 'utf8' });
  }
  return spawnSync('unzip', ['-o', zipPath, '-d', destDir], { encoding: 'utf8' });
}

async function install() {
  const platform = platformToken();
  const url = buildDownloadUrl(platform);
  const installDir = resolveInstallDir();
  fs.mkdirSync(installDir, { recursive: true });
  const zipPath = path.join(installDir, 'platform-tools-latest-' + platform + '.zip');

  console.log('Downloading ' + url);
  try {
    await downloadFile(url, zipPath);
  } catch (err) {
    console.log('ERROR: download failed — ' + err.message);
    return 1;
  }

  console.log('Extracting to ' + installDir);
  const result = extractZip(zipPath, installDir);
  if (!result || result.error || result.status !== 0) {
    console.log('ERROR: extraction failed');
    if (result && result.stdout) console.log(result.stdout);
    if (result && result.stderr) console.log(result.stderr);
    return 1;
  }

  const adbPath = resolveAdbPath();
  if (!fs.existsSync(adbPath)) {
    console.log('ERROR: extraction completed but adb was not found at ' + adbPath);
    return 1;
  }
  // BUG-360: this used to print "Set in mythos/.env: ANDROID_ADB_BIN=<path>" and
  // stop there. A setup step whose last instruction is a manual paste has not
  // finished setting anything up — the first-run wizard runs this unattended, so
  // nobody ever saw the line, ANDROID_ADB_BIN stayed at its 'adb' default, and
  // every phone_* tool was withheld from the model as UNAVAILABLE. The path is
  // now discovered by findInstalledAdb() at boot, so no .env line is required at
  // all and none is advertised.
  console.log('\nInstalled: ' + adbPath);
  console.log('No .env change needed — MYTHOS resolves this path on its own at startup.');
  console.log('  verify: node mythos/scripts/setup-android.js --check');
  return 0;
}

function pair(ipPort, code) {
  if (!ipPort || !code) {
    console.log('Usage: node mythos/scripts/setup-android.js --pair <ip:port> <code>');
    console.log('  The pairing code is shown on the phone itself:');
    console.log('    Settings > Developer options > Wireless debugging > Pair device with pairing code.');
    console.log('  No script can read or automate that on-phone step — type it there, then pass it here.');
    return 1;
  }
  const adb = resolveAdbBin();
  const result = spawnSync(adb, buildPairArgs(ipPort, code), { encoding: 'utf8', timeout: 15000 });
  console.log(String(result.stdout || '') + String(result.stderr || ''));
  return result.status === 0 ? 0 : 1;
}

function connect(ipPort) {
  if (!ipPort) {
    console.log('Usage: node mythos/scripts/setup-android.js --connect <ip:port>');
    return 1;
  }
  const adb = resolveAdbBin();
  const result = spawnSync(adb, buildConnectArgs(ipPort), { encoding: 'utf8', timeout: 15000 });
  const output = String(result.stdout || '') + String(result.stderr || '');
  console.log(output);
  if (result.status !== 0 || !/connected to/i.test(output)) {
    return 1;
  }
  const list = readDeviceList();
  const updated = mergeDeviceRecord(list, { address: ipPort, connectedAt: new Date().toISOString() });
  writeDeviceList(updated);
  console.log('Persisted to vault/Identity/android-devices.json');
  console.log('\nRecommendation: set a DHCP reservation for this device on your router —');
  console.log('a renewed lease changes the IP silently and every phone_* tool stops reaching it.');
  return 0;
}

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    if (argv.includes('--install')) {
      process.exitCode = await install();
    } else if (argv.includes('--pair')) {
      const i = argv.indexOf('--pair');
      process.exitCode = pair(argv[i + 1], argv[i + 2]);
    } else if (argv.includes('--connect')) {
      const i = argv.indexOf('--connect');
      process.exitCode = connect(argv[i + 1]);
    } else {
      process.exitCode = check();
    }
  })();
}

module.exports = {
  buildDownloadUrl,
  resolvePlatformToolsDir,
  resolveAdbPath,
  resolveAdbBin,
  androidSearchDirs,
  findInstalledAdb,
  DEFAULT_ADB_BIN,
  parseDevicesOutput,
  buildPairArgs,
  buildConnectArgs,
  mergeDeviceRecord,
  INSTALL_DIR: function(env) { return resolveInstallDir(env); },
  REPO_ROOT: function() { return REPO_ROOT; },
  VAULT_DEVICES_PATH: function() { return VAULT_DEVICES_PATH; },
};
