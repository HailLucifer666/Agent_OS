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
//   * stderr is EMPTY on success; a terminal error writes its code + message —
//     but ONLY for turn-end reason kind `error`. blocked/aborted/max-tokens
//     exit 1 in silence, with the last assistant text on stdout (BUG-356).
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
var routePolicy = require('../../src/core/brain/route-policy');
var logger = createLogger(process.env.LOG_LEVEL || 'info');
// The post-mortem layer: what a dead child process gets reported AS. Split out
// for BUG-356 because this file sits on its size ratchet ceiling.
var { timeoutDiagnosis, exitDiagnosis, withEvidence } = require('./diagnosis');

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
// failure. BUG-402: paths share the installer's environment-aware resolver.
var DSH_PINNED_VERSION = '0.1.1-rc.2';
var { dshSearchHomes, packageDirFor, findInstalled } = require('../../src/core/dsh-location');

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

function resolveDshPackageDir(env, homes) {
  var found = findInstalled(env, homes);
  return found ? found.pkgDir : null;
}

// Returns the absolute path to dsh's CLI entry, or throws with the install hint.
// Deliberately does NOT fall back to `npx --yes`: that caches outside the opened
// project (root CLAUDE.md forbids it) and floats the version under a pin.
function resolveDshEntry(env, homes) {
  var found = findInstalled(env, homes);
  if (!found) {
    throw new Error('dsh is not installed project-local. Run:\n  ' + INSTALL_HINT + '\nLooked in:\n'
      + (homes || dshSearchHomes(env)).map(packageDirFor).map(function (d) { return '  ' + d; }).join('\n'));
  }
  if (found.reason) {
    throw new Error('dsh install at ' + found.pkgDir + ': ' + found.reason + '. Reinstall: ' + INSTALL_HINT);
  }
  installedVersion = found.version || null;
  if (found.version !== DSH_PINNED_VERSION) {
    throw new Error('dsh version mismatch: installed ' + found.version + ', this adapter is pinned '
      + 'to ' + DSH_PINNED_VERSION + '. dsh is a developer preview whose README says there WILL '
      + 'be compatibility-breaking changes, so the CLI contract this adapter asserts cannot be '
      + 'assumed to hold. Reinstall the pin (' + INSTALL_HINT + '), or move DSH_PINNED_VERSION '
      + 'deliberately after re-reading the installed reference.');
  }
  return found.entry;
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

// The catalog's entry for a model (null when absent). Its baseUrl is what the
// billing policy judges: dsh calls the host pi-ai's catalog names, not MYTHOS's
// own *_API_URL overrides.
function catalogEntry(route, model) {
  var catalog = readPiAiCatalog(route);
  if (!catalog) return null;
  for (var api in catalog) {
    if (Object.prototype.hasOwnProperty.call(catalog[api] || {}, model)) return catalog[api][model] || {};
  }
  return null;
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
  // 2026-10-06: the operator's chosen build model heads the walk (model-choice.js).
  return require('../../src/core/brain/model-choice').withChoice('build', prefs);
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
    var entryInCatalog = catalogEntry(mapped.route, model);
    if (!entryInCatalog) {
      rejected.push(label + ' (pi-ai catalog for route "' + mapped.route + '" does not describe "'
        + model + '")');
      continue;
    }
    // Wave 0c: a paid or unclassified route nobody chose for 'build' is rejected
    // by name like any unreachable one — the explicit override included.
    var billing = routePolicy.decide({ provider: laneProvider, model: model, endpoint: entryInCatalog.baseUrl, mode: 'build' });
    if (!billing.allowed) { rejected.push(label + ' (' + billing.reason + ')'); continue; }
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

  // BUG-301 (found live 2026-08-22, inside the real desktop app). spawnDsh uses
  // `process.execPath`, and MYTHOS's server runs under Electron — so execPath is
  // electron.exe, not node. Electron only behaves as a Node interpreter when
  // ELECTRON_RUN_AS_NODE is set, and the allowlist above deliberately builds a
  // fresh env rather than copying process.env, which STRIPPED exactly that
  // variable. dsh's bin.js was therefore handed to Electron as an APP: it threw
  // "App threw an error during load", never emitted a terminal turn, and the
  // adapter waited its full 600s task timeout before killing it. Three real
  // builds died that way before anything noticed.
  //
  // Set unconditionally, not behind a `process.versions.electron` check: a real
  // node ignores it, and the parent that matters is whatever spawned THIS
  // process, which a library cannot reliably introspect.
  //
  // WHY EVERY TEST MISSED IT, because that is the part worth remembering: under
  // plain `node` — the suite, verify-dsh-build.js's 5/5 stages, the dsh-vs-Hermes
  // spike, every mutation run — execPath IS node and this bug cannot occur. It
  // only exists on the path a user actually takes. Same shape as the cursor
  // overlay crash root CLAUDE.md records: a green suite cannot tell you the
  // Electron app works.
  //
  // The probe is NOT a detector for this and must not be trusted as one:
  // `bin.js --version` printed the pinned version and matched even under
  // Electron, so dsh-agent reported ONLINE with
  // evidence "version-printed-and-matched-pin" while no build could succeed.
  env.ELECTRON_RUN_AS_NODE = '1';

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
  // NO CALLER-SUPPLIED MERGE HERE, deliberately.
  //
  // Audit item 3, 2026-08-22. This line was
  //
  //     return Object.assign(env, opts.extra || {});
  //
  // and later keys win in Object.assign, so whatever the caller passed
  // overwrote every setting decided above. Measured with autoApprove:false
  // and a hostile extra: DSH_PERMISSION_MODE came back "workspace-write",
  // ELECTRON_RUN_AS_NODE came back "" (BUG-301, reintroduced), and
  // DSH_TELEMETRY_DISABLED came back "" (the privacy opt-out, off). Three
  // settings this function exists to decide, all overridable by its caller.
  //
  // DELETED RATHER THAN DEFENDED, because it had no callers: the only
  // mention anywhere in src/ or adapters/ was the forwarding line in runTask
  // that fed it, and no runTask caller passed env. build-engine,
  // forge-runner and from-dsh all express intent structurally instead —
  // cwd, writeRoot, autoApprove — which is what forge-runner's own comment
  // already says it learned when Hermes was deleted out from under a set of
  // HERMES_-prefixed variables.
  //
  // If a real need appears: put the merge ABOVE the decided settings so they
  // still win, and say why here. It does not come back below them.
  return env;
}

// ---------------------------------------------------------------------------
// Spawn. execFile-equivalent by hand so a timeout can tree-kill: dsh boots a
// ~450-package plugin graph and a bare kill can leave the child's own children
// behind, which on Windows shows up later as fork exhaustion in an unrelated
// test run.
// FATAL STDERR — the crash the adapter used to sit through.
//
// BUG-305. During BUG-301 three real builds each ran to the 600,000ms wall and
// then failed, and the engine had already said why. MEASURED 2026-08-22 against
// the installed engine, reproducing the incident shape exactly (dsh launched by
// electron.exe as an APPLICATION):
//
//   first stdout byte : 47ms
//   first stderr byte : 1892ms  "App threw an error during load"
//                               "failed to apply loader entry ... (@deepseek-ai/
//                                cordis-plugin-hmr): --expose-internals is
//                                required for HMR service"
//   still alive at    : 45,028ms, and it would have run to the full timeout
//
// The diagnosis was available at 1.9 seconds. Watching stderr as it arrives
// turns ten minutes of silence into a two-second honest failure.
//
// THE RISK IN THIS FIX IS THE OPPOSITE OF THE BUG: a pattern that is too eager
// kills runs that would have succeeded, and plenty of healthy programs write to
// stderr. So the list is short, every entry was OBSERVED rather than imagined,
// and every entry carries the reason it means "this process cannot recover".
// Add to it with a measurement beside it or not at all.
var FATAL_STDERR_SIGNATURES = [
  {
    pattern: /^App threw an error during load/m,
    why: 'Electron refusing to run the entry as an application — the process never becomes an '
      + 'engine and will sit there until it is killed. This is BUG-301 first layer, verbatim.',
  },
  {
    pattern: /failed to apply loader entry/,
    why: "dsh's own plugin loader could not initialise a required plugin. It raises this at load "
      + 'time, before any model call, and the harness cannot run without its plugin graph.',
  },
];

// The first signature present in `text`, or null. Exported so the list can be
// tested against real captured output rather than against itself.
function fatalStderrSignature(text) {
  var s = String(text || '');
  if (!s.trim()) return null;
  for (var i = 0; i < FATAL_STDERR_SIGNATURES.length; i++) {
    if (FATAL_STDERR_SIGNATURES[i].pattern.test(s)) return FATAL_STDERR_SIGNATURES[i];
  }
  return null;
}

// BUG-437 (2026-09-16): in-flight task children. A dsh task is a grandchild of
// the Electron shell; the shell's kill of the server never reached it, and
// stopRunningLoops() had no hook to stop it. Idempotent: an empty set is a no-op.
var activeChildren = new Set();
function shutdown() {
  activeChildren.forEach(function (c) { try { treeKill(c, c.pid); } catch (_) { /* already gone */ } });
  activeChildren.clear();
}

function spawnDsh(args, spawnOpts) {
  return new Promise(function (resolve) {
    var child;
    try {
      // BUG-301, second half. `--expose-internals` is REQUIRED, not defensive.
      // dsh's own plugin graph loads @deepseek-ai/cordis-plugin-hmr, which
      // refuses to initialise without it:
      //
      //   Error: failed to apply loader entry 1e4e3e1a
      //     (@deepseek-ai/cordis-plugin-hmr): --expose-internals is required
      //     for HMR service
      //
      // Under plain `node` dsh arranges this for itself, which is why every
      // node-hosted run (the suite, verify-dsh-build.js, the spike) passed
      // without it. Under Electron-as-node that arrangement does not survive, so
      // the flag is passed explicitly here. Measured 2026-08-22 under
      // electron.exe 43.3.0 with ELECTRON_RUN_AS_NODE=1: without the flag the
      // task dies in 1.9s on the HMR error; with it the same task returns in
      // 5.06s — the same time it takes under plain node.
      //
      // It is prepended (interpreter flags must precede the script) and it does
      // not widen the sandbox: DSH_PERMISSION_MODE still decides what the task
      // may write. It only makes node's internal modules visible to a child that
      // already requires them to boot.
      child = spawn(process.execPath, ['--expose-internals'].concat(args), {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ kind: 'spawn-error', error: String((err && err.message) || err) });
    }
    // BUG-437 (2026-09-16): tracked so shutdown() can tree-kill a task that is
    // still running when MYTHOS stops. 'close' fires after every exit shape
    // (normal, killed by the timeout, killed by shutdown), so one hook covers
    // removal.
    activeChildren.add(child);
    child.on('close', function () { activeChildren.delete(child); });
    var out = '';
    var errOut = '';
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      // A TIMEOUT IS NOT AN EXIT CODE. Conflating them would hide exactly the
      // failure W6.11 risk 2 predicts — an approval with nowhere to be answered
      // in headless mode simply runs to the wall — behind a generic "exit ?".
      try { treeKill(child, child.pid); } catch (_) { /* already gone */ }
      resolve({ kind: 'timeout', ms: spawnOpts.timeoutMs, stdout: out, stderr: errOut });
    }, spawnOpts.timeoutMs);

    var startedAt = Date.now();
    child.stdout.on('data', function (b) { out += String(b); });
    child.stderr.on('data', function (b) {
      errOut += String(b);
      if (settled) return;
      // BUG-305: act on the crash when it is announced, not when the clock runs
      // out. A FATAL SIGNATURE IS NOT A TIMEOUT and not an exit code — it is its
      // own kind, so the caller cannot confuse "it crashed at load and told us"
      // with "it went quiet", which are different problems with different fixes.
      var signature = fatalStderrSignature(errOut);
      if (!signature) return;
      settled = true;
      clearTimeout(timer);
      try { treeKill(child, child.pid); } catch (_) { /* already gone */ }
      resolve({
        kind: 'fatal-stderr',
        signature: signature,
        ms: Date.now() - startedAt,
        stdout: out,
        stderr: errOut,
      });
    });
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

// BUG-305, second loose end: record a failed task where somebody will find it.
//
// The three builds that died during BUG-301 appear NOWHERE in mythos-server.log.
// The only trace was in the vault audit trail, via the healer's reprobe detail —
// so the first place anyone looks after a ten-minute failure was empty. This
// adapter has built a logger at module load since it was written and already
// uses it twice; the failure path simply never called it.
//
// The logger is a parameter with a default rather than a module global, because
// this repo's logger is silent under test: a test that greps captured output for
// a log line passes whether or not the line is emitted.
function noteTaskFailure(err, ctx) {
  ctx = ctx || {};
  var log = ctx.logger || logger;
  var message = String((err && err.message) || err);
  lastProbeAt = 0;            // a failed run invalidates the cached probe
  lastTaskFailure = { at: Date.now(), error: message.slice(0, 300) };
  log.warn('dsh-agent.task-failed', {
    model: ctx.model || null,
    elapsedMs: typeof ctx.elapsedMs === 'number' ? ctx.elapsedMs : null,
    error: message.slice(0, 300),
    stderr: String(ctx.stderr || '').trim().slice(0, 600) || null,
    // BUG-356: on four of dsh's five non-completed turn ends this is the only
    // channel with anything in it, and it was never logged.
    stdout: String(ctx.stdout || '').trim().slice(0, 600) || null,
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
  lastModel = { laneProvider: selected.laneProvider, route: selected.route, model: selected.model, rejected: selected.rejected || [] }; if (opts.onModelSelected) opts.onModelSelected(lastModel);
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
  var taskStartedAt = Date.now();

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
      }),
      timeoutMs: timeoutMs,
    });

    if (res.kind === 'spawn-error') throw new Error('dsh could not be spawned: ' + res.error
      + offlineEvidence());

    // BUG-305: the engine announced a load-time crash and was stopped there,
    // rather than being left to run to the timeout with the answer already on
    // its stderr.
    if (res.kind === 'fatal-stderr') {
      throw withEvidence(new Error('dsh died at load after ' + res.ms + 'ms on ' + selected.laneProvider + '/'
        + selected.model + ' and was stopped rather than left to reach the ' + timeoutMs
        + 'ms timeout. ' + res.signature.why + ' stderr: '
        + JSON.stringify(String(res.stderr || '').trim().slice(0, 600))), res);
    }

    if (res.kind === 'timeout') {
      throw withEvidence(new Error(timeoutDiagnosis({
        timeoutMs: timeoutMs,
        model: selected.laneProvider + '/' + selected.model,
        stdout: res.stdout,
        stderr: res.stderr,
      })), res);
    }

    var stderrText = String(res.stderr || '').trim();
    // The exit code IS the oracle: 0 iff the final turn/end reason is
    // `completed`. BUG-356: the exit code and stderr do NOT make the same cut —
    // stderr is written only for reason kind `error`, while blocked, aborted,
    // max-tokens and a missing reason all exit 1 in silence. This branch used to
    // report that silence as "(stderr empty)" and drop stdout, which is the one
    // stream dsh writes on every outcome. See ./diagnosis.js for the measurement.
    if (res.code !== 0) {
      throw withEvidence(new Error(exitDiagnosis({
        code: res.code,
        model: selected.laneProvider + '/' + selected.model,
        stdout: res.stdout,
        stderr: res.stderr,
      })), res);
    }
    if (stderrText) {
      // Documented as empty on success. If it is not, the contract MOVED — say
      // so rather than returning content produced under unknown conditions.
      throw withEvidence(new Error('dsh exited 0 but wrote to stderr, which its reference says is empty on '
        + 'success; the CLI contract may have changed: ' + stderrText.slice(0, 600)), res);
    }
    if (!String(res.stdout || '').trim()) {
      throw withEvidence(new Error('dsh exited 0 with empty stdout on ' + selected.laneProvider
        + '/' + selected.model), res);
    }
    lastTaskFailure = null;   // a real task succeeded — the only thing that clears it
    return String(res.stdout);
  } catch (err) {
    // BUG-305: this block already knew everything worth logging and logged none
    // of it. noteTaskFailure keeps the lastTaskFailure bookkeeping getStatus()
    // depends on AND writes the line the server log was missing.
    noteTaskFailure(err, {
      model: selected.laneProvider + '/' + selected.model,
      elapsedMs: Date.now() - taskStartedAt,
      stderr: err && err.stderrText,
      stdout: err && err.stdoutText,
    });
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
  shutdown: shutdown,
  scrubbedEnv: scrubbedEnv,
  // Exported for unit tests, and for the failure messages that name them:
  selectModel: selectModel,
  spawnDsh: spawnDsh,
  fatalStderrSignature: fatalStderrSignature,
  FATAL_STDERR_SIGNATURES: FATAL_STDERR_SIGNATURES,
  timeoutDiagnosis: timeoutDiagnosis,
  exitDiagnosis: exitDiagnosis,
  withEvidence: withEvidence,
  noteTaskFailure: noteTaskFailure,
  requireCwd: requireCwd,
  resolveDshEntry: resolveDshEntry,
  mythosDshHome: mythosDshHome,
  writeOverlay: writeOverlay,
  cleanupOverlay: cleanupOverlay,
  PI_AI_CATALOG_ROUTES: PI_AI_CATALOG_ROUTES,
  DSH_PINNED_VERSION: DSH_PINNED_VERSION,
};
