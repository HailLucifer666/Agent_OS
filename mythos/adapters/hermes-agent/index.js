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
// REMEDIATION P0-1 (item 6): raised from a hardcoded 8000ms — live-verified
// `hermes --version` returns in ~800ms under scrubbedEnv(), so 8s was never
// actually the bottleneck for the 2026-07-29 incident, but a slow/cold-start
// machine deserves headroom; still overridable per the same env-driven
// pattern as taskTimeoutMs() above.
// 2026-07-31, measured on the operator's machine WHILE MYTHOS was running:
// `hermes --version` took 21.2s (venv Python 3.11 importing the OpenAI SDK on
// Windows under load). Against the old 15s cap the probe timed out, the adapter
// declared OFFLINE, and every build failed with "hermes-agent not
// installed/running" — with Hermes installed and working. Same command took
// ~800ms on an idle machine, which is how 15s ever looked generous.
function cliProbeTimeoutMs() { return Number(process.env.HERMES_CLI_PROBE_TIMEOUT_MS) || 30000; }

// Last CLI probe's failure diagnostic — {kind, code?, signal?, detail?} or
// null when the last probe succeeded. Surfaced via getStatus() so a P0-1-class
// failure (build engine OFFLINE) is diagnosable instead of a silent
// resolve(false): a spawn ENOENT (binary genuinely missing), an EACCES
// (present but blocked), a timeout (hung child), and a non-zero exit are all
// distinct root causes that previously collapsed into one indistinguishable
// "not installed/running" hint.
var lastCliProbeDiagnostic = null;

