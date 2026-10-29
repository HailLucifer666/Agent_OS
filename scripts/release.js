'use strict';

// scripts/release.js — cut a release the update check can actually see.
//
// CONTRIBUTING.md's "Publishing a release" is four steps that must all happen or
// none of them should: bump the version, commit it, tag it, build, upload the
// installer + .blockmap + latest.yml together. Done by hand it half-completes —
// a tag with no artifacts, or artifacts with a stale version, or a latest.yml
// beside a file that was never uploaded, which is how an update check
// "succeeds" and then fails at download time.
//
// Design rules, in the order they matter:
//
//   1. EVERY check that can fail runs BEFORE anything mutates. A dirty tree, a
//      wrong branch, an unpushed commit, a `gh` logged in as somebody who cannot
//      publish to this repo — all of it is caught while the only cost is reading
//      the answer. Half a release is worse than none.
//   2. Nothing outward-facing happens without --yes. Without it this is a
//      dry run that prints the exact commands it would run. Bumping, tagging,
//      pushing and publishing are hard to reverse once a release is public.
//   3. GH_TOKEN and CSC_* come from the environment, never from a tracked file,
//      and are never printed.
//
// Usage:
//   node scripts/release.js patch                 dry run (prints the plan)
//   node scripts/release.js patch --yes           do it
//   node scripts/release.js 0.2.0 --yes           explicit version
//   node scripts/release.js patch --yes --no-publish   bump/tag/build, no upload
//   node scripts/release.js patch --yes --ci          let CI publish from the tag
//                                                     (no personal GH_TOKEN needed)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const buildReleaseNotes = require('./build-release-notes');

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');

// ---- pure helpers (unit-tested; see test/release-script.test.js) ------------

