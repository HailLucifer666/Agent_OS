'use strict';
const { childRuntimeDir, childCommand } = require('../../src/core/util/child-runtime');

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
// BUG-354, mirroring BUG-335 in pc-child. A call that INJECTS INPUT and outlives
// the caller's patience gets the driver KILLED: a driver mid-SendInput cannot be
// told to abandon the input, so killing it is the only way to stop the action
// landing after the caller was already told it failed. Read-only calls keep
// today's behaviour - a slow tree read changes nothing in the world, and killing
// the driver for one trades a harmless wait for a dead surface.
//
// `bring_to_front` is deliberately NOT here. It moves foreground focus, so it is
// not read-only, but it injects nothing and is idempotent: running it twice
// leaves the same window in front. The set is input injection, not side effects.
const INPUT_INJECTING_TOOLS = new Set(['click']);
// Timeout-kills draw their OWN budget and never the crash budget above
// (MAX_RESTART_ATTEMPTS = 2, spent from the `exit` handler). Without the split,
// two wedged clicks would leave desktop automation permanently OFFLINE - a dead
// surface traded for a double-click bug, which is the worse of the two.
const MAX_TIMEOUT_RESTARTS = 3;
const TIMEOUT_RESTART_WINDOW_MS = 10 * 60 * 1000;
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
let timeoutRestartTimes = [];   // Date.now() stamps of recent timeout-kills (BUG-354 budget)
let skipCrashBudget = false;    // set by a timeout-kill so `exit` does not spend restartAttempts
// WHY THIS EXISTS AND pc-child NEEDS NO EQUIVALENT: pc-child restarts from an
// explicit scheduleRestart() call, so simply not calling it is enough. THIS
// adapter restarts from its `exit` handler, so a kill schedules a restart all by
// itself. Without this flag the budget-exhausted branch below set state OFFLINE
// and then its OWN kill brought the driver back ONLINE a few milliseconds later -
// a guard undone by its own action, and it announced the offline state first so
// the logs read as if it had held. Copying BUG-335's SHAPE without checking this
// adapter's restart MECHANISM is what produced it.
let noRestartAfterKill = false;
let timedOutIds = new Set();    // ids whose caller has already given up (late-response bell)
// Test seams, mirroring pc-child's. Production passes none of them.
let spawnImpl = null;
let commandTimeoutMs = COMMAND_TIMEOUT_MS;
let restartBackoffMs = RESTART_BACKOFF_MS;
// A seam because the real window is ten minutes: without it no test can prove
// that stamps EXPIRE, and a budget that never forgets is a budget that offlines
// the surface after three timeouts spread across a whole day.
let timeoutRestartWindowMs = TIMEOUT_RESTART_WINDOW_MS;

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
    } else if (msg && msg.id !== undefined && timedOutIds.has(msg.id)) {
      // BUG-354: the answer to a call whose caller already gave up. Matching is
      // by id, so it cannot be misattributed to the NEXT command - but dropping
      // it silently into the ring buffer is how "the click did land, late" stays
      // invisible. Only read-only calls reach here: a timed-out input-injecting
      // call kills the driver, so its late answer has nowhere to come from.
      timedOutIds.delete(msg.id);
      log.warn('cua-driver.late-completion', { id: msg.id, isError: !!(msg.result && msg.result.isError) });
      pushRingLine(`[cua-driver] late completion for id ${msg.id} (caller already gave up)`);
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

// A timeout and a tool error both surface as ok:false, and from-cua.js answered
// both by clicking again. The flag is how a caller tells 'the driver refused' from
// 'the driver never answered and may still be working'.
function timeoutError(message) {
  const err = new Error(message);
  err.timedOut = true;
  return err;
}

// Kill the live child WITHOUT spending the crash budget. The `exit` handler is
// what restarts, so the flag has to be set before the process dies.
function killLiveChild(opts) {
  skipCrashBudget = true;
  noRestartAfterKill = !!(opts && opts.noRestart);
  const proc = child;
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid && proc.kill === undefined) {
      require('child_process').execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    } else {
      proc.kill('SIGTERM');
    }
  } catch (_) { /* best-effort */ }
  // A real child emits 'exit' asynchronously and the handler below restarts it.
  // A fake one in a test may not, so nothing here depends on the event firing.
  if (proc.emit && proc.exitCode === undefined && !proc.__exitEmitted) {
    proc.__exitEmitted = true;
    setImmediate(() => proc.emit('exit', null, 'SIGTERM'));
  }
}
function processQueue() {
  if (commandInFlight || commandQueue.length === 0 || !child) return;

  const { request, resolve, reject } = commandQueue.shift();
  const id = request.id;
  // The tool name lives in the MCP params, not the JSON-RPC method - every tool
  // call is method 'tools/call'. Reading `method` here would classify a click as
  // read-only and defeat the whole split.
  const toolName = (request.method === 'tools/call' && request.params && request.params.name) || null;
  // B3b, at the moment of sending: a click queued before a confirmation dialog
  // opened is refused here, not written to the driver after it (2026-10-05).
  if (toolName !== null && inputInhibit.isInputInhibited() && !READ_ONLY_TOOLS.has(toolName)) {
    resolve({ error: { message: inputInhibit.REFUSAL } });
    processQueue();
    return;
  }
  commandInFlight = { id: id, resolve: resolve, reject: reject, timer: null, toolName: toolName };

  const timer = setTimeout(() => {
    if (commandInFlight === null || commandInFlight.id !== id) return;
    const rejectFn = commandInFlight.reject;
    const touchesWorld = toolName !== null && INPUT_INJECTING_TOOLS.has(toolName);
    log.warn('cua-driver.command-timeout', { tool: toolName, id, touchesWorld, timeoutMs: commandTimeoutMs, queueDepth: commandQueue.length });
    commandInFlight = null;
    timedOutIds.add(id);
    if (!touchesWorld) {
      rejectFn(timeoutError('cua-driver command timed out'));
      processQueue();
      return;
    }
    // BUG-354: the driver cannot be told to abandon input it is mid-way through
    // sending - kill it so the action cannot land after the caller was told it
    // failed. Its restarts draw their own budget, never the crash budget.
    const now = Date.now();
    timeoutRestartTimes = timeoutRestartTimes.filter((stamp) => now - stamp < timeoutRestartWindowMs);
    if (timeoutRestartTimes.length >= MAX_TIMEOUT_RESTARTS) {
      killLiveChild({ noRestart: true });
      state = 'OFFLINE';
      hint = 'cua-driver exceeded the command-timeout restart budget ('
        + MAX_TIMEOUT_RESTARTS + ' input-injecting timeouts in '
        + Math.round(timeoutRestartWindowMs / 60000) + ' minutes). Re-probe health before retrying.';
      log.warn('cua-driver.timeout-budget-exhausted', {});
      // BUG-355's lesson is that rejecting only the in-flight command strands
      // every caller already queued behind it. pc-child needed an explicit drain
      // here; THIS adapter does not, and the difference is worth stating because
      // an explicit one looks like diligence: the killLiveChild() above makes the
      // child emit 'exit', and that handler already rejects commandQueue and
      // empties it. A drain added here as well is unreachable — by the time this
      // branch runs there is either a live child (killed, so exit drains) or the
      // child already died (its exit already drained). Code no test can justify
      // is code the next reader has to re-derive, so it is not here. The
      // queued-callers-settle property is pinned by the BUG-355 test regardless
      // of which mechanism delivers it.
      rejectFn(timeoutError(hint));
      return;
    }
    timeoutRestartTimes.push(now);
    killLiveChild();
    rejectFn(timeoutError('cua-driver command timed out; the driver was restarted so it cannot execute late'));
    processQueue();
  }, commandTimeoutMs);
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

const inputInhibit = require('../input-inhibit');
const READ_ONLY_TOOLS = new Set(['list_windows', 'get_window_state']);

// B2e (2026-09-29 audit, review 2026-09-30): cua-driver's clicks never reach
// ps-automation.ps1's input gate, so the same judgement runs here, at this
// adapter's one door, for every tool that is not a read: the window the call
// acts in (named by its pid - without one there is nothing to check, so it is
// refused) is asked of pc-child's read-only input_target; MYTHOS's own window and
// an unidentifiable one are refused; a command window runs only inside the
// operator's approval scope for that exact window (pc-child/input-approval.js).
// Every caller is covered - cua_click and spotify_play's direct clicks alike.
const CUA_NOT_INPUT = new Set(['list_windows', 'get_window_state', 'bring_to_front']);
async function inputGate(toolName, args) {
  if (CUA_NOT_INPUT.has(toolName)) return null;
  const pid = Number(args && args.pid);
  if (!Number.isInteger(pid) || pid <= 0) return 'Refused: a cua-driver ' + toolName + ' needs the pid of its window, so that window can be checked first. Nothing was sent.';
  const pcChild = require('../pc-child');
  const inputApproval = require('../pc-child/input-approval');
  let res;
  try { res = await pcChild.sendCommand({ cmd: 'input_target', target: { cmd: 'ui_click', pid } }); } catch (err) { res = { ok: false, error: err && err.message }; }
  const w = res && res.ok && res.result && Array.isArray(res.result.windows) ? res.result.windows[0] : null;
  if (!w) return 'Refused: the window for pid ' + pid + ' could not be checked (' + String((res && res.error) || 'no answer') + '). Nothing was sent.';
  if (w.kind === 'own') return 'Refused: pid ' + pid + ' is MYTHOS\'s own window (' + w.why + '). MYTHOS never clicks into itself; its prompts are the operator\'s to answer.';
  if (w.kind === 'unknown') return 'Refused: the window for pid ' + pid + ' could not be identified (' + w.why + '). Nothing was sent.';
  if (w.kind === 'command') {
    const approved = inputApproval.currentApproved() || [];
    const same = approved.some((a) => a.pid === Number(w.pid) && a.start === String(w.start || '') && (!a.hwnd || a.hwnd === Number(w.hwnd)));
    if (!same) return 'Refused: pid ' + pid + ' is ' + (w.process || 'a program') + ' - ' + w.why + '. Input there can run commands, so it needs the operator\'s approval for this one call.';
  }
  return null;
}

// The server acks a confirmation's inhibit only once no input call is still
// running here, as it does for pc-child (whenInputIdle there). true = idle.
function whenInputIdle(maxMs) {
  const until = Date.now() + (Number(maxMs) || 2000);
  return new Promise((resolve) => {
    (function poll() {
      const busy = commandInFlight && commandInFlight.toolName && !READ_ONLY_TOOLS.has(commandInFlight.toolName);
      if (!busy) return resolve(true);
      if (Date.now() > until) return resolve(false);
      setTimeout(poll, 20);
    })();
  });
}

// Call a cua-driver MCP tool (names confirmed against 0.8.3 — see header).
// Returns { ok, result } where result is the FULL MCP tool result object
// ({ content, structuredContent, isError }) so callers can read
// structuredContent.elements etc.; on failure result is an error string.
async function invoke(toolName, args) {
  // B3b: while a MYTHOS confirmation dialog is open, only the read tools run
  // (adapters/input-inhibit.js). Everything else could click or focus.
  // Runs BEFORE the identity gate: it needs no pid and no round-trip, so it
  // answers the cheapest, most absolute refusal first.
  if (inputInhibit.isInputInhibited() && !READ_ONLY_TOOLS.has(toolName)) {
    return { ok: false, result: inputInhibit.REFUSAL };
  }
  const refusal = await inputGate(toolName, args);
  if (refusal) return { ok: false, result: refusal };
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
    // The flag rides out with the failure. Without it a caller sees only
    // ok:false and cannot tell a refusal from a driver that never answered and
    // may still be mid-click (BUG-354).
    const out = { ok: false, result: err.message };
    if (err && err.timedOut) out.timedOut = true;
    return out;
  }
}

