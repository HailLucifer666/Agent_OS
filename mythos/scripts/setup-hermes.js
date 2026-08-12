#!/usr/bin/env node
'use strict';

// scripts/setup-hermes.js — install / verify the Hermes-Agent build engine.
//
// Hermes-Agent (github.com/NousResearch/hermes-agent, MIT) generates the
// content for every MYTHOS build. It is a required dependency, not an optional
// sidecar, and there is deliberately no brain.think fallback — so a fresh
// clone needs this run once before builds work.
//
// WHAT IT DOES
//   --check (default)  report the resolved binary, its version, and whether
//                      the flags MYTHOS depends on (-z, --yolo) are present.
//   --install          clone the repo into <repo>/Hermes Agent/hermes-agent
//                      and run ITS OWN platform installer from that clone.
//
// WHY IT NEVER PIPES A REMOTE SCRIPT INTO A SHELL. Upstream's documented
// install is `iex (irm …)` / `curl … | bash`. We clone first and run the
// script from the checkout instead, so the code that executes is versioned,
// diffable, and auditable before it runs. Same line drawn for every other
// third-party installer in this repo.
//
// EVERYTHING STAYS INSIDE THE PROJECT (dev checkout) OR INSIDE userData (packaged
// install). HERMES_HOME is set to the resolved home below, which relocates the
// install dir, Hermes's managed uv, its bundled PortableGit, and its
// data/config. Nothing lands in %LOCALAPPDATA% / ~/.hermes. The dev location is
// gitignored — it holds a full third-party checkout AND Hermes's own credentials.
//
// WHY MYTHOS_TOOLS_DIR IS HONOURED (operator, 2026-08-12): "when updating, it
// asks me for the same things — the phone install, the Hermes install. Those are
// already installed."
//
// They were. An update DELETED them. This script installed unconditionally into
// <repo>/Hermes Agent, and for a packaged install <repo> is
// resources/app.asar.unpacked — inside the install tree, which the NSIS updater
// replaces wholesale (measured 2026-08-12: 23,283 files removed before the new
// ones were written). So Hermes was un-installed by every single update, and
// doctor.js — which resolved the same one path — correctly reported it missing
// and the wizard correctly re-offered it. The re-prompt was a symptom; the
// delivery location was the defect.
//
// This is the same fix, and the same dual-search rule, that
// src/core/setup/model-paths.js already applies to model weights and
// setup-android.js applies to adb: WRITE to MYTHOS_TOOLS_DIR when Electron
// injected it (userData — writable without elevation, survives an update,
// survives a reinstall), fall back to the repo for a bare `node
// scripts/setup-hermes.js` in a dev checkout, and READ both so a machine that
// installed before this change keeps working with no migration step.
//
// NOTE ON `-HermesHome`: install.ps1's -InstallDir default is computed from
// the HERMES_HOME **environment variable**, not from the -HermesHome
// parameter, so passing the flag alone still installs to %LOCALAPPDATA%.
// Both are set below. This is load-bearing — do not "simplify" it away.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_URL = 'https://github.com/NousResearch/hermes-agent.git';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Exported (via module.exports at the bottom) so doctor.js resolves exactly the
// same candidates instead of hardcoding one of them — the drift that made
// "installed" and "where we install" two different answers.
const REPO_HERMES_HOME = path.join(REPO_ROOT, 'Hermes Agent');

function toolsHermesHome(env) {
  const e = env || process.env;
  if (!e.MYTHOS_TOOLS_DIR) return null;
  return path.join(path.resolve(e.MYTHOS_TOOLS_DIR), 'Hermes Agent');
}

// A WRITE goes to userData/tools when Electron told us where that is, else the
// repo. HERMES_HOME set by the operator overrides both — it is the documented
// escape hatch and it must keep winning.
function resolveHermesHome(env) {
  const e = env || process.env;
  if (e.HERMES_HOME) return path.resolve(e.HERMES_HOME);
  return toolsHermesHome(e) || REPO_HERMES_HOME;
}

// Every home a READ should consider, most-preferred first, de-duplicated. The
// repo stays in the list forever: a dev checkout (and any machine that installed
// before 2026-08-12) has Hermes there and must not be told to reinstall it.
function hermesSearchHomes(env) {
  const homes = [];
  const e = env || process.env;
  if (e.HERMES_HOME) homes.push(path.resolve(e.HERMES_HOME));
  const tools = toolsHermesHome(e);
  if (tools) homes.push(tools);
  homes.push(REPO_HERMES_HOME);
  return homes.filter((h, i) => homes.indexOf(h) === i);
}

