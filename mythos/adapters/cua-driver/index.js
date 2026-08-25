'use strict';

// adapters/cua-driver/index.js — BUG-026 (4th attempt, part B): lifecycle wrapper for the external
// `cua-driver` binary (trycua/cua project — native Rust CLI, MIT licensed, NOT the
// Python `cua` package). Mirrors adapters/pc-child/index.js's lifecycle discipline:
// side-effect-free require, explicit start/stop, ring buffer for diagnostics,
// auto-restart with budget, module-level singleton state.
//
// WHY THIS EXISTS: findPlayControl() in from-spotify.js substring-matches UIA element
// name/automationId for "play"/"pause" — Spotify's Chromium/CEF desktop client often
// exposes no such named leaf element, so the search returns null and MYTHOS falls back
// to a keystroke guess. cua-driver UIA-hit-tests the exact pixel and invokes whatever
// control sits there, which can succeed even when the element has no matching name.
//
// TOOL SURFACE CONFIRMED (2026-07-17, cua-driver-rs 0.8.3 installed + probed live
// via MCP tools/list): 39 tools. The ones this codebase uses:
//   list_windows                      — top-level windows w/ HWNDs
//   get_window_state {pid, window_id} — UIA tree as structuredContent.elements[]
//                                       (each actionable element has element_index)
//   click {pid, window_id, element_index, delivery_mode?} — element-addressed click;
//       'background' (default) uses UIA Invoke/PostMessage without fronting; returns
//       a structured background_unavailable error for Chromium/Electron surfaces →
//       re-issue the SAME click with delivery_mode:'foreground' (brief SetForeground
//       swap + SendInput, prior foreground restored).
// Responses: JSON-RPC result = { content: [...], structuredContent: {...}, isError }.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../src/core/logger');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const RING_BUFFER_MAX_LINES = 100;
const MAX_RESTART_ATTEMPTS = 2;
const RESTART_BACKOFF_MS = [2000, 5000];
const COMMAND_TIMEOUT_MS = 15000;
const STARTUP_TIMEOUT_MS = 5000;
const BINARY_NAME = 'cua-driver';

// The official installer puts the binary here and adds it to the USER PATH — but a
// server process started before the PATH change (or from a non-login context) won't
// see it. Prefer the absolute install location when it exists.
function resolveBinary() {
  const installed = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'
  );
  try {
    if (process.env.LOCALAPPDATA && fs.existsSync(installed)) return installed;
  } catch (_) { /* fall through to PATH lookup */ }
  return BINARY_NAME;
}

// Module-level singleton state
let child = null;
let state = 'OFFLINE'; // OFFLINE | STARTING | ONLINE
let hint = null;
let ringBuffer = [];
let restartAttempts = 0;
let intentionalShutdown = false;
let restartTimer = null;
let notInstalled = false; // ENOENT on spawn — stop retrying a binary that isn't there

// Pending JSON-RPC requests, keyed by id (unlike pc-child's single-in-flight
// command queue, MCP's stdio transport is message-id addressed, so simple
// sequential dispatch is not required, but we still serialize for simplicity
// and to match pc-child's easy-to-reason-about one-at-a-time contract).
let nextId = 1;
let commandQueue = [];
let commandInFlight = null; // { id, resolve, reject, timer }
let stdoutBuf = '';

function pushRingLine(line) {
  ringBuffer.push(line);
  if (ringBuffer.length > RING_BUFFER_MAX_LINES) {
    ringBuffer = ringBuffer.slice(ringBuffer.length - RING_BUFFER_MAX_LINES);
  }
}

function getStatus() {
  return { state: state, hint: hint, queueDepth: commandQueue.length };
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

// ---- stdout: newline-delimited JSON-RPC responses ----
function handleStdoutChunk(chunk) {
  stdoutBuf += chunk.toString('utf8');
  const lines = stdoutBuf.split(/\r?\n/);
  stdoutBuf = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      pushRingLine(line); // not JSON — diagnostic/log output
      continue;
    }
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && commandInFlight && msg.id === commandInFlight.id) {
      clearTimeout(commandInFlight.timer);
      const resolve = commandInFlight.resolve;
      commandInFlight = null;
      resolve(msg);
      processQueue();
    } else {
      pushRingLine(line); // notification or out-of-band message
    }
  }
}

function handleStderrChunk(chunk) {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line) pushRingLine(`[stderr] ${line}`);
  }
}

// Diagnostic tail. The child's stderr has always been captured into the ring
// buffer above and then never looked at, so every handshake failure read as
// "startup handshake timed out." and nothing else — the same undiagnosable
// shape pc-child had before BUG-167, and the same fix.
function recentStderr(maxLines = 20) {
  return ringBuffer
    .filter((line) => line.startsWith('[stderr]'))
    .slice(-maxLines);
}

// ---- JSON-RPC dispatch (one in flight at a time, like pc-child) ----
function processQueue() {
  if (commandInFlight || commandQueue.length === 0 || !child) return;

  const { request, resolve, reject } = commandQueue.shift();
  commandInFlight = { id: request.id, resolve: resolve, reject: reject, timer: null };

  const timer = setTimeout(() => {
    if (commandInFlight === null) return;
    const rejectFn = commandInFlight.reject;
    commandInFlight = null;
    rejectFn(new Error('cua-driver command timed out'));
    processQueue();
  }, COMMAND_TIMEOUT_MS);
  commandInFlight.timer = timer;

  try {
    child.stdin.write(JSON.stringify(request) + '\n');
  } catch (err) {
    clearTimeout(timer);
    commandInFlight = null;
    reject(err);
    processQueue();
  }
}

function sendRequest(method, params) {
  return new Promise((resolve, reject) => {
    const request = { jsonrpc: '2.0', id: nextId++, method: method, params: params || {} };
    commandQueue.push({ request: request, resolve: resolve, reject: reject });
    processQueue();
  });
}

