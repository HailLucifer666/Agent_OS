'use strict';

// scripts/build-release-notes.js — put something real in the built latest.yml.
//
// GitHub release bodies in this pipeline have always been structurally empty:
// electron-publish's createRelease() sends no `body` field, so there has never
// been a release note anywhere — not on GitHub, not in latest.yml, not in the
// install-consent dialog that now reads UpdateInfo.releaseNotes.
//
// app-builder-lib's getReleaseInfo (node_modules/app-builder-lib/out/publish/
// updateInfoBuilder.js) resolves, in order:
//   release-notes-<buildConfigurationKey>.md -> release-notes-<platform.name>.md
//   -> release-notes-<platform.nodeName>.md -> release-notes.md
// from `buildResourcesDir` (package.json has no directories.buildResources, so
// that defaults to "build") and embeds the contents into the built latest.yml
// as its `releaseNotes` field. GitHubProvider prefers that over its Atom-feed
// fallback. So the file this script writes — build/release-notes.md — is read
// by electron-builder at build time and never touched by hand.
//
// Usage:
//   node scripts/build-release-notes.js            derive the previous tag
//   node scripts/build-release-notes.js v0.1.9      use this as the previous tag

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const OUT_PATH = path.join(REPO_ROOT, 'build', 'release-notes.md');
const MAX_LENGTH = 4000;

// ---- pure helpers (unit-tested; see mythos/test/build-release-notes.test.js) --

// parseVersion('v1.2.3') -> [1,2,3]   parseVersion('1.2.3') -> [1,2,3]
// parseVersion('not-a-version') -> null
function parseVersion(tagOrVersion) {
  const s = String(tagOrVersion || '').trim();
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// compareVersions([1,2,3],[1,2,4]) -> negative   equal -> 0   greater -> positive
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// pickPreviousTag(['v0.1.9','v0.1.8','wip-x'], '0.1.10') -> 'v0.1.9'
// Picks the highest-semver tag strictly below currentVersion, ignoring tags
// that are not x.y.z (or v x.y.z) so a stray branch-name tag like
// "wip-local-widgets-2026-08-03" is never mistaken for a release.
function pickPreviousTag(tags, currentVersion) {
  const cur = parseVersion(currentVersion);
  if (!cur) return null;
  const candidates = (tags || [])
    .map((tag) => ({ tag, v: parseVersion(tag) }))
    .filter((c) => c.v && compareVersions(c.v, cur) < 0);
  candidates.sort((a, b) => compareVersions(b.v, a.v));
  return candidates.length ? candidates[0].tag : null;
}

// buildReleaseNotesBody('0.1.10', ['- fix: x', '- feat: y']) ->
//   '## MYTHOS 0.1.10\n\n- fix: x\n- feat: y'
// No previous tag / no commits both fall back to an honest one-liner rather
// than an empty body, since an empty releaseNotes field is the exact defect
// this script exists to fix.
function buildReleaseNotesBody(version, commitLines) {
  const header = `## MYTHOS ${version}`;
  const lines = (commitLines || []).filter((l) => l.trim() !== '');
  const body = lines.length ? lines.join('\n') : '- no commit-log entries found for this release';
  return `${header}\n\n${body}`;
}

// capLength('a'.repeat(5000), 4000) -> 4000-char string ending in a truncation
// note, cut at a line boundary so it never leaves a half-written commit line.
function capLength(text, max) {
  const limit = max || MAX_LENGTH;
  if (text.length <= limit) return text;
  const suffix = '\n\n…(truncated)';
  const budget = limit - suffix.length;
  let cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  // A slice can end on a lone UTF-16 high surrogate (its low-surrogate partner
  // fell just past the cut) — drop it rather than write an invalid character.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}${suffix}`;
}

// ---- shelling out -----------------------------------------------------------

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, Object.assign({ cwd: REPO_ROOT, encoding: 'utf8' }, opts || {}));
  return {
    ok: res.status === 0 && !res.error,
    status: res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || res.error || '').trim(),
  };
}

// A failed git command (spawn error or non-zero exit) must not look like a
// genuinely empty result — that is how a broken git in CI ships placeholder
// notes that look fine. Only a successful call with no output degrades to [].
function listTags() {
  const res = run('git', ['tag']);
  if (!res.ok) throw new Error(`git tag failed: ${res.stderr || 'unknown error'}`);
  return res.stdout ? res.stdout.split(/\r?\n/).filter(Boolean) : [];
}

// collectCommitLog(prevTag) -> ['- subject one', '- subject two']
// prevTag === null means "no prior release found" — logs the full history
// reachable from HEAD rather than nothing.
function collectCommitLog(prevTag) {
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const res = run('git', ['log', '--pretty=- %s', range]);
  if (!res.ok) throw new Error(`git log ${range} failed: ${res.stderr || 'unknown error'}`);
  return res.stdout ? res.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function readVersion() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version;
}

function writeReleaseNotes(body, outPath) {
  const dest = outPath || OUT_PATH;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body, 'utf8');
}

// outPath defaults to the real build/release-notes.md that scripts/release.js
// and the CI step both expect — tests must pass their own (os.tmpdir()-based)
// path instead of touching that real, gitignored file.
function main(argv, outPath) {
  const dest = outPath || OUT_PATH;
  const version = readVersion();
  const prevTagArg = (argv || []).find((a) => !a.startsWith('--'));
  const prevTag = prevTagArg || pickPreviousTag(listTags(), version);

  const commitLines = collectCommitLog(prevTag);
  const body = capLength(buildReleaseNotesBody(version, commitLines), MAX_LENGTH);

  writeReleaseNotes(body, dest);
  console.log(`build-release-notes: wrote ${dest} (previous tag: ${prevTag || '(none found)'}, ${commitLines.length} commit(s))`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  parseVersion,
  compareVersions,
  pickPreviousTag,
  buildReleaseNotesBody,
  capLength,
  collectCommitLog,
  readVersion,
  writeReleaseNotes,
  main,
  OUT_PATH,
  MAX_LENGTH,
};
