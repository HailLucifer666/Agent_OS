'use strict';

// memory/notes.js — plain-markdown notes the operator can open in Obsidian.
//
// WHY THIS IS NOT semantic.js. The Semantic store holds *facts* MYTHOS asserts
// about the operator, in a shape only MYTHOS reads (topic files, confidence,
// sources). Notes are the operator's own documents: a title, a body they wrote
// or dictated, links to other notes. They have to survive MYTHOS being
// uninstalled, so the file on disk IS the store — no index, no sidecar JSON,
// nothing that has to be rebuilt.
//
// Obsidian compatibility is a file-format decision, not an integration: YAML
// frontmatter, `[[wikilinks]]` left exactly as written, one `.md` per note in
// one flat directory. Point Obsidian at the directory and it is a vault. There
// is deliberately no Obsidian CLI dependency (operator decision, 2026-08-14) —
// the vendored `obsidian-markdown` skill teaches the syntax; this writes it.
//
// Location: MYTHOS_NOTES_DIR when set, else <vault>/Notes. Both derived —
// never a hardcoded path (repo portability rule / AD-7).

const fs = require('fs');
const path = require('path');
const { isWindowsDeviceName } = require('./okf');

// A note title becomes a filename, so it goes through the same discipline as
// every other user-string-to-path in this repo: allowlist, not blocklist.
// Wikilinks reference notes by TITLE, so the slug has to stay legible —
// spaces become hyphens rather than being stripped.
//
// A slug whose file would be a Windows device name ("CON" -> CON.md, and
// "con.txt" -> con.txt.md, since the reserved stem is what counts) gets a
// "-note" suffix, the same rule okf.js applies to concept files: a title is
// not a filename, so it is renamed, never refused. It happens HERE, not in
// write(), because read() slugifies too and the two must land on one file.
function slugifyTitle(title) {
  const slug = String(title == null ? '' : title)
    .trim()
    .replace(/[^\w\s.-]+/g, '')     // drop anything that is not word/space/dot/hyphen
    .replace(/\s+/g, '-')
    .replace(/\.+/g, '.')           // collapse dots so '..' can never survive
    .replace(/^[.-]+|[.-]+$/g, '')  // no leading/trailing dot or hyphen
    .slice(0, 80);
  return isWindowsDeviceName(slug + '.md') ? slug + '-note' : slug;
}

// Scanning ceiling. A notes directory is operator-scale (hundreds), not
// machine-scale; a bound keeps note_search honest about cost instead of
// walking an unbounded tree, and it is reported when it bites.
const MAX_SCAN_FILES = 2000;
const MAX_MATCH_CHARS = 240;