// Call a cua-driver MCP tool (names confirmed against 0.8.3 — see header).
// Returns { ok, result } where result is the FULL MCP tool result object
// ({ content, structuredContent, isError }) so callers can read
// structuredContent.elements etc.; on failure result is an error string.
async function invoke(toolName, args) {
  if (state !== 'ONLINE') {
    return { ok: false, result: hint || 'cua-driver unavailable' };
  }
  try {
    const resp = await sendRequest('tools/call', { name: toolName, arguments: args || {} });
    if (resp.error) {
      return { ok: false, result: resp.error.message || 'cua-driver tool call failed' };
    }
    const result = resp.result || {};
    return { ok: !result.isError, result };
  } catch (err) {
    return { ok: false, result: err.message };
  }
}

// ---- Child process lifecycle (mirrors pc-child/index.js) ----
function spawnChild() {
  state = 'STARTING';
  hint = null;

  let proc;
  try {
    proc = spawn(resolveBinary(), ['mcp'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    state = 'OFFLINE';
    hint = `Failed to spawn ${BINARY_NAME}: ${err.message}`;
    notInstalled = true;
    return;
  }
  child = proc;

  if (proc.stdout) proc.stdout.on('data', handleStdoutChunk);
  if (proc.stderr) proc.stderr.on('data', handleStderrChunk);

  proc.on('error', (err) => {
    pushRingLine(`[cua-driver] spawn error: ${err.message}`);
    state = 'OFFLINE';
    child = null;
    if (err.code === 'ENOENT') {
      notInstalled = true;
      hint = `${BINARY_NAME} not found on PATH — install it first (see BUGS.md / plan), then restart MYTHOS. Falls back to the existing UIA/keystroke Spotify path until then.`;
    } else {
      hint = `Failed to start ${BINARY_NAME}: ${err.message}`;
    }
  });

  proc.on('exit', (code, signal) => {
    child = null;
    if (commandInFlight) {
      clearTimeout(commandInFlight.timer);
      commandInFlight.reject(new Error('cua-driver exited unexpectedly'));
      commandInFlight = null;
    }
    for (const entry of commandQueue) entry.reject(new Error('cua-driver exited unexpectedly'));
    commandQueue = [];

    if (intentionalShutdown) {
      state = 'OFFLINE';
      return;
    }
    if (code === 0) {
      state = 'OFFLINE';
      return;
    }
    pushRingLine(`[cua-driver] exited unexpectedly (code=${code}, signal=${signal})`);

    if (notInstalled || restartAttempts >= MAX_RESTART_ATTEMPTS) {
      state = 'OFFLINE';
      hint = hint || 'cua-driver exceeded restart budget.';
      return;
    }

    const backoffMs = RESTART_BACKOFF_MS[restartAttempts] || RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
    restartAttempts += 1;
    log.warn('cua-driver.restarting', { attempt: restartAttempts, backoffMs });
    state = 'STARTING';
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, backoffMs);
    if (restartTimer.unref) restartTimer.unref();
  });

  // MCP initialize handshake. Only becomes ONLINE on a genuine successful
  // response — never assumed.
  const initStart = Date.now();
  sendRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mythos', version: '1.0.0' }
  }).then((resp) => {
    if (resp && resp.result && state !== 'OFFLINE') {
      // MCP spec: client must send the initialized notification (no id, no
      // response expected) before issuing tools/* requests.
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch (_) {}
      state = 'ONLINE';
      log.info('cua-driver.online', {});
    } else if (state !== 'OFFLINE') {
      state = 'OFFLINE';
      hint = 'cua-driver MCP initialize did not return a result.';
    }
  }).catch((err) => {
    if (state !== 'OFFLINE') {
      state = 'OFFLINE';
      const tail = recentStderr(5);
      hint = `cua-driver MCP initialize failed: ${err.message}`
        + (tail.length ? ` — last stderr: ${tail.join(' | ')}` : '');
    }
  });

  // Startup timeout safety net in case the promise above never settles.
  setTimeout(() => {
    if (state === 'STARTING') {
      state = 'OFFLINE';
      const tail = recentStderr(5);
      hint = 'cua-driver startup handshake timed out.'
        + (tail.length ? ` Last stderr: ${tail.join(' | ')}` : ' The child printed nothing to stderr.');
    }
  }, STARTUP_TIMEOUT_MS);
}

function startCuaDriver() {
  intentionalShutdown = false;
  restartAttempts = 0;
  notInstalled = false;
  clearRestartTimer();
  commandQueue = [];
  commandInFlight = null;
  stdoutBuf = '';

  try {
    spawnChild();
  } catch (err) {
    state = 'OFFLINE';
    hint = `cua-driver start failed: ${err.message}`;
    log.warn('cua-driver.start-failed', { error: err.message });
  }
}

function shutdownCuaDriver() {
  intentionalShutdown = true;
  clearRestartTimer();

  for (const entry of commandQueue) entry.reject(new Error('cua-driver shutting down'));
  commandQueue = [];

  if (commandInFlight) {
    clearTimeout(commandInFlight.timer);
    commandInFlight.reject(new Error('cua-driver shutting down'));
    commandInFlight = null;
  }

  if (child && !child.killed) {
    try {
      if (process.platform === 'win32' && child.pid) {
        const { execFile } = require('child_process');
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']);
      } else {
        child.kill('SIGTERM');
      }
    } catch (_) { /* best-effort */ }
    child = null;
  }
  state = 'OFFLINE';
}

module.exports = {
  startCuaDriver: startCuaDriver,
  shutdownCuaDriver: shutdownCuaDriver,
  invoke: invoke,
  getStatus: getStatus
};
