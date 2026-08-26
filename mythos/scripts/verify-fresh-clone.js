#!/usr/bin/env node
'use strict';

// scripts/verify-fresh-clone.js — can somebody who clones this repo actually run it?
//
// WHY. This is an open-source project whose stated contract is that anyone who
// supplies their own API keys can run it (root CLAUDE.md). Nothing has ever
// checked that. The way it fails is quiet: a per-machine dependency gets added,
// the machine that added it already has the dependency, and every test passes —
// so the gap only appears on someone else's computer, where a feature is simply
// missing rather than broken. BUG-360 was that on this very machine: adb present
// in two directories, resolved from neither, all 14 phone_* tools withheld from
// the model with a green suite.
//
// TWO STAGES, because the honest check is slow and the fast one is still worth
// having.
//
//   default          the REPRODUCIBILITY INVARIANT, in about a second. Every path
//                    the app needs at runtime must be either TRACKED in git or
//                    FETCHABLE by a named setup script that really exists. A path
//                    that is neither cannot be obtained by a stranger at all, and
//                    that is the thing that must never be true.
//
//   --clone          the real proof: clone HEAD into a temp directory, install
//                    both dependency trees from nothing, and report what is
//                    missing. Minutes, and it downloads. Opt-in for that reason.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never runs the component installers.
// Those download ~90MB from Google and Hugging Face, and an unattended download
// is the operator's decision — the same rule scripts/setup-android.js has always
// followed. It reports whether each installer EXISTS and is reachable, which is
// the part a fresh clone can get wrong.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const MYTHOS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_DIR, '..');

const { LINKS } = require(path.join(__dirname, 'setup-worktree.js'));
const { catalog } = require(path.join(MYTHOS_DIR, 'src', 'core', 'setup', 'components.js'));

function check(name, ok, detail) {
  return { name, ok, detail: detail === undefined ? '' : String(detail) };
}

function isTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// ── stage 1: the reproducibility invariant ───────────────────────────────────
//
// LINKS is the canonical list of "gitignored things a checkout needs in order to
// behave like a working one" — it exists for worktrees, but a fresh clone is the
// same problem with the volume turned up, so it is reused rather than duplicated.
// A second list would drift from it, and the drift would be invisible.
function invariantChecks() {
  const checks = [];

  // Every component the first-run wizard offers must name a script that is
  // actually in the repo. A catalogue entry pointing at a missing file is a
  // wizard step that fails on a stranger's machine and on nobody else's, because
  // the author's checkout had the file untracked.
  for (const component of catalog()) {
    const script = path.join(MYTHOS_DIR, component.script);
    const exists = fs.existsSync(script);
    const tracked = exists && isTracked(path.relative(REPO_ROOT, script).split(path.sep).join('/'));
    checks.push(check(`installer:${component.id}`, exists && tracked,
      exists
        ? (tracked ? component.script : `${component.script} exists but is NOT TRACKED — it will not be in a clone`)
        : `${component.script} does not exist, so the wizard's "${component.label}" step cannot run`));
  }

  // Every gitignored dependency must be obtainable. "Obtainable" means a setup
  // script or a documented package manager step names it — otherwise the only
  // way to get it is to already have it, which a stranger by definition does not.
  const OBTAINABLE = {
    'node_modules': 'npm install (repo root)',
    'mythos/node_modules': 'npm install (in mythos/)',
    'mythos/.venv': 'python -m venv .venv && pip install edge-tts  (BYO — LGPLv3, never bundled)',
    'mythos/ui/public/models/wakeword': 'scripts/setup-wakeword.js',
    'mythos/ui/public/models/silero': 'scripts/setup-silero.js',
    'mythos/models/piper': 'scripts/setup-piper.js --install',
    'DeepSeek Harness': 'scripts/setup-dsh.js --install',
    'Android Platform Tools': 'scripts/setup-android.js --install',
  };
  for (const entry of LINKS) {
    const how = OBTAINABLE[entry.rel];
    checks.push(check(`obtainable:${entry.rel}`, Boolean(how),
      how || 'NOTHING in this repo explains how to obtain this. A fresh clone cannot get it at '
        + 'all, so whatever depends on it is permanently absent for everyone but the machine '
        + 'that created it.'));
  }

  // And the reverse direction, which is the one that rots: a path listed as
  // obtainable but no longer in LINKS means the two lists have drifted apart.
  const linked = new Set(LINKS.map((l) => l.rel));
  const orphans = Object.keys(OBTAINABLE).filter((rel) => !linked.has(rel));
  checks.push(check('lists-agree', orphans.length === 0,
    orphans.length ? 'listed here but no longer in setup-worktree.js LINKS: ' + orphans.join(', ')
      : `${linked.size} dependencies, each with a way to obtain it`));

  // The env template is how a stranger learns which keys exist at all. Without
  // it, "supply your own API keys" is not actionable.
  const envExample = path.join(MYTHOS_DIR, '.env.example');
  checks.push(check('env-example-tracked', isTracked('mythos/.env.example'),
    fs.existsSync(envExample) ? 'mythos/.env.example' : 'mythos/.env.example is MISSING'));

  // A lockfile is the difference between "installs" and "installs the versions
  // that were tested". Both trees have their own.
  for (const rel of ['package-lock.json', 'mythos/package-lock.json']) {
    checks.push(check(`lockfile:${rel}`, isTracked(rel),
      isTracked(rel) ? 'tracked' : 'NOT TRACKED — a clone resolves its own versions, so it does not run what was tested'));
  }

  return checks;
}

