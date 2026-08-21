'use strict';

// adapters/dsh-agent — DeepSeek Harness (`dsh`) as MYTHOS's build engine.
//
// Replaces adapters/hermes-agent. Same four exports, so no caller learns a new
// shape: probe · runTask · getStatus · scrubbedEnv.
//
// UPSTREAM CONTRACT, verified 2026-08-21/22 by reading the INSTALLED package —
// not from memory, because dsh is a developer preview whose own README says
// there WILL be compatibility-breaking changes:
//   * `dsh --profile headless "<task>"` runs one fresh session and exits.
//   * stdout carries the last non-empty assistant text.
//   * exit 0 iff the final `turn/end` reason is `completed`, else 1.
//   * stderr is EMPTY on success; a terminal error writes its code + message.
//   * no listening port is opened.
//   * `dsh --version` prints the version and exits 0 — the probe.
// Source: @deepseek-ai/dsh-headless/README.md and cordis.patch.yml.
// Every one of those is ASSERTED below rather than trusted.
//
// WHAT THIS ADAPTER DOES NOT DO, and why each absence is deliberate:
//
//   * No HTTP surface. Hermes had a gateway on :8642 and this adapter has no
//     equivalent, because the headless profile opens no listening port. There is
//     one transport, so there is no `mode` to choose and nothing to fall back to.
//   * No provider slots, no rotation, no HERMES_ERROR_REPLY_RE twin
//     (W6-AD-8: delete, don't stub). Hermes needed all three because it reports
//     provider failures on stdout WITH EXIT CODE 0 (BUG-058/245) and because a
//     single 401 killed a whole build. dsh's exit code IS its oracle, so an
//     error-string detector here would be a speculative guard — and this repo
//     already recorded that a guard which is correct and never fires is not a
//     guard. If dsh ever grows an exit-0-but-failed mode, that is a measurement
//     and a new commit, not a regex written in advance.
//   * No runtime lane failover. The model is chosen ONCE, at selection time,
//     from the first build-lane entry that is actually reachable (see
//     selectModel). Retrying the next lane entry after a failure would need a
//     classifier over dsh's error text to tell "this model is unavailable" from
//     "this task failed", and a wrong classification that also hides the real
//     diagnosis is worse than the original failure.
//
// NO FALLBACK (BUG-244 ruling A, re-pointed by W6 rather than weakened): dsh
// missing means the build FAILS with an install hint. Boot still succeeds.

var { spawn } = require('child_process');
var fs = require('fs');
var path = require('path');
var os = require('os');
var { treeKill } = require('../command-runner');
var { createLogger } = require('../../src/core/logger');
var logger = createLogger(process.env.LOG_LEVEL || 'info');

// ---------------------------------------------------------------------------
// Install location and version pin.
//
// dsh gets its OWN install root at the repo root, the convention `Hermes Agent/`
// and `Android Platform Tools/` already follow. Measured 2026-08-21 and the
// reason this is not an ordinary dependency: `npm install @deepseek-ai/dsh`
// inside mythos/ made npm re-resolve mythos's entire 191-package tree alongside
// dsh's own 30+ @deepseek-ai/* packages — 24 minutes of CPU, 2.8 GB of RSS, and
// zero files extracted when it was killed.
//
// The version is ASSERTED, not assumed. A developer preview that promises
// breaking changes cannot be trusted to keep the CLI contract above, and a
// silent version drift would turn a contract change into a mystery build
// failure. Paths are derived from __dirname (W6-AD-7 — no machine paths).
var DSH_PINNED_VERSION = '0.1.1-rc.2';
var ADAPTERS_DIR = path.resolve(__dirname, '..');            // mythos/adapters
var MYTHOS_DIR = path.resolve(ADAPTERS_DIR, '..');           // mythos
var REPO_ROOT = path.resolve(MYTHOS_DIR, '..');              // repo root

var DSH_INSTALL_ROOTS = [
  path.join(REPO_ROOT, 'DeepSeek Harness', 'node_modules', '@deepseek-ai', 'dsh'),
  path.join(MYTHOS_DIR, 'node_modules', '@deepseek-ai', 'dsh'),
];

var INSTALL_HINT = 'node mythos/scripts/setup-dsh.js --install';

