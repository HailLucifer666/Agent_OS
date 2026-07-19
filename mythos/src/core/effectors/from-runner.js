'use strict';

// effectors/from-runner.js — Phase 3 (V7) run_command effector. Runs an
// allow-listed shell command with cwd pinned inside the vault and a
// per-command timeout. Tier 3 (confirm-once-per-goal) — the leash's
// credential scanner runs on every call automatically.
//
// SAFETY MODEL (v1 — task-957 handoff: "v1 is allowlist+timeout, not a full
// sandbox"). Five layers of defense, enforced HERE before delegating the
// subprocess lifecycle to adapters/command-runner:
//
//   1. ALLOWLIST       — exact command match + per-command arg-flag allowlist,
//                        configured via RUN_COMMAND_ALLOWLIST env. Empty/unset
//                        → fail-closed ('run_command disabled — set
//                        RUN_COMMAND_ALLOWLIST'). Unknown command or disallowed
//                        arg flag → deny.
//   2. METACHAR REJECT — reject any arg containing $(, backtick, <(, >, |, ;,
//                        &&, ||, \n, or leading ~. The credential scanner
//                        can't see what the shell WOULD expand (if shell:true
//                        were ever used), so block expansion at the effector.
//                        (shell:false in the adapter means these wouldn't
//                        expand anyway, but the reject catches operator error
//                        and a future regression where shell:true sneaks in.)
//   3. CWD PINNING     — caller passes a {projectSlug} or {engagementId} +
//                        the vault; this resolves cwd to the project's
//                        builds/projects/<slug> or builds/engagements/<id>
//                        dir, with a startsWith traversal guard. Caller
//                        cannot override cwd.
//   4. ENV SCRUBBING   — strip *_API_KEY, *_SECRET, *_TOKEN, GOOGLE_*,
//                        MYTHOS_* (except a benign allowlist) from the child
//                        env. Pass through PATH, HOME/USERPROFILE, SYSTEMROOT,
//                        LANG, etc. (the OS-needs-these set).
//   5. TIMEOUT         — RUN_COMMAND_TIMEOUT_MS (default 60000). Adapter
//                        tree-kills on expiry.
//
// NOT a sandbox. A malicious allowlisted command can still do damage inside
// its cwd — the allowlist is the trust boundary. Operators should keep the
// allowlist minimal (e.g. npm[:test,:run,:install], node[:--version]) and
// never allow a shell (sh/bash/cmd/powershell).

var path = require('path');
var fs = require('fs');
var effectorFromTool = require('./adapter').effectorFromTool;
var runner = require('../../../adapters/command-runner');

function ok(r) { return { ok: true, result: r }; }
function fail(m, extra) { return { ok: false, result: Object.assign({ error: m }, extra || {}) }; }

// ---- allowlist parsing ----
// Format: cmd[:flag,flag];cmd2[:flag,flag];cmd3
//   ;  separates commands
//   :  precedes a command's allowed flag list (optional — no colon = any args allowed)
//   ,  separates flags within one command's list
// Examples:
//   npm:test,install,run           (npm allowed; only -test/-install/-run flags... note:
//                                   flags in the allowlist omit the leading - for ergonomics
//                                   but the metachar-reject expects args WITH the -; the
//                                   matcher below normalizes both)
//   node:--version,--help;git:status,diff
//   python3                        (any args allowed — minimal lockdown)
// Whitespace trimmed. Empty entries ignored. Empty input → empty Map → tool disabled.
// Returns Map<cmd, Set<flag>> (flags stored WITH leading dashes normalized in; matcher
// compares against the arg with its leading dashes intact).
function parseAllowlist(raw) {
  var map = new Map();
  if (!raw || typeof raw !== 'string') return map;
  var entries = raw.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var colonIdx = entry.indexOf(':');
    var cmd, flags;
    if (colonIdx === -1) {
      cmd = entry.trim();
      flags = [];
    } else {
      cmd = entry.slice(0, colonIdx).trim();
      flags = entry.slice(colonIdx + 1).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    if (!cmd) continue;
    // Normalize each flag to carry its leading dashes (so a caller passing
    // '--version' and an allowlist entry of 'version' both match).
    var normalized = new Set();
    for (var j = 0; j < flags.length; j++) {
      var f = flags[j];
      normalized.add(f);
      if (f.charAt(0) !== '-' && f.charAt(0) !== '') {
        normalized.add('--' + f);
        // Single-dash form too (e.g. -v vs --version).
        if (f.length >= 1) normalized.add('-' + f);
      }
    }
    map.set(cmd, normalized);
  }
  return map;
}

