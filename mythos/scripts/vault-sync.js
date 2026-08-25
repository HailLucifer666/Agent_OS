'use strict';

// scripts/vault-sync.js — one brain across two machines.
//
// The memory built while working on one machine is the memory the other one has.
// Neither machine is always on, so there is no host to share live against; that
// leaves sync-on-boot / sync-on-quit, and git is the only transport here that can
// be made structurally conflict-free for these shapes rather than
// last-writer-wins (which would silently destroy a day of episodic memory).
//
// Why the vault gets its own repo and not this one: mythos/vault/ holds every
// conversation, every fact learned about the operator, and the incident log. The
// code repo is public. This is not a preference.
//
// How each store merges, against the real on-disk layout:
//
//   Episodic/YYYY-MM-DD.jsonl   append-only    -> merge=union, conflict-free even
//                                                 when both machines wrote the
//                                                 same day
//   Documents/*.json            one per chunk  -> different files, never collide
//   Semantic|Identity|Lessons   one .md/topic  -> collide only if BOTH machines
//                                                 edited the same topic, and the
//                                                 result is human-readable
//   Index/*.vec.json            derived        -> gitignored; reindex() rebuilds
//   Goals.json, Kanban.json     single mutable -> the real risk. See the lock.
//
// OPT-IN BY CONSTRUCTION. Nothing here does anything until the operator runs
// --init themselves: --pull and --push no-op (loudly) unless the vault is already
// a git repo with a remote. Pushing someone's conversation history to a remote is
// not a thing a boot sequence should decide to start doing.
//
// OFFLINE MUST WORK. Every failure here is a warning and exit 0 on the boot/quit
// paths: an unreachable remote, a missing git, a rejected push. MYTHOS starting
// must never depend on a network.
//
// Usage:
//   node scripts/vault-sync.js --status
//   node scripts/vault-sync.js --init            (needs MYTHOS_VAULT_REPO)
//   node scripts/vault-sync.js --pull            (boot)
//   node scripts/vault-sync.js --push            (quit)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const MYTHOS_DIR = path.resolve(__dirname, '..');

// Same resolution as src/main.js/schema.js: an explicit MYTHOS_VAULT_ROOT wins
// (Electron sets it to the userData vault at fork), otherwise mythos/vault.
// Never a hardcoded path — this repo is meant to run on anyone's machine.
function resolveVaultRoot() {
  const explicit = process.env.MYTHOS_VAULT_ROOT;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(MYTHOS_DIR, 'vault');
}

// BUG-328 — THE AMBIENT GIT ENVIRONMENT MUST BE STRIPPED, and `cwd` is not
// enough. An explicit GIT_DIR beats the working directory, always: with it set,
// every command below operates on THAT repository and silently ignores
// vaultRoot.
//
// This is not theoretical. `git commit` EXPORTS the repository environment to
// its hooks — measured 2026-08-23 inside .githooks/pre-commit:
//
//     GIT_DIR=<repo>/.git/worktrees/<name>
//     GIT_INDEX_FILE=<repo>/.git/worktrees/<name>/index
//
// The hook runs the whole suite, test/vault-sync.test.js calls main(['--init'])
// on a temp directory, and `git init -b main` therefore re-initialised THE
// MYTHOS REPOSITORY. With GIT_DIR set and no GIT_WORK_TREE, git concludes the
// repository has no working tree and writes `bare = true` into the SHARED
// .git/config — which breaks the main checkout and every worktree at once with
//
//     fatal: this operation must be run in a work tree
//
// FOUR COMMITS IN A ROW WERE BLOCKED BY IT before the cause was found, and the
// operator's notes had recorded the flip since 2026-08-22 as "a thing that
// happens and has no known trigger". The trigger is any commit.
//
// `git init` was merely the loudest instance. The same helper runs `remote add
// origin`, `add -A`, `commit` and `push origin main` — so an ambient GIT_DIR
// would point a vault push at the code repository. The --init test passes
// `git@example.invalid:nobody/vault.git` as the remote; MYTHOS's own origin
// survived only because `remote add` refuses a name that already exists.
const INHERITED_GIT_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
];

function vaultGitEnv() {
  const env = Object.assign({}, process.env);
  for (const key of INHERITED_GIT_ENV) delete env[key];
  return env;
}