// bumpVersion('1.2.3', 'patch') -> '1.2.4'   bumpVersion('1.2.3','2.0.0') -> '2.0.0'
function bumpVersion(current, spec) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current || '').trim());
  if (!parsed) throw new Error(`current version "${current}" is not x.y.z`);
  const [major, minor, patch] = parsed.slice(1).map(Number);
  const s = String(spec || '').trim();
  if (s === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (s === 'minor') return `${major}.${minor + 1}.0`;
  if (s === 'major') return `${major + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(s)) {
    if (!isNewer(s, current)) {
      // electron-updater compares semver, so a version that is not strictly
      // newer produces a release nobody is ever offered.
      throw new Error(`${s} is not newer than the current ${current}`);
    }
    return s;
  }
  throw new Error(`version must be patch|minor|major or x.y.z, got "${spec}"`);
}

function isNewer(candidate, current) {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// The publish target as electron-builder will resolve it, so the preflight can
// compare it against whoever `gh` is actually logged in as.
function publishTarget(pkg) {
  const list = pkg && pkg.build && pkg.build.publish;
  if (!Array.isArray(list)) return null;
  const github = list.find((p) => p && p.provider === 'github');
  if (!github || !github.owner || !github.repo) return null;
  return { owner: github.owner, repo: github.repo };
}

// The ordered command list a release runs. Pure and exported so the ORDER itself
// is testable — it is the part that was wrong, and it is invisible in review
// because every individual step reads correctly.
//
// build (never publishes) -> scan -> re-check origin -> commit, tag -> push ->
// upload the scanned bytes.
//
// THE UPLOAD COMES AFTER THE PUSHES, and that ordering is load-bearing.
// package.json's publish config is `releaseType: "release"`, and GitHub REFUSES
// to create a published release for a tag it does not have:
//
//     422 Unprocessable Entity — "Published releases must have a valid tag"
//
// Cutting 0.1.10 on 2026-08-26 hit it when the upload ran before the tag push: a
// full 271MB installer built, the blockmap uploaded, the release POST 422'd, and
// what was left on GitHub was a PUBLISHED release marked "Latest" holding one
// 263KB blockmap and no installer. (v0.1.4 is the same wrong order under a draft
// releaseType: no 422, just a draft electron-updater can never see.)
// publish-scanned-release.js passes `gh release create --verify-tag`, so a
// missing remote tag now fails before anything is posted.
//
// THE BUILD AND SCAN COME FIRST, before the commit and the tag (changed
// 2026-09-29, B1). The old order built last, with `--publish always`, because the
// only upload route was electron-builder's own and a separate upload meant
// building twice. That left no gap between building the installer and uploading
// it — and the 2026-09-23 local build carried four .env backups nothing would
// have caught. Uploading is now its own step (the scanned bytes, via gh), so the
// build can move to the front: a build or scan failure leaves nothing but the
// edited version line in package.json. (Building after the tag, as a first draft
// of this change did, left a local tag behind a red scan — and a tag that exists
// makes this script's own preflight refuse the re-run.)
//
// The build takes minutes and another machine pushes to this repo, so origin/main
// is checked AGAIN after the scan, immediately before the commit. The preflight's
// "0 behind" is minutes old by then; a push rejected after the tag exists is the
// recovery nobody wants.
//
// Every step carries the recovery for its own failure, and main() prints it —
// the operator reads the terminal, not this file.
//
// `--publish never` is explicit on every build, never omitted. With no --publish
// flag electron-builder decides for itself, and one of its triggers is
// npm_lifecycle_event === "release" — which `npm run release` sets and this
// script's child inherits — so a build started that way uploaded whatever it
// had just built, under --no-publish and --ci as well
// (app-builder-lib/out/publish/PublishManager.js, 26.15.3; re-verified 26.18.0).
//
// electron-builder is invoked as `node <its cli.js>`, NOT as `npx electron-builder`,
// and that is the difference between a release that works on Windows and one that
// cannot run at all.
//
// `npx` on Windows is `npx.cmd`. Node's spawn does not do PATHEXT resolution, so
// spawnSync('npx', …) fails ENOENT — and Node 26 refuses spawnSync('npx.cmd', …)
// outright with EINVAL, because executing a .cmd without a shell is the argument-
// injection hole DEP0190 warns about. Measured on this machine:
//
//     spawnSync('npx',     ['--version'])                -> status null, ENOENT
//     spawnSync('npx.cmd', ['--version'])                -> status null, EINVAL
//     spawnSync('npx',     ['--version'], {shell:true})  -> status 0, "11.13.0"
//
// So this step has NEVER been able to run from this script on Windows. It cost two
// releases on 2026-08-26 — 0.1.10 and 0.1.11 both stopped here — and it presented
// as "failed (exit null)" with no output whatsoever, because status is null for a
// spawn that never started just as it is for a signal kill, and run() was
// discarding res.error. That missing error is what made this look like a mystery
// kill; the fix to run() below is the more important half of this change.
//
// `shell: true` would also work and is what most projects reach for. Spawning the
// CLI's own JS entry point through process.execPath is preferred because it needs
// no shell, cannot be affected by argument escaping, and pins the LOCAL
// electron-builder rather than whatever npx would resolve.
const BUILDER_CLI = path.join(REPO_ROOT, 'node_modules', 'electron-builder', 'cli.js');
const SCANNER = path.join(REPO_ROOT, 'mythos', 'scripts', 'verify-package-contents.js');
const PUBLISHER = path.join(REPO_ROOT, 'scripts', 'publish-scanned-release.js');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const SCAN_RECEIPT = path.join(DIST_DIR, 'package-scan.json');

// Each step is [command, args, recovery]: the recovery is what main() prints
// when that step fails, because what is safe to do next differs per step.
function releaseSteps(tag, opts) {
  const o = opts || {};
  const undoBump = 'Nothing was committed, tagged or pushed. Undo the version bump with `git checkout -- package.json`.';
  const uploads = o.publishing && !o.ci ? [[process.execPath, [PUBLISHER, tag],
    `The tag is public. Re-run \`node scripts/publish-scanned-release.js ${tag}\` alone: it re-checks the receipt, `
    + 'uploads only what is missing, and refuses to replace a file already published. Do NOT re-run this script — '
    + 'the tag exists, so its own preflight will (correctly) refuse.']] : [];
  return [
    [process.execPath, [BUILDER_CLI, '--win', '--publish', 'never'],
      `${undoBump} A manual re-run of the build needs ELECTRON_BUILDER_CACHE exported, or it downloads NSIS outside the repo.`],
    [process.execPath, [SCANNER, '--dist', DIST_DIR, '--receipt', SCAN_RECEIPT],
      `${undoBump} The scan lists every forbidden file by name: move them out of the working directory, then cut the release again.`],
    ['git', ['fetch', 'origin', 'main'], `${undoBump} origin could not be reached to re-check main; retry when it can.`],
    ['git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
      `${undoBump} origin/main moved while the build ran, so that build is of stale code. Pull, then cut the release again.`],
    ['git', ['add', 'package.json'], undoBump],
    ['git', ['commit', '-m', `chore(release): ${tag}`],
      'Nothing was committed or pushed. `git reset -- package.json` then `git checkout -- package.json` undoes the bump.'],
    ['git', ['tag', '-a', tag, '-m', `MYTHOS ${tag}`],
      'The version commit exists locally only. `git reset --hard HEAD~1` removes it (the preflight required a clean tree).'],
    ['git', ['push', 'origin', 'main'],
      `A local commit and tag only. If origin rejected the push, main moved: \`git tag -d ${tag}\`, \`git reset --hard HEAD~1\`, pull, cut again.`],
    ['git', ['push', 'origin', tag],
      `main is pushed with the version commit. Push the tag by hand (\`git push origin ${tag}\`)`
      + (uploads.length ? `, then run \`node scripts/publish-scanned-release.js ${tag}\`.` : '; that push starts the release workflow.')],
    ...uploads,
  ];
}

