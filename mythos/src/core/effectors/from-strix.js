'use strict';

// effectors/from-strix.js — run Strix, an autonomous security-testing agent,
// against a target the operator is authorized to test.
//
// Strix (github.com/usestrix/strix, Apache-2.0) exercises a target for real —
// dynamic testing in Docker containers, not a static scan — and reports what it
// could exploit. That power is the reason this effector is the most tightly
// gated one in the tree.
//
// TWO GATES, BOTH MANDATORY:
//
//   1. EXPLICIT AUTHORIZATION. The call MUST carry an `authorized_by` string —
//      the operator stating, in their own words, that they own or have written
//      permission to test the target. No default, no inference. Scanning
//      infrastructure you do not control is unlawful in most jurisdictions, and
//      the argument's absence is a refusal, not a prompt to guess.
//
//   2. TARGET PROVENANCE. The target is passed as a first-class argument by the
//      caller. It must never be a URL that arrived from a web page, a search
//      result, an email or a document — that path is prompt injection steering
//      a real attack, and it is exactly what the authorization gate exists to
//      interrupt. The effector cannot see where a string came from, so it
//      enforces what it can (shape + the authorization assertion) and the skill
//      doc (mythos/skills/strix-security/SKILL.md) carries the provenance rule.
//
// GRACEFUL DEGRADATION. Strix (pip install strix-agent) and Docker are optional.
// Absent → the effector reports OFFLINE with an install hint and never throws,
// the same probe-once-cache-degrade pattern agent-actions.js uses for
// agent-reach. MYTHOS boots and runs fine without it.
//
// HONEST RESULTS. A Strix run produces claims. The effector returns the real
// subprocess output (exit code, stdout, stderr) and marks the result
// unverified — a finding MYTHOS did not personally reproduce is the tool's
// assertion, not a confirmed vulnerability. Never a bare ok:true.

var effectorFromTool = require('./adapter').effectorFromTool;
var evidence = require('./evidence');
var runnerGuards = require('./from-runner');

var execFile = require('child_process').execFile;

var hasShellMetachar = runnerGuards.hasShellMetachar;
var scrubEnv = runnerGuards.scrubEnv;

function ok(r) { return { ok: true, result: r }; }
function fail(m, extra) { return { ok: false, result: Object.assign({ error: m }, extra || {}) }; }

var DEFAULT_STRIX_TIMEOUT_MS = 1800000;   // 30 min — real runs are long
var PROBE_TIMEOUT_MS = 4000;
var INSTALL_HINT = 'Strix is not installed. Install it with `pip install strix-agent` (needs Python >=3.12 and a running Docker daemon), then set STRIX_LLM and LLM_API_KEY in your environment.';

// A target must be a local path, a github repo, or an http(s) URL — and carry
// no shell metacharacters (it becomes a spawned argument). The shape check is a
// guard, not a permission: authorization is the operator's assertion, not the
// URL's form.
function validateTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'target must be a non-empty string' };
  var target = raw.trim();
  if (hasShellMetachar(target)) return { error: 'shell-metachar-rejected in target: ' + target.slice(0, 120) };
  var looksUrl = /^https?:\/\//i.test(target);
  var looksPath = /^(\.|\/|[A-Za-z]:\\)/.test(target);
  if (!looksUrl && !looksPath) {
    return { error: 'target must be an http(s) URL or a local path (got: ' + target.slice(0, 80) + ')' };
  }
  return { target: target };
}