function installDirFor(home) {
  return path.join(home, 'hermes-agent');
}

// Where each platform's installer leaves the entry point, for a given home.
function binaryPathFor(home) {
  return process.platform === 'win32'
    ? path.join(installDirFor(home), 'venv', 'Scripts', 'hermes.exe')
    : path.join(installDirFor(home), 'venv', 'bin', 'hermes');
}

// The first binary that actually exists across the search homes, or null. This is
// what "is Hermes installed?" means now — not "is it at the one path we would
// install to today".
//
// `homes` is an injectable seam for tests only. Without it, the repo home is
// always searched (deliberately — see hermesSearchHomes), so a machine that has
// Hermes in its dev checkout cannot express "nothing is installed anywhere" and
// the negative case would be untestable on the very machine that needs it.
function findInstalledBinary(env, homes) {
  for (const home of (homes || hermesSearchHomes(env))) {
    const bin = binaryPathFor(home);
    try { if (fs.statSync(bin).size > 0) return { bin, home }; } catch { /* next candidate */ }
  }
  return null;
}

const HERMES_HOME = resolveHermesHome();
const INSTALL_DIR = installDirFor(HERMES_HOME);

// An existing install anywhere wins for --check/probe purposes; a fresh
// --install still writes to the resolved home above.
function binaryPath() {
  const found = findInstalledBinary();
  return found ? found.bin : binaryPathFor(HERMES_HOME);
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, Object.assign({ stdio: 'inherit', shell: false }, opts || {}));
    child.on('error', (err) => resolve({ ok: false, code: -1, error: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code }));
  });
}

// Capture rather than inherit — used for the version/flag probes, whose output
// is reported verbatim rather than summarised.
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 120000 });
  return { ok: r.status === 0, out: String(r.stdout || '') + String(r.stderr || ''), error: r.error && r.error.message };
}