var state = 'OFFLINE';       // OFFLINE | ONLINE
var hint = 'not probed yet — call probe() or invoke dsh_task';
var lastProbeAt = 0;
var PROBE_TTL_MS = 60 * 1000;
var lastProbeDiagnostic = null;   // {kind, code?, signal?, detail?} or null
var lastTaskFailure = null;       // {at, error} — the only field from a real content call
var installedVersion = null;
var lastModel = null;             // {laneProvider, route, model, apiKeyEnv} of the last run

function taskTimeoutMs() { return Number(process.env.DSH_TASK_TIMEOUT_MS) || 600000; }
// The probe spawns node on a ~450-package tree. Measured on this machine:
// `dsh --version` answers in about a second idle. 30s of headroom mirrors the
// hermes adapter's own hard-won number — its 15s cap once declared the engine
// OFFLINE while Hermes was installed and working, purely because the machine
// was loaded.
function probeTimeoutMs() { return Number(process.env.DSH_PROBE_TIMEOUT_MS) || 30000; }

// ---------------------------------------------------------------------------
// W6-AD-3. `cwd` is REQUIRED and its absence is FATAL — a deliberate divergence
// from the hermes adapter, where a missing cwd merely inherited the process
// working directory.
//
// dsh treats the invoking directory as its workspace root, grants it
// workspace-write, and loads that directory's AGENTS.md/CLAUDE.md as agent
// instructions under a 65,536-byte budget. This repo's two files total 41,412
// bytes and BOTH would load in full, so an inherited cwd hands a build task
// MYTHOS's own operating rules *while holding write access to the repository*.
// build-engine.js's scratchDir() returns undefined on failure and its comment
// says "adapter falls back to cwd inheritance"; that fallback does not survive
// here. Failing loudly beats a default that makes a broken configuration look
// healthy.
function requireCwd(cwd) {
  if (!cwd || typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('dsh-agent: cwd is required. dsh adopts its invoking directory as a '
      + 'WRITABLE workspace and reads that directory\'s CLAUDE.md/AGENTS.md as agent '
      + 'instructions, so inheriting MYTHOS\'s own cwd would hand a build task this repo\'s '
      + 'operating rules plus write access to the repository. Pass an explicit scratch or '
      + 'project directory.');
  }
  var abs = path.resolve(cwd);
  if (!fs.existsSync(abs)) {
    throw new Error('dsh-agent: cwd does not exist: ' + abs + ' — create it before running a '
      + 'task. dsh would otherwise resolve its workspace root against a directory that is not '
      + 'there.');
  }
  return abs;
}

function resolveDshPackageDir() {
  return DSH_INSTALL_ROOTS.find(function (d) { return fs.existsSync(path.join(d, 'package.json')); }) || null;
}

// Returns the absolute path to dsh's CLI entry, or throws with the install hint.
// Deliberately does NOT fall back to `npx --yes`: that caches outside the opened
// project (root CLAUDE.md forbids it) and floats the version under a pin.
function resolveDshEntry() {
  var pkgDir = resolveDshPackageDir();
  if (!pkgDir) {
    throw new Error('dsh is not installed project-local. Run:\n  ' + INSTALL_HINT + '\nLooked in:\n'
      + DSH_INSTALL_ROOTS.map(function (d) { return '  ' + d; }).join('\n'));
  }
  var pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  installedVersion = pkg.version || null;
  if (pkg.version !== DSH_PINNED_VERSION) {
    throw new Error('dsh version mismatch: installed ' + pkg.version + ', this adapter is pinned '
      + 'to ' + DSH_PINNED_VERSION + '. dsh is a developer preview whose README says there WILL '
      + 'be compatibility-breaking changes, so the CLI contract this adapter asserts cannot be '
      + 'assumed to hold. Reinstall the pin (' + INSTALL_HINT + '), or move DSH_PINNED_VERSION '
      + 'deliberately after re-reading the installed reference.');
  }
  // `bin` is a string or a map; read whichever shape ships rather than guessing
  // a file name.
  var bin = pkg.bin;
  var rel = typeof bin === 'string' ? bin : (bin && (bin.dsh || bin[Object.keys(bin)[0]]));
  if (!rel) {
    throw new Error('dsh package.json declares no `bin` entry — the CLI contract moved. Read the '
      + 'installed package before assuming a file name.');
  }
  var entry = path.join(pkgDir, rel);
  if (!fs.existsSync(entry)) {
    throw new Error('dsh `bin` points at ' + rel + ', which is not inside the installed package. '
      + 'Reinstall rather than guessing another path.');
  }
  return entry;
}

