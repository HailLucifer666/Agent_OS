'use strict';

// effectors/from-installer.js — install_from_github effector. Takes a repo
// {url} or a {name} (resolved to a URL via web_search), clones it into the
// vault, detects the install method from the clone's manifest files, runs the
// install, and reports every stage's REAL subprocess output.
//
// Tier 3 (confirm-once-per-goal), same as run_command — the leash's credential
// scanner runs on every call automatically.
//
// WHY THE STAGE-LEVEL OUTPUT MATTERS. This effector exists because MYTHOS has
// a documented history of reporting "done" for actions that never happened
// (the 2026-07-29 notepad session: three "I typed Hi Alex" claims, zero
// keystrokes). An installer that lies is worse than one that fails, so:
//   - every stage records {command, args, exitCode, stdout, stderr},
//   - a non-zero exit at ANY stage returns ok:false naming the stage,
//   - the health check reports what it actually observed (e.g. `pip show`'s
//     Location line), never an inferred "installed successfully".
//
// SAFETY MODEL — deliberately reuses from-runner.js's layers rather than
// reimplementing them (require, don't copy):
//   1. ALLOWLIST       — RUN_COMMAND_ALLOWLIST (shared with run_command).
//                        Empty → fail-closed. Every binary this effector wants
//                        to spawn (git + the detected package manager) must be
//                        allow-listed, or the call fails naming the missing
//                        entry. NOTE for operators: allow-listing git/npm/pip
//                        here also enables them for generic run_command calls.
//   2. METACHAR REJECT — hasShellMetachar() on the URL, the derived slug, and
//                        every spawned arg.
//   3. URL ALLOWLIST   — only https://github.com/<owner>/<repo>. Rejects
//                        gist./raw. subdomains by anchoring the host, and
//                        rejects GitHub's own reserved first-path-segments
//                        (topics, search, orgs, ...) which would otherwise
//                        match the <owner>/<repo> shape. This is what stops a
//                        hostile search result from steering the clone.
//   4. CWD PINNING     — clones land in vault/builds/installs/<slug> with the
//                        same startsWith traversal guard resolveCwd() uses.
//                        Callers cannot override the location.
//   5. ENV SCRUBBING   — scrubEnv() from from-runner.js.
//   6. TIMEOUT         — INSTALL_TIMEOUT_MS (default 600000). Real installs
//                        routinely exceed run_command's 60s default; the
//                        adapter tree-kills on expiry.
//
// EXPLICIT NON-GOALS. No shell:true (the adapter forbids it). No `&&` chaining
// — every step is a discrete spawn. **No executing a repo's install.sh /
// Makefile / bootstrap script**: that "read and run the remote installer" flow
// is exactly the supply-chain pattern this effector refuses. Only standard
// git + package-manager invocations. Unrecognized repo → honest failure with
// the file listing, not a guess.
//
// NOT a sandbox. An allow-listed package manager running a hostile repo's
// build hooks (npm postinstall, setup.py) can still do damage. The URL
// allowlist plus the operator's own RUN_COMMAND_ALLOWLIST are the trust
// boundary.

var path = require('path');
var fs = require('fs');
var effectorFromTool = require('./adapter').effectorFromTool;
var defaultRunner = require('../../../adapters/command-runner');
var defaultWebSearch = require('./web-search').web_search;
var runnerGuards = require('./from-runner');

var parseAllowlist = runnerGuards.parseAllowlist;
var hasShellMetachar = runnerGuards.hasShellMetachar;
var scrubEnv = runnerGuards.scrubEnv;

function ok(r) { return { ok: true, result: r }; }
function fail(m, extra) { return { ok: false, result: Object.assign({ error: m }, extra || {}) }; }

var DEFAULT_INSTALL_TIMEOUT_MS = 600000;

// ---- GitHub URL validation ----
// Anchored to the github.com host so gist.github.com / raw.githubusercontent.com
// / codeload.github.com never match. Owner+repo charset is GitHub's own.
var GITHUB_REPO_RE = /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

// GitHub's reserved first-path-segments. Without this, https://github.com/topics/ai
// and https://github.com/search/foo satisfy the <owner>/<repo> shape and would be
// cloned as if they were repos — the most likely way a bad search hit gets through.
var RESERVED_OWNERS = new Set([
  'topics', 'search', 'orgs', 'organizations', 'collections', 'features',
  'sponsors', 'marketplace', 'explore', 'trending', 'about', 'pricing',
  'login', 'join', 'settings', 'notifications', 'apps', 'users', 'site',
  'security', 'enterprise', 'events', 'codespaces', 'sitemap', 'new',
  'pulls', 'issues', 'dashboard', 'account', 'contact', 'readme'
]);

