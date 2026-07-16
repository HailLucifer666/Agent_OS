'use strict';

// adapters/hermes-agent — optional coding-agent sidecar (P7 Jarvis upgrade).
//
// hermes-agent (github.com/NousResearch/Hermes-Agent, MIT) is a self-improving
// Python agent with its own learning loop. Surface probed 2026-07-17:
//   HTTP — `hermes gateway` api_server platform on :8642:
//          GET /health, POST /v1/chat/completions (OpenAI-compatible,
//          Authorization: Bearer API_SERVER_KEY)
//   CLI  — `hermes chat -q "<query>" --quiet` (documented one-shot
//          programmatic mode: prints only the final response)
//
// Lifecycle follows adapters/cua-driver exactly: side-effect-free require,
// nothing spawned at boot, OFFLINE until a probe succeeds, ENOENT degrades
// honestly with an install hint. MYTHOS never installs hermes itself — the
// operator opts in (see .env.example HERMES_* keys). HTTP is preferred (the
// gateway holds hermes's own memory/session state); CLI one-shot is the
// fallback.

var { spawn } = require('child_process');

var state = 'OFFLINE';       // OFFLINE | ONLINE
var mode = null;             // 'http' | 'cli' when ONLINE
var hint = 'not probed yet — call probe() or invoke hermes_task';
var lastProbeAt = 0;
var PROBE_TTL_MS = 60 * 1000;

function apiUrl() { return (process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/+$/, ''); }
function apiKey() { return process.env.HERMES_API_KEY || ''; }
function cliBin() { return process.env.HERMES_CLI || 'hermes'; }
function taskTimeoutMs() { return Number(process.env.HERMES_TASK_TIMEOUT_MS) || 180000; }

// Probe HTTP first, then CLI presence. Cached for PROBE_TTL_MS so repeated
// tool calls don't spam health checks.
async function probe(force) {
  var now = Date.now();
  if (!force && now - lastProbeAt < PROBE_TTL_MS) return state === 'ONLINE';
  lastProbeAt = now;

  try {
    var res = await fetch(apiUrl() + '/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      state = 'ONLINE'; mode = 'http'; hint = 'gateway at ' + apiUrl();
      return true;
    }
  } catch (_) { /* gateway not running — try CLI */ }

  var cliOk = await new Promise(function(resolve) {
    var child;
    try {
      child = spawn(cliBin(), ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
    } catch (_) { return resolve(false); }
    var timer = setTimeout(function() { try { child.kill(); } catch (_) {} resolve(false); }, 8000);
    child.on('error', function() { clearTimeout(timer); resolve(false); });
    child.on('exit', function(code) { clearTimeout(timer); resolve(code === 0); });
  });

  if (cliOk) {
    state = 'ONLINE'; mode = 'cli'; hint = 'one-shot via `' + cliBin() + ' chat -q`';
    return true;
  }
  state = 'OFFLINE'; mode = null;
  hint = 'hermes-agent not installed/running — install from github.com/NousResearch/Hermes-Agent, or start `hermes gateway` (set HERMES_API_URL/HERMES_API_KEY)';
  return false;
}

async function runViaHttp(prompt, signal) {
  var headers = { 'Content-Type': 'application/json' };
  if (apiKey()) headers.Authorization = 'Bearer ' + apiKey();
  var res = await fetch(apiUrl() + '/v1/chat/completions', {
    method: 'POST', headers: headers, signal: signal,
    body: JSON.stringify({ model: 'hermes-agent', messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error('hermes gateway HTTP ' + res.status);
  var data = await res.json();
  var msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return (msg && msg.content) || '';
}

function runViaCli(prompt, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var child;
    try {
      child = spawn(cliBin(), ['chat', '-q', prompt, '--quiet'], { windowsHide: true, shell: process.platform === 'win32' });
    } catch (err) { return reject(err); }
    var out = '', errOut = '';
    var timer = setTimeout(function() {
      try { child.kill(); } catch (_) {}
      reject(new Error('hermes CLI timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.stdout.on('data', function(d) { out += d; });
    child.stderr.on('data', function(d) { errOut += d; });
    child.on('error', function(err) { clearTimeout(timer); reject(err); });
    child.on('exit', function(code) {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error('hermes CLI exit ' + code + (errOut ? ': ' + errOut.slice(0, 300) : '')));
    });
  });
}

// Run one coding/agent task through hermes. Probes first; throws with the
// install hint when unavailable (callers surface it honestly).
async function runTask(prompt) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');
  var online = await probe(false);
  if (!online) throw new Error('hermes-agent OFFLINE: ' + hint);
  var text = String(prompt).slice(0, 8000);
  try {
    if (mode === 'http') {
      return await runViaHttp(text, AbortSignal.timeout(taskTimeoutMs()));
    }
    return await runViaCli(text, taskTimeoutMs());
  } catch (err) {
    // A failed run invalidates the cached probe — the next call re-checks.
    lastProbeAt = 0;
    throw err;
  }
}

function getStatus() {
  return { state: state, mode: mode, hint: hint };
}

module.exports = { probe: probe, runTask: runTask, getStatus: getStatus };
