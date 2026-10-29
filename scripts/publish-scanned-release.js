'use strict';

// scripts/publish-scanned-release.js — upload EXACTLY the artifacts the package
// scan passed, and prove GitHub now holds those bytes.
//
// Why this is not `electron-builder --publish always` (2026-09-29 audit, B1):
//   1. That builds and uploads in one step, so nothing can inspect the installer
//      between the two. The 2026-09-23 local build carried four .env backups;
//      the only thing that would have stopped them reaching a release is a scan
//      of the finished artifact, and a combined step leaves no gap to put it in.
//   2. `electron-builder publish --files …` (upload-only) is not a substitute:
//      its publishPackageWithTasks() catches every upload error, logs it, and
//      RETURNS NORMALLY, so the process exits 0 on a failed upload
//      (node_modules/electron-builder/out/publish.js, 26.15.3; re-verified 26.18.0). It also names
//      each asset after the file on disk, "MYTHOS Setup x.exe" — GitHub stores
//      that as "MYTHOS.Setup.x.exe", and latest.yml tells the updater to fetch
//      "MYTHOS-Setup-x.exe", so every update download would 404.
// So: `gh`, which exits non-zero on failure, with names taken from latest.yml,
// followed by a read-back of GitHub's own sha256 digest for every asset.
//
// Order of checks, each before anything outward-facing:
//   receipt exists, is clean, is for this version (written by
//     mythos/scripts/verify-package-contents.js --receipt, only on a clean scan)
//   every artifact on disk still hashes to what the scan saw   <- scan-to-upload swap
//   every staged upload copy hashes to it too                  <- the bytes that leave
//   the release does not already exist as a draft
//   an existing published release holds none of these names with other bytes
// then upload what is missing, then read back: every asset present, right size,
// digest equal.
//
// Usage: node scripts/publish-scanned-release.js <tag>
//   GH_TOKEN must belong to an account that can write the publish target; gh's
//   stored login is not consulted when GH_TOKEN is set.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist');
const RECEIPT = path.join(DIST, 'package-scan.json');
const NOTES = path.join(REPO_ROOT, 'build', 'release-notes.md');
const { sha256File } = require(path.join(REPO_ROOT, 'mythos', 'scripts', 'verify-package-contents.js'));
const { publishTarget } = require('./release.js');

// ---- pure checks (unit-tested; see mythos/test/publish-scanned-release.test.js) ----

function versionOf(tag) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
  if (!m) throw new Error(`tag must look like v1.2.3, got "${tag}"`);
  return m[1];
}

// Returns a list of reasons the receipt cannot vouch for this upload; empty = ok.
function receiptProblems(receipt, version) {
  if (!receipt || typeof receipt !== 'object') return ['no scan receipt — run verify-package-contents.js --dist dist --receipt dist/package-scan.json'];
  const out = [];
  if (receipt.schema !== 1) out.push(`receipt schema ${receipt.schema} is not 1`);
  if (receipt.status !== 'clean') out.push(`receipt status is "${receipt.status}", not clean`);
  if (receipt.version !== version) out.push(`receipt is for ${receipt.version}, this release is ${version}`);
  const names = Array.isArray(receipt.artifacts) ? receipt.artifacts.map((a) => a && a.name) : [];
  if (!names.includes('latest.yml') || !names.some((n) => /\.exe$/.test(n)) || !names.some((n) => /\.exe\.blockmap$/.test(n))) {
    out.push('receipt must list the installer, its .blockmap and latest.yml');
  }
  for (const a of receipt.artifacts || []) {
    if (!a || !/^[0-9a-f]{64}$/.test(String(a.sha256)) || !Number.isInteger(a.size) || !a.file || !a.name) {
      out.push(`receipt artifact entry is malformed: ${JSON.stringify(a)}`);
    }
    if (a && (String(a.name).includes('/') || String(a.name).includes('\\') || String(a.file).includes('/') || String(a.file).includes('\\'))) {
      out.push(`receipt artifact names a path, not a file: ${JSON.stringify(a)}`);
    }
  }
  return out;
}