// A git command inside the vault. Time-boxed, because this runs on the boot path
// and a hung network call must not become a hung MYTHOS. Never throws.
function git(vaultRoot, args, timeoutMs) {
  const res = spawnSync('git', args, {
    cwd: vaultRoot,
    env: vaultGitEnv(),
    encoding: 'utf8',
    timeout: timeoutMs || 20000,
    windowsHide: true,
  });
  if (res.error && res.error.code === 'ENOENT') {
    return { ok: false, missingGit: true, stdout: '', stderr: 'git is not installed or not on PATH' };
  }
  return {
    ok: res.status === 0,
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    status: res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  };
}

// ---- pure decisions (unit-tested; see test/vault-sync.test.js) --------------

// The one file that must exist for union merge to do its job. Written by --init.
const GITATTRIBUTES = [
  '# Episodic memory is append-only JSONL: one record per line, never rewritten.',
  '# union merge takes BOTH sides\' lines instead of raising a conflict, which is',
  '# what makes "both machines wrote today" a non-event rather than a lost day.',
  '*.jsonl merge=union',
  '',
].join('\n');

const GITIGNORE = [
  '# Derived, and big. reindex() rebuilds these from the stores, so syncing them',
  '# would be pure conflict for no information.',
  'Index/',
  '',
  '# Scratch space for in-flight builds.',
  'builds/.engine-scratch/',
  '',
].join('\n');

const LOCK_FILE = '.mythos-sync-lock.json';

// describeLock(lock, now, thisMachine) -> null | {message}
// A WARNING, never a block: the operator must always be able to work, even on
// the machine that did not close its session cleanly.
function describeLock(lock, nowMs, thisMachine) {
  if (!lock || typeof lock !== 'object') return null;
  if (!lock.machine || lock.machine === thisMachine) return null;
  const heldMs = Number.isFinite(lock.at) ? Math.max(0, nowMs - lock.at) : null;
  const minutes = heldMs === null ? null : Math.round(heldMs / 60000);
  const when = minutes === null ? 'at an unknown time'
    : minutes < 1 ? 'less than a minute ago'
      : `${minutes} minute(s) ago`;
  return {
    message: `"${lock.machine}" had the vault open ${when} and may not have pushed yet. ` +
      'Working here now can fork Goals.json/Kanban.json — the append-only stores are safe either way.',
  };
}

// classifyPull({fetchOk, mergeOk, mergeStderr}) -> {outcome, message}
// outcome: 'ok' | 'offline' | 'conflict' | 'failed'
function classifyPull(facts) {
  const f = facts || {};
  if (f.missingGit) return { outcome: 'offline', message: 'git is not available — the vault stays local this session.' };
  if (!f.fetchOk) {
    // Unreachable remote is the NORMAL case for a laptop that is not online yet,
    // not an error worth stopping a boot over.
    return { outcome: 'offline', message: 'the vault remote is unreachable — continuing with the local vault.' };
  }
  if (!f.mergeOk) {
    const stderr = String(f.mergeStderr || '');
    if (/conflict/i.test(stderr)) {
      return {
        outcome: 'conflict',
        message: 'the vault has a merge conflict. Resolve it by hand in the vault repo — ' +
          'this script will not "resolve" your memory for you. Until then MYTHOS runs on the working tree as it stands.',
      };
    }
    return { outcome: 'failed', message: `the vault merge failed: ${stderr || 'unknown reason'}` };
  }
  return { outcome: 'ok', message: 'vault up to date.' };
}

// classifyPush({dirty, commitOk, pushOk, pushStderr}) -> {outcome, message}
// outcome: 'ok' | 'nothing' | 'offline' | 'rejected' | 'failed'
function classifyPush(facts) {
  const f = facts || {};
  if (f.missingGit) return { outcome: 'offline', message: 'git is not available — nothing was pushed.' };
  if (!f.dirty && !f.ahead) return { outcome: 'nothing', message: 'no vault changes to push.' };
  if (f.dirty && !f.commitOk) return { outcome: 'failed', message: `could not commit the vault: ${f.commitStderr || 'unknown reason'}` };
  if (!f.pushOk) {
    const stderr = String(f.pushStderr || '');
    if (/non-fast-forward|rejected|fetch first/i.test(stderr)) {
      // The other machine pushed while this one was working. The commit is safe
      // locally; the next --pull will union-merge it. Saying "pushed" here would
      // be the lie that loses a day.
      return {
        outcome: 'rejected',
        message: 'the vault push was rejected — the other machine pushed first. Your work is committed locally ' +
          'and the next boot pulls and merges it. Nothing is lost.',
      };
    }
    return { outcome: 'offline', message: 'could not reach the vault remote — the work is committed locally and will push next time.' };
  }
  return { outcome: 'ok', message: 'vault pushed.' };
}