// Returns { url, owner, repo } on success, or { error } — never throws.
function parseGithubUrl(raw) {
  if (!raw || typeof raw !== 'string') return { error: 'url must be a string' };
  var url = raw.trim();
  if (hasShellMetachar(url)) return { error: 'shell-metachar-rejected in url: ' + url.slice(0, 120) };
  var m = GITHUB_REPO_RE.exec(url);
  if (!m) {
    return { error: 'not a github repo url (expected https://github.com/<owner>/<repo>): ' + url.slice(0, 200) };
  }
  var owner = m[1];
  var repo = m[2];
  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    return { error: 'reserved github path, not a repo: /' + owner + '/' + repo };
  }
  if (repo === '.' || repo === '..') return { error: 'illegal repo name: ' + repo };
  return { url: 'https://github.com/' + owner + '/' + repo, owner: owner, repo: repo };
}

// ---- clone-dir resolution + traversal guard ----
// Mirrors from-runner.js's resolveCwd() guard, but for builds/installs/<slug>.
// resolveCwd() itself only maps {projectSlug}/{engagementId} to
// builds/projects|engagements, so it cannot be reused verbatim here.
function resolveInstallDir(vault, slug) {
  if (!vault || typeof vault.vaultPath !== 'function') {
    throw new Error('vault required (fs-store)');
  }
  var s = String(slug || '');
  if (!s) throw new Error('empty install slug');
  if (/[\\\/]|\.\./.test(s)) throw new Error('illegal path segment in repo name: ' + s);
  var rootAbs = vault.vaultPath();
  var installsRoot = vault.vaultPath(path.join('builds', 'installs'));
  var abs = vault.vaultPath(path.join('builds', 'installs', s));
  if (abs.indexOf(rootAbs) !== 0) throw new Error('install dir escapes vault: ' + abs);
  return { root: installsRoot, dir: abs };
}

// ---- install-method detection ----
// Order matters: a repo with both package.json and pyproject.toml is treated as
// the ecosystem whose lockfile/manifest is the primary one. npm first because a
// JS repo shipping a helper pyproject is more common than the reverse.
var METHODS = [
  { method: 'npm',   marker: 'package.json',   command: 'npm',   args: ['install'] },
  { method: 'pip',   marker: 'pyproject.toml', command: 'pip',   args: ['install', '.'] },
  { method: 'pip',   marker: 'setup.py',       command: 'pip',   args: ['install', '.'] },
  { method: 'cargo', marker: 'Cargo.toml',     command: 'cargo', args: ['build', '--release'] },
  { method: 'go',    marker: 'go.mod',         command: 'go',    args: ['build', './...'] }
];

// Scripts we deliberately REFUSE to run, reported so the operator can act.
var REFUSED_MARKERS = ['install.sh', 'install.ps1', 'bootstrap.sh', 'setup.sh', 'Makefile', 'makefile'];

function detectMethod(dir, fsImpl) {
  var f = fsImpl || fs;
  for (var i = 0; i < METHODS.length; i++) {
    var candidate = METHODS[i];
    if (f.existsSync(path.join(dir, candidate.marker))) {
      return { method: candidate.method, marker: candidate.marker, command: candidate.command, args: candidate.args.slice() };
    }
  }
  var refused = [];
  for (var j = 0; j < REFUSED_MARKERS.length; j++) {
    if (f.existsSync(path.join(dir, REFUSED_MARKERS[j]))) refused.push(REFUSED_MARKERS[j]);
  }
  var listing = [];
  try { listing = f.readdirSync(dir).slice(0, 40); } catch (_) { /* unreadable — report empty */ }
  return { error: 'no recognized install manifest (looked for package.json, pyproject.toml, setup.py, Cargo.toml, go.mod)', refusedScripts: refused, files: listing };
}

