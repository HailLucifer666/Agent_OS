'use strict';

// adapters/hermes-agent — optional coding-agent sidecar (P7 Jarvis upgrade;
// Phase 1 of the build-worker upgrade added cwd pinning, env scrubbing,
// tree-kill and `-z` scripting mode below).
//
// hermes-agent (github.com/NousResearch/Hermes-Agent, MIT) is a self-improving
// Python agent with its own learning loop. Surface probed 2026-07-17:
//   HTTP — `hermes gateway` api_server platform on :8642:
//          GET /health, POST /v1/chat/completions (OpenAI-compatible,
//          Authorization: Bearer API_SERVER_KEY)
//   CLI  — `hermes -z "<prompt>"` (documented non-interactive scripting
//          mode: prints only the final response, scriptable/cwd-pinnable —
//          needed so a build task can be driven inside a project directory)
//
// Lifecycle follows adapters/cua-driver exactly: side-effect-free require,
// nothing spawned at boot, OFFLINE until a probe succeeds, ENOENT degrades
// honestly with an install hint. MYTHOS never installs hermes itself — the
// operator opts in (see .env.example HERMES_* keys). CLI is now preferred
// when available (builds need cwd pinning, which the HTTP gateway can't
// offer); HTTP remains the fallback for the plain one-shot chat use case.

var { spawn } = require('child_process');
var { treeKill } = require('../command-runner');
var { createLogger } = require('../../src/core/logger');
var logger = createLogger(process.env.LOG_LEVEL || 'info');

var state = 'OFFLINE';       // OFFLINE | ONLINE
var mode = null;             // 'http' | 'cli' when ONLINE
var hint = 'not probed yet — call probe() or invoke hermes_task';
var lastProbeAt = 0;
var PROBE_TTL_MS = 60 * 1000;
var caps = { http: false, cli: false }; // which surfaces the last probe found reachable

function apiUrl() { return (process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/+$/, ''); }
function apiKey() { return process.env.HERMES_API_KEY || ''; }
function cliBin() { return process.env.HERMES_CLI || 'hermes'; }
function taskTimeoutMs() { return Number(process.env.HERMES_TASK_TIMEOUT_MS) || 180000; }

// With shell:true on win32, spawn() concatenates command+args into a single
// cmd.exe command line and does NOT quote them — an unquoted path containing
// a space (a HERMES_CLI pointing into "Program Files", a per-user profile
// with a space, or a venv install path) silently splits into two tokens and
// cmd.exe reports "not recognized". Only the command itself needs quoting
// here (args stay a normal array — node keeps those as real argv entries).
function quoteForWindowsShell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// System env vars a Hermes child needs just to run (PATH resolution, temp
// dirs, shell). Deliberately NOT process.env wholesale — a Hermes child must
// never see every provider key configured in mythos/.env.
var SYSTEM_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT'];
var PASSTHROUGH_PREFIX_RE = /^(HERMES_|TERMINAL_|API_SERVER_)/;

// Exactly one provider key (+ its base-URL companion) is forwarded, first
// match wins. HERMES_PROVIDER_KEY is MYTHOS-side naming and gets re-keyed to
// OPENAI_API_KEY/OPENAI_BASE_URL — the generic OpenAI-compatible shape Hermes
// understands.
var PROVIDER_KEY_PRIORITY = [
  { key: 'HERMES_PROVIDER_KEY', base: 'HERMES_PROVIDER_BASE_URL', rekeyTo: 'OPENAI_API_KEY', rekeyBaseTo: 'OPENAI_BASE_URL' },
  { key: 'NVIDIA_API_KEY', base: 'NVIDIA_BASE_URL' },
  { key: 'OPENROUTER_API_KEY', base: 'OPENROUTER_BASE_URL' },
  { key: 'OPENAI_API_KEY', base: 'OPENAI_BASE_URL' },
  { key: 'ANTHROPIC_API_KEY', base: 'ANTHROPIC_BASE_URL' },
  { key: 'GOOGLE_API_KEY', base: null },
];