// Transport selection. shell:true was previously used unconditionally on win32
// to survive a HERMES_CLI path containing a space — but that cure was worse
// than the disease: with shell enabled, spawn() concatenates command AND args
// into one cmd.exe command line WITHOUT quoting them, so
//   1. a 24000-char build prompt (hermes-runner.js maxPromptChars) blows past
//      cmd.exe's 8191-char command-line limit, and
//   2. the prompt re-splits on spaces into dozens of argv entries, with its
//      quotes stripped — Hermes receives a shredded fragment, not the prompt.
// shell:false passes argv through verbatim and handles spaces in the command
// path correctly on its own, so it is now the default everywhere.
//
// The one case that still needs a shell is a .bat/.cmd target: Node refuses to
// spawn those without shell:true (CVE-2024-27980). That path is kept working
// but warned about loudly, because it reintroduces both problems above — a
// .bat shim (e.g. one forwarding into WSL) cannot carry a real build prompt.
function needsShell(bin) { return /\.(bat|cmd)$/i.test(String(bin || '').trim()); }
function quoteForWindowsShell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// Resolve {bin, args, shell} for a spawn. Callers never build these by hand.
function spawnShape(args) {
  var bin = cliBin();
  if (needsShell(bin)) {
    logger.warn('hermes-agent.bat-shim', {
      bin: bin,
      hint: 'HERMES_CLI points at a .bat/.cmd, which must run through cmd.exe — arguments are concatenated unquoted and truncated at 8191 chars, so long build prompts WILL be corrupted. Point HERMES_CLI at the real hermes executable instead.',
    });
    return { bin: quoteForWindowsShell(bin), args: args, shell: true };
  }
  return { bin: bin, args: args, shell: false };
}

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
        // MYTHOS wires one provider via HERMES_PROVIDER_KEY (rekeyed to the
        // OpenAI-compatible OPENAI_API_KEY above). Hermes's config.yaml may
        // instead select a provider that reads a provider-specific env name
        // (e.g. provider:"nvidia" reads NVIDIA_API_KEY, ignoring OPENAI_API_KEY).
        // When the forwarded base_url identifies such an endpoint, alias the SAME
        // key value to the provider-specific name — one secret, two labels, so
        // config.yaml's provider choice resolves credentials. No unrelated keys
        // leak (the test suite enforces exactly-one-provider forwarding).
        var baseUrl = entry.base && process.env[entry.base] ? process.env[entry.base] : '';
        if (/integrate\.api\.nvidia\.com/.test(baseUrl)) {
          env.NVIDIA_API_KEY = process.env[entry.key];
        }
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

  lastCliProbeDiagnostic = null;
  // Resolves true | false | 'timeout'. 'timeout' is deliberately NOT false: a
  // probe that did not finish is evidence of SLOWNESS, not of absence, and the
  // only thing that reading it as absence achieved was failing every build on a
  // busy machine (see cliProbeTimeoutMs above). ENOENT, EACCES and a non-zero
  // exit remain real evidence and stay false.
  var cliProbe = await new Promise(function(resolve) {
    var child;
    var settled = false;
    try {
      var shape = spawnShape(['--version']);
      child = spawn(shape.bin, shape.args, { windowsHide: true, shell: shape.shell, env: scrubbedEnv() });
    } catch (err) {
      // Synchronous spawn throw (rare — e.g. an invalid options object).
      lastCliProbeDiagnostic = { kind: 'spawn-threw', detail: (err && err.message) || String(err) };
      return resolve(false);
    }
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      lastCliProbeDiagnostic = { kind: 'timeout', detail: 'no exit within ' + cliProbeTimeoutMs() + 'ms' };
      treeKill(child, child.pid);
      // REMEDIATION (2026-07-29, discovered verifying items 6/10): taskkill
      // is itself best-effort — if the OS-level kill silently fails or is
      // slow (system congestion, a stubborn grandchild process), this
      // child's still-open stdio pipes were keeping the WHOLE Node process
      // alive (observed as an intermittent full-suite test hang). Once we've
      // given up waiting on this child and asked to kill it, its continued
      // existence must never block OUR process from exiting.
      if (typeof child.unref === 'function') child.unref();
      resolve('timeout');
    }, cliProbeTimeoutMs());
    child.on('error', function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Previously this discarded err.code entirely — ENOENT (binary not
      // found on PATH), EACCES (present but blocked), and everything else
      // all collapsed into the same generic hint below.
      lastCliProbeDiagnostic = { kind: 'spawn-error', code: err && err.code, detail: (err && err.message) || String(err) };
      resolve(false);
    });
    child.on('exit', function(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve(true); return; }
      lastCliProbeDiagnostic = { kind: 'exit-nonzero', code: code, signal: signal || null };
      resolve(false);
    });
  });

  var cliSlow = cliProbe === 'timeout';
  var cliOk = cliProbe === true;
  var cliUsable = cliOk || cliSlow;
  caps = { http: httpOk, cli: cliUsable };

  if (httpOk || cliUsable) {
    state = 'ONLINE';
    mode = cliUsable ? 'cli' : 'http'; // CLI preferred — builds need cwd pinning HTTP can't offer
    if (cliSlow) {
      // Honest about WHY it is online on thin evidence. The real task call has
      // its own (much larger) timeout and will fail with the actual error if the
      // binary genuinely cannot run, so an optimistic probe costs one slow build
      // attempt; a pessimistic one costs every build.
      hint = 'one-shot via `' + cliBin() + ' -z <prompt>` — version probe did not exit within '
        + cliProbeTimeoutMs() + 'ms, assuming present (a slow probe is not evidence of absence)';
      logger.warn('hermes-agent.cli-probe-slow', { bin: cliBin(), timeoutMs: cliProbeTimeoutMs() });
    } else {
      hint = cliOk ? 'one-shot via `' + cliBin() + ' -z <prompt>`' : 'gateway at ' + apiUrl();
    }
    return true;
  }
  state = 'OFFLINE'; mode = null;
  hint = 'hermes-agent not installed/running — install from github.com/NousResearch/Hermes-Agent, or start `hermes gateway` (set HERMES_API_URL/HERMES_API_KEY)';
  if (lastCliProbeDiagnostic) {
    logger.warn('hermes-agent.cli-probe-failed', Object.assign({ bin: cliBin() }, lastCliProbeDiagnostic));
    hint += ' [CLI probe: ' + lastCliProbeDiagnostic.kind +
      (lastCliProbeDiagnostic.code != null ? ' ' + lastCliProbeDiagnostic.code : '') +
      (lastCliProbeDiagnostic.detail ? ' — ' + lastCliProbeDiagnostic.detail : '') + ']';
  }
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
      var shape = spawnShape(['-z', prompt]);
      child = spawn(shape.bin, shape.args, {
        windowsHide: true,
        shell: shape.shell,
        cwd: opts.cwd,
        env: env,
      });
    } catch (err) { return reject(err); }
    var out = '', errOut = '';
    var timer = setTimeout(function() {
      treeKill(child, child.pid);
      // REMEDIATION (2026-07-29): see the identical comment in probe()'s
      // timeout handler above — taskkill is best-effort; once we've given up
      // on this child, its stdio pipes must never keep our own process alive.
      if (typeof child.unref === 'function') child.unref();
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
  return { state: state, mode: mode, hint: hint, cliProbeDiagnostic: lastCliProbeDiagnostic };
}

module.exports = {
  probe: probe, runTask: runTask, getStatus: getStatus, scrubbedEnv: scrubbedEnv,
  // Exported for unit tests:
  needsShell: needsShell, spawnShape: spawnShape,
};