// ---------------------------------------------------------------------------
// MODEL SELECTION — the build lane, never a hardcoded vendor.
//
// W6.4, corrected by operator ruling 2026-08-21: W6 swaps the HARNESS. The
// models stay the ones src/core/brain/lanes.default.js already ranks, because
// those rankings were arrived at deliberately. "DeepSeek Harness" is the name of
// a program, not an instruction to run DeepSeek's models through it.
//
// pi-ai (dsh's bundled multi-provider LLM adapter) ships INSTALLED CATALOGS for
// these providers. A route key that names one inherits that provider's endpoint
// AND ITS WIRE PROTOCOL, which is the whole ballgame: per
// dsh-llm-pi-ai/lib/types/config.d.ts the `api` field's omission "keeps each
// installed catalog model's own protocol, which is why a catalog route needs no
// protocol at all". Mistral's catalog entries declare `mistral-conversations`,
// Mistral's own protocol. Hand-declaring `api: openai-completions` instead
// forced OpenAI shaping, which sends the system prompt in a `developer` role,
// which Mistral rejects with `422 union_tag_invalid` — and
// `compat.supportsDeveloperRole: false` was INERT against it at both route and
// model level. The fix was never a compat switch; it was to stop declaring a
// protocol for a provider the catalog already describes.
var PI_AI_CATALOG_ROUTES = {
  // MYTHOS lane provider -> { pi-ai route key, credential env var }
  mistral: { route: 'mistral', apiKeyEnv: 'MISTRAL_API_KEY' },
  cerebras: { route: 'cerebras', apiKeyEnv: 'CEREBRAS_API_KEY' },
  groq: { route: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
  nim: { route: 'nvidia', apiKeyEnv: 'NIM_API_KEY' },   // MYTHOS says nim; pi-ai says nvidia
  google: { route: 'google', apiKeyEnv: 'GOOGLE_API_KEY' },
  openrouter: { route: 'openrouter', apiKeyEnv: 'OPENROUTER_API_KEY' },
  deepseek: { route: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  // DELIBERATELY ABSENT: ollama. pi-ai ships no catalog for it, so a route key
  // naming it becomes a whole-provider declaration needing an explicit protocol
  // and a loopback port. A guessed port that half-works is worse than a named
  // refusal, so a lane walk that reaches the ollama tail says so instead.
};

// Read the installed pi-ai catalog for a route, or null when pi-ai ships none.
// The catalog file is keyed by wire protocol, then by model id.
function readPiAiCatalog(route) {
  var pkgDir = resolveDshPackageDir();
  if (!pkgDir) return null;
  // <install root>/node_modules/@deepseek-ai/dsh -> <install root>
  var installRoot = path.resolve(pkgDir, '..', '..', '..');
  var file = path.join(installRoot, 'node_modules', '@earendil-works', 'pi-ai',
    'dist', 'providers', 'data', route + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A corrupt catalog is not an absent catalog, and treating it as one would
    // silently downgrade the model. Say which file and stop.
    throw new Error('dsh-agent: pi-ai catalog for route "' + route + '" is unreadable ('
      + file + '): ' + String((err && err.message) || err));
  }
}

function catalogHasModel(route, model) {
  var catalog = readPiAiCatalog(route);
  if (!catalog) return false;
  for (var api in catalog) {
    if (Object.prototype.hasOwnProperty.call(catalog[api] || {}, model)) return true;
  }
  return false;
}

function buildLane() {
  // Required lazily so this adapter stays side-effect-free to require and so a
  // lane-table syntax error surfaces at task time with a name rather than at
  // boot as an unrelated crash.
  var lanes = require('../../src/core/brain/lanes.default');
  var table = lanes && lanes.BRAIN_TABLES && lanes.BRAIN_TABLES.build;
  var prefs = table && table.prefs;
  if (!Array.isArray(prefs) || !prefs.length) {
    throw new Error('dsh-agent: BRAIN_TABLES.build has no prefs — lanes.default.js is the single '
      + 'source of truth for which model builds run on, and it is empty or reshaped. Fix the lane '
      + 'table rather than hardcoding a model here.');
  }
  return prefs;
}

// Pick the first build-lane entry that is ACTUALLY REACHABLE: pi-ai ships a
// catalog for its provider, the catalog describes the model, and the credential
// this machine needs is present. Every rejected entry is reported by name in the
// failure, so an unreachable head reads as "why" and not as "wrong model".
//
// This is selection, not failover — see the header. The choice is made once per
// task, before the child is spawned.
function selectModel(override) {
  var rejected = [];
  var candidates = override ? [override] : buildLane();
  for (var i = 0; i < candidates.length; i++) {
    var entry = candidates[i] || {};
    var laneProvider = String(entry.provider || '');
    var model = String(entry.model || '');
    var label = laneProvider + '/' + model;
    var mapped = PI_AI_CATALOG_ROUTES[laneProvider];
    if (!mapped) {
      rejected.push(label + ' (no pi-ai catalog route for provider "' + laneProvider + '")');
      continue;
    }
    if (!process.env[mapped.apiKeyEnv]) {
      rejected.push(label + ' (' + mapped.apiKeyEnv + ' unset)');
      continue;
    }
    if (!catalogHasModel(mapped.route, model)) {
      rejected.push(label + ' (pi-ai catalog for route "' + mapped.route + '" does not describe "'
        + model + '")');
      continue;
    }
    return {
      laneProvider: laneProvider,
      route: mapped.route,
      model: model,
      apiKeyEnv: mapped.apiKeyEnv,
      rejected: rejected,
    };
  }
  throw new Error('dsh-agent: no reachable model in the build lane. Rejected, in lane order:\n'
    + rejected.map(function (r) { return '  ' + r; }).join('\n')
    + '\nThe build lane lives in mythos/src/core/brain/lanes.default.js (BRAIN_TABLES.build). '
    + 'Set the credential the first entry needs, or reorder the lane — do not hardcode a model '
    + 'in the adapter.');
}

// ---------------------------------------------------------------------------
// The overlay that points dsh at the selected model.
//
// Written to a per-run temp file rather than a tracked fixture: it is derived
// state, and a tracked file would carry a machine path (W6-AD-7) and go stale
// against the lane the moment the lane changes.
//
// `models` is omitted ON PURPOSE. config.d.ts: omission "serves the installed
// catalog for the route unchanged", while an explicit list REPLACES the catalog
// and each entry then defaults its unset fields. Listing one model would hide
// every other model the same key can reach and silently re-size the one listed.
//
// `apiKeyEnv` is a credential REFERENCE resolved per request by dsh, so no
// secret is ever written to disk here.
function writeOverlay(selected) {
  var lines = [
    '# GENERATED per run by mythos/adapters/dsh-agent. Do not edit; do not commit.',
    '# Model chosen from BRAIN_TABLES.build in src/core/brain/lanes.default.js.',
    '#',
    '# A CATALOG route: no `api` and no `baseURL`, so every model keeps the wire',
    '# protocol the installed pi-ai catalog records for it. That is what avoids',
    '# the `developer`-role 422 a hand-declared openai-completions route causes.',
    '#',
    '# apiKeyEnv is a reference resolved per request. No secret is written here.',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: ' + selected.route,
    '    model: ' + selected.model,
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      ' + selected.route + ':',
    '        apiKeyEnv: ' + selected.apiKeyEnv,
    '',
  ];
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-dsh-'));
  var file = path.join(dir, 'lane.patch.yml');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file: file, dir: dir };
}

function cleanupOverlay(handle) {
  if (!handle || !handle.dir) return;
  try { fs.rmSync(handle.dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Environment. Allowlist, never a filtered copy of process.env.
var SYSTEM_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'USERPROFILE', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATHEXT'];

// dsh's own knobs are forwarded so an operator can tune the harness, with the
// telemetry and permission names re-set below AFTER this pass so a stray
// inherited value cannot override MYTHOS's decision.
var DSH_PREFIX_RE = /^DSH_/;

// dsh's permission presets (@deepseek-ai/dsh-permission-presets, read from
// dsh-base/cordis.patch.yml:193-205):
//   read-only            sandbox read-only,      approval ask
//   workspace-write      sandbox workspace-write, approval ask   (dsh's default)
//   danger-full-access   sandbox danger-full-access, approval never
//
// MYTHOS uses the first two and NEVER the third (W6-AD-8's sibling rule in the
// plan's step-2 notes: never a blanket danger-full-access).
var PERMISSION_READ_ONLY = 'read-only';
var PERMISSION_WORKSPACE_WRITE = 'workspace-write';

// A MYTHOS-owned dsh profile directory, derived from the environment so it is
// portable (root CLAUDE.md) and so a build can never mutate the operator's own
// dsh profiles or credentials.
function mythosDshHome() {
  if (process.env.MYTHOS_DSH_HOME) return process.env.MYTHOS_DSH_HOME;
  var base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME
    || (process.env.HOME ? path.join(process.env.HOME, '.local', 'state') : os.tmpdir());
  return path.join(base, 'MYTHOS', 'dsh-home');
}

// `extra` is for tests and for the one caller that needs to pin something; it is
// applied LAST so a test can assert on an exact value.
//
// EXACTLY ONE provider credential is forwarded — the one the selected route
// references. Everything else key-shaped stays out, so a build cannot exfiltrate
// an unrelated provider key through a tool call, and a misconfigured route fails
// with MISSING_CREDENTIAL instead of silently succeeding on a neighbour's key.
function scrubbedEnv(opts) {
  opts = opts || {};
  var env = {};
  for (var i = 0; i < SYSTEM_ENV_KEYS.length; i++) {
    var k = SYSTEM_ENV_KEYS[i];
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (var key in process.env) {
    if (DSH_PREFIX_RE.test(key)) env[key] = process.env[key];
  }

  // Telemetry. dsh's export is local by default, but the shipped base bundle has
  // NO redaction rule, so an enabled export can carry message text, tool
  // arguments and results, and workspace paths. Any non-empty
  // DSH_TELEMETRY_DISABLED is documented as an authoritative hard opt-out, so it
  // is set explicitly and its two companions are deleted rather than trusted to
  // be absent — the DSH_ passthrough above would otherwise forward an inherited
  // one straight back in.
  env.DSH_TELEMETRY_DISABLED = '1';
  delete env.DSH_TELEMETRY_MODE;
  delete env.DSH_TELEMETRY_OTLP_URL;

  // Profile directory: MYTHOS-owned, never the operator's.
  env.DSH_HOME = mythosDshHome();

  // Permission mode is MYTHOS's call, so it is SET rather than inherited.
  //
  // This is where hermes-runner's `HERMES_YOLO_MODE: '1'` goes, and the
  // translation is a strict improvement. Under Hermes, "write nothing" was a
  // sentence in a prompt plus a throwaway scratch directory. Under dsh, a task
  // that must not write gets `read-only`, so the sandbox itself refuses —
  // OUTPUT_CONTRACT becomes enforced rather than requested.
  env.DSH_PERMISSION_MODE = opts.autoApprove ? PERMISSION_WORKSPACE_WRITE : PERMISSION_READ_ONLY;

  // Exactly one provider credential.
  if (opts.apiKeyEnv) {
    if (!process.env[opts.apiKeyEnv]) {
      throw new Error('dsh-agent: scrubbedEnv was asked to forward ' + opts.apiKeyEnv
        + ', which is unset. Selection should have rejected this route before now.');
    }
    env[opts.apiKeyEnv] = process.env[opts.apiKeyEnv];
  }
  return Object.assign(env, opts.extra || {});
}

// ---------------------------------------------------------------------------
// Spawn. execFile-equivalent by hand so a timeout can tree-kill: dsh boots a
// ~450-package plugin graph and a bare kill can leave the child's own children
// behind, which on Windows shows up later as fork exhaustion in an unrelated
// test run.
function spawnDsh(args, spawnOpts) {
  return new Promise(function (resolve) {
    var child;
    try {
      child = spawn(process.execPath, args, {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ kind: 'spawn-error', error: String((err && err.message) || err) });
    }
    var out = '';
    var errOut = '';
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      // A TIMEOUT IS NOT AN EXIT CODE. Conflating them would hide exactly the
      // failure W6.11 risk 2 predicts — an approval with nowhere to be answered
      // in headless mode simply runs to the wall — behind a generic "exit ?".
      try { treeKill(child.pid); } catch (_) { /* already gone */ }
      resolve({ kind: 'timeout', ms: spawnOpts.timeoutMs, stdout: out, stderr: errOut });
    }, spawnOpts.timeoutMs);

    child.stdout.on('data', function (b) { out += String(b); });
    child.stderr.on('data', function (b) { errOut += String(b); });
    child.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: 'spawn-error', error: String((err && err.message) || err) });
    });
    child.on('close', function (code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: 'exit', code: code, signal: signal, stdout: out, stderr: errOut });
    });
  });
}

