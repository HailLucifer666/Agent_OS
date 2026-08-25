'use strict';

// test/fresh-clone-invariant.test.js — BUG-360 (2026-08-26).
//
// scripts/verify-fresh-clone.js asserts the thing this open-source project
// promises and has never checked: that somebody who clones the repo and supplies
// their own API keys can actually run it (root CLAUDE.md).
//
// The way that promise breaks is silent. A per-machine dependency gets added; the
// machine that added it already has the dependency; every test passes. The gap
// only exists on someone else's computer, where a feature is absent rather than
// broken — which is exactly how BUG-360 behaved here, with adb sitting in two
// directories, resolved from neither, and all 14 phone_* tools withheld from the
// model behind a green suite.
//
// So the assertions below are about the CHECK not going quiet, because a
// reproducibility check that silently stops covering something is worse than
// none: it is a green light nobody re-earns.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fresh = require('../scripts/verify-fresh-clone.js');
const { LINKS } = require('../scripts/setup-worktree.js');
const { catalog } = require('../src/core/setup/components.js');

function byName(checks, name) {
  return checks.find((c) => c.name === name);
}

describe('the fresh-clone invariant', () => {
  const checks = fresh.invariantChecks();

  it('passes on the current tree', () => {
    // If this ever fails, do not adjust the check — something a stranger needs
    // has genuinely become unobtainable, and the named row says which.
    const failed = checks.filter((c) => c.ok === false);
    assert.deepEqual(failed.map((c) => c.name + ': ' + c.detail), [],
      'a fresh clone of this tree could not reach a working state');
  });

  it('covers EVERY gitignored dependency, not a sample', () => {
    // The rot mode. A dependency added to LINKS but never given a way to obtain
    // it would leave a stranger with no route to it at all — and nothing else in
    // the repo would notice, because every developer machine already has it.
    for (const entry of LINKS) {
      const row = byName(checks, `obtainable:${entry.rel}`);
      assert.ok(row, `${entry.rel} is a required dependency with no obtainability check`);
    }
  });

  it('covers every wizard component\'s installer', () => {
    for (const component of catalog()) {
      assert.ok(byName(checks, `installer:${component.id}`),
        `the wizard offers "${component.label}" but nothing checks that its script ships`);
    }
  });

  it('detects drift between the two lists in BOTH directions', () => {
    // The obtainability table and LINKS describe the same set from two angles.
    // Checking only one direction lets an entry be quietly dropped from LINKS
    // while still looking accounted for.
    const agree = byName(checks, 'lists-agree');
    assert.ok(agree, 'the drift check must exist');
    assert.equal(agree.ok, true, agree.detail);
    assert.match(agree.detail, /\d+ dependencies/);
  });

  it('demands both lockfiles, not just the root one', () => {
    // mythos/ has its own package.json and the suite runs from inside it — the
    // second tree is the one that gets forgotten, which is why setup-worktree.js
    // says so about node_modules in its own list.
    assert.equal(byName(checks, 'lockfile:package-lock.json').ok, true);
    assert.equal(byName(checks, 'lockfile:mythos/package-lock.json').ok, true);
  });

  it('demands the env template, because BYO keys is unusable without it', () => {
    assert.equal(byName(checks, 'env-example-tracked').ok, true);
  });

  it('the --clone stage is opt-in', () => {
    // Guards against a well-meaning change making the slow, downloading stage the
    // default — it clones, runs npm ci twice and boots. A check that expensive
    // stops being run at all, and then stops being maintained.
    //
    // This began as a regex over the source and was wrong: the pattern it used to
    // prove "cloneChecks is not called unconditionally" matched the correctly
    // GUARDED call too, so it failed against working code. A source-shape guard
    // that cannot tell the two apart is not a guard. The decision is a function
    // now, and this asks the function.
    assert.equal(fresh.shouldClone([]), false, 'the default run must not clone');
    assert.equal(fresh.shouldClone(['--json']), false, 'an unrelated flag must not trigger it');
    assert.equal(fresh.shouldClone(['--clone']), true);
    assert.equal(fresh.shouldClone(undefined), false, 'no argv at all is not consent to clone');
  });

  it('never runs a component installer on its own initiative', () => {
    // ~90MB from Google and Hugging Face. An unattended download is the
    // operator's decision — the same rule scripts/setup-android.js has always
    // followed, and the reason its own test suite never invokes --install.
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-fresh-clone.js'), 'utf8');
    assert.doesNotMatch(src, /spawnSync\([^)]*component\.script/,
      'this script reports whether installers EXIST; it must never execute one');
  });
});