// ── stage 2: actually clone it ───────────────────────────────────────────────
function cloneChecks() {
  const checks = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-fresh-'));
  const clone = path.join(dir, 'repo');
  console.log(`\ncloning HEAD into ${clone} …`);

  // Clone the LOCAL repository at HEAD, not the remote. The question is whether
  // the commit about to be pushed is self-sufficient; fetching origin would test
  // whatever was pushed last instead, and would also need the network.
  const cloned = spawnSync('git', ['clone', '--no-hardlinks', '--depth', '1', REPO_ROOT, clone],
    { encoding: 'utf8' });
  if (cloned.status !== 0) {
    checks.push(check('clone', false, (cloned.stderr || '').trim().slice(0, 300)));
    return { checks, dir };
  }
  checks.push(check('clone', true, clone));

  for (const [label, cwd] of [['root', clone], ['mythos', path.join(clone, 'mythos')]]) {
    console.log(`npm ci (${label}) — this is the slow part …`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
    checks.push(check(`npm-ci:${label}`, res.status === 0,
      res.status === 0 ? 'installed' : (res.stderr || res.stdout || '').trim().slice(-400)));
  }

  // Boot it. A dependency tree that installs is not the same as an app that runs,
  // and this repo has the receipts: a green suite could not tell anyone the
  // Electron shell would not start at all (CLAUDE.md, 2026-08-04).
  console.log('booting the clone …');
  const boot = spawnSync(process.execPath, [path.join(clone, 'mythos', 'src', 'main.js')], {
    cwd: path.join(clone, 'mythos'),
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, { MYTHOS_PORT: '4987', BOOT_GREETING: 'false', BROWSER_AUTOMATION: 'false' }),
  });
  const out = (boot.stdout || '') + (boot.stderr || '');
  checks.push(check('boots', /MYTHOS ALIVE/.test(out),
    /MYTHOS ALIVE/.test(out) ? 'the clone boots with no configuration' : out.trim().slice(-400) || 'no output'));

  return { checks, dir };
}

function report(checks) {
  const failed = checks.filter((c) => c.ok === false);
  console.log('\nMYTHOS fresh-clone reproducibility');
  console.log('----------------------------------');
  for (const c of checks) {
    console.log(`[${c.ok === true ? ' ok ' : c.ok === false ? 'FAIL' : ' ?? '}] ${c.name}${c.detail ? '  —  ' + c.detail : ''}`);
  }
  console.log('');
  if (failed.length) {
    console.log(`FAILED (${failed.length}): ${failed.map((c) => c.name).join(', ')}`);
    console.log('Each of these is something a stranger who clones this repo cannot get.');
  } else {
    console.log('Everything this app needs is either tracked or fetchable by a script in the repo.');
  }
  return failed.length === 0 ? 0 : 1;
}

// Opt-in, and a function rather than an inline condition so a test can assert it
// without pattern-matching the source. The stage clones, runs `npm ci` twice and
// boots — minutes, and it downloads. A check that expensive run by default stops
// being run at all, and then stops being maintained.
function shouldClone(argv) {
  return Array.isArray(argv) && argv.includes('--clone');
}

function main() {
  const argv = process.argv.slice(2);
  let checks = invariantChecks();
  let tempDir = null;

  if (shouldClone(argv)) {
    const result = cloneChecks();
    checks = checks.concat(result.checks);
    tempDir = result.dir;
  }

  const code = report(checks);
  if (tempDir) console.log(`\n(the clone is left at ${tempDir} — delete it when you are done)`);
  else if (!shouldClone(argv)) console.log('(add --clone for the real thing: clone, install both trees, boot. Minutes, and it downloads.)');
  process.exitCode = code;
}

if (require.main === module) main();

module.exports = { invariantChecks, report, shouldClone };
