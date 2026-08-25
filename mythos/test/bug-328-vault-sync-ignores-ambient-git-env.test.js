'use strict';

// test/bug-328-vault-sync-ignores-ambient-git-env.test.js
//
// THE BUG. scripts/vault-sync.js's git() helper passed `cwd: vaultRoot` and
// nothing else. An explicit GIT_DIR in the environment beats the working
// directory, always — so with one set, every command in that file operates on
// THAT repository and silently ignores the vault it was handed.
//
// WHY NOT HYPOTHETICAL. `git commit` exports the repository environment to its
// hooks. Measured 2026-08-23 by instrumenting .githooks/pre-commit:
//
//     GIT_DIR=<repo>/.git/worktrees/<name>
//     GIT_INDEX_FILE=<repo>/.git/worktrees/<name>/index
//
// The hook runs the full suite. test/vault-sync.test.js calls main(['--init'])
// on a fresh temp directory, so `git init -b main` re-initialised THE MYTHOS
// REPOSITORY instead — and with GIT_DIR set and no GIT_WORK_TREE, git decides the
// repository has no working tree and writes `bare = true` into the SHARED
// .git/config. Every checkout and every worktree then fails with "fatal: this
// operation must be run in a work tree".
//
// The probe, verbatim:
//
//     PROBE-B core.bare=false      (immediately before node --test)
//     PROBE-C core.bare=true       (immediately after)
//
// Four consecutive commits were refused before the cause was found. The repo's
// own notes had carried the flip since 2026-08-22 as "a thing that happens and
// has no known trigger"; the trigger is any commit, and worktree-setup-links's
// core.bare tripwire was right every time it fired.
//
// `git init` was the loudest instance, not the only one. The same helper runs
// `remote add origin`, `add -A`, `commit` and `push origin main`. The --init test
// supplies git@example.invalid:nobody/vault.git as the remote; MYTHOS's own
// origin survived only because `git remote add` refuses a name that already
// exists.
//
// WHAT THIS TEST DOES. Builds a throwaway repository, points GIT_DIR at it the
// way a hook would, runs --init against an unrelated temp vault, and demands the
// throwaway repository came out untouched while the vault got its own. Nothing in
// here goes near the real repo: that is the whole point of the bug and it would
// be a poor way to prove it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const sync = require('../scripts/vault-sync.js');

// EVERY git call in this harness scrubs, and each omission cost a red run.
//
// The reader was first: asking the vault for its remote answered with the
// scratch repository's, because it inherited the GIT_DIR the test had just set.
// Then the BUILDER, and that one only failed inside the pre-commit hook — where
// `git commit` has already exported GIT_DIR, so `git init` in a temp directory
// went to the code repository and `git remote add origin` threw because origin
// was already there. The bug under test, reproduced twice inside its own harness.
function cleanGitEnv() {
  const env = Object.assign({}, process.env);
  for (const k of sync._INHERITED_GIT_ENV) delete env[k];
  return env;
}

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug328-repo-'));
  const env = cleanGitEnv();
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, stdio: 'ignore', env });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.invalid:someone/real.git'],
    { cwd: dir, stdio: 'ignore', env });
  return dir;
}

function configValue(repo, key) {
  const res = spawnSync('git', ['config', key], { cwd: repo, encoding: 'utf8', env: cleanGitEnv() });
  return String(res.stdout || '').trim();
}

describe('BUG-328 — vault-sync must ignore an ambient git environment', () => {
  it('strips every variable that can redirect a git command', () => {
    // The list is asserted by name because a missing entry is invisible: the
    // command still succeeds, just against the wrong repository.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
      assert.ok(sync._INHERITED_GIT_ENV.includes(key), key + ' must be stripped');
    }
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = 'somewhere-else';
    try {
      assert.equal(sync._vaultGitEnv().GIT_DIR, undefined);
      // And it must still be a real environment, not an empty one — git needs
      // PATH, and on Windows also SystemRoot.
      assert.ok(sync._vaultGitEnv().PATH || sync._vaultGitEnv().Path);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
  });

  it('leaves an unrelated repository alone when GIT_DIR points at it', () => {
    const repo = scratchRepo();
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bug328-vault-'));
    const savedDir = process.env.GIT_DIR;
    const savedIndex = process.env.GIT_INDEX_FILE;
    const savedRepo = process.env.MYTHOS_VAULT_REPO;

    assert.equal(configValue(repo, 'core.bare'), 'false', 'fixture assumption');

    // Exactly what git hands a pre-commit hook.
    process.env.GIT_DIR = path.join(repo, '.git');
    process.env.GIT_INDEX_FILE = path.join(repo, '.git', 'index');
    process.env.MYTHOS_VAULT_REPO = 'git@example.invalid:nobody/vault.git';
    try {
      const lines = [];
      const code = sync.main(['--init'], { vaultRoot: vault, out: (l) => lines.push(l) });
      assert.equal(code, 0, lines.join('\n'));

      // THE ASSERTION THIS FILE EXISTS FOR. Without the env strip this reads
      // 'true' and the shared config is corrupt for every checkout.
      assert.equal(configValue(repo, 'core.bare'), 'false',
        'vault-sync re-initialised the repository GIT_DIR named, and marked it bare');
      // And it must not have repointed that repository's remote at the vault.
      assert.match(configValue(repo, 'remote.origin.url'), /someone\/real\.git$/,
        'the unrelated repository\'s origin was rewritten');
      // The vault, meanwhile, must actually have been initialised.
      assert.ok(fs.existsSync(path.join(vault, '.git')), 'the vault did not get its own repo');
      assert.equal(configValue(vault, 'remote.origin.url'), 'git@example.invalid:nobody/vault.git');
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir;
      if (savedIndex === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = savedIndex;
      if (savedRepo === undefined) delete process.env.MYTHOS_VAULT_REPO; else process.env.MYTHOS_VAULT_REPO = savedRepo;
    }
  });

  it('still reports "not configured" for a plain directory under an ambient GIT_DIR', () => {
    // A PIN, NOT A CATCH — said plainly because a test that passes either way
    // and is described as protection is worse than no test. Mutating the env
    // strip back out leaves this one green: the not-configured branch is decided
    // by isGitRepo(), which looks for .git on disk rather than asking git, so the
    // ambient environment cannot reach it. The reason to hold it anyway is that
    // the obvious "improvement" is to replace that filesystem check with `git
    // remote get-url origin` — which SUCCEEDS whenever GIT_DIR names a repo that
    // has a remote, making an unconfigured vault look configured and letting
    // --pull merge someone else's history into it.
    const repo = scratchRepo();
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'bug328-plain-'));
    const savedDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(repo, '.git');
    try {
      const lines = [];
      assert.equal(sync.main(['--pull'], { vaultRoot: vault, out: (l) => lines.push(l) }), 0);
      assert.match(lines.join(' '), /not configured/);
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir;
    }
  });
});