// ---------------------------------------------------------------------------
// probe(). Cheap and honest: it answers "is the pinned CLI here and does it
// run", and NOTHING MORE.
//
// The hermes adapter learned this the hard way (its F5 note): a version banner
// says the binary exists and says nothing about whether a task will produce
// content. So getStatus() reports `evidence` separately from `state`, and
// ONLINE beside a recent lastTaskFailure must stay readable as such.
async function probe(force) {
  var now = Date.now();
  if (!force && now - lastProbeAt < PROBE_TTL_MS) return state === 'ONLINE';
  lastProbeAt = now;

  var entry;
  try {
    entry = resolveDshEntry();
  } catch (err) {
    state = 'OFFLINE';
    hint = String((err && err.message) || err);
    lastProbeDiagnostic = { kind: 'not-installed', detail: hint.split('\n')[0] };
    return false;
  }

  var res = await spawnDsh([entry, '--version'], {
    cwd: os.tmpdir(),                // a probe writes nothing; AD-3 still applies
    env: scrubbedEnv({}),            // read-only permission mode by default
    timeoutMs: probeTimeoutMs(),
  });

  if (res.kind === 'spawn-error') {
    state = 'OFFLINE';
    lastProbeDiagnostic = { kind: 'spawn-error', detail: res.error };
    hint = 'dsh could not be spawned (' + res.error + '). Reinstall: ' + INSTALL_HINT;
    return false;
  }
  if (res.kind === 'timeout') {
    // A slow probe is not evidence of absence, and treating it as absence costs
    // every build on a loaded machine while trusting it costs one failed
    // attempt. Same trade the hermes adapter settled after `hermes --version`
    // took 21.2s on a loaded machine. The optimism is RECORDED so a log can
    // tell it apart from a verified probe.
    state = 'ONLINE';
    lastProbeDiagnostic = { kind: 'timeout', detail: 'dsh --version exceeded ' + res.ms + 'ms; '
      + 'assumed present rather than declaring the engine offline on a loaded machine' };
    hint = 'ONLINE on a timed-out probe — presence assumed, not verified';
    logger.warn('dsh-agent.probe-timeout', { timeoutMs: res.ms, hint: hint });
    return true;
  }
  if (res.code !== 0) {
    state = 'OFFLINE';
    lastProbeDiagnostic = { kind: 'nonzero-exit', code: res.code, signal: res.signal,
      detail: String(res.stderr || '').trim().slice(0, 300) };
    hint = 'dsh --version exited ' + res.code + '. Reinstall: ' + INSTALL_HINT;
    return false;
  }
  var printed = String(res.stdout || '').trim();
  if (printed !== DSH_PINNED_VERSION) {
    // The package.json check above already ran, so this catches the case where
    // the installed tree and the running CLI disagree — a half-finished
    // reinstall, which is exactly the state that produces inexplicable results.
    state = 'OFFLINE';
    lastProbeDiagnostic = { kind: 'version-mismatch', detail: 'package.json says '
      + DSH_PINNED_VERSION + ', the CLI printed ' + JSON.stringify(printed) };
    hint = 'dsh install is inconsistent: ' + lastProbeDiagnostic.detail + '. Reinstall: ' + INSTALL_HINT;
    return false;
  }
  state = 'ONLINE';
  lastProbeDiagnostic = null;
  hint = 'dsh ' + DSH_PINNED_VERSION + ' present';
  return true;
}

