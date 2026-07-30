'use strict';

// adapters/android-child/index.js — Task 8 (Wave 2, ADB phone bridge).
//
// NOT a copy of pc-child. pc-child keeps one PowerShell process alive because
// ps-automation.ps1 is a long-running script MYTHOS owns. `adb` has no such
// mode — every `adb -s <serial> shell …` is a one-shot call that exits.
// Cargo-culting the persistent-daemon shape would invent a protocol where
// adb's own argv/exit-code contract already is one. What transfers from
// pc-child/cua-driver is the DISCIPLINE, not the shape: a command queue, a
// per-command timeout, side-effect-free require(), explicit start()/
// shutdown(), module-level singleton state, and cua-driver's ENOENT ->
// OFFLINE contract (AD-9: absence of the binary degrades, never blocks boot).
//
// Unlike pc-child/cua-driver there is no persistent child and therefore no
// async handshake — startAndroidChild() is a single synchronous spawnSync
// probe ('adb version'), so state settles to ONLINE/OFFLINE before the call
// returns. No restart budget/backoff either: there is no process to restart.
//
// TWO DEVICES IS AN EXPLICIT REQUIREMENT (Pro-Plus parity): queues are keyed
// per serial (Map<serial, {queue, inFlight}>), not one global queue — a slow
// command on phone A must never block phone B.

const { spawn, spawnSync } = require('child_process');
const { createLogger } = require('../../src/core/logger');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const DEFAULT_ADB_BIN = 'adb';
const DEFAULT_POLL_MS = 8000;
const DEFAULT_CMD_TIMEOUT_MS = 15000;
const ADB_PROBE_TIMEOUT_MS = 5000;
const ADB_START_SERVER_TIMEOUT_MS = 10000;
const ADB_DEVICES_TIMEOUT_MS = 10000;

// Module-level singleton state — side-effect-free at require time.
let state = 'OFFLINE'; // OFFLINE | ONLINE (no STARTING — the probe is synchronous)
let hint = null;
let adbBin = DEFAULT_ADB_BIN;
let pollMs = DEFAULT_POLL_MS;
let cmdTimeoutMs = DEFAULT_CMD_TIMEOUT_MS;
let pollTimer = null;
// serial -> { model, transportId, authState, lastSeenAt }
let devices = new Map();
// serial -> { queue: [{args, timeoutMs, resolve}], inFlight: boolean }
let deviceQueues = new Map();

function getStatus() {
  let queueDepth = 0;
  deviceQueues.forEach(function(q) {
    queueDepth += q.queue.length + (q.inFlight ? 1 : 0);
  });
  return {
    state: state,
    hint: hint,
    devices: Array.from(devices.values()),
    queueDepth: queueDepth,
  };
}

function clearPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// One-shot adb invocation (spawn, not spawnSync, so it can be killed on
// timeout without blocking the event loop — matters for exec-out screencap,
// which can be a multi-megabyte binary transfer).
function runAdb(args, timeoutMs) {
  return new Promise(function(resolve) {
    let settled = false;
    let child;
    try {
      child = spawn(adbBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let stdoutChunks = [];
    let stderr = '';

    const timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* best-effort */ }
      resolve({ ok: false, error: 'adb command timed out after ' + timeoutMs + 'ms' });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    if (child.stdout) child.stdout.on('data', function(d) { stdoutChunks.push(d); });
    if (child.stderr) child.stderr.on('data', function(d) { stderr += d.toString('utf8'); });

    child.on('error', function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });

    child.on('exit', function(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      if (code === 0) {
        resolve({ ok: true, stdout: stdout, stderr: stderr });
      } else {
        resolve({ ok: false, error: stderr.trim() || ('adb exited with code ' + code), stdout: stdout, stderr: stderr });
      }
    });
  });
}

function refreshDevices() {
  let r;
  try {
    r = spawnSync(adbBin, ['devices', '-l'], { encoding: 'utf8', timeout: ADB_DEVICES_TIMEOUT_MS, windowsHide: true });
  } catch (err) {
    log.warn('android-child.refresh-failed', { error: err.message });
    return;
  }
  if (!r || r.status !== 0) return; // best-effort — keep the last-known device list

  const lines = String(r.stdout || '').split(/\r?\n/).slice(1); // skip "List of devices attached"
  const seen = new Set();
  const now = Date.now();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const authState = parts[1] || 'unknown'; // device | unauthorized | offline
    seen.add(serial);
    const modelMatch = /model:(\S+)/.exec(trimmed);
    const transportMatch = /transport_id:(\S+)/.exec(trimmed);
    devices.set(serial, {
      serial: serial,
      model: modelMatch ? modelMatch[1] : null,
      transportId: transportMatch ? transportMatch[1] : null,
      authState: authState,
      lastSeenAt: now,
    });
  }
  // Prune devices no longer reported (unplugged / connection dropped).
  Array.from(devices.keys()).forEach(function(serial) {
    if (!seen.has(serial)) devices.delete(serial);
  });
}

