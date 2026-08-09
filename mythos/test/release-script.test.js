'use strict';

// scripts/release.js — cutting a release the update check can actually see.
//
// The preflight is the whole value of this script, so it is what gets pinned:
// every condition that would leave a HALF-finished release (a tag with no
// artifacts, artifacts with a stale version, a tag naming a commit origin does
// not have) must be a blocker, and it must be caught before anything mutates.
// evaluatePreflight is a pure function of gathered facts precisely so these
// cases need no git repo, no network and no gh login.
//
// Run: cd mythos && node --test test/release-script.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const release = require(path.join(__dirname, '..', '..', 'scripts', 'release.js'));

const okFacts = (overrides) => Object.assign({
  clean: true,
  branch: 'main',
  ahead: 0,
  behind: 0,
  tag: 'v0.1.2',
  tagExists: false,
  publishTarget: { owner: 'HailLucifer666', repo: 'Agent_OS' },
  publishing: true,
  hasToken: true,
  signing: true,
  ghLogin: 'HailLucifer666',
}, overrides || {});

describe('bumpVersion', () => {
  it('bumps patch, minor and major', () => {
    assert.equal(release.bumpVersion('0.1.1', 'patch'), '0.1.2');
    assert.equal(release.bumpVersion('0.1.1', 'minor'), '0.2.0');
    assert.equal(release.bumpVersion('0.1.1', 'major'), '1.0.0');
  });

  it('accepts an explicit newer version', () => {
    assert.equal(release.bumpVersion('0.1.1', '0.5.0'), '0.5.0');
  });

  it('refuses a version that is not strictly newer', () => {
    // electron-updater compares semver: a same-or-older release is one nobody is
    // ever offered, which looks like a broken updater rather than a bad tag.
    assert.throws(() => release.bumpVersion('0.1.1', '0.1.1'), /not newer/);
    assert.throws(() => release.bumpVersion('0.1.1', '0.1.0'), /not newer/);
  });

  it('refuses nonsense', () => {
    assert.throws(() => release.bumpVersion('0.1.1', 'next'), /patch\|minor\|major/);
    assert.throws(() => release.bumpVersion('not-a-version', 'patch'), /not x\.y\.z/);
  });
});

describe('publishTarget', () => {
  it('reads the github provider out of build.publish', () => {
    assert.deepEqual(
      release.publishTarget({ build: { publish: [{ provider: 'github', owner: 'o', repo: 'r' }] } }),
      { owner: 'o', repo: 'r' }
    );
  });

  it('is null when publishing is not configured at all', () => {
    assert.equal(release.publishTarget({ build: { publish: null } }), null);
    assert.equal(release.publishTarget({}), null);
  });

  it('is null for a provider with no owner/repo, rather than a half object', () => {
    assert.equal(release.publishTarget({ build: { publish: [{ provider: 'github' }] } }), null);
  });
});

describe('evaluatePreflight', () => {
  it('passes on a clean, pushed, tokened main', () => {
    const res = release.evaluatePreflight(okFacts());
    assert.equal(res.ok, true, res.blockers.join('; '));
    assert.deepEqual(res.warnings, []);
  });

  it('blocks a dirty tree', () => {
    const res = release.evaluatePreflight(okFacts({ clean: false }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /uncommitted/);
  });

  it('blocks a release cut from another branch', () => {
    const res = release.evaluatePreflight(okFacts({ branch: 'feat/x' }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /cut from main/);
  });

  it('blocks unpushed commits — a tag naming a commit origin does not have', () => {
    const res = release.evaluatePreflight(okFacts({ ahead: 2 }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /not pushed/);
  });

  it('blocks being behind origin — the release would silently omit those commits', () => {
    const res = release.evaluatePreflight(okFacts({ behind: 3 }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /behind/);
  });

  it('blocks an existing tag', () => {
    const res = release.evaluatePreflight(okFacts({ tagExists: true }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /already exists/);
  });

  it('blocks when build.publish has no github provider — no latest.yml means nothing to poll', () => {
    const res = release.evaluatePreflight(okFacts({ publishTarget: null }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /no github provider/);
  });

  it('blocks publishing with no GH_TOKEN — the tag would exist with no artifacts', () => {
    const res = release.evaluatePreflight(okFacts({ hasToken: false }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /GH_TOKEN/);
  });

  it('allows a build with no GH_TOKEN when --no-publish was passed', () => {
    const res = release.evaluatePreflight(okFacts({ hasToken: false, publishing: false }));
    assert.equal(res.ok, true, res.blockers.join('; '));
  });

  it('warns when gh is logged in as somebody other than the publish target owner', () => {
    // The known trap on this operator's machine. It is a WARNING, not a blocker,
    // because GH_TOKEN is what actually authorizes the upload and it need not
    // belong to the gh-cli account.
    const res = release.evaluatePreflight(okFacts({ ghLogin: 'someone-else' }));
    assert.equal(res.ok, true, 'gh login is not the authority — GH_TOKEN is');
    assert.match(res.warnings.join(' '), /logged in as "someone-else"/);
    assert.match(res.warnings.join(' '), /HailLucifer666\/Agent_OS/);
  });

  it('does not cross-check the gh account when not publishing', () => {
    const res = release.evaluatePreflight(okFacts({ publishing: false, ghLogin: 'someone-else' }));
    assert.equal(res.warnings.some((w) => /logged in as/.test(w)), false);
  });

  it('warns about an unsigned build without blocking it', () => {
    const res = release.evaluatePreflight(okFacts({ signing: false }));
    assert.equal(res.ok, true, 'unsigned is the documented default, not an error');
    assert.match(res.warnings.join(' '), /UNSIGNED/);
  });

  it('reports every blocker at once, not just the first', () => {
    // Fixing them one release attempt at a time is how a half-release happens.
    const res = release.evaluatePreflight(okFacts({ clean: false, branch: 'x', ahead: 1, hasToken: false }));
    assert.ok(res.blockers.length >= 4, `expected several blockers, got ${res.blockers.length}`);
  });
});

describe('release cli', () => {
  it('a bare invocation explains itself and changes nothing', () => {
    const realError = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.join(' '));
    try {
      assert.equal(release.main([]), 2);
      assert.match(lines.join(' '), /usage:/);
    } finally { console.error = realError; }
  });

  it('an invalid version spec exits before any git command', () => {
    const realError = console.error;
    const realLog = console.log;
    console.error = () => {};
    console.log = () => {};
    try {
      assert.equal(release.main(['sideways']), 2);
    } finally { console.error = realError; console.log = realLog; }
  });
});
