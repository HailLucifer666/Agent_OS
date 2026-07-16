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
// KNOWN GAP (do not remove this comment until resolved): the plan this adapter was
// built from could not confirm cua-driver's exact MCP tool names/params from public
// docs alone (its README does not fully document the tools/list response). This file
// therefore assumes the standard MCP stdio JSON-RPC framing (one JSON-RPC message per
// line, per the MCP spec) for the transport, but the *tool name* passed to invoke() by
// callers is a PLACEHOLDER — see from-spotify.js's call site. Before this is trusted in
// production: install cua-driver, run `cua-driver doctor`, start `cua-driver mcp`, and
// inspect its real tools/list response; update the placeholder tool name + arg shape
// to match. Until then this adapter degrades cleanly (getStatus() never reports ONLINE
// unless it genuinely completed the MCP initialize handshake against a real process).

const { spawn } = require('child_process');
const { createLogger } = require('../../src/core/logger');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const RING_BUFFER_MAX_LINES = 100;
const MAX_RESTART_ATTEMPTS = 2;
const RESTART_BACKOFF_MS = [2000, 5000];
const COMMAND_TIMEOUT_MS = 15000;
const STARTUP_TIMEOUT_MS = 5000;
const BINARY_NAME = 'cua-driver';

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

// Call a cua-driver MCP tool. toolName/args are caller-supplied — see the
// KNOWN GAP note above: names are unconfirmed against a real install.
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
    return { ok: !result.isError, result: result.content !== undefined ? result.content : result };
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
    proc = spawn(BINARY_NAME, ['mcp'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
      state = 'ONLINE';
      log.info('cua-driver.online', {});
    } else if (state !== 'OFFLINE') {
      state = 'OFFLINE';
      hint = 'cua-driver MCP initialize did not return a result.';
    }
  }).catch((err) => {
    if (state !== 'OFFLINE') {
      state = 'OFFLINE';
      hint = `cua-driver MCP initialize failed: ${err.message}`;
    }
  });

  // Startup timeout safety net in case the promise above never settles.
  setTimeout(() => {
    if (state === 'STARTING') {
      state = 'OFFLINE';
      hint = 'cua-driver startup handshake timed out.';
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