function buildTools(ctx) {
  var config = (ctx && ctx.config) || {};
  var logger = (ctx && ctx.logger) || { debug: function() {}, info: function() {}, warn: function() {} };
  // Injectable for tests; default is the real child_process.execFile.
  var exec = (ctx && ctx.execFile) || execFile;

  // Probe once, cache. Availability can change if the operator installs Strix
  // mid-session, so a reset hook is exported for tests, but a running process
  // does not re-probe on every call.
  var available = null;
  function isAvailable() {
    if (available !== null) return Promise.resolve(available);
    return new Promise(function(resolve) {
      exec('strix', ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, function(err) {
        available = !err;
        resolve(available);
      });
    });
  }

  function timeoutMs() {
    var v = config.STRIX_TIMEOUT_MS !== undefined ? config.STRIX_TIMEOUT_MS : process.env.STRIX_TIMEOUT_MS;
    var n = Number(v);
    return (isFinite(n) && n >= 10000) ? n : DEFAULT_STRIX_TIMEOUT_MS;
  }

  // Strix reads its LLM config from the environment. Without it the run fails
  // deep inside the tool with an opaque error; catching it here gives the
  // operator the actionable message instead.
  function llmConfigured() {
    return Boolean(
      (config.STRIX_LLM || process.env.STRIX_LLM) &&
      (config.LLM_API_KEY || process.env.LLM_API_KEY)
    );
  }

  async function security_scan(args) {
    var a = args || {};

    // ---- Gate 1: explicit operator authorization ----
    var authorizedBy = typeof a.authorized_by === 'string' ? a.authorized_by.trim() : '';
    if (!authorizedBy) {
      return fail(
        'refused: security_scan requires `authorized_by` — the operator must state that they own or have '
        + 'written permission to test this target. Scanning a target you do not control is unlawful. This is '
        + 'not a target MYTHOS may supply for you; the operator must name it and authorize it.',
        { needsAuthorization: true }
      );
    }

    // ---- Gate 2: target shape ----
    var validated = validateTarget(a.target);
    if (validated.error) return fail('refused: ' + validated.error);

    // ---- Availability (degrade, do not throw) ----
    if (!await isAvailable()) {
      return fail(INSTALL_HINT, { offline: true, install: 'pip install strix-agent' });
    }
    if (!llmConfigured()) {
      return fail(
        'Strix is installed but its LLM is not configured. Set STRIX_LLM (e.g. "openai/gpt-5.4") and '
        + 'LLM_API_KEY in your environment — Strix bills against your own key, not MYTHOS.',
        { offline: false, misconfigured: true }
      );
    }

    // ---- Build the argv. Every piece is metachar-checked; nothing is shelled. ----
    var argv = ['--target', validated.target];
    if (a.instruction) {
      var instruction = String(a.instruction);
      if (hasShellMetachar(instruction)) return fail('shell-metachar-rejected in instruction');
      argv.push('--instruction', instruction);
    }
    if (a.scan_mode) {
      var mode = String(a.scan_mode);
      if (['light', 'standard', 'deep'].indexOf(mode) === -1) {
        return fail('scan_mode must be one of light|standard|deep');
      }
      argv.push('--scan-mode', mode);
    }
    // Headless by default: an autonomous run has no interactive console.
    if (a.headless !== false) argv.push('-n');

    var env = scrubEnv(process.env);
    // scrubEnv strips *_API_KEY / *_LLM-shaped secrets — Strix genuinely needs
    // them, so add back exactly the two it reads, from config or the real env.
    env.STRIX_LLM = config.STRIX_LLM || process.env.STRIX_LLM;
    env.LLM_API_KEY = config.LLM_API_KEY || process.env.LLM_API_KEY;
    if (config.LLM_API_BASE || process.env.LLM_API_BASE) env.LLM_API_BASE = config.LLM_API_BASE || process.env.LLM_API_BASE;
    if (config.PERPLEXITY_API_KEY || process.env.PERPLEXITY_API_KEY) env.PERPLEXITY_API_KEY = config.PERPLEXITY_API_KEY || process.env.PERPLEXITY_API_KEY;

    logger.info('strix.scan.start', { target: validated.target, authorizedBy: authorizedBy, scanMode: a.scan_mode || 'default' });

    var run = await new Promise(function(resolve) {
      exec('strix', argv, {
        timeout: timeoutMs(),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: env
      }, function(err, stdout, stderr) {
        resolve({
          err: err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: Boolean(err && err.killed && err.signal === 'SIGTERM')
        });
      });
    });

    if (run.err && !run.stdout) {
      return fail('strix run failed: ' + (run.err.message || 'unknown'), {
        target: validated.target,
        timedOut: run.timedOut,
        stderr: run.stderr.slice(0, 2000)
      });
    }

    // A completed run still produces CLAIMS. MYTHOS reproduced nothing, so the
    // result is unverified — the operator must confirm any finding before
    // acting on it.
    return ok(evidence.unverified({
      target: validated.target,
      authorizedBy: authorizedBy,
      scanMode: a.scan_mode || 'default',
      exitCode: run.err ? (typeof run.err.code === 'number' ? run.err.code : -1) : 0,
      stdout: run.stdout.slice(0, 20000),
      stderr: run.stderr.slice(0, 4000),
      timedOut: run.timedOut,
      viewHint: 'run `strix view` to inspect the full recorded run'
    }, 'Strix reported these findings; MYTHOS did not reproduce them. Confirm each before acting.'));
  }

  return {
    tools: [
      {
        name: 'security_scan',
        description: 'Run Strix, an autonomous security-testing agent, against a target the operator is authorized to test (a local path, a github repo, or an http(s) URL). REQUIRES authorized_by — the operator asserting they own or have written permission to test it; absent, the call is refused. Needs Strix (pip install strix-agent) + Docker + the operator\'s own STRIX_LLM/LLM_API_KEY; degrades to an install hint when absent. Tier 3 (confirm). Findings are returned unverified — they are the tool\'s claims, not confirmed vulnerabilities.',
        params: {
          target: 'string — local path, https://github.com/<owner>/<repo>, or an http(s) URL the operator owns/is authorized to test',
          authorized_by: 'string — the operator\'s authorization statement (who authorized this and on what basis). No default; its absence refuses the call.',
          instruction: 'string (optional) — extra guidance, e.g. "authenticated testing, creds in the vault"',
          scan_mode: 'string (optional) — light|standard|deep',
          headless: 'boolean (optional) — run without an interactive console (default true)'
        },
        danger: true,
        needs_result: true,
        fn: security_scan
      }
    ],
    _resetProbe: function() { available = null; }
  };
}

function registerFromStrix(hub, ctx) {
  var built = buildTools(ctx);
  for (var i = 0; i < built.tools.length; i++) hub.register(effectorFromTool(built.tools[i]));
  return { count: built.tools.length };
}

module.exports = {
  registerFromStrix: registerFromStrix,
  buildTools: buildTools,
  // Exported for tests:
  validateTarget: validateTarget
};