// Read a package name out of pyproject.toml so `pip show <name>` can serve as
// a real post-install oracle. Deliberately a narrow regex, not a TOML parser —
// on no match we skip the health check rather than guess a name.
function pyprojectName(dir, fsImpl) {
  var f = fsImpl || fs;
  try {
    var src = f.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
    var m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(src);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

function buildTools(ctx) {
  var vault = ctx && ctx.vault;
  var config = (ctx && ctx.config) || {};
  // Injectable for tests — defaults are the real adapter/effector.
  var runner = (ctx && ctx.runner) || defaultRunner;
  var webSearch = (ctx && ctx.webSearch) || defaultWebSearch;
  var fsImpl = (ctx && ctx.fs) || fs;

  // Read config LIVE on every call (D-46: never cache at construction).
  function allowlist() {
    var raw = (config && config.RUN_COMMAND_ALLOWLIST) || process.env.RUN_COMMAND_ALLOWLIST || '';
    return parseAllowlist(raw);
  }
  function timeoutMs() {
    var v = (config && config.INSTALL_TIMEOUT_MS) || process.env.INSTALL_TIMEOUT_MS || DEFAULT_INSTALL_TIMEOUT_MS;
    var n = Number(v);
    return (isFinite(n) && n >= 1000) ? n : DEFAULT_INSTALL_TIMEOUT_MS;
  }

  // Allowlist + metachar check for one command. Returns null when permitted,
  // or a fail() payload naming exactly what was denied.
  function denyReason(allow, command, args) {
    var allowedFlags = allow.get(command);
    if (!allowedFlags) {
      return 'allowlist-denied: ' + command + ' not in RUN_COMMAND_ALLOWLIST';
    }
    for (var i = 0; i < args.length; i++) {
      var arg = args[i];
      if (typeof arg !== 'string') return 'non-string arg at index ' + i + ' for ' + command;
      if (hasShellMetachar(arg)) return 'shell-metachar-rejected in arg: ' + arg.slice(0, 80);
      if (arg.charAt(0) === '-' && allowedFlags.size > 0 && !allowedFlags.has(arg)) {
        return 'allowlist-denied: arg flag ' + arg + ' not permitted for ' + command;
      }
    }
    return null;
  }

  async function install_from_github(args) {
    var a = args || {};
    var steps = [];

    // ---- Layer 1: fail-closed allowlist gate (before any network/disk work) ----
    var allow = allowlist();
    if (allow.size === 0) {
      return fail('install_from_github disabled — set RUN_COMMAND_ALLOWLIST (needs at least git plus the repo\'s package manager, e.g. "git;npm;pip;cargo;go")');
    }

    // ---- Resolve the target URL: {url} directly, or {name} via web_search ----
    var rawUrl = a.url;
    var searchedWith = null;
    if (!rawUrl && a.name) {
      if (typeof a.name !== 'string' || !a.name.trim()) return fail('name must be a non-empty string');
      var query = a.name.trim() + ' site:github.com';
      searchedWith = query;
      var searched;
      try {
        searched = await webSearch({ query: query, maxResults: 8 });
      } catch (err) {
        return fail('search-failed: ' + (err && err.message), { stage: 'search', query: query });
      }
      var hits = (searched && searched.ok && searched.result && Array.isArray(searched.result.results))
        ? searched.result.results : [];
      if (!hits.length) {
        return fail('no search results for "' + a.name + '" — pass an explicit url instead', { stage: 'search', query: query });
      }
      // First hit that survives the repo-URL allowlist. Report every candidate
      // on failure so the operator can see what was rejected and why.
      var rejected = [];
      for (var i = 0; i < hits.length; i++) {
        var candidate = parseGithubUrl(hits[i] && hits[i].url);
        if (candidate.url) { rawUrl = candidate.url; break; }
        rejected.push({ url: (hits[i] && hits[i].url) || '', reason: candidate.error });
      }
      if (!rawUrl) {
        return fail('no search result was a valid github repo url', { stage: 'search', query: query, rejected: rejected });
      }
    }
    if (!rawUrl) return fail('url or name required');

    // ---- Layers 2+3: URL allowlist + metachar reject (re-run even for a
    // caller-supplied url — the search path is not the only untrusted source) ----
    var parsed = parseGithubUrl(rawUrl);
    if (parsed.error) return fail(parsed.error, { stage: 'validate', url: String(rawUrl).slice(0, 200) });

    // ---- Layer 4: cwd pinning + traversal guard ----
    var dirs;
    try {
      dirs = resolveInstallDir(vault, parsed.repo);
    } catch (err) {
      return fail('install-dir-resolve-failed: ' + (err && err.message), { stage: 'resolve-dir' });
    }
    try {
      fsImpl.mkdirSync(dirs.root, { recursive: true });
    } catch (err) {
      return fail('install-dir-create-failed: ' + (err && err.message) + ' (dir=' + dirs.root + ')', { stage: 'resolve-dir' });
    }

    // ---- Layer 5: env scrubbing (built once, reused for every stage) ----
    var env = scrubEnv(process.env);

    // One stage = one discrete spawn. shell:false in the adapter means no
    // chaining is possible even if someone tried.
    async function stage(name, command, cmdArgs, cwd) {
      var denied = denyReason(allow, command, cmdArgs);
      if (denied) {
        var deniedStep = { stage: name, command: command, args: cmdArgs, ok: false, error: denied };
        steps.push(deniedStep);
        return deniedStep;
      }
      var res;
      try {
        res = await runner.run({ command: command, args: cmdArgs, cwd: cwd, env: env, timeoutMs: timeoutMs() });
      } catch (err) {
        // The adapter documents "never throws", but a stubbed/replaced runner
        // might — treat it as a stage failure rather than crashing the effector.
        res = { ok: false, result: { error: 'runner-threw: ' + (err && err.message) } };
      }
      var r = (res && res.result) || {};
      var step = {
        stage: name,
        command: command,
        args: cmdArgs,
        ok: Boolean(res && res.ok),
        exitCode: (typeof r.exitCode === 'number') ? r.exitCode : null,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        error: (res && res.ok) ? null : (r.error || 'failed')
      };
      steps.push(step);
      return step;
    }

    function stageFail(step, extra) {
      return fail(step.error, Object.assign({
        stage: step.stage,
        repo: parsed.owner + '/' + parsed.repo,
        url: parsed.url,
        command: step.command,
        args: step.args,
        exitCode: step.exitCode,
        stdout: step.stdout,
        stderr: step.stderr,
        steps: steps
      }, extra || {}));
    }

    // ---- Clone (or fast-forward an existing clone — makes this idempotent) ----
    var alreadyCloned = fsImpl.existsSync(path.join(dirs.dir, '.git'));
    var cloneStep = alreadyCloned
      ? await stage('pull', 'git', ['pull', '--ff-only'], dirs.dir)
      : await stage('clone', 'git', ['clone', parsed.url, parsed.repo], dirs.root);
    if (!cloneStep.ok) return stageFail(cloneStep);

    // ---- Detect the install method from the clone itself ----
    var detected = detectMethod(dirs.dir, fsImpl);
    if (detected.error) {
      return fail(detected.error, {
        stage: 'detect',
        repo: parsed.owner + '/' + parsed.repo,
        url: parsed.url,
        dir: dirs.dir,
        refusedScripts: detected.refusedScripts,
        files: detected.files,
        note: 'install scripts are never executed by this effector — run them yourself if you trust the repo',
        steps: steps
      });
    }

    // ---- Install ----
    var installStep = await stage('install', detected.command, detected.args, dirs.dir);
    if (!installStep.ok) return stageFail(installStep, { method: detected.method });

    // ---- Health check: an OBSERVATION, not an assumption ----
    // Caller-supplied check wins (allowlist-validated like any other stage);
    // otherwise use the package manager's own oracle where one exists.
    var healthCheck = null;
    var hc = a.healthCommand;
    if (hc && typeof hc === 'object' && typeof hc.command === 'string') {
      healthCheck = await stage('health', hc.command, Array.isArray(hc.args) ? hc.args.slice() : [], dirs.dir);
    } else if (detected.method === 'pip') {
      var pkg = pyprojectName(dirs.dir, fsImpl);
      if (pkg) healthCheck = await stage('health', 'pip', ['show', pkg], dirs.dir);
    } else if (detected.method === 'npm') {
      healthCheck = await stage('health', 'npm', ['ls', '--depth=0'], dirs.dir);
    }

    return ok({
      repo: parsed.owner + '/' + parsed.repo,
      url: parsed.url,
      dir: dirs.dir,
      method: detected.method,
      detectedFrom: detected.marker,
      alreadyCloned: alreadyCloned,
      searchedWith: searchedWith,
      steps: steps,
      // null when no oracle applies to this ecosystem — the honest answer is
      // "not checked", never a fabricated pass.
      healthCheck: healthCheck
        ? { ok: healthCheck.ok, command: healthCheck.command, args: healthCheck.args, exitCode: healthCheck.exitCode, stdout: healthCheck.stdout, stderr: healthCheck.stderr }
        : null,
      healthCheckNote: healthCheck ? undefined : 'no automatic health check for method ' + detected.method + ' — pass healthCommand to verify'
    });
  }

  return [
    {
      name: 'install_from_github',
      description: 'Clone a GitHub repo into the vault and install it, reporting every stage\'s real subprocess output. Accepts {url} or {name} (resolved via web_search). Detects npm/pip/cargo/go from the repo\'s manifest. Tier 3 (confirm). Requires RUN_COMMAND_ALLOWLIST to include git plus the repo\'s package manager — disabled (fail-closed) when empty. Never executes a repo\'s install.sh/Makefile. NOT a sandbox: an allow-listed package manager still runs the repo\'s build hooks.',
      params: {
        url: 'string (optional) — https://github.com/<owner>/<repo>. Required unless name is given.',
        name: 'string (optional) — project name; resolved to a repo url via web_search "<name> site:github.com"',
        healthCommand: 'object (optional) — {command, args} run in the clone dir after install to verify it (e.g. {command:"agent-reach",args:["doctor"]}). Must be allow-listed like any other command.'
      },
      danger: true,
      fn: install_from_github
    }
  ];
}

function registerFromInstaller(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = {
  registerFromInstaller: registerFromInstaller,
  buildTools: buildTools,
  // Exported for unit tests:
  parseGithubUrl: parseGithubUrl,
  resolveInstallDir: resolveInstallDir,
  detectMethod: detectMethod,
  pyprojectName: pyprojectName
};
