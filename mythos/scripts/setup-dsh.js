#!/usr/bin/env node
'use strict';

// scripts/setup-dsh.js — install / verify DeepSeek Harness, MYTHOS's build engine.
//
// dsh (github.com/deepseek-ai/deepseek-harness, MIT) generates the content for
// every MYTHOS build. It is a REQUIRED dependency, not an optional sidecar, and
// there is deliberately no brain.think fallback (BUG-244 ruling A, re-pointed by
// W6) — so a fresh clone needs this run once before builds work. Boot still
// succeeds without it; only builds stop.
//
// WHAT IT DOES
//   --check (default)  report the resolved entry point, its version, whether it
//                      matches the pin the adapter asserts, and whether the
//                      build lane has a model this machine can actually reach.
//   --install          npm install the PINNED version into <root>/DeepSeek Harness.
//
// WHY IT NEVER PIPES A REMOTE SCRIPT INTO A SHELL. Root CLAUDE.md forbids
// `curl | bash` / `iex (irm …)`, and unlike Hermes-Agent, dsh needs no such
// thing: it is an ordinary npm package. This runs `npm install --save-exact`
// against a version literal, so what executes is a registry tarball at a known
// version rather than whatever a URL serves today.
//
// WHY IT GETS ITS OWN INSTALL ROOT INSTEAD OF BEING A mythos/ DEPENDENCY.
// Measured 2026-08-21: `npm install @deepseek-ai/dsh` inside mythos/ made npm
// re-resolve mythos's entire 191-package tree alongside dsh's own 30+
// @deepseek-ai/* packages. It burned 24 minutes of CPU and 2.8 GB of RSS and had
// not extracted a single file when it was killed. A separate root with its own
// package.json has nothing to re-resolve and installed 452 packages in 26
// minutes. This is the same convention `Hermes Agent/` and
// `Android Platform Tools/` already follow.
//
// THE VERSION IS PINNED, AND THE PIN IS ASSERTED IN THREE PLACES. dsh is a
// developer preview whose own README says there WILL be compatibility-breaking
// changes. The adapter asserts the pin before every task (package.json AND the
// CLI's own --version output, because a half-finished reinstall makes those
// disagree). `--install` writes it with --save-exact. Never float on `latest`.
//
// WHERE IT INSTALLS, and why two locations are searched. Same dual-search rule
// as setup-hermes.js and model-paths.js: WRITE to MYTHOS_TOOLS_DIR when Electron
// injected it (userData — writable without elevation, survives an update),
// otherwise the repo root for a dev checkout, and READ both. That rule exists
// because a packaged install's repo root is resources/app.asar.unpacked, which
// the NSIS updater replaces wholesale — 23,283 files removed on a measured
// update — so anything installed there is un-installed by every update.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The one version literal. Kept in sync with adapters/dsh-agent's
// DSH_PINNED_VERSION, and --check fails loudly if they ever disagree, because a
// script that installs a version the adapter refuses is worse than no script.
const DSH_VERSION = '0.1.1-rc.2';
const DSH_PACKAGE = '@deepseek-ai/dsh';

