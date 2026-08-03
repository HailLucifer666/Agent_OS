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
// EVERYTHING STAYS INSIDE THE PROJECT. HERMES_HOME is set to
// <repo>/Hermes Agent, which relocates the install dir, Hermes's managed uv,
// its bundled PortableGit, and its data/config. Nothing lands in
// %LOCALAPPDATA% / ~/.hermes. That directory is gitignored — it holds a full
// third-party checkout AND Hermes's own credentials.
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
const HERMES_HOME = path.join(REPO_ROOT, 'Hermes Agent');
const INSTALL_DIR = path.join(HERMES_HOME, 'hermes-agent');

// Where each platform's installer leaves the entry point.
function binaryPath() {
  return process.platform === 'win32'
    ? path.join(INSTALL_DIR, 'venv', 'Scripts', 'hermes.exe')
    : path.join(INSTALL_DIR, 'venv', 'bin', 'hermes');
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
  const cfg = path.join(HERMES_HOME, 'config.yaml');
  if (fs.existsSync(cfg)) {
    const src = fs.readFileSync(cfg, 'utf8');
    const base = /^\s*base_url:\s*(\S+)/m.exec(src);
    const model = /^\s*default:\s*(\S+)/m.exec(src);
    const provider = /^\s*provider:\s*(\S+)/m.exec(src);
    console.log('  provider     : ' + (provider ? provider[1] : '(unset)') +
                '  model: ' + (model ? model[1] : '(unset)') +
                '  base_url: ' + (base ? base[1] : '(unset)'));
    // config.yaml overrides the OPENAI_* pair the adapter forwards, and only the
    // `openai-api` registry id actually consumes that pair (its ProviderConfig
    // declares api_key_env_vars=("OPENAI_API_KEY",) / base_url_env_var=
    // "OPENAI_BASE_URL"). `openai` is not a registry id at all and `custom` is a
    // plugin, so either one authenticates as nobody: every call comes back
    // "HTTP 401: Missing Authentication header". Root-caused live 2026-07-29.
    if (!provider || provider[1] !== 'openai-api') {
      console.log('  WARNING: model.provider should be "openai-api" for MYTHOS.');
      console.log('    That is the only registry id that reads the OPENAI_API_KEY/');
      console.log('    OPENAI_BASE_URL pair the adapter forwards. With anything else');
      console.log('    (including "openai" or "custom") every build fails with');
      console.log('    "HTTP 401: Missing Authentication header".');
      console.log('    Fix in ' + cfg + ':  provider: openai-api');
    }
  }
  reportProviderSlots();
  reportKeyShadowing();
  return (hasOneshot && hasYolo) ? 0 : 1;
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

  console.log('  WARNING: provider rotation is DISABLED by Hermes\'s own .env.');
  console.log('    ' + hermesEnv);
  console.log('    defines ' + shadowed.join(' and ') + ', and Hermes prefers its own .env');
  console.log('    over the environment MYTHOS forwards (hermes_cli/auth.py,');
  console.log('    get_env_value_prefer_dotenv). Every slot therefore authenticates with');
  console.log('    the SAME credential no matter which slot the adapter selected, so a');
  console.log('    401/429 rotation cannot escape the failing provider.');
  console.log('    FIX: remove those lines from that .env and keep the keys in mythos/.env');
  console.log('    (HERMES_PROVIDER_KEY / HERMES_PROVIDER_BASE_URL) instead. Model');
  console.log('    rotation via HERMES_INFERENCE_MODEL is unaffected and works today.');
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

(async () => {
  const wantsInstall = process.argv.includes('--install');
  process.exitCode = wantsInstall ? await install() : check();
})();
