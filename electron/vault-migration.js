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

// ---- sibling userData adoption (installer parity, 2026-08-11) ------------------
//
// app.setName('MYTHOS') (electron/main.js) collapses what used to be three
// separate userData directories onto one. It does NOT move the data that is
// already in the other two, and on the operator's machine that data is the
// entire difference between the two runs:
//
//   %APPDATA%\Electron  the dev run — Identity/boundaries.md, operator-profile,
//                       operator-style, Contacts/contacts.json, 8 learned Skills
//   %APPDATA%\agent-os  the installed .exe — a second, near-empty brain
//   %APPDATA%\MYTHOS    the new canonical name (and where the NSIS installer
//                       already wrote install-selection.json)
//
// A missing Identity/boundaries.md is not cosmetic: identity/index.js clamps the
// autonomy ceiling to Tier 1 when it cannot read that file, which is why the
// installed build asked for approval on every Tier-2 tool while dev never did.
//
// "Richest" = most files, ties broken by bytes. Crude on purpose — it only has
// to separate a real months-old vault from an empty or one-session one, and a
// heuristic that can be read off two integers is one the operator can check in
// the log. EVERY decision is logged, including the candidates NOT chosen.
function rankVaultCandidates(candidates, statsOf = dirStats) {
  const scored = [];
  for (const dir of candidates) {
    if (!isNonEmptyDir(dir)) { scored.push({ dir, present: false, files: 0, bytes: 0 }); continue; }
    try {
      const s = statsOf(dir);
      scored.push({ dir, present: true, files: s.files, bytes: s.bytes });
    } catch (err) {
      scored.push({ dir, present: false, files: 0, bytes: 0, error: err.message });
    }
  }
  const usable = scored.filter((c) => c.present && c.files > 0);
  usable.sort((a, b) => (b.files - a.files) || (b.bytes - a.bytes));
  return { ranked: scored, winner: usable[0] || null };
}

// adoptSiblingVault({dest, siblingDirs, markerPath, log}) -> {status, from?, ...}
//
//   'already-done'   marker present — never runs twice.
//   'dest-non-empty' this install already has its own vault; nothing to adopt.
//   'no-candidate'   no sibling vault has anything in it (a genuinely new machine).
//   'adopted'        copied + verified from the richest sibling.
//   'failed'         copy/verify failed; the marker is NOT written, so the next
//                    boot retries, and the source is untouched either way.
function adoptSiblingVault({ dest, siblingDirs = [], markerPath, log = () => {} }) {
  if (fs.existsSync(markerPath)) return { status: 'already-done' };

  if (isNonEmptyDir(dest)) {
    writeMarker(markerPath, { status: 'dest-non-empty', at: new Date().toISOString() }, log);
    return { status: 'dest-non-empty' };
  }

  const { ranked, winner } = rankVaultCandidates(siblingDirs);
  for (const c of ranked) {
    log(`vault-adopt: candidate ${c.dir} — ${c.present ? `${c.files} files/${c.bytes}B` : 'absent or empty'}`
      + `${c.error ? ` (${c.error})` : ''}${winner && c.dir === winner.dir ? '  <-- richest, adopting' : ''}`);
  }

  if (!winner) {
    log('vault-adopt: no sibling vault found — this is a fresh brain.');
    writeMarker(markerPath, { status: 'no-candidate', candidates: siblingDirs, at: new Date().toISOString() }, log);
    return { status: 'no-candidate' };
  }

  const result = copyAndVerify(winner.dir, dest);
  if (!result.ok) {
    log(`vault-adopt: FAILED — ${result.error} — ${winner.dir} left untouched`);
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
    return { status: 'failed', error: result.error, from: winner.dir };
  }

  log(`vault-adopt: OK — adopted ${winner.dir} -> ${dest} (${winner.files} files; source left in place)`);
  writeMarker(markerPath, {
    status: 'adopted', from: winner.dir, to: dest, files: winner.files, bytes: winner.bytes,
    candidates: ranked.map(({ dir, present, files, bytes }) => ({ dir, present, files, bytes })),
    at: new Date().toISOString(),
  }, log);
  return { status: 'adopted', from: winner.dir, files: winner.files };
}

// Resolve MYTHOS_VAULT_ROOT for the forked server child.
//
// Explicit env ALWAYS wins and skips migration entirely — the operator's own
// .env, or render.yaml's MYTHOS_VAULT_ROOT=/data/vault, is a deliberate
// choice this module must never second-guess.
//
// Order matters. The install-tree vault (oldVaultDir) is checked FIRST because
// that migration predates this one and its marker may already be written; a
// sibling userData vault is only adopted when the canonical vault is still
// empty afterwards. Both are one-time and both refuse to overwrite.
function resolveVaultRoot({ explicitEnv, oldVaultDir, userDataDir, siblingUserDataNames = [], log = () => {} }) {
  if (explicitEnv) return explicitEnv;
  const dest = path.join(userDataDir, 'vault');
  const markerPath = path.join(userDataDir, 'vault-migration.json');
  migrateVault({ src: oldVaultDir, dest, markerPath, log });

  if (siblingUserDataNames.length) {
    // Siblings live beside this app's own userData directory — %APPDATA%\<name> —
    // so derive them from userDataDir's parent rather than reading APPDATA.
    // That keeps the module free of platform assumptions and testable with a
    // plain tmpdir, like the rest of this file.
    const parent = path.dirname(userDataDir);
    const siblingDirs = siblingUserDataNames
      .map((name) => path.join(parent, name, 'vault'))
      .filter((dir) => path.resolve(dir) !== path.resolve(dest));
    adoptSiblingVault({
      dest,
      siblingDirs,
      // Its OWN marker. Sharing vault-migration.json would mean the install-tree
      // migration's "no-source" marker (written on every fresh install) also
      // suppressed sibling adoption forever — which is precisely the case this
      // exists for.
      markerPath: path.join(userDataDir, 'vault-adopt.json'),
      log,
    });
  }
  return dest;
}

module.exports = {
  migrateVault,
  resolveVaultRoot,
  adoptSiblingVault,
  rankVaultCandidates,
  isNonEmptyDir,
  dirStats,
  copyAndVerify,
};
