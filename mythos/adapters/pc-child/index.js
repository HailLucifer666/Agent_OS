'use strict';
const { childRuntimeDir } = require('../../src/core/util/child-runtime');

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
// B2e: the only route an operator's approval takes onto an input command.
const inputApproval = require('./input-approval');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const RING_BUFFER_MAX_LINES = 100;
const MAX_RESTART_ATTEMPTS = 2;
// Env overrides exist so the lifecycle tests can exercise the real timeout /
// backoff code paths in milliseconds instead of tens of seconds. Production
// never sets them; the defaults below are the real values.
const RESTART_BACKOFF_MS = process.env.PC_CHILD_RESTART_BACKOFF_MS
  ? process.env.PC_CHILD_RESTART_BACKOFF_MS.split(',').map(Number)
  : [2000, 5000];
const COMMAND_TIMEOUT_MS = 15000; // 15s per command
// BUG-335 (2026-08-24): an input-injecting command whose child outlives the
// caller's patience gets the child KILLED, because a PowerShell mid-SendInput
// cannot be told to abandon the keystrokes — killing it is the only way to
// guarantee the action cannot land after the caller already saw "timed out"
// and retried. Those kill-restarts draw their OWN budget below, never the
// crash budget (MAX_RESTART_ATTEMPTS=2): otherwise two wedged ui_types would
// permanently offline desktop automation, trading a double-typing bug for a
// dead surface. Looker commands keep today's behaviour plus a visible bell.
const INPUT_INJECTING_CMDS = new Set(['ui_type', 'ui_click', 'click_at', 'right_click_at', 'send_key', 'drag']);
const MAX_TIMEOUT_RESTARTS = 3;
const TIMEOUT_RESTART_WINDOW_MS = 10 * 60 * 1000;
// BUG-141(b): STARTUP_TIMEOUT_MS is deliberately shorter than
// COMMAND_TIMEOUT_MS (15s). The startup ping is queued through the SAME
// pipeline as any other command (processQueue()), so it carries the full
// 15s in-flight timer even though handleStartup() gives up polling and
// reports state OFFLINE at the startup deadline. That means a caller who
// sees OFFLINE and retries/restarts can still be delayed behind the stale
// ping occupying commandInFlight. handleStartup() frees that slot itself
// (matched by id) to keep the window small.
//
// BUG-167: raised 5s -> 12s. The first `powershell.exe` spawn after boot
// (cold script cache, Defender on-access scan of the .ps1) routinely takes
// longer than 5s on real machines, and a handshake that missed the deadline
// used to leave the adapter OFFLINE *forever* with a live zombie child. The
// split with COMMAND_TIMEOUT_MS is preserved (12s < 15s).
const STARTUP_TIMEOUT_MS = Number(process.env.PC_CHILD_STARTUP_TIMEOUT_MS) || 12000;

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
let timeoutRestartTimes = []; // Date.now() stamps of recent timeout-restarts (BUG-335 budget)
let lateCompletionSink = null; // set via startPcChild({lateCompletionSink}); emits health.anomaly
let spawnImpl = null; // test seam: startPcChild({spawnImpl}); production uses real spawn
let commandTimeoutMs = COMMAND_TIMEOUT_MS; // test seam: startPcChild({commandTimeoutMs})

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
          // BUG-335 bell (looker path): a response arriving after its caller
          // was told "timed out" means the action DID run. Never silently
          // swallow that again — hand it to the immune system.
          if (lateCompletionSink) {
            try {
              lateCompletionSink({
                expectedId: commandInFlight.id,
                gotId: parsed.id,
                cmdName: commandInFlight.cmdName,
                preview: line.slice(0, 200),
              });
            } catch (_) { /* sink must never break the dispatch loop */ }
          }
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
      // No command in flight — diagnostics, or a LATE response to an
      // already-timed-out command (BUG-335): with nothing in flight the id
      // guard below never even runs, which is exactly how a late completion
      // used to vanish into chatter. Ring the bell before filing it.
      let lateParsed = null;
      try { lateParsed = JSON.parse(line); } catch (_) { /* genuine chatter */ }
      if (lateParsed && lateParsed.id !== undefined && lateCompletionSink) {
        try {
          lateCompletionSink({ expectedId: null, gotId: lateParsed.id, cmdName: lateParsed.cmd || null, preview: line.slice(0, 200) });
        } catch (_) { /* sink must never break the dispatch loop */ }
      }
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
    const touchesWorld = INPUT_INJECTING_CMDS.has(cmdName);
    log.warn('pc-child command timeout', { cmd: cmdName, id, touchesWorld, timeoutMs: commandTimeoutMs, queueDepth: commandQueue.length });
    commandInFlight = null;
    if (touchesWorld) {
      // BUG-335: the child cannot be told to abandon keystrokes it is mid-way
      // through sending — kill it so the action cannot land after the caller
      // was told it failed and retried. Its restarts draw their own budget.
      const now = Date.now();
      timeoutRestartTimes = timeoutRestartTimes.filter((t) => now - t < TIMEOUT_RESTART_WINDOW_MS);
      if (timeoutRestartTimes.length >= MAX_TIMEOUT_RESTARTS) {
        killLiveChild();
        state = 'OFFLINE';
        hint = 'PC automation exceeded the command-timeout restart budget ('
          + MAX_TIMEOUT_RESTARTS + ' input-injecting timeouts in '
          + Math.round(TIMEOUT_RESTART_WINDOW_MS / 60000) + ' minutes). Re-probe health before retrying.';
        log.warn('pc-child exceeded timeout restart budget', {});
        // BUG-355: everything queued behind this command must settle too.
        // The old branch rejected only the in-flight entry and returned, so
        // callers of already-queued commands hung forever on a promise that
        // would never resolve (reproduced via spawnImpl; scratch -> this test).
        const drained = commandQueue.splice(0, commandQueue.length);
        for (const entry of drained) {
          try { entry.reject(new Error('PC automation offline: ' + hint)); } catch (_) {}
        }
        rejectFn(new Error(hint));
        return;
      }
      timeoutRestartTimes.push(now);
      killLiveChild();
      scheduleRestart('command-timeout:' + cmdName, { skipCrashBudget: true });
      rejectFn(new Error('PC automation command timed out; child restarted so it cannot execute late'));
    } else {
      rejectFn(new Error('PC automation command timed out'));
    }
    processQueue(); // process next
  }, commandTimeoutMs);

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
    // B2e: stamped HERE, in the caller's own async context — once queued, the
    // command leaves that context. See input-approval.js.
    commandQueue.push({ cmd: inputApproval.stamp(cmdObj), resolve, reject });
    processQueue();
  });
}

