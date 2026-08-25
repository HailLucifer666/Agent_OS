'use strict';

// electron/log-rotate.js — BUG-273 D4. CAP A LOG BY ROTATING, NEVER BY ERASING.
//
// This replaces two mechanisms in main.js that were each deliberate and each threw
// away the only part of a log anybody reads after a crash:
//
//   1. `fs.truncateSync(file, 0)` for the main log's 2 MB cap ("one file, no rotation
//      machinery to go wrong"). Hitting the cap wiped the whole file, so the run
//      LEADING UP TO the overflow went with it.
//   2. `createWriteStream(childLogPath(), { flags: 'w' })` in startChild(). startChild
//      is the RESTART path as well as the boot path, so a crashing server child had
//      its log erased by its own restart roughly a second later — every time. In a
//      crash loop, only the last and shortest attempt survived.
//
// Together those are a complete explanation for D4's "the session died and left no
// diagnostic trail", without needing another death to study.
//
// The old comment on (2) was right that append-mode grows without bound across a
// crash loop. So the bound became a real size cap with ONE kept generation: the
// on-disk ceiling is 2x a named constant instead of unbounded, and any death has
// both its own run and the one before it available.
//
// It lives in its own module rather than inside main.js so its behaviour can be
// tested for real. main.js can only ever be shape-asserted (root CLAUDE.md: unit
// tests inject fakes and are blind to load order), and "the log survives a crash"
// is exactly the kind of claim that must not rest on a regex over source text.
//
// Q3 — WHO ACTUALLY READS THESE FILES? `<userData>/mythos-server.log` is read by
// mythos/scripts/verify-voice-session.js, and `<userData>/logs/main.log` by hand
// during support. The LIVE file therefore keeps its exact name — the old bytes are
// what move aside. Per-run filenames were the obvious alternative and are wrong for
// that reason: they would have split one voice session across two files and silently
// halved every metric that script reports.
//
// Q5 — the caller owns the constant. Nothing is defaulted here: a cap that quietly
// falls back to some number of its own is how a bound gets applied that nobody
// chose. A non-finite or negative cap rotates nothing and says so by returning false.

const fs = require('node:fs');

// Derive the kept generation's name from the live one: `main.log` -> `main.prev.log`,
// `mythos-server.log` -> `mythos-server.prev.log`, and a name with no extension just
// gains `.prev`. The character class excludes both separators so a dotted DIRECTORY
// (a real shape on Windows, where a dot-prefixed config directory holds an
// extensionless log file) cannot have its own dot mistaken for the file's extension.
function previousGenerationPath(file) {
  return String(file).replace(/(\.[^.\\/]+)?$/, (ext) => '.prev' + (ext || ''));
}

// Returns true only when bytes actually moved. Every failure path is swallowed and
// reported as false, for the reason main.js's log() already documents: a missing log
// line is a strictly better failure mode than a dead desktop app. A rotation that
// cannot happen leaves the live file growing, which is still readable — the bound is
// the thing that degrades, never the app and never the evidence.
function rotateLogIfOver(file, maxBytes) {
  if (!file || typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes < 0) return false;
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
  } catch {
    return false; // no file yet, or unreadable — nothing to rotate
  }
  const prev = previousGenerationPath(file);
  try {
    // renameSync onto an existing target is atomic on POSIX but throws EPERM/EEXIST
    // on win32, so the older generation is removed first. Its own failure (already
    // gone, or held open by a reader) must not block the rename that matters.
    try { fs.unlinkSync(prev); } catch { /* nothing there, or locked */ }
    fs.renameSync(file, prev);
    return true;
  } catch {
    return false; // locked by a reader, cross-device, read-only directory, full disk
  }
}

module.exports = { rotateLogIfOver, previousGenerationPath };