// ---- state -----------------------------------------------------------------

function isGitRepo(vaultRoot) {
  return fs.existsSync(path.join(vaultRoot, '.git'));
}

function hasRemote(vaultRoot) {
  const res = git(vaultRoot, ['remote', 'get-url', 'origin'], 5000);
  return res.ok && res.stdout !== '';
}

function midConflict(vaultRoot) {
  // MERGE_HEAD exists between a conflicted merge and its resolution. Doing
  // anything automatic in that state is how a half-merge gets committed as
  // "sync".
  return fs.existsSync(path.join(vaultRoot, '.git', 'MERGE_HEAD'));
}

function readLock(vaultRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(vaultRoot, LOCK_FILE), 'utf8'));
  } catch { return null; }
}

function writeLock(vaultRoot) {
  const lock = { machine: os.hostname(), at: Date.now(), pid: process.pid };
  try {
    fs.writeFileSync(path.join(vaultRoot, LOCK_FILE), JSON.stringify(lock, null, 2), 'utf8');
  } catch { /* a lock we cannot write is a warning we do not get — never fatal */ }
  return lock;
}

// ---- commands ---------------------------------------------------------------

function cmdStatus(vaultRoot, out) {
  out(`vault: ${vaultRoot}`);
  if (!fs.existsSync(vaultRoot)) { out('  the vault directory does not exist yet.'); return 0; }
  out(`  git repo: ${isGitRepo(vaultRoot) ? 'yes' : 'no  (run --init to enable sync)'}`);
  if (!isGitRepo(vaultRoot)) return 0;
  const remote = git(vaultRoot, ['remote', 'get-url', 'origin'], 5000);
  out(`  remote:   ${remote.ok && remote.stdout ? remote.stdout : 'none'}`);
  const status = git(vaultRoot, ['status', '--porcelain=v1'], 10000);
  const changed = status.ok ? status.stdout.split('\n').filter(Boolean).length : -1;
  out(`  uncommitted: ${changed < 0 ? 'unknown' : changed} file(s)`);
  out(`  mid-merge:   ${midConflict(vaultRoot) ? 'YES — resolve by hand before syncing' : 'no'}`);
  const lock = describeLock(readLock(vaultRoot), Date.now(), os.hostname());
  if (lock) out(`  warning: ${lock.message}`);
  return 0;
}

function cmdInit(vaultRoot, out) {
  const remoteUrl = String(process.env.MYTHOS_VAULT_REPO || '').trim();
  if (!remoteUrl) {
    out('MYTHOS_VAULT_REPO is not set. Create a PRIVATE repo for the vault and set it, e.g.');
    out('  MYTHOS_VAULT_REPO=git@github.com:<you>/mythos-vault.git');
    out('The vault holds every conversation and everything learned about you — it must not be public.');
    return 2;
  }
  if (!fs.existsSync(vaultRoot)) {
    out(`the vault directory does not exist yet: ${vaultRoot}`);
    return 2;
  }

  if (!isGitRepo(vaultRoot)) {
    const init = git(vaultRoot, ['init', '-b', 'main'], 15000);
    if (!init.ok) { out(`git init failed: ${init.stderr}`); return 1; }
    out('initialized a git repo in the vault.');
  }

  // Written every time, not just on first init: union merge is the whole
  // correctness argument, and a vault repo that lost its .gitattributes would
  // start raising conflicts on episodic memory without anyone noticing why.
  fs.writeFileSync(path.join(vaultRoot, '.gitattributes'), GITATTRIBUTES, 'utf8');
  const ignorePath = path.join(vaultRoot, '.gitignore');
  if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, GITIGNORE, 'utf8');

  if (!hasRemote(vaultRoot)) {
    const add = git(vaultRoot, ['remote', 'add', 'origin', remoteUrl], 10000);
    if (!add.ok) { out(`could not add the remote: ${add.stderr}`); return 1; }
    out(`remote origin -> ${remoteUrl}`);
  }

  out('');
  out('Ready. Nothing has been pushed yet — review what is about to leave this machine, then:');
  out('  cd "' + vaultRoot + '" && git add -A && git commit -m "vault: initial" && git push -u origin main');
  out('After that, --pull on boot and --push on quit keep the two machines in one brain.');
  return 0;
}