// ---- Child process lifecycle ----

// BUG-167: the exponential-backoff restart used to live inline in the 'exit'
// handler, so it was reachable ONLY when the child actually died. A child
// that spawned but never answered the startup ping (hung PowerShell, AV
// scan, a parse error that never reaches stdout) left the adapter OFFLINE
// permanently — every desktop-control effector dead for the rest of the
// session, with a live zombie process still holding the pipes. Extracted so
// the handshake-timeout path enters the SAME sequence.
// Returns true if a restart was scheduled.
// opts.skipCrashBudget (BUG-335): timeout-kill restarts pass true — they are
// budgeted by MAX_TIMEOUT_RESTARTS in the caller and must NOT consume
// restartAttempts, or two wedged ui_types would exhaust the crash budget and
// permanently offline desktop automation.
function scheduleRestart(reason, opts) {
  const o = opts || {};
  if (intentionalShutdown) return false;

  if (!o.skipCrashBudget && restartAttempts >= MAX_RESTART_ATTEMPTS) {
    state = 'OFFLINE';
    hint = 'PC automation exceeded restart budget. Retry with a health re-probe.';
    log.warn('pc-child exceeded restart attempts', { reason });
    return false;
  }

  const backoffIdx = o.skipCrashBudget ? 0 : restartAttempts;
  const backoffMs = RESTART_BACKOFF_MS[backoffIdx] || RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];
  if (!o.skipCrashBudget) restartAttempts += 1;
  log.warn('pc-child restarting', { attempt: restartAttempts, backoffMs, reason });
  state = 'STARTING';
  clearRestartTimer();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnChild();
  }, backoffMs);
  if (restartTimer.unref) restartTimer.unref();
  return true;
}

// Diagnostic tail for handshake failures: the child's stderr has always been
// captured into the ring buffer and then never looked at, so a failed
// handshake reported "timed out" and nothing else. Surface it.
function recentStderr(maxLines = 20) {
  return ringBuffer
    .filter((line) => line.startsWith('[stderr]'))
    .slice(-maxLines);
}

