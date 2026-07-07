// pc-child.js — lifecycle management for the PowerShell PC automation child process.
// Follows the same singleton pattern as s2s-child.js: side-effect-free require,
// explicit start/stop, ring buffer for diagnostics, auto-restart with budget.
//
// The child process runs ps-automation.ps1 as a JSON-over-stdin daemon:
// - Write one JSON command line to stdin
// - Read exactly one JSON response line from stdout
// - Commands are serialized (one at a time via a pending queue)
//
// Exposes: sendCommand({ cmd, ...args }) → Promise<{ ok, result/error }>

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { log } = require('../logger');

const RING_BUFFER_MAX_LINES = 100;
const MAX_RESTART_ATTEMPTS = 2;
const RESTART_BACKOFF_MS = [2000, 5000];
const COMMAND_TIMEOUT_MS = 15000; // 15s per command
const STARTUP_TIMEOUT_MS = 5000; // 5s for ping handshake

// Module-level singleton state
let child = null;
let state = 'OFFLINE'; // OFFLINE | STARTING | ONLINE
let hint = null;
let ringBuffer = [];
let restartAttempts = 0;
let intentionalShutdown = false;
let restartTimer = null;

// Command queue — ensures only one command in-flight at a time
let commandQueue = [];
let commandInFlight = null; // { resolve, reject, timer }

// stdout line buffer (incomplete lines accumulate here)
let stdoutBuf = '';

function pushRingLine(line) {
  ringBuffer.push(line);
  if (ringBuffer.length > RING_BUFFER_MAX_LINES) {
    ringBuffer = ringBuffer.slice(ringBuffer.length - RING_BUFFER_MAX_LINES);
  }
}

function resolveScriptPath() {
  // ps-automation.ps1 lives next to this file
  return path.join(__dirname, 'ps-automation.ps1');
}

function getStatus() {
  return { state, hint, queueDepth: commandQueue.length };
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

// ---- Stdout handler ----
// Accumulates lines; the first line after spawn must be empty or a response to ping.
// Each completed line is either a command response or diagnostic output.

function handleStdoutChunk(chunk) {
  stdoutBuf += chunk.toString('utf8');
  const lines = stdoutBuf.split(/\r?\n/);
  // Keep the last (potentially incomplete) segment in the buffer
  stdoutBuf = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    if (commandInFlight) {
      // This line is the response to the current command
      try {
        const parsed = JSON.parse(line);
        clearTimeout(commandInFlight.timer);
        const resolve = commandInFlight.resolve;
        commandInFlight = null;
        resolve(parsed);
      } catch {
        // Not valid JSON — treat as diagnostic
        pushRingLine(line);
      }
    } else {
      // No command in flight — diagnostic line
      pushRingLine(line);
    }
  }
}

function handleStderrChunk(chunk) {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line) pushRingLine(`[stderr] ${line}`);
  }
}

// ---- Command dispatch ----

function processQueue() {
  if (commandInFlight || commandQueue.length === 0 || !child) return;

  const { cmd, resolve, reject } = commandQueue.shift();
  commandInFlight = { resolve, reject, timer: null };

  const timer = setTimeout(() => {
    if (commandInFlight === null) return; // already resolved
    const rejectFn = commandInFlight.reject;
    commandInFlight = null;
    rejectFn(new Error('PC automation command timed out'));
    processQueue(); // process next
  }, COMMAND_TIMEOUT_MS);

  commandInFlight.timer = timer;

  try {
    const jsonStr = JSON.stringify(cmd);
    child.stdin.write(jsonStr + '\n');
  } catch (err) {
    clearTimeout(timer);
    commandInFlight = null;
    reject(err);
    processQueue();
  }
}

function sendCommand(cmdObj) {
  return new Promise((resolve, reject) => {
    commandQueue.push({ cmd: cmdObj, resolve, reject });
    processQueue();
  });
}

// ---- Child process lifecycle ----