function createNotesStore(opts) {
  const o = opts || {};
  // Resolved once per store, not per call: the whole point is one directory the
  // operator can open. `dir` is always supplied by the caller (memory/index.js
  // resolves MYTHOS_NOTES_DIR or <vault>/Notes) so this module never reads env
  // itself and stays trivially testable.
  const dir = o.dir;
  if (!dir) throw new Error('createNotesStore requires a dir');

  function notesDir() { return dir; }

  function notePath(slug) {
    const full = path.resolve(dir, slug + '.md');
    // Defense in depth. slugifyTitle already cannot emit a separator or '..',
    // but the check is cheap and this is the only place a user string becomes a
    // filesystem path.
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!full.startsWith(prefix)) throw new Error('note path escapes the notes directory: ' + slug);
    return full;
  }

  function listNoteFiles() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return { files: [], truncated: false };
      throw err;
    }
    const md = names.filter((n) => n.toLowerCase().endsWith('.md'));
    return { files: md.slice(0, MAX_SCAN_FILES), truncated: md.length > MAX_SCAN_FILES, total: md.length };
  }

  // Obsidian frontmatter. Written only on create — a rewrite preserves whatever
  // the operator has since edited by hand, because their edit is the newer
  // truth and silently reformatting someone's file is how a tool loses trust.
  function frontmatter(meta) {
    const lines = ['---', 'created: ' + meta.created];
    if (meta.tags && meta.tags.length) lines.push('tags:\n' + meta.tags.map((t) => '  - ' + t).join('\n'));
    lines.push('source: mythos', '---', '');
    return lines.join('\n');
  }

  function splitFrontmatter(raw) {
    const m = String(raw).match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
    if (!m) return { head: '', body: String(raw) };
    return { head: m[0], body: String(raw).slice(m[0].length) };
  }

  /**
   * Create or extend a note. Returns the vault-relative-ish info the caller
   * needs to prove the write landed: absolute path, bytes on disk, mode.
   * `mode`: 'append' (default) adds to an existing note under a timestamped
   * separator; 'replace' overwrites the body but keeps the frontmatter.
   */
  function write(args) {
    const a = args || {};
    const title = String(a.title == null ? '' : a.title).trim();
    const text = String(a.text == null ? '' : a.text);
    if (!title) throw new Error('title required');
    if (!text.trim()) throw new Error('text required');
    const slug = slugifyTitle(title);
    if (!slug) throw new Error('title has no usable characters for a filename: ' + title.slice(0, 40));

    fs.mkdirSync(dir, { recursive: true });
    const full = notePath(slug);
    const existed = fs.existsSync(full);
    const mode = a.mode === 'replace' ? 'replace' : 'append';
    const nowIso = new Date(a.now || Date.now()).toISOString();
    const tags = Array.isArray(a.tags) ? a.tags.map((t) => String(t).trim()).filter(Boolean) : [];

    let out;
    if (!existed) {
      out = frontmatter({ created: nowIso, tags: tags }) + '# ' + title + '\n\n' + text.trim() + '\n';
    } else {
      const raw = fs.readFileSync(full, 'utf8');
      const parts = splitFrontmatter(raw);
      out = mode === 'replace'
        ? parts.head + text.trim() + '\n'
        : parts.head + parts.body.replace(/\s*$/, '') + '\n\n---\n\n_' + nowIso + '_\n\n' + text.trim() + '\n';
    }
    fs.writeFileSync(full, out, 'utf8');
    const bytes = fs.statSync(full).size;
    return { title: title, slug: slug, path: full, bytes: bytes, created: !existed, mode: existed ? mode : 'create' };
  }

  /**
   * Read one note by title (or slug). Returns null when it does not exist —
   * the caller turns that into an honest "no note called X", never into an
   * empty note that reads as a real one.
   */
  function read(titleOrSlug) {
    const slug = slugifyTitle(titleOrSlug);
    if (!slug) return null;
    const full = notePath(slug);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return { title: titleOrSlug, slug: slug, path: full, bytes: Buffer.byteLength(raw, 'utf8'), content: raw };
  }

  /** Titles only — the cheap "what notes exist" answer. */
  function list() {
    const scan = listNoteFiles();
    return {
      notes: scan.files.map((f) => ({ slug: f.replace(/\.md$/i, ''), path: path.join(dir, f) })),
      truncated: scan.truncated,
      total: scan.total || scan.files.length,
    };
  }

  /**
   * Substring search over titles and bodies, case-insensitive. Deliberately not
   * semantic: recall_memory already covers embedding search over MYTHOS's own
   * stores, and a note search that "sort of" matches is worse than one the
   * operator can predict. Returns the matching line so a hit is checkable.
   */
  function search(query, opts2) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return { query: '', matches: [], scanned: 0, truncated: false };
    const limit = Math.max(1, Math.min(Number((opts2 && opts2.limit) || 10), 50));
    const scan = listNoteFiles();
    const matches = [];
    for (const file of scan.files) {
      if (matches.length >= limit) break;
      const full = path.join(dir, file);
      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      const slug = file.replace(/\.md$/i, '');
      const inTitle = slug.toLowerCase().indexOf(q) !== -1;
      const lines = raw.split(/\r?\n/);
      let hitLine = null;
      for (const line of lines) {
        if (line.toLowerCase().indexOf(q) !== -1) { hitLine = line.trim().slice(0, MAX_MATCH_CHARS); break; }
      }
      if (!inTitle && hitLine === null) continue;
      matches.push({ slug: slug, path: full, matchedIn: inTitle && hitLine === null ? 'title' : (inTitle ? 'title+body' : 'body'), line: hitLine });
    }
    return { query: q, matches: matches, scanned: scan.files.length, truncated: scan.truncated };
  }

  return {
    notesDir: notesDir,
    write: write,
    read: read,
    list: list,
    search: search,
    _slugifyTitle: slugifyTitle,
    _MAX_SCAN_FILES: MAX_SCAN_FILES,
  };
}

module.exports = { createNotesStore, slugifyTitle };