// `observed` maps artifact name -> { sha256, size } measured now.
function hashProblems(receipt, observed, where) {
  const out = [];
  for (const a of receipt.artifacts) {
    const seen = observed[a.name];
    if (!seen) out.push(`${where}: ${a.name} is missing`);
    else if (seen.sha256 !== a.sha256 || seen.size !== a.size) {
      out.push(`${where}: ${a.name} changed after the scan (sha256 ${seen.sha256.slice(0, 12)}… vs scanned ${a.sha256.slice(0, 12)}…)`);
    }
  }
  return out;
}

// GitHub's release JSON -> reasons it does not hold exactly the scanned bytes.
function remoteProblems(receipt, release) {
  if (!release) return ['the release was not found after upload'];
  const out = [];
  if (release.draft) out.push('the release is a DRAFT — electron-updater cannot see it');
  const assets = new Map((release.assets || []).map((a) => [a.name, a]));
  for (const a of receipt.artifacts) {
    const remote = assets.get(a.name);
    if (!remote) { out.push(`${a.name} is not on the release`); continue; }
    if (remote.size !== a.size) out.push(`${a.name}: GitHub holds ${remote.size} bytes, the scan saw ${a.size}`);
    if (!remote.digest) out.push(`${a.name}: GitHub reported no digest, so the upload cannot be proven`);
    else if (remote.digest !== `sha256:${a.sha256}`) out.push(`${a.name}: GitHub's digest ${remote.digest} is not the scanned sha256:${a.sha256}`);
  }
  return out;
}

// A PUBLISHED RELEASE IS NEVER ALTERED IN PLACE (independent review, 2026-09-29).
// electron-builder refused to upload onto a release published more than two
// hours earlier (electron-publish/out/gitHubPublisher.js:86-96). The first draft
// of this script used `gh release upload --clobber` and so removed that guard: a
// re-run, or the CI run a tag push starts after a local upload, could swap an
// installer people had already downloaded under the same version number.
// Per scanned file, against the existing release:
//   absent                          -> upload it (finishing a half-done upload)
//   present with the scanned bytes  -> leave it, so a re-run is harmless
//   present with other bytes, or with no digest to compare -> refuse all of it
// Changing a published file means a new version, never a re-upload.
function existingPlan(receipt, release) {
  const assets = new Map((release.assets || []).map((a) => [a.name, a]));
  const missing = [];
  const conflicts = [];
  for (const a of receipt.artifacts) {
    const remote = assets.get(a.name);
    if (!remote) missing.push(a.name);
    else if (!remote.digest) conflicts.push(`${a.name} is already on the release and GitHub reports no digest for it, so it cannot be shown to be the scanned file`);
    else if (remote.digest !== `sha256:${a.sha256}` || remote.size !== a.size) {
      conflicts.push(`${a.name} is already published with different bytes (${remote.digest}, ${remote.size} bytes; the scan saw sha256:${a.sha256.slice(0, 12)}…, ${a.size} bytes)`);
    }
  }
  return { missing, conflicts };
}

// ---- shelling out -------------------------------------------------------------

function realGh(args) {
  const res = spawnSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return {
    ok: res.status === 0,
    status: res.status,
    error: res.error ? `${res.error.code || 'spawn failed'}: ${res.error.message}` : null,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '').trim(),
  };
}

// Listing every release and picking by tag avoids telling "not found" apart from
// every other failure by matching an error string.
function findRelease(gh, repo, tag) {
  const res = gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]);
  if (!res.ok) throw new Error(`could not list releases for ${repo}: ${res.error || res.stderr}`);
  const pages = JSON.parse(res.stdout);
  return pages.flat().find((r) => r.tag_name === tag) || null;
}

function measure(files) {
  const out = {};
  for (const [name, file] of Object.entries(files)) {
    if (fs.existsSync(file)) out[name] = { sha256: sha256File(file), size: fs.statSync(file).size };
  }
  return out;
}

function fail(log, lines) {
  for (const l of lines) log(`  BLOCKER: ${l}`);
  log('publish-scanned-release: nothing was uploaded.');
  return 1;
}

