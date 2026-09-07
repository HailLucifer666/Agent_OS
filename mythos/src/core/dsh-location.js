'use strict';

// BUG-402: installation and runtime resolve the same ordered homes. Resolve
// environment at call time so setup changes do not leave a cached reader stale.
// This module has no CLI, logging, environment loading, or process side effects.
const path = require('node:path');
const fs = require('node:fs');
const MYTHOS_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');

const DIR_NAME = 'DeepSeek Harness';

const REPO_DSH_HOME = path.join(REPO_ROOT, DIR_NAME);

function toolsDshHome(env) {
  const e = env || process.env;
  if (!e.MYTHOS_TOOLS_DIR) return null;
  return path.join(path.resolve(e.MYTHOS_TOOLS_DIR), DIR_NAME);
}

// A WRITE goes to userData/tools when Electron told us where that is, else the
// repo root. MYTHOS_DSH_INSTALL_DIR overrides both — the documented escape hatch.
function resolveDshHome(env) {
  const e = env || process.env;
  if (e.MYTHOS_DSH_INSTALL_DIR) return path.resolve(e.MYTHOS_DSH_INSTALL_DIR);
  return toolsDshHome(e) || REPO_DSH_HOME;
}

// Every home a READ should consider, most-preferred first, de-duplicated. The
// repo root stays in the list forever: a dev checkout has dsh there and must not
// be told to reinstall it. mythos/node_modules is included last so a contributor
// who installed dsh as an ordinary dependency is not told it is missing.
function dshSearchHomes(env) {
  const e = env || process.env;
  const homes = [];
  if (e.MYTHOS_DSH_INSTALL_DIR) homes.push(path.resolve(e.MYTHOS_DSH_INSTALL_DIR));
  const tools = toolsDshHome(e);
  if (tools) homes.push(tools);
  homes.push(REPO_DSH_HOME);
  homes.push(MYTHOS_DIR);
  return homes.filter((h, i) => homes.indexOf(h) === i);
}

function packageDirFor(home) {
  return path.join(home, 'node_modules', '@deepseek-ai', 'dsh');
}


// Read the installed package's own metadata rather than guessing a file name:
// `bin` is a string on some packages and a map on others, and dsh's own
// reference is the only authority on which.
function readInstalled(home) {
  const pkgDir = packageDirFor(home);
  const pkgJson = path.join(pkgDir, 'package.json');
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8')); } catch (err) {
    // Missing is recoverable by a lower-priority home; corruption/permissions
    // are not absence. Both setup and builds must report the same broken home.
    if (err.code === 'ENOENT') return null;
    return { home, pkgDir, entry: null, reason: 'cannot read package metadata (' + (err.code || 'invalid JSON') + ')' };
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { home, pkgDir, entry: null, reason: 'package metadata must be an object' };
  }
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : (bin && (bin.dsh || bin[Object.keys(bin)[0]]));
  if (!rel || typeof rel !== 'string') return { home, pkgDir, version: pkg.version, entry: null, reason: 'package declares no bin entry' };
  const entry = path.join(pkgDir, rel);
  try {
    if (!fs.statSync(entry).isFile()) throw new Error('not a file');
  } catch (err) {
    return { home, pkgDir, version: pkg.version, entry: null, reason: 'bin points at ' + rel + ', which is not a readable file (' + (err.code || err.message) + ')' };
  }
  return { home, pkgDir, version: pkg.version, entry, reason: null };
}

function findInstalled(env, homes) {
  for (const home of (homes || dshSearchHomes(env))) {
    const found = readInstalled(home);
    if (found) return found;
  }
  return null;
}

module.exports = { REPO_DSH_HOME, resolveDshHome, dshSearchHomes, packageDirFor, readInstalled, findInstalled };