// ---- Child process lifecycle (mirrors pc-child/index.js) ----
function spawnChild() {
  state = 'STARTING';
  hint = null;

  let proc;
  try {
    proc = spawnImpl
      ? spawnImpl(resolveBinary(), ['mcp'])
      : spawn(childCommand(resolveBinary()), ['mcp'], { cwd: childRuntimeDir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (noRestartAfterKill) {
      // The timeout budget is spent. Stay down and KEEP the hint that says why -
      // coming back up here is what made the exhausted branch a no-op.
      noRestartAfterKill = false;
      skipCrashBudget = false;
      state = 'OFFLINE';
      return;
    }
    if (code === 0) {
      state = 'OFFLINE';
      return;
    }
    if (!skipCrashBudget) pushRingLine(`[cua-driver] exited unexpectedly (code=${code}, signal=${signal})`);

    // BUG-354: a timeout-kill is not a crash and must not spend the crash
    // budget. Two wedged clicks would otherwise offline desktop automation for
    // good. Its own budget was already charged at the kill site.
    const wasTimeoutKill = skipCrashBudget;
    skipCrashBudget = false;
    if (!wasTimeoutKill && (notInstalled || restartAttempts >= MAX_RESTART_ATTEMPTS)) {
      state = 'OFFLINE';
      hint = hint || 'cua-driver exceeded restart budget.';
      return;
    }
    if (wasTimeoutKill && notInstalled) {
      state = 'OFFLINE';
      return;
    }

    const backoffMs = restartBackoffMs[restartAttempts] || restartBackoffMs[restartBackoffMs.length - 1];
    if (!wasTimeoutKill) restartAttempts += 1;
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

function startCuaDriver(opts) {
  const o = opts || {};
  intentionalShutdown = false;
  restartAttempts = 0;
  notInstalled = false;
  clearRestartTimer();
  commandQueue = [];
  commandInFlight = null;
  stdoutBuf = '';
  timeoutRestartTimes = [];
  skipCrashBudget = false;
  noRestartAfterKill = false;
  timedOutIds = new Set();
  // Test seams, mirroring pc-child's. main.js calls this with no arguments, so
  // production always gets the real spawn and the real 15s timeout.
  spawnImpl = typeof o.spawnImpl === 'function' ? o.spawnImpl : null;
  commandTimeoutMs = typeof o.commandTimeoutMs === 'number' ? o.commandTimeoutMs : COMMAND_TIMEOUT_MS;
  restartBackoffMs = Array.isArray(o.restartBackoffMs) ? o.restartBackoffMs : RESTART_BACKOFF_MS;
  timeoutRestartWindowMs = typeof o.timeoutRestartWindowMs === 'number' ? o.timeoutRestartWindowMs : TIMEOUT_RESTART_WINDOW_MS;

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
  whenInputIdle: whenInputIdle,
  getStatus: getStatus
};
