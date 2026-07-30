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
  return (hasOneshot && hasYolo) ? 0 : 1;
}

async function install() {
  console.log('Installing Hermes-Agent into ' + HERMES_HOME);
  fs.mkdirSync(HERMES_HOME, { recursive: true });

  if (fs.existsSync(path.join(INSTALL_DIR, '.git'))) {
    console.log('\n[1/2] existing clone found — fetching latest');
    const pulled = await run('git', ['-C', INSTALL_DIR, 'pull', '--ff-only']);
    if (!pulled.ok) return console.log('git pull failed (exit ' + pulled.code + ')'), 1;
  } else {
    console.log('\n[1/2] cloning ' + REPO_URL);
    const cloned = await run('git', ['clone', REPO_URL, INSTALL_DIR]);
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
