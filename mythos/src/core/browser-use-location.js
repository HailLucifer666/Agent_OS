'use strict';
// browser-use-location.js — where the browser-use runner's Python environment lives, and
// how to tell whether the PINNED version is installed there, without spawning anything.
//
// Mirrors dsh-location.js on purpose (same vendor-root rule, same env override shape):
//   MYTHOS_BROWSER_USE_INSTALL_DIR  explicit home
//   MYTHOS_TOOLS_DIR/browser-use    packaged app (the tools dir the installer owns)
//   <repo>/browser-use              dev checkout (gitignored, like /DeepSeek Harness/)
//
// The version is PINNED and asserted from the installed dist-info, not from a `--version`
// call: browser-use is a fast-moving library whose constructor signatures changed between
// minor versions during the 2026-09-08 spike, so a floating install would turn a contract
// change into a mystery failure inside a spoken turn.

const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(MYTHOS_DIR, '..');
const DIR_NAME = 'browser-use';
const REPO_HOME = path.join(REPO_ROOT, DIR_NAME);
const BROWSER_USE_PINNED_VERSION = '0.13.10';
const PYTHON_SERIES = '3.11';

function resolveBrowserUseHome(env) {
  const e = env || process.env;
  if (e.MYTHOS_BROWSER_USE_INSTALL_DIR) return path.resolve(e.MYTHOS_BROWSER_USE_INSTALL_DIR);
  if (e.MYTHOS_TOOLS_DIR) return path.join(path.resolve(e.MYTHOS_TOOLS_DIR), DIR_NAME);
  return REPO_HOME;
}

function venvDir(home) { return path.join(home, '.venv'); }

function pythonPath(home, platform = process.platform) {
  return platform === 'win32' ? path.join(venvDir(home), 'Scripts', 'python.exe') : path.join(venvDir(home), 'bin', 'python');
}

// Version from the dist-info directory name. Windows venvs keep site-packages under
// Lib/; POSIX under lib/python3.x/. Both are searched so the check is platform-neutral.
function installedVersion(home) {
  const roots = [path.join(venvDir(home), 'Lib', 'site-packages')];
  const lib = path.join(venvDir(home), 'lib');
  try { for (const d of fs.readdirSync(lib)) if (d.startsWith('python')) roots.push(path.join(lib, d, 'site-packages')); } catch { /* not posix */ }
  for (const root of roots) {
    let entries; try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const m = /^browser_use-(.+)\.dist-info$/.exec(name);
      if (m) return m[1];
    }
  }
  return null;
}

// { ok, home, python, version, reason } — ok only when the pinned version is present AND
// the venv's python exists. Anything else names exactly what is missing.
function findInstalled(env) {
  const home = resolveBrowserUseHome(env);
  const python = pythonPath(home);
  const version = installedVersion(home);
  if (!fs.existsSync(python)) return { ok: false, home, python, version, reason: 'browser-use is not installed (no Python environment at ' + venvDir(home) + '). Run: node mythos/scripts/setup-browser-use.js --install' };
  if (!version) return { ok: false, home, python, version, reason: 'browser-use is not installed in ' + venvDir(home) + '. Run: node mythos/scripts/setup-browser-use.js --install' };
  if (version !== BROWSER_USE_PINNED_VERSION) return { ok: false, home, python, version, reason: 'browser-use ' + version + ' is installed but ' + BROWSER_USE_PINNED_VERSION + ' is pinned. Run: node mythos/scripts/setup-browser-use.js --install' };
  return { ok: true, home, python, version, reason: null };
}

// For the Live capability snapshot (server/index.js): ONLINE when the pinned runner is
// installed. A filesystem read per Live session open, no spawn.
function statusAdapter() { return { getStatus: () => ({ state: findInstalled().ok ? 'ONLINE' : 'OFFLINE' }) }; }

module.exports = { statusAdapter, BROWSER_USE_PINNED_VERSION, PYTHON_SERIES, REPO_HOME, resolveBrowserUseHome, venvDir, pythonPath, installedVersion, findInstalled };