function check() {
  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    console.log('hermes: NOT INSTALLED');
    console.log('  expected at: ' + bin);
    console.log('  run: node mythos/scripts/setup-hermes.js --install');
    return 1;
  }
  const version = capture(bin, ['--version']);
  if (!version.ok) {
    console.log('hermes: PRESENT BUT NOT RUNNABLE');
    console.log('  ' + bin);
    console.log(version.out.trim() || version.error || '(no output)');
    return 1;
  }
  console.log('hermes: OK');
  console.log('  binary : ' + bin);
  version.out.trim().split(/\r?\n/).forEach((l) => console.log('  ' + l));

  // MYTHOS drives Hermes through `-z <prompt>`; Forge additionally relies on
  // --yolo. A major Hermes release removing either would break builds, so this
  // is checked rather than assumed.
  const help = capture(bin, ['--help']);
  const hasOneshot = /-z\s+PROMPT|--oneshot/.test(help.out);
  const hasYolo = /--yolo/.test(help.out);
  console.log('  -z/--oneshot : ' + (hasOneshot ? 'present' : 'MISSING — builds cannot run'));
  console.log('  --yolo       : ' + (hasYolo ? 'present' : 'MISSING — Forge builds cannot run'));

  // A provider must be configured or every build returns an auth error. Hermes
  // reports provider failures on stdout with exit code 0, so this is worth
  // saying out loud rather than discovering inside a failed build.
  // BUG-168: a misconfigured provider is not a "warning" — it is a guaranteed
  // build failure on every single build, reported as an HTTP 401 that looks
  // like a MYTHOS bug. --check now exits non-zero for it, same as a missing
  // -z/--yolo flag, so the operator finds out here instead of in a build.
  let providerOk = true;
  const cfg = path.join(HERMES_HOME, 'config.yaml');
  if (fs.existsSync(cfg)) {
    const src = fs.readFileSync(cfg, 'utf8');
    // YAML quotes are optional and Hermes accepts either form, but this check
    // used to compare the RAW capture against a bare string — so the perfectly
    // valid `provider: "openai-api"` was reported as
    // `must be "openai-api" (found: "openai-api")`, which reads as a bug in
    // MYTHOS and cannot be acted on. It bites by default: the Hermes installer
    // writes `provider: "auto"` quoted, so an operator fixing it in place keeps
    // the quotes. Strip them before comparing (2026-08-13).
    const unquote = (m) => (m ? m[1].replace(/^['"]|['"]$/g, '') : null);
    const base = unquote(/^\s*base_url:\s*(\S+)/m.exec(src));
    const model = unquote(/^\s*default:\s*(\S+)/m.exec(src));
    const provider = unquote(/^\s*provider:\s*(\S+)/m.exec(src));
    console.log('  provider     : ' + (provider || '(unset)') +
                '  model: ' + (model || '(unset)') +
                '  base_url: ' + (base || '(unset)'));
    // config.yaml overrides the OPENAI_* pair the adapter forwards, and only the
    // `openai-api` registry id actually consumes that pair (its ProviderConfig
    // declares api_key_env_vars=("OPENAI_API_KEY",) / base_url_env_var=
    // "OPENAI_BASE_URL"). `openai` is not a registry id at all and `custom` is a
    // plugin, so either one authenticates as nobody: every call comes back
    // "HTTP 401: Missing Authentication header". Root-caused live 2026-07-29.
    if (provider !== 'openai-api') {
      providerOk = false;
      console.log('  ERROR: model.provider must be "openai-api" for MYTHOS (found: ' + (provider || 'unset') + ').');
      console.log('    That is the only registry id that reads the OPENAI_API_KEY/');
      console.log('    OPENAI_BASE_URL pair the adapter forwards. With anything else');
      console.log('    (including "openai" or "custom") every build fails with');
      console.log('    "HTTP 401: Missing Authentication header".');
      console.log('    Fix in ' + cfg + ':  provider: openai-api');
    }
  }
  reportProviderSlots();
  reportKeyShadowing();
  if (!providerOk) {
    console.log('');
    console.log('hermes: NOT USABLE FOR BUILDS — fix model.provider above, then re-run this check.');
    console.log('  Builds have no brain fallback by design, so this fails every build, not some.');
  }
  return (hasOneshot && hasYolo && providerOk) ? 0 : 1;
}

// ROOT-CAUSED LIVE 2026-08-03, against Hermes v0.19.0's own source.
//
// Provider rotation forwards OPENAI_API_KEY / OPENAI_BASE_URL per attempt. That
// silently does NOTHING if <HERMES_HOME>/.env defines those keys, because
// Hermes prefers its own .env over the inherited process env:
//   hermes_cli/env_loader.py:321  loads <HERMES_HOME>/.env with override=True
//   hermes_cli/auth.py:597-604    resolves api_key_env_vars through
//                                 get_env_value_prefer_dotenv(), which returns
//                                 the .env value and only falls back to
//                                 os.environ when .env has none.
// Upstream did that deliberately ("so a deliberate key rotation in the user's
// .env isn't shadowed by a stale shell export") — it is not a bug, and there is
// no env-var escape hatch.
//
// The symptom is the worst kind: builds SUCCEED. A deliberately invalid key
// forwarded by MYTHOS produced a correct artifact on this machine, because
// Hermes never read it. Rotation would then "work" in tests and rotate into the
// same credential forever in production.
//
// MYTHOS does not edit this file. It is the operator's third-party install
// state and holds live credentials — the same reason config.yaml is never
// written. Detect and instruct; the operator decides.
//
// HERMES_INFERENCE_MODEL is NOT affected: Hermes's .env does not define it, so
// the forwarded value applies. Model-based rotation is live-verified working.
function reportKeyShadowing() {
  const hermesEnv = path.join(HERMES_HOME, '.env');
  if (!fs.existsSync(hermesEnv)) return;
  let src;
  try { src = fs.readFileSync(hermesEnv, 'utf8'); } catch (_) { return; }

  // Names only — this file holds live credentials and is never echoed.
  const shadowed = ['OPENAI_API_KEY', 'OPENAI_BASE_URL']
    .filter((k) => new RegExp('^\\s*' + k + '\\s*=\\s*\\S', 'm').test(src));
  if (!shadowed.length) return;

  // Track D (2026-08-04): every MYTHOS-driven build now runs inside a
  // throwaway per-attempt HERMES_HOME that never carries a copy of this
  // file, so this shadowing can no longer touch a build — the warning below
  // is scoped to standalone `hermes` CLI use (running it directly, outside
  // MYTHOS) where the real HERMES_HOME above is still what gets read.
  console.log('  NOTE: ' + hermesEnv + ' still defines ' + shadowed.join(' and ') + '.');
  console.log('    This no longer affects MYTHOS builds — every build attempt now runs in');
  console.log('    its own throwaway HERMES_HOME (adapters/hermes-agent per-attempt config,');
  console.log('    Track D 2026-08-04) that never copies this file, so the override=True');
  console.log('    shadow (env_loader.py, get_env_value_prefer_dotenv) cannot reach it.');
  console.log('    It STILL applies if you run `hermes` standalone (outside MYTHOS) against');
  console.log('    the real HERMES_HOME above — that keeps reading this file as before.');
}

// Provider failover (2026-08-03). The adapter forwards ONE provider pair per
// attempt and rotates through the configured slots on a provider-class failure,
// so "which slots do I actually have?" is now a real question a fresh clone
// needs answered before a build, not after one dies on a 429.
//
// KEYS ARE NEVER PRINTED — only the endpoint and model each slot resolves to.
// The slot table is read from the adapter rather than re-derived here: one
// definition of the convention, no chance of this report and the runtime
// disagreeing about what is configured.
function reportProviderSlots() {
  // --check is run standalone, before MYTHOS boots, so nothing has loaded .env.
  try {
    const envFile = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
  } catch (_) { /* best-effort: an unreadable .env just means fewer slots reported */ }

  let slots;
  try {
    const hermesAdapter = require('../adapters/hermes-agent');
    slots = hermesAdapter.providerSlots();
  } catch (err) {
    console.log('  provider slots: (could not read — ' + ((err && err.message) || err) + ')');
    return;
  }

  if (!slots.length) {
    console.log('  provider slots: NONE CONFIGURED — every build will fail with an auth error.');
    console.log('    Set HERMES_PROVIDER_KEY / HERMES_PROVIDER_BASE_URL / HERMES_INFERENCE_MODEL in mythos/.env');
    return;
  }

  console.log('  provider slots: ' + slots.length + ' (tried in order; rotation on 401/429/timeout/non-zero exit)');
  slots.forEach((s) => {
    const d = require('../adapters/hermes-agent').describeSlot(s);
    console.log('    slot ' + d.slot + '  ' + d.baseUrl + '  ' + d.model);
  });

  // A duplicated key value is the failure mode that looks like it works. Two
  // slots sharing one key share ONE rate bucket, so rotating from slot 1 to
  // slot 2 on a 429 rotates straight into the same exhausted quota — the
  // failover reports as configured and buys nothing.
  const seen = new Map();
  slots.forEach((s) => {
    if (!s.apiKey) return;
    if (seen.has(s.apiKey)) {
      console.log('  WARNING: slot ' + seen.get(s.apiKey) + ' and slot ' + s.slot + ' share the SAME key value.');
      console.log('    One key is one rate bucket — rotating between them cannot escape a 429.');
      console.log('    Issue a separate key per slot, or drop the duplicate slot.');
    } else {
      seen.set(s.apiKey, s.slot);
    }
  });

  // FIXED 2026-08-04 (Track D). Hermes takes model.base_url from its own
  // config.yaml and ignores the OPENAI_BASE_URL the adapter forwards — proven
  // 2026-08-03 by forwarding an unroutable base_url and still getting a
  // correct reply. Until Track D landed, that made a cross-provider slot
  // genuinely UNREACHABLE: rotation could change the KEY and the MODEL, never
  // the ENDPOINT, so a differing base_url here was a real dead end and this
  // function said so.
  //
  // adapters/hermes-agent's runViaCliWithRotation now gives EACH ATTEMPT its
  // own throwaway HERMES_HOME with a config.yaml written for that attempt's
  // slot (provider/base_url/model), so a slot whose base_url differs from
  // the REAL config.yaml below is no longer unreachable — it authenticates
  // against its own endpoint instead of the shared one. The only thing left
  // to flag is a slot with no endpoint configured at all (relies entirely on
  // config.yaml's default, which is fine for slot 1 but a silent no-op for
  // slots 2-4).
  let configBase = '';
  try {
    const cfgPath = path.join(HERMES_HOME, 'config.yaml');
    if (fs.existsSync(cfgPath)) {
      const m = /^\s*base_url:\s*(\S+)/m.exec(fs.readFileSync(cfgPath, 'utf8'));
      if (m) configBase = m[1].replace(/\/+$/, '');
    }
  } catch (_) { /* diagnostic only — never block --check */ }
  if (configBase) {
    const crossProvider = slots.filter((s) => {
      const b = s.baseUrl ? String(s.baseUrl).replace(/\/+$/, '') : '';
      return b && b !== configBase;
    });
    if (crossProvider.length) {
      console.log('  ' + crossProvider.length + ' slot(s) point at a different endpoint than config.yaml below —');
      console.log('    reachable via a per-attempt HERMES_HOME (Track D, 2026-08-04):');
      crossProvider.forEach((s) => console.log('    slot ' + s.slot + ' -> ' + s.baseUrl));
      console.log('    Each attempt now gets its own throwaway HERMES_HOME/config.yaml naming');
      console.log('    that slot\'s own endpoint, so it authenticates against ITS provider,');
      console.log('    not the one pinned below. config.yaml itself: base_url: ' + configBase);
    }
    const noEndpoint = slots.filter((s) => s.slot !== 1 && !s.baseUrl);
    if (noEndpoint.length) {
      console.log('  WARNING: slot(s) ' + noEndpoint.map((s) => s.slot).join(', ') + ' set no base_url of their own.');
      console.log('    They will fall back to config.yaml\'s endpoint (' + configBase + '), which usually');
      console.log('    means the slot shares a rate bucket with slot 1 instead of escaping it.');
    }
  }
}

async function install() {
  console.log('Installing Hermes-Agent into ' + HERMES_HOME);
  fs.mkdirSync(HERMES_HOME, { recursive: true });

  // ponytail: pin to a specific release tag instead of main HEAD. Hermes uses
  // date-based versioning (vYYYY.M.D), not semver — v0.19.0/Quicksilver (the
  // 2026.7.20 release) is tag v2026.7.20. Upgrade path: bump this tag, re-run --install.
  const TAG = 'v2026.7.20';
  if (fs.existsSync(path.join(INSTALL_DIR, '.git'))) {
    console.log('\n[1/2] existing clone found — checking out ' + TAG);
    const fetched = await run('git', ['-C', INSTALL_DIR, 'fetch', '--tags', '--force']);
    if (!fetched.ok) return console.log('git fetch failed (exit ' + fetched.code + ')'), 1;
    const checked = await run('git', ['-C', INSTALL_DIR, 'checkout', TAG]);
    if (!checked.ok) return console.log('git checkout ' + TAG + ' failed (exit ' + checked.code + ')'), 1;
  } else {
    console.log('\n[1/2] cloning ' + REPO_URL + ' @ ' + TAG);
    const cloned = await run('git', ['clone', '--branch', TAG, REPO_URL, INSTALL_DIR]);
    if (!cloned.ok) return console.log('git clone failed (exit ' + cloned.code + ')'), 1;
  }

  console.log('\n[2/2] running the clone\'s own installer (this downloads its own Python/uv — expect ~1GB)');
  // HERMES_HOME must be in the ENV, not just the flag — see the note at the
  // top of this file.
  const env = Object.assign({}, process.env, { HERMES_HOME: HERMES_HOME });
  let res;
  if (process.platform === 'win32') {
    res = await run('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(INSTALL_DIR, 'scripts', 'install.ps1'),
      '-HermesHome', HERMES_HOME, '-InstallDir', INSTALL_DIR,
      '-NonInteractive', '-SkipSetup',
    ], { cwd: INSTALL_DIR, env });
  } else {
    res = await run('bash', [path.join(INSTALL_DIR, 'scripts', 'install.sh')], { cwd: INSTALL_DIR, env });
  }
  if (!res.ok) return console.log('installer failed (exit ' + res.code + ')'), 1;

  console.log('\nInstaller finished. Verifying against the binary itself:\n');
  const code = check();
  if (code === 0) {
    console.log('\nNext: set HERMES_CLI in mythos/.env to');
    console.log('  ' + binaryPath());
    console.log('An absolute path is required — a bare `hermes` can resolve to an');
    console.log('unrelated shim earlier on PATH. Then run `hermes model` once to');
    console.log('choose a provider, or builds will fail with an auth error.');
  }
  return code;
}

// Same require.main guard setup-android.js uses, and for the same reason: doctor.js
// now requires this file to resolve the binary, and a require that also ran the
// --check probe would spawn a child process on every doctor report.
if (require.main === module) {
  (async () => {
    const wantsInstall = process.argv.includes('--install');
    process.exitCode = wantsInstall ? await install() : check();
  })();
}

module.exports = {
  resolveHermesHome,
  hermesSearchHomes,
  findInstalledBinary,
  binaryPathFor,
  installDirFor,
  binaryPath,
  REPO_HERMES_HOME,
  HERMES_HOME: function() { return HERMES_HOME; },
  INSTALL_DIR: function() { return INSTALL_DIR; },
};
