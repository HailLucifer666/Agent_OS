'use strict';

// electron/vault-migration.js — audit finding B3.
//
// MYTHOS_VAULT_ROOT defaults to './vault' (mythos/src/core/config/schema.js)
// and electron/main.js pins the forked server's cwd to mythos/ so that
// resolves to <install_dir>/mythos/vault — inside the install tree, and
// silently empty whenever anything (a different launcher, a portable build,
// a scheduled task, a debugger config) forks the server with a different
// cwd. This already happened in production (see
// mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md's "factory-reset MYTHOS" entry,
// tracked open at ROADMAP.md D-05): a fork without a pinned cwd opened
// <repo>/vault (empty) instead of the real vault, and it reported healthy.
//
// keys.json, the server log and the adblock cache in electron/main.js all
// already live under app.getPath('userData') — the one OS-managed,
// survives-reinstall location. This module resolves the vault the same way
// for the Electron/packaged path, with a ONE-TIME migration that copies
// (never moves) any existing install-tree vault across.
//
// No `require('electron')` anywhere in this file — pure fs/path — so unlike
// electron/main.js it is require()-able and unit-testable under a bare
// `node --test`, the same testability split cursor-overlay-window.js and
// media-window.js already use for main.js's Electron-only pieces.

const fs = require('node:fs');
const path = require('node:path');

function isNonEmptyDir(dir) {
  try { return fs.existsSync(dir) && fs.readdirSync(dir).length > 0; }
  catch { return false; }
}

// File count + total bytes, recursive. Cheap and enough to catch a partial
// or truncated copy without hashing every byte.
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { files += 1; bytes += fs.statSync(full).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

// COPY only — fs.cpSync never touches src. Verifies by comparing file
// count + total bytes between source and destination before declaring
// success.
function copyAndVerify(src, dest) {
  try {
    fs.cpSync(src, dest, { recursive: true, errorOnExist: false });
  } catch (err) {
    return { ok: false, error: `copy failed: ${err.message}` };
  }
  try {
    const s = dirStats(src);
    const d = dirStats(dest);
    if (s.files !== d.files || s.bytes !== d.bytes) {
      return { ok: false, error: `verify mismatch: source ${s.files} files/${s.bytes}B, dest ${d.files} files/${d.bytes}B` };
    }
  } catch (err) {
    return { ok: false, error: `verify failed: ${err.message}` };
  }
  return { ok: true };
}

function writeMarker(markerPath, data, log) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    log(`vault-migration: failed to write marker (will re-check next boot): ${err.message}`);
  }
}

// migrateVault({ src, dest, markerPath, log }) -> { status, error? }
//
//   'already-done'    marker exists — never re-runs once complete.
//   'no-source'       nothing at src to migrate (fresh install); marks done.
//   'dest-non-empty'  dest already has data — a second install, not a
//                      migration; refuses to merge/overwrite; marks done.
//   'migrated'        copied + verified.
//   'failed'          copy or verify failed; source is untouched, the
//                      partial destination (if any) is removed, and the
//                      marker is deliberately NOT written so the next boot
//                      retries. Logged loudly via the injected `log`.
function migrateVault({ src, dest, markerPath, log = () => {} }) {
  if (fs.existsSync(markerPath)) return { status: 'already-done' };

  if (!isNonEmptyDir(src)) {
    writeMarker(markerPath, { status: 'no-source', at: new Date().toISOString() }, log);
    return { status: 'no-source' };
  }

  if (isNonEmptyDir(dest)) {
    log(`vault-migration: SKIPPED — destination already has data, refusing to overwrite: ${dest}`);
    writeMarker(markerPath, { status: 'dest-non-empty', at: new Date().toISOString() }, log);
    return { status: 'dest-non-empty' };
  }

  const result = copyAndVerify(src, dest);
  if (!result.ok) {
    log(`vault-migration: FAILED — ${result.error} — old vault left untouched at ${src}`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
    return { status: 'failed', error: result.error };
  }

  log(`vault-migration: OK — copied ${src} -> ${dest} (old vault left in place, not deleted)`);
  writeMarker(markerPath, { status: 'migrated', from: src, to: dest, at: new Date().toISOString() }, log);
  return { status: 'migrated' };
}

// Resolve MYTHOS_VAULT_ROOT for the forked server child.
//
// Explicit env ALWAYS wins and skips migration entirely — the operator's own
// .env, or render.yaml's MYTHOS_VAULT_ROOT=/data/vault, is a deliberate
// choice this module must never second-guess.
function resolveVaultRoot({ explicitEnv, oldVaultDir, userDataDir, log = () => {} }) {
  if (explicitEnv) return explicitEnv;
  const dest = path.join(userDataDir, 'vault');
  const markerPath = path.join(userDataDir, 'vault-migration.json');
  migrateVault({ src: oldVaultDir, dest, markerPath, log });
  return dest;
}

module.exports = { migrateVault, resolveVaultRoot, isNonEmptyDir, dirStats, copyAndVerify };
