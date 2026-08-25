'use strict';

// identity/boot-timeline.js — Wave 7 (2026-08-13): "when did you first boot" /
// "how long have you been in development" had no honest answer. version.js's
// bootDate is THIS process's boot time, re-stamped every restart — it cannot
// answer either question. This persists the FIRST boot's timestamp exactly
// once, in the vault (survives restarts/updates, same lifetime class as
// Identity/boundaries.md), and every later boot just reads it back.
//
// Deliberately tiny and single-purpose rather than folded into version.js:
// version.js's `cached` is real in-memory, per-process state; this is a single
// durable fact written once, ever, for the lifetime of an install.

var FILE = 'Identity/first-boot.json';

// ensureFirstBootRecorded(fs, now) -> ISO string of the FIRST boot ever
// recorded for this vault. Idempotent: a vault that already has the file
// just reads it back; nothing is ever overwritten. Best-effort like
// boundaries-seed.js — a write failure degrades to "record it again next
// boot" rather than crashing startup over a non-critical fact.
function ensureFirstBootRecorded(fs, now) {
  var nowIso = new Date(typeof now === 'number' ? now : Date.now()).toISOString();
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function') {
    return nowIso; // no vault to persist to (e.g. a headless/test caller) — answer honestly for this boot only
  }
  var existing = null;
  try { existing = fs.readJSON(FILE, null); } catch (_) { existing = null; }
  if (existing && typeof existing.firstBootAt === 'string' && existing.firstBootAt) {
    return existing.firstBootAt;
  }
  try {
    if (typeof fs.ensureDir === 'function') fs.ensureDir('Identity');
    fs.writeJSON(FILE, { firstBootAt: nowIso });
  } catch (_) { /* best-effort — next boot tries again if this one failed */ }
  return nowIso;
}

module.exports = { ensureFirstBootRecorded, FILE: FILE };
