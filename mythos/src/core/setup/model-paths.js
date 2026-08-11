'use strict';

// model-paths.js — where downloadable model weights live, and why that is not
// the install tree.
//
// THE BUG THIS EXISTS FOR (operator, 2026-08-11): the wake word was dead on the
// freshly installed build. The detector itself is fine (the reshapeMelOutput fix
// landed the same day) and deriveWakewordDefaults flips WAKEWORD_ENABLED on as
// soon as the weights are on disk. The failure was DELIVERY:
//
//   - the models live at mythos/ui/public/models/{wakeword,silero}, and
//     package.json build.files EXCLUDES that directory, so the installer ships
//     no weights at all — resources/app.asar.unpacked/mythos/ui/public/models/
//     does not exist on the operator's machine;
//   - the installer's own component page recorded the intent
//     (install-selection.json: wakeword:true, silero:true, adb:true) and then
//     fetched nothing, and the wizard's Components step never completed;
//   - even had it run, the downloaders wrote into the INSTALL TREE, which an
//     update replaces wholesale — so every update would silently un-install the
//     weights and take the wake word with them.
//
// So models get their own OS-managed home, beside keys.json / config.json / the
// vault, for the same three reasons those live there: writable without elevation,
// survives an update, survives a reinstall.
//
// RESOLUTION ORDER for a READ (modelSearchDirs):
//   1. MYTHOS_MODELS_DIR — injected by electron/main.js as <userData>/models
//   2. the install-tree ui/public/models — a dev checkout that ran the
//      downloaders before this change, and anything a distro packages
// Both are searched on every read, so a machine that already downloaded into the
// old location keeps working with no migration step.
//
// A WRITE always goes to (1) when it is known, and falls back to (2) for a bare
// `node scripts/setup-wakeword.js` in a dev checkout with no Electron around.

const fs = require('node:fs');
const path = require('node:path');

// mythos/ui/public/models — the historical location, and still what
// express.static serves at /models/… for a dev checkout.
const INSTALL_TREE_MODELS_DIR = path.join(__dirname, '..', '..', '..', 'ui', 'public', 'models');

// The userData-scoped root, or null when nothing told us where that is.
//
// MYTHOS_SETTINGS_PATH is the fallback source on purpose: electron/main.js
// already injects it as <userData>/config.json, so its directory IS userData.
// Deriving from it means an older main.js that predates MYTHOS_MODELS_DIR still
// puts models in the right place instead of silently reverting to the install
// tree — the exact class of half-wired change this whole effort is about.
function userDataModelsDir(env) {
  const e = env || process.env;
  if (e.MYTHOS_MODELS_DIR) return path.resolve(e.MYTHOS_MODELS_DIR);
  if (e.MYTHOS_SETTINGS_PATH) return path.join(path.dirname(path.resolve(e.MYTHOS_SETTINGS_PATH)), 'models');
  return null;
}

// Every directory a read should consider, most-preferred first, de-duplicated.
function modelSearchDirs(env) {
  const dirs = [];
  const userData = userDataModelsDir(env);
  if (userData) dirs.push(userData);
  dirs.push(INSTALL_TREE_MODELS_DIR);
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

// Where a downloader should write. Prefers userData; falls back to the install
// tree so a dev checkout keeps behaving exactly as it did before.
function modelWriteDir(subdir, env) {
  const userData = userDataModelsDir(env);
  const root = userData || INSTALL_TREE_MODELS_DIR;
  return subdir ? path.join(root, subdir) : root;
}

// resolveModelDir(subdir, env) -> the first search dir that CONTAINS subdir,
// or null. Used by readers that need one concrete directory.
function resolveModelDir(subdir, env) {
  for (const root of modelSearchDirs(env)) {
    const dir = subdir ? path.join(root, subdir) : root;
    try { if (fs.existsSync(dir)) return dir; } catch (_) { /* unreadable → next */ }
  }
  return null;
}

// findModelFile(subdir, filename, env) -> {dir, file, size} | null
// Non-empty is part of the test: a zero-byte file is what a failed download
// leaves behind, and treating it as present is how "installed" became a claim
// rather than a fact.
function findModelFile(subdir, filename, env) {
  for (const root of modelSearchDirs(env)) {
    const file = path.join(root, subdir || '', filename);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) return { dir: path.dirname(file), file, size: st.size };
    } catch (_) { /* absent → next */ }
  }
  return null;
}

module.exports = {
  INSTALL_TREE_MODELS_DIR,
  userDataModelsDir,
  modelSearchDirs,
  modelWriteDir,
  resolveModelDir,
  findModelFile,
};
