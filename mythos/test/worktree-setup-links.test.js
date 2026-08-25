'use strict';

// test/worktree-setup-links.test.js — keeps scripts/setup-worktree.js's link list
// honest.
//
// WHAT THIS IS PROTECTING. A git worktree copies TRACKED files only. Several things
// this repo needs in order to test itself are deliberately gitignored, and the
// licence guards react to a missing fixture by calling t.skip() — the honest
// design, because materialising a fake model file on disk is the trap CLAUDE.md's
// wakeword rename-race entry documents. The consequence is that a worktree missing
// a fixture is not RED, it is QUIETER: 6031 tests, 0 failures, 2 silent skips,
// measured 2026-08-22. Sync the docs from a run like that and `skipped=2` becomes
// the repo's committed baseline.
//
// So the list in setup-worktree.js is load-bearing, and the way it rots is by
// standing still: somebody adds a new fixture-gated guard, the list does not learn
// about it, and every future worktree quietly skips one more test than the main
// checkout. That is the failure this file is aimed at — not a typo in a path.
//
// WHY THESE ASSERTIONS AND NOT "DOES THE SETUP WORK". Actually creating a worktree
// and linking into it would take minutes, need write access outside the repo, and
// on Windows would shell out to mklink — a slow, environment-dependent test for a
// script whose real verification is stated in its own output (run the suite, demand
// skipped=0). What CAN be pinned cheaply is the list's internal consistency and,
// more importantly, its coverage of the guards that actually skip.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LINKS, COPIES } = require('../scripts/setup-worktree.js');
const REPO_ROOT = path.join(__dirname, '..', '..');
const TEST_DIR = __dirname;

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