function cmdPull(vaultRoot, out) {
  if (!isGitRepo(vaultRoot) || !hasRemote(vaultRoot)) {
    out('vault-sync: not configured (no git repo/remote in the vault) — skipping. Run --init to enable.');
    return 0;
  }
  if (midConflict(vaultRoot)) {
    out('vault-sync: the vault is mid-merge — refusing to touch it. Resolve the conflict by hand.');
    return 0;
  }

  const lockWarning = describeLock(readLock(vaultRoot), Date.now(), os.hostname());
  if (lockWarning) out(`vault-sync: warning — ${lockWarning.message}`);

  const fetched = git(vaultRoot, ['fetch', 'origin', 'main'], 25000);
  let merged = { ok: false, stderr: '' };
  if (fetched.ok) {
    // Explicit merge rather than `git pull`: this repo has already been bitten by
    // a pull that looked like a fast-forward and was not.
    merged = git(vaultRoot, ['merge', '--no-edit', 'origin/main'], 25000);
  }
  const verdict = classifyPull({
    missingGit: fetched.missingGit,
    fetchOk: fetched.ok,
    mergeOk: merged.ok,
    mergeStderr: merged.stderr,
  });
  out(`vault-sync: ${verdict.message}`);
  writeLock(vaultRoot);
  // Always 0 on the boot path. A vault that cannot sync is a degraded feature,
  // not a reason for MYTHOS not to start.
  return 0;
}

function cmdPush(vaultRoot, out) {
  if (!isGitRepo(vaultRoot) || !hasRemote(vaultRoot)) {
    out('vault-sync: not configured — skipping.');
    return 0;
  }
  if (midConflict(vaultRoot)) {
    out('vault-sync: the vault is mid-merge — refusing to commit over it.');
    return 0;
  }

  const status = git(vaultRoot, ['status', '--porcelain=v1'], 15000);
  const dirty = status.ok && status.stdout !== '';
  let commit = { ok: true, stderr: '' };
  if (dirty) {
    git(vaultRoot, ['add', '-A'], 20000);
    commit = git(vaultRoot, ['commit', '-m', `vault: ${os.hostname()} ${new Date().toISOString()}`], 20000);
  }
  const ahead = git(vaultRoot, ['rev-list', '--count', 'origin/main..HEAD'], 15000);
  const aheadCount = ahead.ok ? Number(ahead.stdout) || 0 : 0;

  let pushed = { ok: true, stderr: '' };
  if (dirty || aheadCount > 0) {
    pushed = git(vaultRoot, ['push', 'origin', 'main'], 30000);
  }

  const verdict = classifyPush({
    missingGit: status.missingGit,
    dirty,
    ahead: aheadCount,
    commitOk: commit.ok,
    commitStderr: commit.stderr,
    pushOk: pushed.ok,
    pushStderr: pushed.stderr,
  });
  out(`vault-sync: ${verdict.message}`);
  try { fs.rmSync(path.join(vaultRoot, LOCK_FILE), { force: true }); } catch { /* best effort */ }
  return 0;
}

function main(argv, opts) {
  const out = (opts && opts.out) || ((line) => console.log(line));
  const vaultRoot = (opts && opts.vaultRoot) || resolveVaultRoot();
  if (argv.includes('--init')) return cmdInit(vaultRoot, out);
  if (argv.includes('--pull')) return cmdPull(vaultRoot, out);
  if (argv.includes('--push')) return cmdPush(vaultRoot, out);
  if (argv.includes('--status')) return cmdStatus(vaultRoot, out);
  out('usage: node scripts/vault-sync.js --status | --init | --pull | --push');
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {});
}

module.exports = {
  GITATTRIBUTES,
  GITIGNORE,
  LOCK_FILE,
  resolveVaultRoot,
  describeLock,
  classifyPull,
  classifyPush,
  isGitRepo,
  midConflict,
  main,
  // BUG-328: exported so the regression test can assert the strip list directly
  // as well as behaviourally.
  _INHERITED_GIT_ENV: INHERITED_GIT_ENV,
  _vaultGitEnv: vaultGitEnv,
};