function stage(receipt, version, distDir) {
  const stageDir = path.join(distDir, `upload-${version}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const staged = {};
  for (const a of receipt.artifacts) {
    staged[a.name] = path.join(stageDir, a.name);
    fs.copyFileSync(path.join(distDir, a.file), staged[a.name]);
  }
  return staged;
}

function main(argv, deps) {
  const d = deps || {};
  const log = d.log || ((l) => console.log(l));
  const gh = d.gh || realGh;
  const distDir = d.distDir || DIST;
  const notesFile = d.notesFile || NOTES;
  let version;
  try { version = versionOf(argv[0]); } catch (err) { log(`publish-scanned-release: ${err.message}`); return 2; }
  const tag = argv[0];
  const target = publishTarget(d.pkg || JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')));
  if (!target) return fail(log, ['package.json build.publish has no github provider']);
  const repo = `${target.owner}/${target.repo}`;

  const receiptFile = path.join(distDir, 'package-scan.json');
  const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
  const bad = receiptProblems(receipt, version);
  if (bad.length) return fail(log, bad);
  if (!fs.existsSync(notesFile)) return fail(log, [`${path.relative(REPO_ROOT, notesFile)} is missing — run scripts/build-release-notes.js`]);

  const onDisk = Object.fromEntries(receipt.artifacts.map((a) => [a.name, path.join(distDir, a.file)]));
  const drift = hashProblems(receipt, measure(onDisk), 'dist');
  if (drift.length) return fail(log, drift);
  const staged = stage(receipt, version, distDir);
  const stagedDrift = hashProblems(receipt, measure(staged), 'staged copy');
  if (stagedDrift.length) return fail(log, stagedDrift);

  let existing;
  try { existing = findRelease(gh, repo, tag); } catch (err) { return fail(log, [err.message]); }
  if (existing && existing.draft) {
    return fail(log, [`${tag} already exists as a DRAFT. Delete it by hand, then re-run. Do not publish it: `
      + 'a half-uploaded draft made public is how 0.1.10 went out with a blockmap and no installer.']);
  }

  let names = receipt.artifacts.map((a) => a.name);
  if (existing) {
    const plan = existingPlan(receipt, existing);
    if (plan.conflicts.length) return fail(log, plan.conflicts.concat(['a published file is never replaced — cut a new version instead']));
    if (!plan.missing.length) {
      log(`publish-scanned-release: ${tag} already holds exactly the ${names.length} scanned artifacts (sha256 verified by GitHub); nothing to upload.`);
      return 0;
    }
    names = plan.missing;
  }

  const files = names.map((n) => staged[n]);
  // No --clobber, ever: if a same-named file appeared since the check above,
  // gh refuses the upload instead of replacing it.
  const upload = existing
    ? ['release', 'upload', tag, ...files, '--repo', repo]
    : ['release', 'create', tag, ...files, '--repo', repo, '--verify-tag', '--title', version, '--notes-file', notesFile];
  log(`+ gh ${upload[0]} ${upload[1]} ${tag} (${files.length} files, ${existing ? 'existing release' : 'new release'})`);
  const up = gh(upload);
  if (!up.ok) return fail(log, [`gh ${upload[1]} failed (exit ${up.status})${up.error ? `: ${up.error}` : ''}${up.stderr ? `: ${up.stderr.slice(-500)}` : ''}`]);

  let after;
  try { after = findRelease(gh, repo, tag); } catch (err) { return fail(log, [`uploaded, but could not read the release back: ${err.message}`]); }
  const remote = remoteProblems(receipt, after);
  if (remote.length) {
    for (const l of remote) log(`  MISMATCH: ${l}`);
    log(`publish-scanned-release: ${tag} was uploaded but does NOT hold the scanned bytes — withdraw it before anyone updates.`);
    return 1;
  }
  log(`publish-scanned-release: ${tag} holds exactly the ${receipt.artifacts.length} scanned artifacts (sha256 verified by GitHub).`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { versionOf, receiptProblems, hashProblems, remoteProblems, existingPlan, findRelease, main, RECEIPT };
