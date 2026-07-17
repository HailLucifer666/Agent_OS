'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// FsStore — base filesystem abstraction (CA from NOVA vault.js)
// Extended with append, entries, prune for episodic/audit stores.
// vaultRoot read live per call for test isolation.

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
    const line = JSON.stringify(obj) + '\n';
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
  function readDirLinesReverse(relDir, opts) {
    opts = opts || {};
    const limit = opts.limit || 100;
    const match = opts.match || function() { return true; };
    const files = listFiles(relDir, '.jsonl');
    files.sort(function(a, b) { return b.name.localeCompare(a.name); }); // newest first
    const out = [];
    for (let i = 0; i < files.length && out.length < limit; i++) {
      const raw = readText(files[i].path, '');
      if (!raw) continue;
      const lines = raw.split('\n');
      for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
        if (!lines[j].trim()) continue;
        try {
          const entry = JSON.parse(lines[j]);
          if (match(entry)) out.push(entry);
        } catch (_) {
          if (bus) bus.emit('health.anomaly', { kind: 'corrupt-line', path: files[i].path, line: j });
        }
      }
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

  // Get today's date string YYYY-MM-DD
  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

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
    vaultPath, ensureDir, readText, writeText, readJSON, writeJSON,
    listFiles, appendLine, readLines, readDirLines, readDirLinesReverse, pruneOldFiles,
    exists, removeFile, todayKey, withLock, root
  };
}

module.exports = { createFsStore };
