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
var { execSync } = require('child_process');

var PKG_PATH = path.join(__dirname, '..', '..', '..', 'package.json');

function readPackageVersion() {
  try {
    var pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    return pkg.version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// Run a git command, return trimmed stdout or null on any failure.
// stdio piped so failures never leak to the console.
function git(args) {
  try {
    return String(execSync('git ' + args, {
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
  var described = git('describe --tags --always --dirty 2>nul');
  if (described) return described;
  var hash = git('rev-parse --short HEAD');
  return hash || 'unknown';
}

function captureRecentChanges(maxCommits) {
  var log = git('log --oneline -' + (maxCommits || 15));
  if (!log) return [];
  return log.split('\n').filter(Boolean);
}

var cached = null;

function getVersion() {
  if (cached) return cached;
  cached = {
    version: readPackageVersion(),
    gitRef: captureGitRef(),
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
