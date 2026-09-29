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
    const buildIdx = text.indexOf('Build the installer (publishing disabled)');
    assert.notEqual(notesIdx, -1, 'the workflow must run scripts/build-release-notes.js');
    assert.notEqual(buildIdx, -1, 'the workflow must still have its build step');
    assert.ok(notesIdx < buildIdx,
      'release notes must be generated BEFORE the build step reads build/release-notes.md');
  });

  it('builds with publishing disabled, scans, then uploads only the scanned artifacts', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const build = code.indexOf('npx electron-builder --win --publish never');
    const scan = code.indexOf('node mythos/scripts/verify-package-contents.js --dist dist --receipt dist/package-scan.json');
    const upload = code.indexOf('node scripts/publish-scanned-release.js');
    assert.ok(build >= 0 && scan >= 0 && upload >= 0, `build=${build} scan=${scan} upload=${upload}`);
    assert.ok(build < scan && scan < upload, 'the order must be build, scan, upload');
    assert.doesNotMatch(code, /--publish\s+(always|onTag|onTagOrDraft)/,
      'no step may let electron-builder upload by itself — it would skip the scan');
    // The build step holds no upload rights: GH_TOKEN appears only on steps after the scan.
    const firstToken = code.indexOf('GH_TOKEN:');
    assert.ok(firstToken > scan, 'GH_TOKEN must not be in scope for the build or the scan');
  });

  // Widened 2026-09-29 after independent review: the first version checked only
  // the upload line, while the tag-check and draft-check steps still pasted the
  // free-text workflow_dispatch input straight into pwsh source. So this now
  // holds over EVERY line: an expression may appear only as the value of a key
  // that is not shell source.
  it('never splices an expression into a run: script — the tag travels by environment', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l));
    const spliced = code.filter((l) => l.includes('${{') && !/^\s*(ref|GH_TOKEN|RELEASE_TAG):\s/.test(l));
    assert.deepEqual(spliced, [], 'a ${{ }} outside an input/env value is pasted into the script before the shell parses it');
    assert.match(text, /\n {4}env:\n {6}RELEASE_TAG: \$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}\n/,
      'the tag must be set once, at job level, for every step');
    assert.equal((text.match(/\$env:RELEASE_TAG/g) || []).length, 3, 'tag check, upload and draft check all read it from the environment');
  });

  it('does not leave the write token on disk for the build to read', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');
    // Read as lines, not one regex: the first version was
    //   /checkout@v4\n\s+with:\n(?:\s+[^\n]*\n)*?\s+persist-credentials: false\n/
    // and because \s also matches "\n", every line could be split between the two
    // quantifiers several ways — so when the key was ABSENT the match backtracked
    // exponentially and the test hung instead of failing. Found by mutation probe
    // R17 on 2026-09-29 (it ran for 14 minutes before it was noticed).
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /^\s*- uses: actions\/checkout@v4\s*$/.test(l));
    assert.ok(at >= 0, 'the checkout step must exist');
    const block = [];
    for (let i = at + 1; i < lines.length && !/^\s*- /.test(lines[i]); i += 1) block.push(lines[i].trim());
    assert.ok(block.includes('persist-credentials: false'),
      'actions/checkout persists the contents:write token in .git/config unless told not to');
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
  const isScan = ([, args]) => /verify-package-contents\.js$/.test(String(args[0]));
  const isUpload = ([, args]) => /publish-scanned-release\.js$/.test(String(args[0]));

  it('pushes the tag BEFORE the upload that publishes against it', () => {
    const tagPush = idx(isTagPush);
    const upload = idx(isUpload);
    assert.ok(tagPush >= 0, 'the tag must still be pushed');
    assert.ok(upload >= 0, 'the upload step must still exist');
    assert.ok(tagPush < upload,
      `the tag push is at ${tagPush} and the upload at ${upload}. With releaseType "release", `
      + 'GitHub 422s a published release whose tag it has never seen — so this order must never invert.');
  });

  // 2026-09-29 audit, B1. The build used to be last and to upload as it went
  // ("--publish always"), so nothing could look at the installer before it was
  // public — and the 2026-09-23 local build carried four .env backups.
  // Mutation-probed the same day, each red here: the build without
  // "--publish never"; the scan moved after the pushes; the upload moved before
  // the tag push; release.yml's build set to "--publish always"; release.yml's
  // tag spliced into the command line.
  // After independent review (Opus), same day, six more, each red: no origin
  // re-check after the build; the recovery not printed; the tag spliced into the
  // draft-check step; checkout persisting its token; `npm run dist` without
  // --receipt; the workflow search exempting any line containing "install". The
  // persisted-token probe first HUNG this file for 14 minutes — the assertion's
  // regex backtracked exponentially once the key was missing — so that test now
  // reads lines instead.
  it('builds and scans BEFORE any push', () => {
    const build = idx(isBuild);
    const scan = idx(isScan);
    const firstPush = idx(([cmd, args]) => cmd === 'git' && args[0] === 'push');
    assert.ok(build >= 0 && scan >= 0, 'the build and the scan must both exist');
    assert.equal(scan, build + 1, 'the scan must run directly after the build it inspects');
    assert.ok(scan < firstPush, `the scan is at ${scan} and the first push at ${firstPush}`);
  });

  // Independent review, 2026-09-29: the first B1 draft built AFTER committing and
  // tagging, so a red scan left a local tag — and a tag that exists makes this
  // script's preflight refuse the re-run. Now a red scan leaves only package.json.
  it('builds and scans BEFORE the commit and the tag, so a red scan leaves no commit and no tag', () => {
    const scan = idx(isScan);
    const firstGitWrite = idx(([cmd, args]) => cmd === 'git' && ['add', 'commit', 'tag'].includes(args[0]));
    assert.ok(scan >= 0 && firstGitWrite >= 0);
    assert.ok(scan < firstGitWrite, `the scan is at ${scan} and the first git write at ${firstGitWrite}`);
  });

  it('re-checks origin/main after the build and before the commit', () => {
    // The build takes minutes and a second machine pushes to this repo.
    const scan = idx(isScan);
    const fetch = idx(([cmd, args]) => cmd === 'git' && args[0] === 'fetch');
    const ancestor = idx(([cmd, args]) => cmd === 'git' && args.join(' ') === 'merge-base --is-ancestor origin/main HEAD');
    const commit = idx(([cmd, args]) => cmd === 'git' && args[0] === 'commit');
    assert.ok(scan < fetch && fetch < ancestor && ancestor < commit, `scan=${scan} fetch=${fetch} ancestor=${ancestor} commit=${commit}`);
  });

  it('every step carries its own recovery, and none before the tag tells the operator to delete one', () => {
    const all = steps();
    const tagAt = all.findIndex(([cmd, args]) => cmd === 'git' && args[0] === 'tag');
    all.forEach(([cmd, args, recovery], i) => {
      assert.ok(typeof recovery === 'string' && recovery.length > 20, `${cmd} ${args.join(' ')} has no recovery`);
      if (i < tagAt) assert.doesNotMatch(recovery, /git tag -d/, `no tag exists yet at step ${i}`);
    });
    assert.match(all[0][2], /git checkout -- package\.json/);
    assert.match(all[all.length - 1][2], /publish-scanned-release\.js v1\.2\.3.*Do NOT re-run this script/s);
    // And main() prints it: the operator reads the terminal, not the source.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'release.js'), 'utf8');
    assert.match(src, /for \(const \[cmd, cmdArgs, recovery\] of steps\)/);
    assert.match(src, /console\.error\(`release: recovery — \$\{recovery\}`\)/);
  });

  it('scans the dist directory and writes the receipt the upload step demands', () => {
    const scan = steps().find(isScan);
    assert.equal(scan[0], process.execPath);
    assert.deepEqual(scan[1].slice(1).map((a, i) => (i % 2 === 0 ? a : path.basename(a))),
      ['--dist', 'dist', '--receipt', 'package-scan.json']);
  });

  it('the upload is the LAST step and goes through the scanned-receipt publisher, never electron-builder', () => {
    const all = steps();
    const upload = all[all.length - 1];
    assert.ok(isUpload(upload), 'the final step must be scripts/publish-scanned-release.js');
    assert.deepEqual(upload[1].slice(1), ['v1.2.3']);
    assert.equal(all.filter(isBuild).length, 1, 'exactly one build — the upload must not rebuild');
  });

  // electron-builder publishes on its own when --publish is absent and
  // npm_lifecycle_event is "release" (which `npm run release` sets) or a CI tag
  // is visible (app-builder-lib/out/publish/PublishManager.js, 26.15.3). So
  // "never" must be explicit in EVERY mode — omitting the flag is not the same as
  // not publishing.
  for (const opts of [
    { publishing: true, ci: false }, { publishing: true, ci: true },
    { publishing: false, ci: false }, { publishing: false, ci: true },
  ]) {
    it(`every build passes --publish never (${JSON.stringify(opts)})`, () => {
      const builds = release.releaseSteps('v1.2.3', opts).filter(isBuild);
      assert.equal(builds.length, 1);
      const args = builds[0][1];
      const at = args.indexOf('--publish');
      assert.ok(at > 0 && args[at + 1] === 'never', `build args were: ${args.slice(1).join(' ')}`);
      assert.equal(args.includes('always'), false);
    });
  }

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

  it('does not upload under --ci, where the workflow does the upload', () => {
    const ciSteps = release.releaseSteps('v1.2.3', { publishing: true, ci: true });
    const build = ciSteps.find(isBuild);
    assert.ok(build, 'the build still runs as a smoke test');
    assert.equal(ciSteps.some(isUpload), false, 'the workflow uploads; a local upload as well would race it');
    // Under --ci the tag push is what STARTS the release workflow, so the local
    // smoke build and its scan run first: a red scan must stop the push rather
    // than follow it. (Until 2026-09-29 this asserted the reverse, when the
    // local build was also the upload and needed the remote tag to exist.)
    const order = ciSteps.map(([cmd, args]) => cmd + ' ' + args.join(' '));
    assert.ok(order.findIndex((s) => s.includes('verify-package-contents')) < order.findIndex((s) => s.includes('push origin v1.2.3')));
  });

  it('does not upload under --no-publish, but still builds and scans', () => {
    const s = release.releaseSteps('v1.2.3', { publishing: false, ci: false });
    assert.equal(s.some(isUpload), false);
    assert.ok(s.some(isBuild) && s.some(isScan));
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

// Every route that can run electron-builder, found by searching for it rather
// than listed by hand: package.json scripts and every workflow. Each must say
// `--publish never`, because a route that omits the flag lets electron-builder
// decide — and it decides "publish" under `npm run release`, and on any CI run
// that can see a tag. The upload belongs to publish-scanned-release.js alone.
describe('no build route lets electron-builder upload by itself', () => {
  const REPO = path.join(__dirname, '..', '..');

  // Every non-comment line that runs electron-builder. There is deliberately no
  // exemption: an earlier version skipped any line CONTAINING "install", so
  // `electron-builder --publish always --config.nsis.installerIcon=x` — or one
  // ending in "# build installer" — walked past this guard (independent review,
  // 2026-09-29), and no workflow line needed the exemption in the first place.
  function builderLines(text, file) {
    const found = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (/electron-builder(\s|$)/.test(line)) found.push({ where: `${file}:${i + 1}`, cmd: line.trim() });
    });
    return found;
  }

  function invocations() {
    const found = [];
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      if (/electron-builder/.test(cmd)) found.push({ where: `package.json scripts.${name}`, cmd });
    }
    const wfDir = path.join(REPO, '.github', 'workflows');
    for (const file of fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
      found.push(...builderLines(fs.readFileSync(path.join(wfDir, file), 'utf8'), file));
    }
    return found;
  }

  it('finds the routes it polices (so an empty search cannot pass)', () => {
    const where = invocations().map((i) => i.where);
    assert.ok(where.includes('package.json scripts.dist'), `found: ${where.join(', ')}`);
    assert.ok(where.some((w) => w.startsWith('release.yml:')), `found: ${where.join(', ')}`);
  });

  // Every publish flag on the line, in every spelling electron-builder's yargs
  // accepts. Exactly one, and it must say "never": with "--publish never -p
  // always" the LAST one wins, so the presence of "never" alone proves nothing.
  function publishValues(cmd) {
    const toks = cmd.split(/\s+/);
    const values = [];
    toks.forEach((tok, i) => {
      if (tok === '--publish' || tok === '-p') values.push(toks[i + 1]);
      else if (/^(--publish|-p)=/.test(tok)) values.push(tok.split('=')[1]);
    });
    return values;
  }

  // Independent review, 2026-09-29: `npm run dist` scanned without --receipt,
  // so the documented upload after it (publish-scanned-release.js) always refused.
  it('npm run dist writes the receipt the documented upload step demands', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.dist,
      /electron-builder --win --publish never && node mythos\/scripts\/verify-package-contents\.js --dist dist --receipt dist\/package-scan\.json$/);
  });

  it('every one of them passes exactly one publish flag, and it is --publish never', () => {
    const bad = invocations().filter((i) => JSON.stringify(publishValues(i.cmd)) !== '["never"]');
    assert.deepEqual(bad, [], 'these routes let electron-builder choose whether to upload');
  });

  it('the flag reader is not fooled by a second, later publish flag (attack on this guard)', () => {
    assert.deepEqual(publishValues('electron-builder --win --publish never'), ['never']);
    assert.deepEqual(publishValues('electron-builder --win --publish never -p always'), ['never', 'always']);
    assert.deepEqual(publishValues('electron-builder --win --publish=always'), ['always']);
    assert.deepEqual(publishValues('electron-builder --win'), []);
  });

  it('no line that runs electron-builder is exempt from the search (attack on this guard)', () => {
    const wf = [
      '# a comment naming electron-builder is prose, not a route',
      '        run: npx electron-builder --win --publish always --config.nsis.installerIcon=x',
      '        run: npx electron-builder --win # build installer',
      '        run: npm ci && npx electron-builder --publish always',
    ].join('\r\n');
    const found = builderLines(wf, 'x.yml');
    assert.deepEqual(found.map((f) => f.where), ['x.yml:2', 'x.yml:3', 'x.yml:4']);
    assert.deepEqual(found.map((f) => JSON.stringify(publishValues(f.cmd))), ['["always"]', '[]', '["always"]']);
  });
});