function spawnChild() {
  const scriptPath = resolveScriptPath();
  if (!fs.existsSync(scriptPath)) {
    state = 'OFFLINE';
    hint = `ps-automation.ps1 not found at ${scriptPath}`;
    log.warn('pc-child script missing', { path: scriptPath });
    return;
  }

  state = 'STARTING';
  hint = null;

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ];

  const proc = spawn('powershell.exe', args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = proc;

  if (proc.stdout) proc.stdout.on('data', handleStdoutChunk);
  if (proc.stderr) proc.stderr.on('data', handleStderrChunk);

  proc.on('error', (err) => {
    pushRingLine(`[pc-child] spawn error: ${err.message}`);
    state = 'OFFLINE';
    hint = `Failed to start PowerShell: ${err.message}`;
    child = null;
  });

  proc.on('exit', (code, signal) => {
    child = null;
    // Reject any in-flight command
    if (commandInFlight) {
      clearTimeout(commandInFlight.timer);
      commandInFlight.reject(new Error('PC automation child exited unexpectedly'));
      commandInFlight = null;
    }

    if (intentionalShutdown) {
      state = 'OFFLINE';
      return;
    }

    const unexpected = code !== 0 && code !== null;
    if (code === 0) {
      state = 'OFFLINE';
      return;
    }

    pushRingLine(`[pc-child] exited unexpectedly (code=${code}, signal=${signal})`);

    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
      state = 'OFFLINE';
      hint = 'PC automation exceeded restart budget.';
      log.warn('pc-child exceeded restart attempts');
      return;
    }

    const backoffMs = RESTART_BACKOFF_MS[restartAttempts] || RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
    restartAttempts += 1;
    log.warn('pc-child restarting', { attempt: restartAttempts, backoffMs });
    state = 'STARTING';
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnChild();
    }, backoffMs);
    if (restartTimer.unref) restartTimer.unref();
  });

  // Startup handshake: send ping, wait for pong
  const pingCmd = { cmd: 'ping' };
  const pingStart = Date.now();

  const handleStartup = () => {
    if (state === 'ONLINE') return; // already resolved
    const elapsed = Date.now() - pingStart;
    if (elapsed > STARTUP_TIMEOUT_MS) {
      state = 'OFFLINE';
      hint = 'PC automation startup handshake timed out.';
      log.warn('pc-child startup timeout');
      return;
    }
    setTimeout(handleStartup, 100);
  };

  // Send ping and wait for response via the normal command pipeline
  commandQueue.unshift({
    cmd: pingCmd,
    resolve: (resp) => {
      if (resp.ok) {
        state = 'ONLINE';
        log.info('pc-child online');
      } else {
        state = 'OFFLINE';
        hint = `PC automation ping failed: ${resp.error || 'unknown'}`;
      }
    },
    reject: (err) => {
      state = 'OFFLINE';
      hint = `PC automation startup failed: ${err.message}`;
    },
  });
  processQueue();
}

async function startPcChild() {
  intentionalShutdown = false;
  restartAttempts = 0;
  clearRestartTimer();
  commandQueue = [];
  commandInFlight = null;
  stdoutBuf = '';

  try {
    spawnChild();
  } catch (err) {
    state = 'OFFLINE';
    hint = `pc-child spawn failed: ${err.message}`;
    log.warn('pc-child start failed', { error: err.message });
  }
}

function shutdownPcChild() {
  intentionalShutdown = true;
  clearRestartTimer();

  // Reject all queued commands
  for (const entry of commandQueue) {
    entry.reject(new Error('PC automation shutting down'));
  }
  commandQueue = [];

  if (commandInFlight) {
    clearTimeout(commandInFlight.timer);
    commandInFlight.reject(new Error('PC automation shutting down'));
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
    } catch { /* best-effort */ }
    child = null;
  }
  state = 'OFFLINE';
}

module.exports = {
  startPcChild,
  shutdownPcChild,
  sendCommand,
  getStatus,
};