// `-s <serial>` MUST precede the subcommand (adb -s <serial> shell ...), not
// follow it. Exported/pure so it's independently unit-testable — this is
// the only thing standing between "phone A" and "whichever device adb
// happens to default to", which matters most exactly when it's silent: with
// a single device attached, an unqualified `adb shell ...` still succeeds by
// accident, hiding the bug until a second device (Pro-Plus's own explicit
// 2-device requirement) is paired and every command starts racing which
// phone it actually lands on.
function buildAdbArgs(serial, args) {
  if (!serial) return args.slice();
  return ['-s', serial].concat(args);
}

function getQueue(serial) {
  if (!deviceQueues.has(serial)) {
    deviceQueues.set(serial, { queue: [], inFlight: false });
  }
  return deviceQueues.get(serial);
}

function processDeviceQueue(serial) {
  const q = deviceQueues.get(serial);
  if (!q || q.inFlight || q.queue.length === 0) return;
  const job = q.queue.shift();
  q.inFlight = true;
  runAdb(job.args, job.timeoutMs).then(function(result) {
    q.inFlight = false;
    job.resolve(result);
    processDeviceQueue(serial);
  });
}

// sendCommand({ serial, args, timeoutMs }) -> Promise<{ ok, stdout?, stderr?, error? }>
// NEVER throws / never rejects, mirroring cua-driver's invoke() contract —
// callers (from-android.js) always get a settled result to translate into
// the effector ok()/fail() shape, even while fully offline.
function sendCommand(opts) {
  const o = opts || {};
  const args = o.args;
  const serial = o.serial;

  return new Promise(function(resolve) {
    if (state !== 'ONLINE') {
      resolve({ ok: false, error: hint || ('Android bridge is ' + state + '.') });
      return;
    }
    if (!Array.isArray(args) || args.length === 0) {
      resolve({ ok: false, error: 'adb args are required.' });
      return;
    }
    const timeoutMs = o.timeoutMs || cmdTimeoutMs;

    if (!serial) {
      // Global, non-device-scoped command (e.g. `adb devices -l`). Not queued
      // per-device — nothing to serialize it against.
      runAdb(args, timeoutMs).then(resolve);
      return;
    }

    const q = getQueue(serial);
    q.queue.push({ args: buildAdbArgs(serial, args), timeoutMs: timeoutMs, resolve: resolve });
    processDeviceQueue(serial);
  });
}

// startAndroidChild(opts?: { adbBin, pollMs, cmdTimeoutMs })
// Probes `adb version` synchronously. ENOENT -> OFFLINE with an install
// hint; boot continues either way (AD-9) — this function never throws.
function startAndroidChild(opts) {
  const o = opts || {};
  adbBin = o.adbBin || DEFAULT_ADB_BIN;
  pollMs = o.pollMs || DEFAULT_POLL_MS;
  cmdTimeoutMs = o.cmdTimeoutMs || DEFAULT_CMD_TIMEOUT_MS;

  hint = null;
  clearPollTimer();
  deviceQueues.clear();
  devices.clear();

  let probe;
  try {
    probe = spawnSync(adbBin, ['version'], { encoding: 'utf8', timeout: ADB_PROBE_TIMEOUT_MS, windowsHide: true });
  } catch (err) {
    probe = { error: err };
  }

  if (!probe || probe.error || probe.status !== 0) {
    state = 'OFFLINE';
    if (probe && probe.error && probe.error.code === 'ENOENT') {
      hint = 'adb not found — run node mythos/scripts/setup-android.js --install';
    } else if (probe && probe.error) {
      hint = 'Failed to probe adb: ' + probe.error.message;
    } else {
      hint = 'adb version check failed (exit ' + (probe && probe.status) + ').';
    }
    log.info('android-child.offline', { hint: hint });
    return;
  }

  // Idempotent — a second `start-server` on an already-running server is a
  // no-op. Best-effort: a failure here doesn't block going ONLINE, since
  // `adb devices` will implicitly start the server anyway.
  try {
    spawnSync(adbBin, ['start-server'], { encoding: 'utf8', timeout: ADB_START_SERVER_TIMEOUT_MS, windowsHide: true });
  } catch (_) { /* best-effort */ }

  state = 'ONLINE';
  log.info('android-child.online', {});
  refreshDevices();
  pollTimer = setInterval(refreshDevices, pollMs);
  if (pollTimer.unref) pollTimer.unref();
}

// Never calls `adb kill-server` — that would drop other tools' adb sessions
// on the same machine (a developer's own `adb logcat` in another terminal,
// e.g.). Only stops this process's own polling and drains its own queues.
function shutdownAndroidChild() {
  clearPollTimer();
  deviceQueues.forEach(function(q) {
    q.queue.forEach(function(job) {
      job.resolve({ ok: false, error: 'Android bridge shutting down.' });
    });
    q.queue = [];
  });
  deviceQueues.clear();
  devices.clear();
  state = 'OFFLINE';
  hint = null;
}

module.exports = {
  startAndroidChild: startAndroidChild,
  shutdownAndroidChild: shutdownAndroidChild,
  sendCommand: sendCommand,
  getStatus: getStatus,
  buildAdbArgs: buildAdbArgs, // exported for unit testing only (security-review finding)
};
