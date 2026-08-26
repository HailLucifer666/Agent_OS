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
// For the workflow-shape assertions at the bottom: the release route's promise
// ("--ci needs no personal token") is only true if .github/workflows/release.yml
// actually exists and does what it claims.
const fs = require('fs');

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

describe('the --ci route (no personal token)', () => {
  it('a missing GH_TOKEN is a warning, not a blocker, when CI will publish', () => {
    // The whole point: on this project one machine's `gh` is authenticated as a
    // different account than the repo owner, so requiring a local personal token
    // is the step most likely to stall a release. secrets.GITHUB_TOKEN is scoped
    // to the repository by GitHub and needs nothing minted by hand.
    const res = release.evaluatePreflight(okFacts({ hasToken: false, ci: true }));
    assert.equal(res.ok, true, res.blockers.join('; '));
    assert.match(res.warnings.join(' '), /release\.yml/, 'and it must say who is going to do the upload');
  });

  it('without --ci a missing GH_TOKEN still blocks, and names --ci as the way out', () => {
    const res = release.evaluatePreflight(okFacts({ hasToken: false, ci: false }));
    assert.equal(res.ok, false);
    assert.match(res.blockers.join(' '), /--ci/);
  });
});

describe('the release workflow', () => {
  const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml');

  it('exists, and is what --ci relies on', () => {
    assert.equal(fs.existsSync(WORKFLOW), true,
      '--ci downgrades the GH_TOKEN blocker on the promise that this workflow does the upload');
  });

  it('publishes with the repository-scoped token and asks for no more permission than it needs', () => {
    // Line endings normalised to \n before ANY regex runs. release.yml is CRLF on
    // disk, so /\npermissions:\n/ below found nothing and this test reported "the
    // workflow does not declare permissions" about a workflow that declares them
    // on line 50 — a test failing for the opposite of the reason it exists, which
    // is the same shape its own comments already complain about twice.
    const text = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    assert.match(text, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
      'the built-in token is the entire reason this route needs no personal one');
    // Assert the GUARANTEE, not the comment layout: exactly one write scope, and
    // it is contents. Counting comment lines (the first version of this) breaks
    // the moment someone edits the prose, which is a test failing for a reason
    // that has nothing to do with what it protects.
    const permissions = /\npermissions:\n((?:[ \t]+[^\n]*\n)+)/.exec(text);
    assert.ok(permissions, 'the workflow must declare permissions explicitly rather than inheriting the default');
    const grants = permissions[1]
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean);
    assert.deepEqual(grants, ['contents: write'],
      `contents: write is required to create the release; anything broader is not (found: ${grants.join(', ')})`);
    // Comment-stripped, because the workflow's header deliberately NAMES CSC_LINK
    // in order to explain why it does not use it — and a test that reads prose as
    // code fails for the opposite of the reason it exists. (Second time this shape
    // has bitten in this session; see electron-vault-sync-wiring.test.js.)
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /CSC_LINK|CSC_KEY_PASSWORD|secrets\.CSC/,
      'a signing certificate must not be wired into repository secrets before that decision is actually made');
  });

  it('regenerates release notes from the commit log before the build/publish step', () => {
    // build/release-notes.md is gitignored (see .gitignore) precisely because
    // it must never be committed, which means CI's fresh checkout has to
    // rebuild it itself — otherwise app-builder-lib's getReleaseInfo() finds
    // nothing and latest.yml's releaseNotes field goes back to being empty.
    const text = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    const notesIdx = text.indexOf('node scripts/build-release-notes.js');
    const buildIdx = text.indexOf('Build and publish the installer');
    assert.notEqual(notesIdx, -1, 'the workflow must run scripts/build-release-notes.js');
    assert.notEqual(buildIdx, -1, 'the workflow must still have its build/publish step');
    assert.ok(notesIdx < buildIdx,
      'release notes must be generated BEFORE the build step reads build/release-notes.md');
  });

  it('checks out full history, which build-release-notes.js needs for git log', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    assert.match(text, /fetch-depth:\s*0/,
      'a shallow checkout would leave git log with no previous-tag range to walk');
  });

  it('refuses a tag that disagrees with package.json, and proves latest.yml was produced', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    // A tag/version mismatch produces a release electron-updater never offers,
    // because it compares semver against package.json's version. Catching it
    // before the build costs seconds; after it costs a wasted run and a bad tag.
    assert.match(text, /does not match package\.json version/,
      'the tag/version check must fail loudly rather than shipping a silent no-op');
    assert.match(text, /latest\.yml is missing/,
      'latest.yml is the file the updater polls — a release without it reports "no update" forever');
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

describe('releaseSteps — the ORDER, which is the part that was wrong', () => {
  // Cutting 0.1.10 on 2026-08-26 failed on this, and the failure was expensive:
  // a full 271MB installer built, the blockmap uploaded, then GitHub refused the
  // release with
  //     422 Unprocessable Entity — "Published releases must have a valid tag"
  // because the tag was still LOCAL when electron-builder posted. What remained
  // on GitHub was a PUBLISHED release marked "Latest" containing one 263KB
  // blockmap and no installer — worse than no release, because auto-update
  // advertises it.
  //
  // Every individual step read correctly. Only their SEQUENCE was wrong, which is
  // why it survived review and why the list is now a pure exported function
  // rather than an array buried inside main().
  const steps = () => release.releaseSteps('v1.2.3', { publishing: true, ci: false });
  const idx = (pred) => steps().findIndex(pred);
  // Matches the build step by what it INVOKES, not by the command name — because
  // the command name is exactly what changed. "npx electron-builder" could never
  // spawn on Windows: npx is npx.cmd, Node gives ENOENT without a shell, and Node
  // 26 gives EINVAL for a .cmd. It is now process.execPath plus the local cli.js.
  const isBuild = ([, args]) => args.some((a) => /electron-builder/.test(String(a)));
  const isTagPush = ([cmd, args]) => cmd === 'git' && args[0] === 'push' && args[2] === 'v1.2.3';
  const isMainPush = ([cmd, args]) => cmd === 'git' && args[0] === 'push' && args[2] === 'main';

  it('pushes the tag BEFORE the build that publishes against it', () => {
    const tagPush = idx(isTagPush);
    const build = idx(isBuild);
    assert.ok(tagPush >= 0, 'the tag must still be pushed');
    assert.ok(build >= 0, 'the build step must still exist');
    assert.ok(tagPush < build,
      `the tag push is at ${tagPush} and the publishing build at ${build}. With releaseType "release", `
      + 'GitHub 422s a published release whose tag it has never seen — so this order must never invert.');
  });

  it('does not invoke the build through npx, which cannot spawn on Windows', () => {
    // The defect that cost 0.1.10 AND 0.1.11, both of which stopped at this step
    // reporting only "failed (exit null)" and no output. npx is npx.cmd on
    // Windows; Node's spawn does no PATHEXT resolution, so spawnSync('npx', …)
    // is ENOENT, and Node 26 refuses spawnSync('npx.cmd', …) with EINVAL because
    // running a .cmd without a shell is the injection hole DEP0190 warns about.
    // Measured here: ENOENT, EINVAL, and status 0 only with shell:true.
    //
    // So this asserts the ABSENCE of the thing that looked most natural to write,
    // which is the only kind of assertion that would have caught it.
    for (const [cmd, args] of steps()) {
      assert.notEqual(cmd, 'npx', 'npx cannot be spawned on Windows without a shell');
      assert.notEqual(cmd, 'npm', 'npm is a .cmd shim on Windows for the same reason');
      for (const a of args) {
        assert.doesNotMatch(String(a), /\.cmd$/,
          'a .cmd target cannot be spawned without a shell on Node 26 (EINVAL): ' + a);
      }
    }
    const build = steps().find(isBuild);
    assert.ok(build, 'there must still be a build step');
    assert.equal(build[0], process.execPath,
      'the build must run through the current Node binary, which needs no shell and pins the '
      + 'LOCAL electron-builder rather than whatever npx would resolve');
    assert.match(String(build[1][0]), /electron-builder[\\/]cli\.js$/,
      "the first argument must be electron-builder's own CLI entry point");
  });

  it('pushes main before the tag, so the tag names a commit origin has', () => {
    assert.ok(idx(isMainPush) < idx(isTagPush));
  });

  it('creates the tag locally before pushing it', () => {
    const create = idx(([cmd, args]) => cmd === 'git' && args[0] === 'tag');
    assert.ok(create >= 0 && create < idx(isTagPush));
  });

  it('commits the version bump before tagging it', () => {
    // Otherwise the tag names a commit whose package.json still says the OLD
    // version — which is exactly the state the remote tag ended up in during the
    // 0.1.10 recovery, when GitHub created the tag itself against main.
    const commit = idx(([cmd, args]) => cmd === 'git' && args[0] === 'commit');
    const tag = idx(([cmd, args]) => cmd === 'git' && args[0] === 'tag');
    assert.ok(commit >= 0 && commit < tag);
  });

  it('omits --publish under --ci, where the workflow does the upload', () => {
    const ciSteps = release.releaseSteps('v1.2.3', { publishing: true, ci: true });
    const build = ciSteps.find(isBuild);
    assert.ok(build, 'the build still runs as a smoke test');
    assert.equal(build[1].includes('--publish'), false);
    // The pushes must STILL come first here — under --ci the tag push is what
    // triggers the release workflow, so a build placed before it would run
    // against a tag that does not exist yet for a different reason.
    const order = ciSteps.map(([cmd, args]) => cmd + ' ' + args.join(' '));
    assert.ok(order.findIndex((s) => s.includes('push origin v1.2.3')) < order.findIndex((s) => s.includes('electron-builder')));
  });

  it('omits --publish under --no-publish', () => {
    const build = release.releaseSteps('v1.2.3', { publishing: false, ci: false }).find(isBuild);
    assert.equal(build[1].includes('--publish'), false);
  });

  it('names the tag consistently in every step that mentions it', () => {
    // A mismatch here produces a tag and a release that disagree, which is only
    // discoverable after a full build and upload.
    for (const [cmd, args] of steps()) {
      if (cmd !== 'git') continue;
      const mentions = args.filter((a) => /^v\d+\.\d+\.\d+$/.test(a));
      for (const m of mentions) assert.equal(m, 'v1.2.3');
    }
  });
});