function ownPids() {
  return [process.pid, process.ppid].filter((n) => Number.isInteger(n) && n > 0).join(',');
}

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
    // B2e: MYTHOS's own processes — this server and the process that started it
    // (Electron's main process, which owns the HUD window). ps-automation.ps1
    // refuses any keystroke or click into their windows. Fixed for the child's life.
    '-InputOwnPids', ownPids(),
  ];

  const proc = (spawnImpl || spawn)('powershell.exe', args, {
    cwd: childRuntimeDir(),
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
    scheduleRestart(`exit code=${code} signal=${signal}`);
  });

  // Startup handshake: send ping, wait for pong
  const pingCmd = { cmd: 'ping' };
  const pingStart = Date.now();

  const handleStartup = () => {
    if (state === 'ONLINE') return; // already resolved
    // BUG-167: if this child is already gone (spawn 'error' / 'exit' fired,
    // or a newer child replaced it) the poll has nothing left to wait for —
    // those handlers own the outcome. Stop instead of running the clock down
    // and then "timing out" a process that never existed.
    if (proc !== child) return;
    const elapsed = Date.now() - pingStart;
    if (elapsed > STARTUP_TIMEOUT_MS) {
      const stderr = recentStderr();
      // BUG-167: the child's own stderr was captured and never surfaced, so
      // every handshake failure looked identical and undiagnosable.
      log.warn('pc-child.handshake-timeout', {
        timeoutMs: STARTUP_TIMEOUT_MS,
        restartAttempts,
        stderr,
      });
      // BUG-141(b): commandInFlight is still occupied by this same ping (it
      // carries the full 15s COMMAND_TIMEOUT_MS, not STARTUP_TIMEOUT_MS) —
      // free the slot now so a newly-queued command isn't stuck behind it
      // for up to 3 more seconds. Matched by id so this only ever touches
      // THIS ping's own in-flight entry, never a normal command's timeout
      // or the queue/timeout semantics those use.
      if (commandInFlight && commandInFlight.id === startupPingId) {
        clearTimeout(commandInFlight.timer);
        commandInFlight = null;
      }
      // BUG-167: the child is hung, not dead — 'exit' will never fire, so
      // nothing else will ever restart it. Kill it (otherwise it lingers as
      // a zombie holding the pipes) and enter the same backoff sequence an
      // unexpected exit uses. killLiveChild() nulls `child`, so this child's
      // later exit event fails the `proc !== child` guard and is ignored.
      killLiveChild();
      if (!scheduleRestart('handshake-timeout')) {
        state = 'OFFLINE';
        hint = stderr.length
          ? `PC automation startup handshake timed out. Last child stderr: ${stderr[stderr.length - 1]}`
          : 'PC automation startup handshake timed out.';
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

async function startPcChild(opts) {
  const o = opts || {};
  // BUG-335 seams: tests inject a fake child factory; main.js injects the
  // late-completion sink that turns dropped stale responses into anomalies.
  spawnImpl = o.spawnImpl || null;
  lateCompletionSink = o.lateCompletionSink || null;
  timeoutRestartTimes = [];
  commandTimeoutMs = o.commandTimeoutMs || COMMAND_TIMEOUT_MS;
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

// BUG-167: once the restart budget is spent the adapter is OFFLINE with no
// way back short of restarting the whole app — sendCommand() rejects
// immediately and nothing ever tries to spawn again. This is the recovery
// surface: an explicit, operator/health-check-driven re-probe that resets the
// budget and tries once more. Idempotent — a no-op while a child is alive or
// a restart is already pending, so a periodic health check can call it
// blindly without stacking spawns.
function probePcChild() {
  if (intentionalShutdown) return getStatus();
  if (child || restartTimer) return getStatus();
  if (state === 'ONLINE') return getStatus();

  log.info('pc-child re-probe requested', { previousHint: hint });
  restartAttempts = 0;
  hint = null;
  try {
    spawnChild();
  } catch (err) {
    state = 'OFFLINE';
    hint = `pc-child re-probe failed: ${err.message}`;
    log.warn('pc-child re-probe failed', { error: err.message });
  }
  return getStatus();
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
  probePcChild,
  sendCommand,
  getStatus,
};
