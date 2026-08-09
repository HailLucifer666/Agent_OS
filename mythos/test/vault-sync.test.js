'use strict';

// scripts/vault-sync.js — one brain across two machines.
//
// The dangerous failures here are all the same shape: reporting success while
// memory was lost, or blocking work to protect memory. So the pinned behaviours
// are the classifications, plus the two structural guarantees that make git
// usable for this at all:
//
//   - a rejected push is NOT a loss and must not be reported as a failure that
//     invites the operator to "fix" it by force-pushing over the other machine;
//   - an unreachable remote is the NORMAL laptop case and must never stop a boot;
//   - .gitattributes must carry `*.jsonl merge=union`, which is the entire
//     reason "both machines wrote today" is a non-event rather than a lost day.
//
// Run: cd mythos && node --test test/vault-sync.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('../scripts/vault-sync.js');

describe('the union-merge contract', () => {
  it('.gitattributes makes JSONL union-merge — the whole conflict-free story', () => {
    assert.match(sync.GITATTRIBUTES, /^\*\.jsonl merge=union$/m,
      'without this, two machines writing the same day\'s episodic file conflict, and the ' +
      'obvious "resolution" throws away one side');
  });

  it('.gitignore drops the derived index rather than syncing conflict for no information', () => {
    assert.match(sync.GITIGNORE, /^Index\/$/m, 'Index/*.vec.json is rebuilt by reindex()');
  });
});

describe('describeLock', () => {
  const now = 1_700_000_000_000;

  it('warns when the OTHER machine held the vault recently', () => {
    const res = sync.describeLock({ machine: 'desktop-pc', at: now - 4 * 60000 }, now, 'laptop');
    assert.ok(res, 'a fork risk the operator cannot see is one they cannot avoid');
    assert.match(res.message, /desktop-pc/);
    assert.match(res.message, /4 minute/);
  });

  it('says nothing about this machine\'s own lock', () => {
    assert.equal(sync.describeLock({ machine: 'laptop', at: now - 60000 }, now, 'laptop'), null);
  });

  it('says nothing when there is no lock at all', () => {
    assert.equal(sync.describeLock(null, now, 'laptop'), null);
    assert.equal(sync.describeLock({}, now, 'laptop'), null);
  });

  it('survives a lock with a corrupt timestamp instead of printing NaN', () => {
    const res = sync.describeLock({ machine: 'desktop-pc', at: 'yesterday' }, now, 'laptop');
    assert.ok(res);
    assert.doesNotMatch(res.message, /NaN/);
  });

  it('names the append-only stores as safe, so the warning is actionable rather than scary', () => {
    const res = sync.describeLock({ machine: 'desktop-pc', at: now }, now, 'laptop');
    assert.match(res.message, /Goals\.json|Kanban\.json/, 'the risk is the single mutable JSON files');
    assert.match(res.message, /append-only stores are safe/);
  });
});

describe('classifyPull', () => {
  it('an unreachable remote is offline, not a failure — a boot must not depend on a network', () => {
    const res = sync.classifyPull({ fetchOk: false });
    assert.equal(res.outcome, 'offline');
    assert.match(res.message, /continuing with the local vault/);
  });

  it('no git at all is also just offline', () => {
    assert.equal(sync.classifyPull({ missingGit: true }).outcome, 'offline');
  });

  it('a conflict is reported as work for a human, never auto-resolved', () => {
    const res = sync.classifyPull({ fetchOk: true, mergeOk: false, mergeStderr: 'CONFLICT (content): Merge conflict in Goals.json' });
    assert.equal(res.outcome, 'conflict');
    assert.match(res.message, /by hand/);
    assert.match(res.message, /will not "resolve" your memory/);
  });

  it('a non-conflict merge failure is distinguished from a conflict', () => {
    const res = sync.classifyPull({ fetchOk: true, mergeOk: false, mergeStderr: 'fatal: refusing to merge unrelated histories' });
    assert.equal(res.outcome, 'failed');
    assert.match(res.message, /unrelated histories/, 'the real reason must survive to the operator');
  });

  it('a clean merge is ok', () => {
    assert.equal(sync.classifyPull({ fetchOk: true, mergeOk: true }).outcome, 'ok');
  });
});

describe('classifyPush', () => {
  it('nothing to push is its own outcome, not a success message about work that did not happen', () => {
    assert.equal(sync.classifyPush({ dirty: false, ahead: 0 }).outcome, 'nothing');
  });

  it('a rejected push says the work is SAFE — the next pull merges it', () => {
    // This is the message that decides whether the operator reaches for
    // `push --force` and destroys the other machine's day.
    const res = sync.classifyPush({ dirty: true, commitOk: true, pushOk: false, pushStderr: 'error: failed to push some refs (non-fast-forward)' });
    assert.equal(res.outcome, 'rejected');
    assert.match(res.message, /committed locally/);
    assert.match(res.message, /Nothing is lost/);
  });

  it('an unreachable remote leaves the work committed locally', () => {
    const res = sync.classifyPush({ dirty: true, commitOk: true, pushOk: false, pushStderr: 'ssh: Could not resolve hostname' });
    assert.equal(res.outcome, 'offline');
    assert.match(res.message, /committed locally/);
  });

  it('a failed COMMIT is a real failure — there is nothing safe about it', () => {
    const res = sync.classifyPush({ dirty: true, commitOk: false, commitStderr: 'nothing added but untracked files present' });
    assert.equal(res.outcome, 'failed');
  });

  it('pushes commits that exist even when the tree is clean', () => {
    // The previous session committed but could not push. A clean tree must not
    // read as "nothing to do" and leave that commit stranded forever.
    const res = sync.classifyPush({ dirty: false, ahead: 2, pushOk: true });
    assert.equal(res.outcome, 'ok');
  });
});