describe('the worktree link list stays honest', () => {
  it('every linked path is actually gitignored', () => {
    // A tracked path does not belong in the list: the worktree already has it, and
    // linking over it would shadow real content with the main checkout's copy. An
    // entry that is not ignored means somebody misdiagnosed a failure and "fixed"
    // it by adding a link.
    // ONE git invocation, not one per entry, and errors are NOT treated as answers.
    //
    // The first version of this test spawned `git check-ignore` once per path
    // inside a try/catch whose `catch` set "not ignored". That conflates the only
    // answer git gives by exit code (1 = no path matched) with every way a spawn
    // can fail for reasons that have nothing to do with gitignore — and on Windows,
    // under a full suite already spawning heavily, they do fail: this repo's own
    // notes record wandering failures from fork exhaustion and index-lock
    // contention. It passed standalone and in one full run, then blocked a commit.
    // A test that manufactures a verdict out of an environment failure is worse
    // than no test, because the failure it prints names innocent files.
    //
    // So: a single spawn, and anything that is not a clean 0-or-1 exit is rethrown
    // rather than silently becoming evidence.
    const rels = LINKS.map((l) => l.rel);
    let ignoredOut = '';
    try {
      ignoredOut = execFileSync('git', ['check-ignore', '--stdin'],
        { cwd: REPO_ROOT, encoding: 'utf8', input: rels.join('\n') });
    } catch (err) {
      // Exit 1 is git's documented "nothing matched" and carries real output
      // (empty). Anything else — 128, a signal, ENOENT, a spawn failure — is the
      // environment, and must surface as itself.
      if (err.status !== 1) {
        throw new Error('git check-ignore failed for reasons unrelated to gitignore '
          + '(status ' + err.status + '). This is an environment failure, not a verdict on the '
          + 'link list — do not "fix" it by editing LINKS. Original: ' + err.message);
      }
      ignoredOut = err.stdout || '';
    }
    const ignored = new Set(ignoredOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    const tracked = rels.filter((rel) => !ignored.has(rel));
    assert.deepEqual(tracked, [],
      'these entries are not gitignored, so a fresh worktree already has them and linking is '
      + 'wrong — remove them: ' + tracked.join(', '));
  });

  it('every entry carries a real reason, not a path on its own', () => {
    // The list is the only place the knowledge lives. A bare path tells the next
    // person what to link and nothing about what breaks when it is missing, which
    // is the part that took a full suite run to discover.
    for (const entry of LINKS) {
      assert.ok(entry.why && entry.why.length > 60,
        entry.rel + ' has no real explanation. Say what silently degrades without it — '
        + 'a path with no reason decays into a link nobody dares delete.');
    }
  });

  it('has no duplicate entries', () => {
    const seen = LINKS.map((l) => l.rel);
    assert.equal(new Set(seen).size, seen.length,
      'duplicate paths in LINKS: ' + seen.join(', '));
  });

  it('covers every fixture-gated skip in the suite', () => {
    // THE ASSERTION THAT ACTUALLY MATTERS, and the reason this file exists.
    //
    // Guards that stand down on a missing fixture announce themselves with
    // `t.skip('fixture absent: ...')`. Each one is a test that a worktree will
    // silently not run unless its fixture is linked. So: find them all, and require
    // that the file declaring each one also names a path the link list covers.
    //
    // Deliberately shaped to fail OPEN — a new skip in a file the list does not
    // cover fails here, rather than being discovered later as a quiet 6031/0/0/1.
    const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'));
    const offenders = [];

    for (const file of files) {
      const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
      if (!/fixture absent:/.test(src)) continue;
      // Which linked paths does this file mention? A guard that skips on a missing
      // fixture must reference the thing it needs, and the link list must know it.
      const covered = LINKS.some((entry) => {
        const leaf = entry.rel.split('/').pop();
        return src.includes(entry.rel) || src.includes(leaf);
      });
      if (!covered) offenders.push(file);
    }

    assert.deepEqual(offenders, [],
      'these test files skip on a missing fixture, but scripts/setup-worktree.js does not link '
      + 'anything they mention — so a worktree runs them as silent skips and nobody finds out '
      + 'until a licence guard has been dormant for weeks. Add the fixture to LINKS (with a '
      + 'reason), or if it genuinely cannot be shared between checkouts, say so in that test\'s '
      + 'skip message: ' + offenders.join(', '));
  });

  it('core.bare is false, so git can still see a working tree', () => {
    // A TRIPWIRE, not a style rule, and it is here because it fired for real.
    //
    // 2026-08-22: partway through creating a worktree, `core.bare` in the SHARED
    // .git/config flipped from false to true. It was measured as false during
    // setup and found true a few minutes later. Every git operation that needs a
    // working tree then fails with:
    //
    //     fatal: this operation must be run in a work tree
    //
    // and because .git/config is shared by the main checkout and every worktree,
    // it breaks all of them at once — including any other session, which finds out
    // only when its own next command fails. This repo has hit it before; it is in
    // the operator's notes as a thing that happens and has no known trigger.
    //
    // HOW IT PRESENTED, which is the part worth pinning. It did not look like a
    // git problem. It looked like THIS FILE's first assertion failing and naming
    // six innocent paths as "not gitignored", because that assertion caught the
    // spawn failure and turned it into a verdict. The fix above stops it lying;
    // this assertion stops the next person having to work backwards from a
    // confusing message at all. Recovery is one command:
    //
    //     git config core.bare false
    assert.equal(git(['rev-parse', '--is-inside-work-tree']), 'true',
      'git no longer believes it has a working tree. Almost certainly core.bare flipped to true '
      + 'in the SHARED .git/config, which breaks the main checkout and every worktree at once. '
      + 'Fix with: git config core.bare false');
  });

  it('secrets are copied, never linked', () => {
    // Linking a .env would make an edit in the worktree silently change the main
    // checkout's keys, and vice versa. They are also the one thing a worktree may
    // legitimately want to differ on.
    const linked = LINKS.filter((l) => /(^|\/)\.env/.test(l.rel)).map((l) => l.rel);
    assert.deepEqual(linked, [],
      'these are secrets and must be COPIED, not linked, or an edit in one checkout silently '
      + 'rewrites the other: ' + linked.join(', '));
    assert.ok(COPIES.some((c) => c.includes('.env')),
      'the copy list must still carry the env files, or a worktree boots with no provider keys');
  });
});