function offlineEvidence() {
  var parts = [' [engine: dsh ' + (installedVersion || 'not found') + ']'];
  if (lastProbeDiagnostic) {
    parts.push(' [probe: ' + lastProbeDiagnostic.kind
      + (lastProbeDiagnostic.code != null ? ' ' + lastProbeDiagnostic.code : '')
      + (lastProbeDiagnostic.signal ? ' signal ' + lastProbeDiagnostic.signal : '')
      + (lastProbeDiagnostic.detail ? ' — ' + lastProbeDiagnostic.detail : '') + ']');
  }
  // Naming the model the lane would have used turns "the build failed" into
  // "the build failed on this model", which is the difference between a
  // diagnosable report and a shrug.
  try {
    var sel = selectModel(null);
    parts.push(' [build lane would use: ' + sel.laneProvider + '/' + sel.model + ']');
  } catch (err) {
    parts.push(' [build lane: ' + String((err && err.message) || err).split('\n')[0] + ']');
  }
  parts.push(' [fix: ' + INSTALL_HINT + ']');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// runTask(prompt, opts)
//
//   opts.cwd            REQUIRED (W6-AD-3)
//   opts.timeoutMs
//   opts.maxPromptChars
//   opts.writeRoot      intent, not an env var — must equal cwd (see below)
//   opts.autoApprove    intent, not an env var — false/absent means read-only
//   opts.model          {provider, model} override; skips the lane walk
//
// `writeRoot` exists because hermes-runner passed
// `env: { HERMES_WRITE_SAFE_ROOT: dirAbs }` — a generic caller naming another
// program's environment variable. dsh expresses the same idea structurally: the
// invoking directory IS the workspace root. So writeRoot is accepted and
// ASSERTED equal to cwd rather than silently ignored; a caller asking for a
// write root dsh cannot honour deserves to hear that, not to have it dropped.
async function runTask(prompt, opts) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt required');
  opts = opts || {};
  var cwd = requireCwd(opts.cwd);

  if (opts.writeRoot) {
    var wr = path.resolve(opts.writeRoot);
    if (wr !== cwd) {
      throw new Error('dsh-agent: writeRoot must equal cwd. dsh confines writes to its INVOKING '
        + 'directory (plus platform temp), so it cannot write to ' + wr + ' while running in '
        + cwd + '. Run the task in the directory it should write to.');
    }
    if (!opts.autoApprove) {
      throw new Error('dsh-agent: writeRoot was given with autoApprove falsy, which selects the '
        + 'read-only sandbox — the task would be refused permission to write the very directory '
        + 'it was handed. Pass autoApprove:true for a write task.');
    }
  }

  var online = await probe(false);
  if (!online) throw new Error('dsh-agent OFFLINE: ' + hint + offlineEvidence());

  var entry = resolveDshEntry();
  var selected = selectModel(opts.model || null);
  lastModel = { laneProvider: selected.laneProvider, route: selected.route, model: selected.model };
  if (selected.rejected && selected.rejected.length) {
    // The lane head being unreachable is a real operational fact — an unbilled
    // Cerebras account, an unset key — and it must not be invisible just
    // because a later entry answered.
    logger.warn('dsh-agent.lane-head-skipped', {
      using: selected.laneProvider + '/' + selected.model,
      skipped: selected.rejected,
    });
  }

  var maxPromptChars = (typeof opts.maxPromptChars === 'number') ? opts.maxPromptChars : 24000;
  var text = String(prompt).slice(0, maxPromptChars);
  var timeoutMs = opts.timeoutMs || taskTimeoutMs();
  var overlay = writeOverlay(selected);

  try {
    // Launcher flags FIRST. dsh's reference is explicit that the launcher's own
    // flags end at the first token it does not recognize, and that a first app
    // argument of `web` or `plugin` selects that subcommand — so the task is ONE
    // positional argument and never loose words, and --patch (a launcher flag)
    // must precede it.
    //
    // The overlay path is ABSOLUTE. Measured 2026-08-21: a relative --patch was
    // resolved by dsh against ITS cwd (the scratch workspace) rather than
    // MYTHOS's, and every attempt died at boot with ENOENT before a single model
    // call while the report still printed a table.
    var args = [entry, '--profile', 'headless', '--patch', overlay.file, text];
    var res = await spawnDsh(args, {
      cwd: cwd,
      env: scrubbedEnv({
        apiKeyEnv: selected.apiKeyEnv,
        autoApprove: Boolean(opts.autoApprove),
        extra: opts.env || null,
      }),
      timeoutMs: timeoutMs,
    });

    if (res.kind === 'spawn-error') throw new Error('dsh could not be spawned: ' + res.error
      + offlineEvidence());

    if (res.kind === 'timeout') {
      throw new Error('dsh produced no terminal turn within ' + timeoutMs + 'ms and was killed. '
        + 'In headless mode this is the shape an unanswerable approval prompt takes (there is no '
        + 'interactive follow-up surface). Model: ' + selected.laneProvider + '/' + selected.model
        + '. Partial stdout: '
        + (String(res.stdout || '').trim() ? JSON.stringify(String(res.stdout).trim().slice(0, 300)) : '(none)')
        + (String(res.stderr || '').trim() ? ' | stderr: ' + String(res.stderr).trim().slice(0, 300) : ' | stderr empty'));
    }

    var stderrText = String(res.stderr || '').trim();
    // The exit code IS the oracle: 0 iff the final turn/end reason is
    // `completed`. Keep stderr verbatim — a wrong classification that also
    // swallows the diagnosis is worse than the original failure.
    if (res.code !== 0) {
      throw new Error('dsh exit ' + (res.code == null ? '?' : res.code)
        + ' on ' + selected.laneProvider + '/' + selected.model
        + (stderrText ? ': ' + stderrText.slice(0, 600) : ' (stderr empty)'));
    }
    if (stderrText) {
      // Documented as empty on success. If it is not, the contract MOVED — say
      // so rather than returning content produced under unknown conditions.
      throw new Error('dsh exited 0 but wrote to stderr, which its reference says is empty on '
        + 'success; the CLI contract may have changed: ' + stderrText.slice(0, 600));
    }
    if (!String(res.stdout || '').trim()) {
      throw new Error('dsh exited 0 with empty stdout on ' + selected.laneProvider + '/'
        + selected.model);
    }
    lastTaskFailure = null;   // a real task succeeded — the only thing that clears it
    return String(res.stdout);
  } catch (err) {
    lastProbeAt = 0;          // a failed run invalidates the cached probe
    lastTaskFailure = { at: Date.now(), error: String((err && err.message) || err).slice(0, 300) };
    throw err;
  } finally {
    cleanupOverlay(overlay);
  }
}