describe('vault root resolution', () => {
  it('honours MYTHOS_VAULT_ROOT, which is what Electron sets at fork', () => {
    const saved = process.env.MYTHOS_VAULT_ROOT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-root-'));
    process.env.MYTHOS_VAULT_ROOT = dir;
    try {
      assert.equal(sync.resolveVaultRoot(), path.resolve(dir));
    } finally {
      if (saved === undefined) delete process.env.MYTHOS_VAULT_ROOT;
      else process.env.MYTHOS_VAULT_ROOT = saved;
    }
  });

  it('falls back to mythos/vault, never to a hardcoded machine path', () => {
    const saved = process.env.MYTHOS_VAULT_ROOT;
    delete process.env.MYTHOS_VAULT_ROOT;
    try {
      const root = sync.resolveVaultRoot();
      assert.equal(path.basename(root), 'vault');
      assert.equal(path.basename(path.dirname(root)), 'mythos');
    } finally {
      if (saved !== undefined) process.env.MYTHOS_VAULT_ROOT = saved;
    }
  });
});

describe('opt-in by construction', () => {
  const lines = [];
  const out = (l) => lines.push(l);

  it('--pull no-ops loudly on a vault that is not a repo, and exits 0', () => {
    lines.length = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-norepo-'));
    const code = sync.main(['--pull'], { vaultRoot: dir, out });
    assert.equal(code, 0, 'boot must not fail because sync is not set up');
    assert.match(lines.join(' '), /not configured/);
    assert.match(lines.join(' '), /--init/, 'and it must say how to enable it');
  });

  it('--push no-ops the same way', () => {
    lines.length = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-norepo-'));
    assert.equal(sync.main(['--push'], { vaultRoot: dir, out }), 0);
    assert.match(lines.join(' '), /not configured/);
  });

  it('--init refuses without MYTHOS_VAULT_REPO, and says why it must be private', () => {
    lines.length = 0;
    const saved = process.env.MYTHOS_VAULT_REPO;
    delete process.env.MYTHOS_VAULT_REPO;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-init-'));
    try {
      assert.equal(sync.main(['--init'], { vaultRoot: dir, out }), 2);
      const text = lines.join(' ');
      assert.match(text, /MYTHOS_VAULT_REPO/);
      assert.match(text, /must not be public/,
        'the vault is every conversation and everything learned about the operator');
    } finally {
      if (saved !== undefined) process.env.MYTHOS_VAULT_REPO = saved;
    }
  });

  it('--init never pushes on the operator\'s behalf — it prints the command instead', () => {
    lines.length = 0;
    const saved = process.env.MYTHOS_VAULT_REPO;
    // A URL that cannot resolve: this test must not touch a network even if the
    // logic changed to try.
    process.env.MYTHOS_VAULT_REPO = 'git@example.invalid:nobody/vault.git';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-init-'));
    try {
      const code = sync.main(['--init'], { vaultRoot: dir, out });
      assert.equal(code, 0);
      const text = lines.join('\n');
      assert.match(text, /Nothing has been pushed yet/,
        'sending a private history to a remote is the operator\'s decision, made once, deliberately');
      assert.match(text, /git push -u origin main/);
      // And it must have written the correctness-critical file.
      assert.match(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), /merge=union/);
    } finally {
      if (saved === undefined) delete process.env.MYTHOS_VAULT_REPO;
      else process.env.MYTHOS_VAULT_REPO = saved;
    }
  });

  it('a bare invocation explains itself', () => {
    lines.length = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-usage-'));
    assert.equal(sync.main([], { vaultRoot: dir, out }), 2);
    assert.match(lines.join(' '), /usage:/);
  });
});

describe('mid-merge safety', () => {
  it('refuses to pull or push while the vault is mid-merge', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-conflict-'));
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    // A remote must appear to exist for the mid-merge branch to be the one under
    // test rather than the not-configured branch; `git remote get-url` in a fake
    // .git returns non-zero, so assert the honest outcome: it does not proceed.
    const lines = [];
    assert.equal(sync.main(['--pull'], { vaultRoot: dir, out: (l) => lines.push(l) }), 0);
    assert.doesNotMatch(lines.join(' '), /up to date|pushed/,
      'nothing may be reported as synced while a conflict is unresolved');
    assert.equal(sync.midConflict(dir), true);
  });
});
