'use strict';

// adapters/pc-child/index.js — untouched CA of app/lib/voice/pc-child.js. Lifecycle
// management for the PowerShell PC automation child process. Only re-pointing: NOVA's
// `const { log } = require('../logger')` (a singleton) -> a logger instance obtained
// from MYTHOS's createLogger() factory (mythos/src/core/logger.js has no singleton
// export — every other MYTHOS module constructs its own logger instance, so this file
// does the same at require time; side-effect-free, matches this file's own "side-effect-
// free require" contract).
//
// Follows the same singleton pattern as NOVA's s2s-child.js: side-effect-free require,
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
const { createLogger } = require('../../src/core/logger');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const RING_BUFFER_MAX_LINES = 100;
const MAX_RESTART_ATTEMPTS = 2;
const RESTART_BACKOFF_MS = [2000, 5000];
const COMMAND_TIMEOUT_MS = 15000; // 15s per command
// BUG-141(b): STARTUP_TIMEOUT_MS (5s) is deliberately shorter than
// COMMAND_TIMEOUT_MS (15s). The startup ping is queued through the SAME
// pipeline as any other command (processQueue()), so it carries the full
// 15s in-flight timer even though handleStartup() gives up polling and
// reports state OFFLINE at 5s. That means a caller who sees OFFLINE at 5s
// and retries/restarts can still be delayed behind the stale ping occupying
// commandInFlight for up to 10 more seconds. Known, accepted split — see
// startPcChild()'s call site for why cancelling it outright isn't done here.
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
let commandInFlight = null; // { resolve, reject, timer, id, cmdName, sentAt }
// Monotonic id stamped onto every command and echoed back by ps-automation.ps1.
// Without it, a slow command's late response (arriving after its 15s timeout)
// gets matched to whatever command is in-flight NEXT — a permanent off-by-one
// under queue pressure (found live 2026-07-17 while chasing BUG-038).
let nextCommandId = 1;

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
        // Correlate by id: a late response from an already-timed-out command must
        // NOT resolve the next command. Responses without an id (old script) are
        // accepted for compatibility; mismatched ids are logged and dropped.
        if (parsed && parsed.id !== undefined && parsed.id !== commandInFlight.id) {
          log.warn('pc-child stale response dropped', { expected: commandInFlight.id, got: parsed.id });
          pushRingLine(`[stale-response id=${parsed.id}] ${line.slice(0, 200)}`);
          continue;
        }
        clearTimeout(commandInFlight.timer);
        const resolve = commandInFlight.resolve;
        const elapsedMs = Date.now() - commandInFlight.sentAt;
        log.info('pc-child response', { cmd: commandInFlight.cmdName, ok: parsed.ok !== false, elapsedMs, queueDepth: commandQueue.length });
        commandInFlight = null;
        resolve(parsed);
        processQueue();
      } catch {
        // Not valid JSON — treat as diagnostic
        pushRingLine(line);
        log.warn('pc-child unparseable line', { preview: line.slice(0, 200) });
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
  const id = nextCommandId++;
  const cmdName = cmd && cmd.cmd;
  commandInFlight = { resolve, reject, timer: null, id, cmdName, sentAt: Date.now() };

  const timer = setTimeout(() => {
    if (commandInFlight === null || commandInFlight.id !== id) return; // already resolved
    const rejectFn = commandInFlight.reject;
    log.warn('pc-child command timeout', { cmd: cmdName, id, timeoutMs: COMMAND_TIMEOUT_MS, queueDepth: commandQueue.length });
    commandInFlight = null;
    rejectFn(new Error('PC automation command timed out'));
    processQueue(); // process next
  }, COMMAND_TIMEOUT_MS);

  commandInFlight.timer = timer;

  try {
    const jsonStr = JSON.stringify({ ...cmd, id });
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
    // Hard-offline guard: with no child and no restart pending, a queued command
    // would sit forever (queued commands carry no timeout — the 15s timer only
    // starts when a command goes in-flight). Reject fast instead.
    if (!child && !restartTimer && state === 'OFFLINE') {
      reject(new Error('PC automation offline'));
      return;
    }
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

  // Guard both streams by identity: an orphaned previous child must never feed
  // the shared line buffer / in-flight state once a newer child owns them.
  if (proc.stdout) proc.stdout.on('data', (c) => { if (proc === child) handleStdoutChunk(c); });
  if (proc.stderr) proc.stderr.on('data', (c) => { if (proc === child) handleStderrChunk(c); });

  proc.on('error', (err) => {
    pushRingLine(`[pc-child] spawn error: ${err.message}`);
    if (proc !== child) return; // stale process — a newer child already replaced it
    state = 'OFFLINE';
    hint = `Failed to start PowerShell: ${err.message}`;
    child = null;
  });

  proc.on('exit', (code, signal) => {
    // A previous child's late exit event must not clobber the state of a newer
    // child that already replaced it (restart races).
    if (proc !== child) return;
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
      // BUG-141(b): commandInFlight is still occupied by this same ping (it
      // carries the full 15s COMMAND_TIMEOUT_MS, not STARTUP_TIMEOUT_MS) —
      // free the slot now so a newly-queued command isn't stuck behind it
      // for up to 10 more seconds. Matched by id so this only ever touches
      // THIS ping's own in-flight entry, never a normal command's timeout
      // or the queue/timeout semantics those use.
      if (commandInFlight && commandInFlight.id === startupPingId) {
        clearTimeout(commandInFlight.timer);
        commandInFlight = null;
        processQueue();
      }
      return;
    }
    setTimeout(handleStartup, 100);
  };
  // BUG (found live-verifying F5b, previously latent): handleStartup was
  // defined but never actually kicked off anywhere — its own recursive
  // setTimeout is unreachable without a first call. getStatus() therefore
  // never reported OFFLINE at STARTUP_TIMEOUT_MS at all; state sat at
  // STARTING until the ping's own resolve/reject eventually fired via the
  // 15s command timeout. Start the loop.
  setTimeout(handleStartup, 100);

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
  // BUG-141(b): capture the id processQueue() just assigned to this ping so
  // handleStartup's timeout above can identify (and only ever identify)
  // this exact slot later.
  const startupPingId = commandInFlight ? commandInFlight.id : null;
}

async function startPcChild() {
  // BUG-141(a): startPcChild() used to spawn unconditionally — if ever called
  // while a previous child was still alive, that old process was orphaned:
  // never killed, only abandoned once the `proc !== child` identity guards
  // in spawnChild() started ignoring its events. Currently latent (the only
  // call site is main.js, once at boot), but defend it anyway. Reuses the
  // same kill path shutdownPcChild() uses — no second kill mechanism.
  killLiveChild();

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

// BUG-141(a): the actual process-kill, shared by shutdownPcChild() and
// startPcChild()'s defensive guard below — one kill mechanism, not two.
// Best-effort; never throws. Leaves `child` null so a stale process's later
// 'exit'/'error' events fail the `proc !== child` identity guard in
// spawnChild() and are ignored, same as any other orphan race in this file.
function killLiveChild() {
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

  killLiveChild();
  state = 'OFFLINE';
}

module.exports = {
  startPcChild,
  shutdownPcChild,
  sendCommand,
  getStatus,
};
