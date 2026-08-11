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

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, Object.assign({ cwd: REPO_ROOT, encoding: 'utf8' }, opts || {}));
  return {
    ok: res.status === 0,
    status: res.status,
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

  const steps = [
    ['git', ['add', 'package.json']],
    ['git', ['commit', '-m', `chore(release): ${tag}`]],
    ['git', ['tag', '-a', tag, '-m', `MYTHOS ${tag}`]],
    ['npx', ['electron-builder', '--win', ...(publishing && !ci ? ['--publish', 'always'] : [])]],
    ['git', ['push', 'origin', 'main']],
    ['git', ['push', 'origin', tag]],
  ];

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
  for (const [cmd, cmdArgs] of steps) {
    console.log(`+ ${cmd} ${cmdArgs.join(' ')}`);
    const res = run(cmd, cmdArgs, { stdio: 'inherit' });
    if (!res.ok) {
      // Stop at the first failure and say exactly where, because the recovery
      // differs per step: before the tag, `git reset`; after the build, re-run
      // with --publish; after the push, nothing to undo.
      console.error(`release: "${cmd} ${cmdArgs.join(' ')}" failed (exit ${res.status}). Stopped at that step — nothing after it ran.`);
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

module.exports = { bumpVersion, isNewer, publishTarget, evaluatePreflight, main };