function probeEvidence() {
  if (state !== 'ONLINE') return 'none';
  return (lastProbeDiagnostic && lastProbeDiagnostic.kind === 'timeout')
    ? 'version-probe-timed-out-assumed-present'
    : 'version-printed-and-matched-pin';
}

function getStatus() {
  return {
    state: state,
    hint: hint,
    version: installedVersion,
    pinnedVersion: DSH_PINNED_VERSION,
    probeDiagnostic: lastProbeDiagnostic,
    // Never conflate these. `state` is what the probe concluded; `evidence` is
    // what it looked at; `lastTaskFailure` is the only field here derived from a
    // real content call. ONLINE beside a recent lastTaskFailure is a real and
    // diagnosable state, not a contradiction.
    evidence: probeEvidence(),
    lastTaskFailure: lastTaskFailure,
    model: lastModel,
  };
}

module.exports = {
  probe: probe,
  runTask: runTask,
  getStatus: getStatus,
  scrubbedEnv: scrubbedEnv,
  // Exported for unit tests, and for the failure messages that name them:
  selectModel: selectModel,
  requireCwd: requireCwd,
  resolveDshEntry: resolveDshEntry,
  mythosDshHome: mythosDshHome,
  writeOverlay: writeOverlay,
  cleanupOverlay: cleanupOverlay,
  PI_AI_CATALOG_ROUTES: PI_AI_CATALOG_ROUTES,
  DSH_PINNED_VERSION: DSH_PINNED_VERSION,
};