const MYTHOS_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');
const { REPO_DSH_HOME, resolveDshHome, dshSearchHomes, packageDirFor, readInstalled, findInstalled } = require('../src/core/dsh-location');

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, Object.assign({ stdio: 'inherit', shell: false }, opts || {}));
    child.on('error', (err) => resolve({ ok: false, code: -1, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

// Measured BUG-402 recovery: spawn('npm.cmd', ..., {shell:false}) returns EINVAL
// on Windows, so fixing lookup alone leaves Finish setup broken. Only fixed
// installer arguments reach this shell; reject metacharacters before joining.
function npmCommand(args, platform = process.platform) {
  if (platform !== 'win32') return { command: 'npm', args };
  if (!args.every(arg => typeof arg === 'string' && /^[-@a-zA-Z0-9._/]+$/.test(arg))) {
    throw new Error('Unsupported npm installer argument');
  }
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm.cmd ' + args.join(' ')] };
}

// ---------------------------------------------------------------------------
// The build lane's reachability, reported here because "dsh is installed" is
// only half of "builds will work". The other half is whether the lane's first
// entry has a credential on this machine — and that is the half that produced
// six consecutive silent build failures the last time it went unchecked
// (BUG-168). Read from the adapter so there is ONE selection rule, not two.
function laneReport() {
  let dsh;
  try {
    dsh = require('../adapters/dsh-agent');
  } catch (err) {
    return { ok: false, text: 'could not load the dsh-agent adapter: ' + err.message };
  }
  try {
    const sel = dsh.selectModel(null);
    const skipped = (sel.rejected || []).length
      ? '\n  skipped ahead of it:\n' + sel.rejected.map((r) => '    - ' + r).join('\n')
      : '';
    return { ok: true, text: 'build lane resolves to ' + sel.laneProvider + '/' + sel.model
      + ' (pi-ai route "' + sel.route + '", credential ' + sel.apiKeyEnv + ')' + skipped };
  } catch (err) {
    return { ok: false, text: String(err.message || err) };
  }
}

function check() {
  // --check is run standalone, before MYTHOS boots, so nothing has loaded .env.
  // Load the same files the other verify-* scripts do, or the lane report below
  // refuses on a credential that is sitting right there on disk.
  for (const rel of [path.join(MYTHOS_DIR, '.env'), path.join(REPO_ROOT, '.env.local')]) {
    try { process.loadEnvFile(rel); } catch { /* optional */ }
  }

  // The pin must agree with the adapter's. Two literals that can drift is how a
  // script ends up installing a version the adapter then refuses to run.
  let adapterPin = null;
  try { adapterPin = require('../adapters/dsh-agent').DSH_PINNED_VERSION; } catch { /* reported below */ }
  if (adapterPin && adapterPin !== DSH_VERSION) {
    console.log('dsh: VERSION PIN MISMATCH');
    console.log('  this script installs ' + DSH_VERSION);
    console.log('  adapters/dsh-agent asserts ' + adapterPin);
    console.log('  Fix both to the same value before installing anything.');
    return 1;
  }

  const found = findInstalled();
  if (!found) {
    console.log('dsh: NOT INSTALLED');
    console.log('  searched:');
    for (const h of dshSearchHomes()) console.log('    ' + packageDirFor(h));
    console.log('  run: node mythos/scripts/setup-dsh.js --install');
    console.log('  Builds will FAIL until then — DeepSeek Harness is the only');
    console.log('  build-content engine and there is no fallback by design.');
    return 1;
  }
  if (!found.entry) {
    console.log('dsh: PRESENT BUT NOT RUNNABLE');
    console.log('  ' + found.pkgDir);
    console.log('  ' + found.reason);
    console.log('  reinstall: node mythos/scripts/setup-dsh.js --install');
    return 1;
  }
  if (found.version !== DSH_VERSION) {
    // Not a warning. The adapter refuses to run an unpinned version, so an
    // install that says "present" here and fails every build is exactly the
    // half-truth --check exists to prevent.
    console.log('dsh: WRONG VERSION');
    console.log('  installed ' + found.version + ' at ' + found.pkgDir);
    console.log('  pinned    ' + DSH_VERSION);
    console.log('  dsh is a developer preview that promises breaking changes, so the');
    console.log('  adapter asserts the pin and will refuse this install.');
    console.log('  reinstall: node mythos/scripts/setup-dsh.js --install');
    return 1;
  }

  // Spawn it. package.json agreeing with the pin is not the same fact as the CLI
  // agreeing — a half-finished reinstall makes those two disagree, and that is
  // the state that produces inexplicable results rather than a clean failure.
  const res = spawnSync(process.execPath, [found.entry, '--version'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const printed = String((res.stdout || '') + (res.stderr || '')).trim();
  if (res.error || res.status !== 0) {
    console.log('dsh: PRESENT BUT THE CLI DID NOT RUN');
    console.log('  ' + found.entry);
    console.log('  ' + (res.error ? res.error.message : 'exit ' + res.status));
    if (printed) console.log('  output: ' + printed.slice(0, 300));
    return 1;
  }
  if (printed !== DSH_VERSION) {
    console.log('dsh: INCONSISTENT INSTALL');
    console.log('  package.json says ' + found.version + ', the CLI printed ' + JSON.stringify(printed));
    console.log('  reinstall: node mythos/scripts/setup-dsh.js --install');
    return 1;
  }

  console.log('dsh: OK');
  console.log('  ' + found.entry);
  console.log('  version ' + printed + ' (pinned)');

  const lane = laneReport();
  console.log('  ' + lane.text.replace(/\n/g, '\n  '));
  if (!lane.ok) {
    console.log('  dsh: NOT USABLE FOR BUILDS — the engine is installed but the build lane');
    console.log('  has no model this machine can reach. Fix the credential above, then re-run.');
    return 1;
  }
  return 0;
}

async function install() {
  const home = resolveDshHome();
  console.log('installing ' + DSH_PACKAGE + '@' + DSH_VERSION + ' into ' + home);

  fs.mkdirSync(home, { recursive: true });

  // Its own package.json, so npm has nothing else to resolve. `private` because
  // this tree is never published, and no `dependencies` block is written by hand
  // — npm --save-exact writes it, which keeps one source of truth for the pin.
  const pkgPath = path.join(home, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'mythos-dsh-vendor',
      private: true,
      description: 'Vendor root for DeepSeek Harness, MYTHOS\'s build engine. Managed by mythos/scripts/setup-dsh.js. Gitignored.',
    }, null, 2) + '\n', 'utf8');
  }

  const npm = npmCommand(['install', '--save-exact', DSH_PACKAGE + '@' + DSH_VERSION]);
  const res = await run(npm.command, npm.args, {
    cwd: home,
  });
  if (!res.ok) {
    console.log('');
    console.log('npm install failed (' + (res.error || 'exit ' + res.code) + ').');
    console.log('This install is large — 452 packages, ~26 minutes measured on a');
    console.log('Windows machine — so a timeout is worth re-running before treating it');
    console.log('as a real failure.');
    return 1;
  }
  console.log('');
  return check();
}

// Guarded so requiring this module from doctor.js does not spawn anything: a
// --check probe would otherwise run a child process on every doctor report.
if (require.main === module) {
  (async () => {
    const wantsInstall = process.argv.includes('--install');
    process.exitCode = wantsInstall ? await install() : check();
  })();
}

module.exports = {
  DSH_VERSION,
  DSH_PACKAGE,
  REPO_DSH_HOME,
  resolveDshHome,
  dshSearchHomes,
  packageDirFor,
  readInstalled,
  findInstalled,
  npmCommand,
  check,
};
