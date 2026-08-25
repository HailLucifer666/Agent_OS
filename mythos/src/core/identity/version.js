'use strict';

// identity/version.js — self-awareness of version + git ref + recent changes.
// Reads package.json version at boot, captures git describe/hash, and caches
// the recent git log so every prompt can include a compact SYSTEM CONTEXT
// line without re-running git on each query.
//
// This closes the "no version self-awareness" gap: the model previously had
// no idea what version it was, what had changed recently, or how to answer
// "what's new?". Now brain.think and the voice agent get a one-line context.
//
// All git calls are best-effort: if git is absent or this isn't a repo, we
// degrade gracefully to the package.json version alone (never throw).

var fs = require('fs');
var path = require('path');
var { execFileSync } = require('child_process');

// The APP's package.json (repo root, and the asar root in a packaged build) —
// four levels up from src/core/identity, which is the same depth in both
// layouts. mythos/package.json is the fallback, not the preference: it carries
// its own independent version (0.1.0 for months) while the version the operator
// installs, the installer names, and the auto-updater compares is the root one.
// Reading the inner file made the running app report v0.1.0 on /api/status
// while it was a 0.1.6 install — found 2026-08-12 wiring the HUD badge.
var APP_PKG_PATH = path.join(__dirname, '..', '..', '..', '..', 'package.json');
var PKG_PATH = path.join(__dirname, '..', '..', '..', 'package.json');

function readVersionFrom(file) {
  try {
    var pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pkg.version || null;
  } catch (_) {
    return null;
  }
}

// MYTHOS_APP_VERSION is injected by electron/main.js from app.getVersion(), and
// it wins over both files because in a PACKAGED build neither file is the right
// answer: APP_PKG_PATH resolves to resources/app.asar.unpacked/package.json,
// which does not exist (build.files unpacks only mythos/** and node_modules), so
// the walk fell through to mythos/package.json and a 0.1.7 install reported
// v0.1.0 in the HUD badge (operator, 2026-08-13). The path walk stays as the
// fallback for dev/headless runs, where it resolves to the real repo root.
function readPackageVersion() {
  var injected = process.env.MYTHOS_APP_VERSION;
  if (injected) return injected;
  return readVersionFrom(APP_PKG_PATH) || readVersionFrom(PKG_PATH) || 'unknown';
}

// Run a git command, return trimmed stdout or null on any failure.
// Args are passed as an array through execFileSync (no shell), so nothing here
// can ever be interpreted as shell syntax. stderr is dropped via stdio, which
// is why no redirection is needed in the arg list.
function git(args) {
  try {
    return String(execFileSync('git', args, {
      cwd: path.dirname(PKG_PATH),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true,
    })).trim();
  } catch (_) {
    return null;
  }
}

function captureGitRef() {
  // Prefer annotated tags; fall back to any tag; fall back to short hash.
  var described = git(['describe', '--tags', '--always', '--dirty']);
  if (described) return described;
  var hash = git(['rev-parse', '--short', 'HEAD']);
  if (hash) return hash;
  // H10: a packaged build ships no .git directory, so both git calls above
  // always fail here — this used to return the literal string 'unknown' on
  // every boot, which made server/index.js's upgrade check
  // (`prev.gitRef !== v.gitRef`) permanently false ('unknown' !== 'unknown'
  // is never true). Fall back to the package.json version instead: it's the
  // one build identifier every packaged install actually has, so a version
  // bump between boots still flips this string and the upgrade check fires.
  // Dev checkouts are unaffected — they hit the git paths above first.
  return 'v' + readPackageVersion();
}

function captureRecentChanges(maxCommits) {
  var log = git(['log', '--oneline', '-' + (Number(maxCommits) || 15)]);
  if (!log) return [];
  return log.split('\n').filter(Boolean);
}

var cached = null;

function getVersion() {
  if (cached) return cached;
  cached = {
    version: readPackageVersion(),
    gitRef: captureGitRef(),
    // Set by electron/main.js from the asar's mtime; '' in dev and headless,
    // where gitRef above is already the sharper answer. This is what tells two
    // builds of the same version apart — the exact confusion that cost the
    // operator an evening on 2026-08-12, debugging an install a day older than
    // the fixes it was believed to carry.
    buildTime: process.env.MYTHOS_BUILD_TIME || '',
    // Whether this process is running out of a packaged install at all. Derived
    // from the build stamp rather than guessed, so a dev checkout never claims
    // to be a build.
    packaged: !!process.env.MYTHOS_BUILD_TIME,
    bootDate: new Date().toISOString(),
    recentChanges: captureRecentChanges(15),
  };
  return cached;
}

// ponytail: one-line context string for prompt injection. Caller decides
// whether to use the full object or this compact form.
function contextLine() {
  var v = getVersion();
  var lastCommit = v.recentChanges.length ? v.recentChanges[0] : 'no git history';
  return 'MYTHOS v' + v.version + ' (' + v.gitRef + '). Last change: ' + lastCommit + '.';
}

// Force a refresh (tests / after a pull while running).
function refresh() {
  cached = null;
  return getVersion();
}

module.exports = {
  getVersion: getVersion,
  contextLine: contextLine,
  refresh: refresh,
};