// Build a minimal env object for a Hermes child process: allowlisted system
// vars + HERMES_*/TERMINAL_*/API_SERVER_* passthrough + exactly one provider
// key pair. `extra` (caller overrides) is merged in last so it always wins.
function scrubbedEnv(extra) {
  var env = {};
  for (var i = 0; i < SYSTEM_ENV_KEYS.length; i++) {
    var k = SYSTEM_ENV_KEYS[i];
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (var key in process.env) {
    if (PASSTHROUGH_PREFIX_RE.test(key)) env[key] = process.env[key];
  }
  for (var p = 0; p < PROVIDER_KEY_PRIORITY.length; p++) {
    var entry = PROVIDER_KEY_PRIORITY[p];
    if (process.env[entry.key]) {
      if (entry.rekeyTo) {
        env[entry.rekeyTo] = process.env[entry.key];
        if (entry.base && process.env[entry.base]) env[entry.rekeyBaseTo] = process.env[entry.base];
      } else {
        env[entry.key] = process.env[entry.key];
        if (entry.base && process.env[entry.base]) env[entry.base] = process.env[entry.base];
      }
      break;
    }
  }
  return Object.assign(env, extra || {});
}

// Probe both HTTP and CLI capabilities every time a probe actually runs
// (cached for PROBE_TTL_MS so repeated tool calls don't spam health checks).
// Both must be learned every probe — requireCli-driven callers need to know
// CLI reachability even when HTTP already succeeded, so we can no longer
// return early on the first hit.
async function probe(force) {
  var now = Date.now();
  if (!force && now - lastProbeAt < PROBE_TTL_MS) return state === 'ONLINE';
  lastProbeAt = now;

  var httpOk = false;
  try {
    var res = await fetch(apiUrl() + '/health', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      httpOk = true;
    } else if (!apiKey()) {
      // Reachable but rejected, and no API key configured — that's the far
      // more likely explanation and worth a distinct warning instead of
      // being merged into the generic not-installed/not-running hint below.
      logger.warn('hermes-agent.auth-unconfigured', {
        status: res.status,
        hint: 'gateway responded at ' + apiUrl() + ' but HERMES_API_KEY is unset — set it in mythos/.env if the gateway requires auth',
      });
    }
  } catch (_) { /* gateway not running */ }

  var cliOk = await new Promise(function(resolve) {
    var child;
    try {
      var bin = process.platform === 'win32' ? quoteForWindowsShell(cliBin()) : cliBin();
      child = spawn(bin, ['--version'], { windowsHide: true, shell: process.platform === 'win32', env: scrubbedEnv() });
    } catch (_) { return resolve(false); }
    var timer = setTimeout(function() { treeKill(child, child.pid); resolve(false); }, 8000);
    child.on('error', function() { clearTimeout(timer); resolve(false); });
    child.on('exit', function(code) { clearTimeout(timer); resolve(code === 0); });
  });

  caps = { http: httpOk, cli: cliOk };

  if (httpOk || cliOk) {
    state = 'ONLINE';
    mode = cliOk ? 'cli' : 'http'; // CLI preferred — builds need cwd pinning HTTP can't offer
    hint = cliOk ? 'one-shot via `' + cliBin() + ' -z <prompt>`' : 'gateway at ' + apiUrl();
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

// opts: { cwd, env, timeoutMs } — cwd pins the child to a project directory,
// env is the already-scrubbed env object, timeoutMs bounds the run. On
// timeout, tree-kill (never bare child.kill() — that orphans the process
// tree on Windows) before rejecting.
function runViaCli(prompt, opts) {
  opts = opts || {};
  var timeoutMs = opts.timeoutMs || taskTimeoutMs();
  var env = opts.env || scrubbedEnv();
  return new Promise(function(resolve, reject) {
    var child;
    try {
      var bin = process.platform === 'win32' ? quoteForWindowsShell(cliBin()) : cliBin();
      child = spawn(bin, ['-z', prompt], {
        windowsHide: true,
        shell: process.platform === 'win32',
        cwd: opts.cwd,
        env: env,
      });
    } catch (err) { return reject(err); }
    var out = '', errOut = '';
    var timer = setTimeout(function() {
      treeKill(child, child.pid);
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
//
// opts (all optional, all additive — existing no-opts callers like
// from-hermes.js's hermes_task keep working unchanged):
//   cwd            — pin the CLI child to a project directory (build tasks)
//   env            — extra env overrides merged into scrubbedEnv() (wins)
//   timeoutMs      — overrides HERMES_TASK_TIMEOUT_MS for this call
//   requireCli     — true: fail loudly instead of silently falling back to
//                    the HTTP gateway, which can't be cwd-pinned to a project
//   maxPromptChars — overrides the 8000-char default prompt clamp
async function runTask(prompt, opts) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');
  opts = opts || {};
  var online = await probe(false);
  if (!online) throw new Error('hermes-agent OFFLINE: ' + hint);
  if (opts.requireCli && !caps.cli) {
    throw new Error('hermes-agent CLI required but not available: ' + hint);
  }

  var maxPromptChars = (typeof opts.maxPromptChars === 'number') ? opts.maxPromptChars : 8000;
  var text = String(prompt).slice(0, maxPromptChars);
  var timeoutMs = opts.timeoutMs || taskTimeoutMs();
  var useCli = opts.requireCli || mode === 'cli';

  try {
    if (useCli) {
      return await runViaCli(text, { cwd: opts.cwd, env: scrubbedEnv(opts.env), timeoutMs: timeoutMs });
    }
    return await runViaHttp(text, AbortSignal.timeout(timeoutMs));
  } catch (err) {
    // A failed run invalidates the cached probe — the next call re-checks.
    lastProbeAt = 0;
    throw err;
  }
}

function getStatus() {
  return { state: state, mode: mode, hint: hint };
}

module.exports = { probe: probe, runTask: runTask, getStatus: getStatus, scrubbedEnv: scrubbedEnv };
