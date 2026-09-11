'use strict';

// providers/kokoro/migrate-cache.js — move the weights out of node_modules,
// without ever being able to lose them.
//
// WHY THIS IS NEEDED. The Kokoro weights (92,361,116 bytes) live in the default
// cache of the @huggingface/transformers copy nested inside kokoro-js — see
// paths.js for the measurement. That directory belongs to npm: `npm ci`, a
// dependency bump, or a fresh clone deletes it, and the next boot re-downloads
// 92 MB. Moving them to the canonical model dir is the fix.
//
// WHY IT RUNS INSIDE THE WORKER. Copying 92 MB with fs.copyFileSync on the main
// thread is a multi-second event-loop stall — precisely the class of defect
// BUG-436 exists to measure. The caller is worker.js, off the event loop.
//
// THE TWO INVARIANTS, both of which are about NOT LOSING DATA:
//
//   1. A partially-written destination is never visible under its real name.
//      Every file is written to `<dest>.<pid>.<n>.part` in the SAME directory —
//      same volume, so the rename is atomic — fsync'd, then renamed into place.
//      An interrupted run leaves a `.part` file and nothing else; the next run
//      ignores it and starts over. A half-copied 92 MB .onnx that transformers
//      would happily serve as a cache hit is the failure this prevents.
//
//   2. NOTHING IS EVER OVERWRITTEN AND NOTHING IS EVER DELETED. If the
//      destination already exists it is left exactly as it is. A size mismatch
//      is reported as a CONFLICT naming both paths and both sizes — it is not
//      resolved, because this module cannot know which one is right, and
//      guessing means destroying the other. The legacy copy is never removed
//      either: npm will do that in its own time, and until then it is a backup.
//
// CONCURRENCY. Two processes (or two workers) migrating at once is a normal
// state, not an error — the server and a doctor run can overlap. Each writes its
// own pid-scoped .part, and whichever renames first wins; the loser's rename
// fails with EEXIST/EPERM on Windows, it unlinks its .part and moves on. No
// locking, because a lock file that outlives a crash is a worse problem than the
// race it prevents.
//
// NOT PROVEN BY FILENAMES. That a file arrived does not mean the model loads
// from it. `scripts/verify-kokoro-offline.js` is what proves that, by loading
// with the network disabled in a fresh process. This module reports what it
// copied; it claims nothing about whether the result works.

const fs = require('node:fs');
const path = require('node:path');

let partCounter = 0;

function listFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      // Never migrate another run's in-flight temp file.
      if (/\.\d+\.\d+\.part$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function copyOne(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  partCounter += 1;
  const tmp = dest + '.' + process.pid + '.' + partCounter + '.part';
  let fd = null;
  try {
    fs.copyFileSync(src, tmp);
    // fsync before the rename: a rename is atomic with respect to the directory
    // entry, but not with respect to the file's own data reaching the disk. A
    // crash between the two would otherwise leave a correctly-named, empty file.
    fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, dest);
    return { ok: true };
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* already gone */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    // EEXIST/EPERM on the rename means a concurrent migration got there first,
    // which is a success for the caller even though this call failed.
    if (err && (err.code === 'EEXIST' || err.code === 'EPERM') && fs.existsSync(dest)) {
      return { ok: true, wonByOther: true };
    }
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// migrateLegacyCache({ from, to, modelId }) -> { copied, skipped, conflicts, bytes, scanned }
//
// `from` and `to` are cache ROOTS; only the subtree for `modelId` is touched, so
// an unrelated model in the same legacy cache is left alone.
function migrateLegacyCache({ from, to, modelId }) {
  const result = { copied: [], skipped: [], conflicts: [], bytes: 0, scanned: 0 };
  const segments = String(modelId || '').split('/').filter(Boolean);
  if (!from || !to || !segments.length) return result;
  const srcRoot = path.join(from, ...segments);
  const destRoot = path.join(to, ...segments);
  if (!fs.existsSync(srcRoot)) return result;

  for (const src of listFiles(srcRoot)) {
    result.scanned += 1;
    const rel = path.relative(srcRoot, src);
    const dest = path.join(destRoot, rel);
    let srcStat;
    try { srcStat = fs.statSync(src); } catch (_) { result.skipped.push({ rel, why: 'unreadable-source' }); continue; }

    if (fs.existsSync(dest)) {
      let destStat = null;
      try { destStat = fs.statSync(dest); } catch (_) { /* fall through as a conflict */ }
      if (destStat && destStat.size === srcStat.size) { result.skipped.push({ rel, why: 'already-present' }); continue; }
      // PRESERVE AND REPORT. Not resolved, not overwritten, not deleted — this
      // module cannot know which of the two is the good one.
      result.conflicts.push({
        rel,
        legacy: src, legacyBytes: srcStat.size,
        canonical: dest, canonicalBytes: destStat ? destStat.size : null,
      });
      continue;
    }

    const r = copyOne(src, dest);
    if (r.ok) {
      if (r.wonByOther) result.skipped.push({ rel, why: 'concurrent-migration-won' });
      else { result.copied.push(rel); result.bytes += srcStat.size; }
    } else {
      result.skipped.push({ rel, why: r.error });
    }
  }
  return result;
}

module.exports = { migrateLegacyCache, listFiles };