// evaluatePreflight(facts) -> {ok, blockers[], warnings[]}
// Split out from the shelling-out so every branch is testable without a git
// repo, a network, or a gh login.
function evaluatePreflight(facts) {
  const f = facts || {};
  const blockers = [];
  const warnings = [];

  if (!f.clean) blockers.push('the working tree has uncommitted changes — commit or stash them first');
  if (f.branch !== 'main') blockers.push(`on branch "${f.branch}" — releases are cut from main`);
  if (f.ahead > 0) blockers.push(`${f.ahead} commit(s) are not pushed — push before tagging, or the tag names a commit origin does not have`);
  if (f.behind > 0) blockers.push(`${f.behind} commit(s) behind origin/main — pull and re-run, or the release omits them`);
  if (f.tagExists) blockers.push(`tag ${f.tag} already exists — pick another version`);
  if (!f.publishTarget) blockers.push('package.json build.publish has no github provider — electron-builder would emit no latest.yml, and an update check has nothing to poll');

  if (f.publishing) {
    if (!f.hasToken) {
      // Not a blocker when CI is doing the upload: .github/workflows/release.yml
      // publishes on the tag push using secrets.GITHUB_TOKEN, which is scoped to
      // this repository by GitHub and needs no personal token at all. That is the
      // recommended route precisely because a local GH_TOKEN has to belong to an
      // account with write access here, and on at least one machine `gh` is logged
      // in as a different one.
      if (f.ci) {
        warnings.push('GH_TOKEN is not set locally — the tag push will let .github/workflows/release.yml do the upload with the repository-scoped GITHUB_TOKEN');
      } else {
        blockers.push('GH_TOKEN is not set — the upload would be skipped and the tag would exist with no artifacts. Set it, pass --ci to let the release workflow publish, or pass --no-publish');
      }
    }
    // The gotcha this whole function exists for: `gh` on a machine can be
    // authenticated as an account with no write access to the publish target,
    // and electron-builder's failure arrives only after a full build.
    if (f.ghLogin && f.publishTarget && f.ghLogin !== f.publishTarget.owner) {
      warnings.push(`gh is logged in as "${f.ghLogin}" but the publish target is "${f.publishTarget.owner}/${f.publishTarget.repo}". GH_TOKEN is what actually authorizes the upload, so this is only a warning — but if the token belongs to that gh account, the upload will fail after the build`);
    }
    if (!f.ghLogin) {
      warnings.push('could not determine the gh login — skipping the account/publish-target cross-check');
    }
  }

  if (!f.signing) {
    warnings.push('CSC_LINK is not set — this will be an UNSIGNED build. Windows SmartScreen warns on install. Updates still install: electron-updater skips (does not fail) the signature check when app-update.yml has no publisherName, and the sha512 in latest.yml still gates integrity — see CONTRIBUTING.md for the risk that signing would close');
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

// ---- shelling out -----------------------------------------------------------

// ELECTRON_BUILDER_CACHE is set here, for every shell-out, and it is not
// cosmetic. electron-builder downloads NSIS (nsis-3.0.4.1.7z,
// nsis-resources-3.4.1.7z) before it can build an installer, and with this unset
// it writes them to %LOCALAPPDATA%\electron-builder — outside the repo, which
// root CLAUDE.md's project-isolation rule forbids. .gitignore already says the
// variable "must be set to this cache dir when running `npm run dist`"; this
// script shells out to `npx electron-builder` directly and was the one path that
// never set it.
//
// CORRECTION, recorded because the wrong version of this comment stood for an
// hour and shaped a diagnosis: this variable was NOT the cause of the 0.1.10 build
// failure. It looked like it, because a manual run with it exported succeeded where
// the script failed — but 0.1.11 then failed identically WITH the script setting
// it. The real cause was `npx` being unspawnable on Windows (see BUILDER_CLI
// below). A coincidence that survives one comparison is not a mechanism; the
// second data point is what killed it.
//
// This is kept purely because the isolation rule requires it, not as a fix.
//
// Deliberately does not override an existing value: an operator with a warm cache
// elsewhere keeps it.
const BUILDER_CACHE = path.join(REPO_ROOT, '.electron-builder-cache');

function run(cmd, args, opts) {
  const env = Object.assign({ ELECTRON_BUILDER_CACHE: BUILDER_CACHE }, process.env);
  const res = spawnSync(cmd, args, Object.assign({ cwd: REPO_ROOT, encoding: 'utf8', env }, opts || {}));
  return {
    ok: res.status === 0,
    status: res.status,
    // res.error is set when the process NEVER STARTED — ENOENT for a command that
    // is not executable, EINVAL for a .cmd on Node 26. Dropping it, as this used
    // to, is why two failed releases reported only "failed (exit null)" with no
    // output: status is null for a spawn that never happened exactly as it is for
    // a signal kill, so the one field that told the two apart was thrown away.
    // Twice diagnosed wrong off that missing line.
    error: res.error ? `${res.error.code || 'spawn failed'}: ${res.error.message}` : null,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
  };
}

function gatherFacts(pkg, tag, publishing) {
  const status = run('git', ['status', '--porcelain=v1']);
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Ask origin rather than trusting the cached ref: this repo's fetch refspec is
  // pinned to main, and a stale origin/main has already caused one divergence
  // here that looked like a fast-forward.
  run('git', ['fetch', 'origin', 'main']);
  const counts = run('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
  const [behind, ahead] = counts.ok
    ? counts.stdout.split(/\s+/).map((n) => Number(n) || 0)
    : [0, 0];
  const tagCheck = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`]);
  const gh = publishing ? run('gh', ['api', 'user', '--jq', '.login']) : { ok: false, stdout: '' };

  return {
    clean: status.ok && status.stdout === '',
    branch: branch.ok ? branch.stdout : '(unknown)',
    ahead,
    behind,
    tag,
    tagExists: tagCheck.ok,
    publishTarget: publishTarget(pkg),
    publishing,
    hasToken: Boolean(process.env.GH_TOKEN && process.env.GH_TOKEN.trim()),
    signing: Boolean(process.env.CSC_LINK && process.env.CSC_LINK.trim()),
    ghLogin: gh.ok ? gh.stdout : '',
  };
}

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
}

function writeVersion(version) {
  // Rewrite only the version line, so the file keeps its exact formatting and
  // key order. JSON.stringify of a re-parsed package.json would reformat it and
  // bury the one-line change in a whole-file diff.
  const text = fs.readFileSync(PKG_PATH, 'utf8');
  const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (next === text) throw new Error('could not find the version field in package.json');
  fs.writeFileSync(PKG_PATH, next, 'utf8');
}

function main(argv) {
  const args = argv.filter((a) => a !== '');
  const spec = args.find((a) => !a.startsWith('--'));
  const confirmed = args.includes('--yes');
  const publishing = !args.includes('--no-publish');
  // --ci: the tag push is the release. Builds locally as a smoke test but does not
  // upload; .github/workflows/release.yml publishes from the tag with the
  // repository-scoped GITHUB_TOKEN. This is the route that needs no personal token.
  const ci = args.includes('--ci');

  if (!spec) {
    console.error('usage: node scripts/release.js <patch|minor|major|x.y.z> [--yes] [--no-publish]');
    return 2;
  }

  const pkg = readPkg();
  let version;
  try {
    version = bumpVersion(pkg.version, spec);
  } catch (err) {
    console.error(`release: ${err.message}`);
    return 2;
  }
  const tag = `v${version}`;

  console.log(`release: ${pkg.version} -> ${version}  (tag ${tag}, publish ${publishing ? 'yes' : 'no'})`);

  const facts = gatherFacts(pkg, tag, publishing);
  facts.ci = ci;
  const pre = evaluatePreflight(facts);
  for (const w of pre.warnings) console.log(`  warning: ${w}`);
  for (const b of pre.blockers) console.log(`  BLOCKER: ${b}`);
  if (!pre.ok) {
    console.error('release: preflight failed — nothing has been changed.');
    return 1;
  }

  const steps = releaseSteps(tag, { publishing, ci });

  if (!confirmed) {
    console.log('');
    console.log('Dry run. With --yes this would:');
    console.log(`  1. set version ${version} in package.json`);
    for (const [cmd, cmdArgs] of steps) console.log(`  -  ${cmd} ${cmdArgs.join(' ')}`);
    console.log('');
    console.log('Re-run with --yes to cut the release.');
    return 0;
  }

  writeVersion(version);
  // Must exist on disk before the electron-builder step runs (it is one of the
  // `steps` below) — that is the only point at which anything reads it, via
  // app-builder-lib's getReleaseInfo() resolving build/release-notes.md.
  buildReleaseNotes.main([]);
  for (const [cmd, cmdArgs, recovery] of steps) {
    console.log(`+ ${cmd} ${cmdArgs.join(' ')}`);
    const res = run(cmd, cmdArgs, { stdio: 'inherit' });
    if (!res.ok) {
      // Stop at the first failure, say exactly where, and print that step's own
      // recovery (see releaseSteps). Print the spawn error when there is one.
      // Without it a step that never started is indistinguishable from one that
      // ran and failed — the exact ambiguity that made two releases look like
      // mystery kills.
      console.error(`release: "${cmd} ${cmdArgs.join(' ')}" failed (exit ${res.status}).`
        + (res.error ? ` The process did not start: ${res.error}` : '')
        + ' Stopped at that step — nothing after it ran.');
      if (res.stderr) console.error(res.stderr.slice(-2000));
      console.error(`release: recovery — ${recovery}`);
      return 1;
    }
  }

  console.log('');
  console.log(`release: ${tag} is published. An installed older build reports "update available — ${version}" on its next launch.`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { bumpVersion, isNewer, publishTarget, releaseSteps, evaluatePreflight, main };
