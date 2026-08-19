'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { dayKey } = require('../util/day-key');

// FsStore — base filesystem abstraction (CA from NOVA vault.js)
// Extended with append, entries, prune for episodic/audit stores.
// vaultRoot read live per call for test isolation.
//
// Record shapes (documented here so a shape change is a decision, not an
// accident): JSONL files under vault/ are arrays of JSON objects, one per
// line. New records written through appendLine() carry `schemaVersion: 1`
// (F8, go-live proof plan 2026-08-08) so a future shape change is
// detectable instead of silently unreadable. Readers (readLines /
// readDirLines) are deliberately lenient — they JSON.parse each line and
// skip corrupt ones with a health.anomaly — so records written before the
// stamp exist today, read unchanged, and there is no migration machinery
// (per repo YAGNI).

// Read granularity for readTailLines. Big enough that a normal `limit` is
// satisfied by the first read, small enough that the worst case stays bounded.
const TAIL_CHUNK_BYTES = 256 * 1024;
// Largest single line readTailLines will assemble before abandoning a file. A
// JSONL file containing no newline at all would otherwise defeat the memory
// bound this function exists to provide.
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const LF = 0x0A;

// Reads JSONL records from the END of one file, newest first, and stops as soon
// as opts.out holds `limit` matched records. Pushes into opts.out so a caller
// walking several files accumulates across them — which is why `limit` is the
// caller's TOTAL target and not a per-file budget.
//
// Returns { bytesRead, fileSize } — not decoration. It is how a test proves the
// whole file was not read (bytesRead << fileSize), and the only cheap way to
// see that a query paid for a 128MB day file to answer a 50-row question.
function readTailLines(fullPath, opts) {
  const limit = opts.limit;
  const match = opts.match;
  const out = opts.out;
  const onCorrupt = opts.onCorrupt;
  const chunkBytes = opts.chunkBytes || TAIL_CHUNK_BYTES;

  let fd;
  try {
    fd = fs.openSync(fullPath, 'r');
  } catch (err) {
    // Same disposition readText has: a missing file is empty, anything else is
    // a real failure and must not be swallowed into "no records".
    if (err.code === 'ENOENT') return { bytesRead: 0, fileSize: 0 };
    throw err;
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    let pos = fileSize;
    let bytesRead = 0;
    // Bytes of a record whose start lies in a chunk not yet read.
    let carry = null;

    function take(lineBuf, byteOffset) {
      const text = lineBuf.toString('utf8').trim();
      if (!text) return;   // trailing newline, or a blank line
      let entry;
      try {
        entry = JSON.parse(text);
      } catch (_) {
        if (onCorrupt) onCorrupt(byteOffset);
        return;
      }
      if (match(entry)) out.push(entry);
    }

    while (pos > 0 && out.length < limit) {
      const len = Math.min(chunkBytes, pos);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos - len);
      const chunkStart = pos - len;
      pos = chunkStart;
      bytesRead += len;

      // The scan stays at the BYTE level on purpose: 0x0A never occurs inside a
      // multi-byte UTF-8 sequence, so splitting on it cannot cut a character in
      // half, and only complete records are ever decoded. Decoding each chunk
      // to a string first would corrupt any record straddling a chunk boundary.
      const block = carry ? Buffer.concat([buf, carry]) : buf;
      carry = null;
      let end = block.length;
      for (let i = block.length - 1; i >= 0; i--) {
        if (block[i] !== LF) continue;
        take(block.subarray(i + 1, end), chunkStart + i + 1);
        end = i;
        if (out.length >= limit) return { bytesRead: bytesRead, fileSize: fileSize };
      }
      if (end > 0) {
        if (end > MAX_LINE_BYTES) {
          if (onCorrupt) onCorrupt(chunkStart);
          return { bytesRead: bytesRead, fileSize: fileSize };
        }
        // Copied, not aliased: `block` may be the chunk buffer itself.
        carry = Buffer.from(block.subarray(0, end));
      }
      // At the start of the file a carry is not a partial record — it is the
      // first one, and no earlier chunk will ever complete it.
      if (pos === 0 && carry) { take(carry, 0); carry = null; }
    }
    return { bytesRead: bytesRead, fileSize: fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

function createFsStore(vaultRootFn, bus) {
  const root = typeof vaultRootFn === 'function' ? vaultRootFn : () => vaultRootFn;
  const pathLocks = new Map(); // relPath -> tail promise (D-21)

  function vaultPath(...segments) {
    return path.resolve(root(), ...segments);
  }

  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function readText(relPath, fallback) {
    if (fallback === undefined) fallback = '';
    const full = vaultPath(relPath);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  function writeText(relPath, content) {
    const full = vaultPath(relPath);
    ensureDir(path.dirname(full));
    // Atomic write: write to temp then rename
    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    // B6: Clean up .tmp file on rename failure (e.g., Windows EPERM/EXDEV).
    try {
      fs.renameSync(tmp, full);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
  }

  function readJSON(relPath, fallback) {
    const raw = readText(relPath, null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      // B7: Emit anomaly on JSON corruption so operator knows persistence is degraded.
      if (bus) bus.emit('health.anomaly', { kind: 'json-corrupt', path: relPath, error: e.message });
      return fallback;
    }
  }

  // Strict variant of readJSON: returns `fallback` ONLY when the file genuinely
  // does not exist. Unreadable (EBUSY/EPERM from an AV or indexer lock) and
  // unparseable both THROW, so a caller cannot mistake either for "empty".
  //
  // Why this exists (2026-07-31): readJSON() returns `fallback` for a corrupt
  // file as well as a missing one. Any caller that loads a collection, mutates
  // it, and writes it back therefore truncates the whole store on a single
  // corrupt read — and reports success, because from its point of view the
  // store was simply empty. Confirmed by seeding a reminders.json with two real
  // reminders and a truncated closing brace: reminder_add returned ok:true and
  // both existing reminders were permanently gone.
  //
  // readJSON keeps its lenient behaviour — 18 of its 21 callers legitimately
  // want "no usable file -> default" (persona levels, last-boot marker, caches)
  // and turning a corrupt cache into a boot failure would be worse. Only the
  // read-mutate-write callers need the strict version. Use this one whenever a
  // write can follow the read.
  function readJSONStrict(relPath, fallback) {
    const raw = readText(relPath, null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      if (bus) bus.emit('health.anomaly', { kind: 'json-corrupt', path: relPath, error: e.message });
      const err = new Error('unparseable JSON at ' + relPath + ': ' + e.message);
      err.code = 'EJSONCORRUPT';
      throw err;
    }
  }

  function writeJSON(relPath, data) {
    writeText(relPath, JSON.stringify(data, null, 2));
  }

  function listFiles(relDir, ext) {
    const full = vaultPath(relDir);
    try {
      return fs.readdirSync(full)
        .filter(function(f) { return !ext || f.endsWith(ext); })
        .map(function(f) { return { name: f, path: path.join(relDir, f), full: path.join(full, f) }; });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // Append a single line to a JSONL file
  function appendLine(relPath, obj) {
    const full = vaultPath(relPath);
    ensureDir(path.dirname(full));
    // F8 (go-live proof plan, 2026-08-08): every NEW record carries a
    // schemaVersion stamp. Object.assign puts the DEFAULT first, so a caller
    // that already sets schemaVersion wins (their value overrides). Readers
    // are lenient, so existing unstamped records read unchanged.
    const line = JSON.stringify(Object.assign({ schemaVersion: 1 }, obj)) + '\n';
    // Atomic-ish: open in append mode
    fs.appendFileSync(full, line, 'utf8');
  }

  // Read all entries from a JSONL file, skipping corrupt lines
  function readLines(relPath) {
    const raw = readText(relPath, '');
    if (!raw) return [];
    return raw.split('\n').reduce(function(acc, line, idx) {
      if (!line.trim()) return acc;
      try {
        acc.push(JSON.parse(line));
      } catch (_) {
        if (bus) bus.emit('health.anomaly', { kind: 'corrupt-line', path: relPath, line: idx });
        acc.push(null); // null marker for corrupt
      }
      return acc;
    }, []);
  }

  // Read entries from a directory of JSONL files
  function readDirLines(relDir, opts) {
    opts = opts || {};
    const files = listFiles(relDir, '.jsonl');
    // Sort by name (date-based filenames sort chronologically)
    files.sort(function(a, b) { return a.name.localeCompare(b.name); });

    // Optional: filter by date window
    let filtered = files;
    if (opts.since) {
      filtered = files.filter(function(f) {
        // Parse date from filename (YYYY-MM-DD.jsonl)
        const datePart = f.name.replace('.jsonl', '');
        return datePart >= opts.since;
      });
    }
    if (opts.until) {
      filtered = filtered.filter(function(f) {
        const datePart = f.name.replace('.jsonl', '');
        return datePart <= opts.until;
      });
    }

    let entries = [];
    for (let i = 0; i < filtered.length; i++) {
      const lines = readText(filtered[i].path, '');
      if (!lines) continue;
      const fileLines = lines.split('\n');
      for (let j = 0; j < fileLines.length; j++) {
        if (!fileLines[j].trim()) continue;
        try {
          entries.push(JSON.parse(fileLines[j]));
        } catch (_) {
          if (bus) bus.emit('health.anomaly', { kind: 'corrupt-line', path: filtered[i].path, line: j });
        }
      }
    }
    return entries;
  }

  // Bounded newest-first read: walks files in reverse-chronological order and
  // stops as soon as `limit` entries satisfy `match`. Never loads the whole
  // directory history (vault/Audit grows unbounded — reading it all froze the
  // event loop for seconds per panel open).
  //
  // 2026-08-19: it stopped short of the whole DIRECTORY and then read each
  // FILE entire. `readText` + `split` on one day file cost **856ms of blocked
  // event loop and 217MB RSS** on the operator's vault — measured, not
  // theorised — because a healer no-match storm on 2026-07-09 (776,913 rows,
  // before that storm was damped) left a single 128MB file in Audit/.
  //
  // What made it latent instead of obvious: the reverse walk only reaches an
  // old file when the RECENT files cannot satisfy `limit`. So the briefing's
  // `{decision:'heal', limit:500}` query gets slower the QUIETER the healer
  // is — it stops at 2026-07-23 in 17ms today, and one healthy month turns
  // that into the 856ms figure, at boot, in front of the spoken briefing.
  // A cost that grows as the system gets healthier will not show up in
  // testing, which is why this is fixed rather than noted.
  //
  // readTailLines reads each file's tail in bounded chunks, so the cost tracks
  // what the caller asked for instead of what the file happens to weigh.
  function readDirLinesReverse(relDir, opts) {
    opts = opts || {};
    const limit = opts.limit || 100;
    const match = opts.match || function() { return true; };
    const files = listFiles(relDir, '.jsonl');
    files.sort(function(a, b) { return b.name.localeCompare(a.name); }); // newest first
    const out = [];
    for (let i = 0; i < files.length && out.length < limit; i++) {
      const relPath = files[i].path;
      readTailLines(files[i].full, {
        // The TOTAL target, not this file's remainder: readTailLines measures
        // progress as `out.length`, and `out` already holds what earlier files
        // contributed. Passing `limit - out.length` made the very first
        // comparison `out.length >= limit` true for every file after the first,
        // so each returned without reading a byte — a 50-row query answered
        // with 28 rows and no error anywhere.
        limit: limit,
        match: match,
        out: out,
        chunkBytes: opts.chunkBytes,
        onCorrupt: function(byteOffset) {
          // `line` — a FORWARD line index — is deliberately not reported here.
          // Knowing it would mean reading the file from the start, which is the
          // exact cost this function exists to avoid. Nothing consumes the
          // field (its only readers, memory.test.js and
          // chaos-memory-corrupt.test.js, assert on `kind`), so the byte offset
          // replaces it rather than sitting beside a fabricated line number.
          if (bus) bus.emit('health.anomaly', { kind: 'corrupt-line', path: relPath, byteOffset: byteOffset });
        },
      });
    }
    return out; // already newest-first
  }

  // Archive one file to <relDir>/_archive/<name>.md.gz: gzip of a markdown digest
  // wrapping the raw content, then remove the original — no permanent deletion.
  function archiveFile(fileEntry) {
    const content = fs.readFileSync(fileEntry.full, 'utf8');
    const digest = '# Archived ' + fileEntry.name + '\n\nArchived at ' + new Date().toISOString() + '\n\n```\n' + content + '\n```\n';
    const archiveDir = path.join(path.dirname(fileEntry.full), '_archive');
    ensureDir(archiveDir);
    const archivePath = path.join(archiveDir, fileEntry.name.replace(/\.jsonl$/, '') + '.md.gz');
    fs.writeFileSync(archivePath, zlib.gzipSync(digest));
    fs.unlinkSync(fileEntry.full);
  }

  // Archive files older than retentionDays (see archiveFile) instead of deleting them
  function pruneOldFiles(relDir, retentionDays) {
    const cutoff = Date.now() - (retentionDays * 24 * 3600000);
    const files = listFiles(relDir, '.jsonl');
    let archived = 0;
    for (let i = 0; i < files.length; i++) {
      try {
        const stat = fs.statSync(files[i].full);
        if (stat.mtimeMs < cutoff) {
          archiveFile(files[i]);
          archived++;
        }
      } catch (_) {
        // Skip files we can't stat/archive
      }
    }
    return archived;
  }

  function exists(relPath) {
    const full = vaultPath(relPath);
    try {
      fs.accessSync(full, fs.constants.F_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  function removeFile(relPath) {
    const full = vaultPath(relPath);
    try {
      fs.unlinkSync(full);
    } catch (_) {
      // Best-effort
    }
  }

  // Get today's date string YYYY-MM-DD. F11 (2026-08-15): the local-components
  // arithmetic that used to live here now lives in util/day-key.js, because
  // Audit and Incidents need the identical rule and were using UTC instead.
  function todayKey() { return dayKey(); }

  // Per-path async mutex: serialize concurrent ops on the same file (D-21)
  function withLock(relPath, fn) {
    const prev = pathLocks.get(relPath) || Promise.resolve();
    const run = prev.then(fn, fn);                      // a rejection never wedges the queue
    const tail = run.then(function(){}, function(){});
    pathLocks.set(relPath, tail);
    tail.then(function() { if (pathLocks.get(relPath) === tail) pathLocks.delete(relPath); });
    return run;
  }

  return {
    vaultPath, ensureDir, readText, writeText, readJSON, readJSONStrict, writeJSON,
    listFiles, appendLine, readLines, readDirLines, readDirLinesReverse, pruneOldFiles,
    exists, removeFile, todayKey, withLock, root
  };
}

module.exports = { createFsStore, _readTailLines: readTailLines, _TAIL_CHUNK_BYTES: TAIL_CHUNK_BYTES };