// ---- metachar reject ----
// Reject args containing shell-expansion or control constructs. shell:false
// in the adapter means these wouldn't expand, but the reject (a) catches
// operator intent (the operator almost certainly meant shell expansion if
// they typed $(cat foo)), and (b) defends against a future shell:true
// regression. Backtick, $(), <(), redirection, pipe, sequencing, newline,
// leading ~ (HOME expansion).
var METACHAR_RE = /(\$\(|`|<\(|>|[^-]\|\|?|;|&&|\n|^\~)/;
function hasShellMetachar(s) {
  return typeof s === 'string' && METACHAR_RE.test(s);
}

// ---- env scrubbing ----
// Build a minimal env for the child: OS-essential vars + a benign MYTHOS
// subset. Strip every API key, secret, token, and the GOOGLE_* OAuth creds.
var ENV_KEEP = /^(PATH|HOME|USERPROFILE|LANG|LC_[A-Z_]+|SYSTEMROOT|TEMP|TMP|TMPDIR|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|ComSpec|APPDATA|LOCALAPPDATA|ComSpec)$/;
var MYTHOS_ENV_KEEP = /^MYTHOS_(NAME|VERSION|PORT|BIND|VAULT_ROOT)$/;   // identity-only, no secrets/keys
function scrubEnv(env) {
  var scrubbed = {};
  var src = env || process.env;
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    // Strip secret-shaped keys hard.
    if (/(API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL)$/i.test(k)) continue;
    if (/^GOOGLE_/.test(k)) continue;        // GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, etc.
    if (/^GROQ_|^MISTRAL_|^NIM_|^ZCODE_|^OPENROUTER_|^CEREBRAS_|^EXA_|^HERMES_|^OLLAMA_/.test(k)) continue;
    if (/^MYTHOS_/.test(k) && !MYTHOS_ENV_KEEP.test(k)) continue;
    if (ENV_KEEP.test(k)) { scrubbed[k] = src[k]; continue; }
    // Default: keep (operators may set NODE_PATH, etc.). The explicit strips
    // above are the trust boundary; we don't deny-by-default because too many
    // build tools need ambient env (git needs GIT_* via config, npm needs
    // npm_config_*, etc.). cwd-pinning is the real boundary.
    scrubbed[k] = src[k];
  }
  return scrubbed;
}

// ---- cwd resolution + traversal guard ----
// Returns the absolute cwd for a project or engagement, or throws on traversal.
function resolveCwd(vault, scope) {
  if (!vault || typeof vault.vaultPath !== 'function') {
    throw new Error('vault required (fs-store)');
  }
  // Accept {projectSlug} or {engagementId}; default to the builds root.
  var rel;
  if (scope && scope.projectSlug) {
    rel = path.join('builds', 'projects', String(scope.projectSlug));
  } else if (scope && scope.engagementId) {
    rel = path.join('builds', 'engagements', String(scope.engagementId));
  } else {
    rel = path.join('builds');
  }
  // Sanitize: NO path separators / .. in the slug/id (a hostile slug can't
  // be passed by an allowlisted caller, but defense-in-depth).
  var base = scope && (scope.projectSlug || scope.engagementId);
  if (base && /[\\\/]|\.\./.test(String(base))) {
    throw new Error('illegal path segment in scope: ' + base);
  }
  var abs = vault.vaultPath(rel);
  // Re-derive the expected prefix and confirm abs is under it.
  var rootAbs = vault.vaultPath();
  if (abs.indexOf(rootAbs) !== 0) {
    throw new Error('cwd escapes vault: ' + abs);
  }
  return abs;
}

function buildTools(ctx) {
  var vault = ctx && ctx.vault;
  var config = ctx && ctx.config || {};

  // Resolve allowlist + timeout LIVE on each call (D-46: read config live,
  // never cache at construction).
  function allowlist() {
    var raw = (config && config.RUN_COMMAND_ALLOWLIST) || (process.env.RUN_COMMAND_ALLOWLIST) || '';
    return parseAllowlist(raw);
  }
  function timeoutMs() {
    var v = (config && config.RUN_COMMAND_TIMEOUT_MS) || (process.env.RUN_COMMAND_TIMEOUT_MS) || 60000;
    var n = Number(v);
    return (isFinite(n) && n >= 1000) ? n : 60000;
  }

  async function run_command(args) {
    var a = args || {};
    var command = a.command;
    var cmdArgs = Array.isArray(a.args) ? a.args.slice() : [];
    var scope = a.projectSlug ? { projectSlug: a.projectSlug }
              : a.engagementId ? { engagementId: a.engagementId }
              : {};

    if (!command || typeof command !== 'string') return fail('command required (string)');
    // Layer 1: allowlist.
    var allow = allowlist();
    if (allow.size === 0) {
      return fail('run_command disabled — set RUN_COMMAND_ALLOWLIST', { command: command });
    }
    var allowedFlags = allow.get(command);
    if (!allowedFlags) {
      return fail('allowlist-denied: ' + command + ' not in RUN_COMMAND_ALLOWLIST', { command: command });
    }
    // Layer 2: metachar reject + per-cmd arg-flag allowlist.
    for (var i = 0; i < cmdArgs.length; i++) {
      var arg = cmdArgs[i];
      if (typeof arg !== 'string') return fail('non-string arg at index ' + i);
      if (hasShellMetachar(arg)) {
        return fail('shell-metachar-rejected in arg: ' + arg.slice(0, 80));
      }
      // Allowlist flags: an arg is allowed if it is a flag (starts with -)
      // AND is in the per-cmd set, OR the allowlist for this cmd is empty
      // (legacy "command allowed, any args" form), OR it's a positional
      // non-flag value. Positional values are allowed because they're
      // typically file paths inside cwd (already pinned + the metachar
      // reject already cleared them). If an operator wants to lock down
      // positionals too, they omit the colon form entirely.
      if (arg.charAt(0) === '-' && allowedFlags.size > 0 && !allowedFlags.has(arg)) {
        return fail('allowlist-denied: arg flag ' + arg + ' not permitted for ' + command);
      }
    }
    // Layer 3: cwd pinning + ensure it exists (a not-yet-scaffolded project
    // should fail with a clear error, not the adapter's ENOENT-from-cwd which
    // misleadingly blames the binary).
    var cwd;
    try {
      cwd = resolveCwd(vault, scope);
    } catch (err) {
      return fail('cwd-resolve-failed: ' + (err && err.message));
    }
    try {
      // mkdir -p the resolved cwd. Idempotent. The traversal guard above
      // already ensured cwd stays under the vault root.
      fs.mkdirSync(cwd, { recursive: true });
    } catch (err) {
      return fail('cwd-create-failed: ' + (err && err.message) + ' (cwd=' + cwd + ')');
    }
    // Layer 4: env scrubbing.
    var env = scrubEnv(process.env);
    // Layer 5: timeout. Delegate the subprocess lifecycle to the adapter.
    var result;
    try {
      result = await runner.run({
        command: command, args: cmdArgs, cwd: cwd, env: env, timeoutMs: timeoutMs()
      });
    } catch (err) {
      return fail('runner-threw: ' + (err && err.message));
    }
    return result;   // adapter already returns the {ok, result} shape
  }

  return [
    {
      name: 'run_command',
      description: 'Run an allow-listed shell command with cwd pinned inside the vault and a per-command timeout. Tier 3 (confirm). Configure the allowlist via RUN_COMMAND_ALLOWLIST (e.g. "npm:test,install;node:--version"). Disabled (fail-closed) when the allowlist is empty. NOT a sandbox — keep the allowlist minimal and never allow sh/bash/cmd/powershell.',
      params: {
        command: 'string — exact binary name (must be in RUN_COMMAND_ALLOWLIST)',
        args: 'array (optional) — arg flags must be in the command\'s per-cmd allowlist; positional values allowed',
        projectSlug: 'string (optional) — pins cwd to vault/builds/projects/<slug>',
        engagementId: 'string (optional) — pins cwd to vault/builds/engagements/<id>'
      },
      danger: true,
      fn: run_command
    }
  ];
}

function registerFromRunner(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = {
  registerFromRunner: registerFromRunner,
  buildTools: buildTools,
  // Exported for unit tests:
  parseAllowlist: parseAllowlist,
  hasShellMetachar: hasShellMetachar,
  scrubEnv: scrubEnv,
  resolveCwd: resolveCwd
};
