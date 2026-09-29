'use strict';

// effectors/from-okf.js — read and write Open Knowledge Format bundles.
//
// OKF (GoogleCloudPlatform/knowledge-catalog) is plain markdown with YAML
// frontmatter. That makes it the interchange format for MYTHOS's knowledge:
// export travels as ordinary files anybody can read without MYTHOS, and import
// accepts a bundle somebody else produced.
//
// Tools:
//   okf_export (tier 2) — write a bundle under vault/Knowledge/<bundle>/.
//   okf_list   (tier 0) — list bundles and their concepts.
//   okf_import (tier 0) — read a bundle back into structured records.
// (leash/tiers.js is the source; this header had export and import swapped
// until 2026-09-29.)
//
// EXPORT IS A COPY, NOT A MOVE. Nothing here mutates or removes what it read.
// A copy also goes stale, so exported concepts are marked `generated: true`
// with the timestamp of the export — never `verified`, which would assert
// MYTHOS checked the facts against a source during an export that did no such
// thing (memory/okf.js's header says the same, deliberately, in both places).
//
// SANDBOXED. Bundles live under the vault, resolved through fs-store's
// vaultPath with the same startsWith traversal guard from-installer.js uses.
// A bundle name containing a separator or '..' is refused, not sanitized —
// silently rewriting a path the caller asked for is how a guard becomes a
// surprise.

var path = require('path');
var effectorFromTool = require('./adapter').effectorFromTool;
var okf = require('../memory/okf');

function ok(r) { return { ok: true, result: r }; }
function fail(m, extra) { return { ok: false, result: Object.assign({ error: m }, extra || {}) }; }

var KNOWLEDGE_ROOT = 'Knowledge';
var MAX_CONCEPTS = 500;          // one export call; a bigger corpus is a paging problem, not a single call
// One path segment. A generated concept name is at most 91 ("<80-char slug>-concept.md"),
// so 100 leaves room for a hand-written one. This is a bound on the segment, not a
// guarantee about the full path: vault root + Knowledge + a 100-character bundle +
// a 100-character file + writeText's .tmp suffix can pass Windows' 260-character
// MAX_PATH, which then works only where long paths are enabled (they are on the
// machine this was measured on). Where they are not, the write fails and the concept
// is reported as rejected, not lost.
var MAX_NAME_LENGTH = 100;
// Characters Windows gives meaning to. ":" is the dangerous one: "notes.md:x.exe"
// is not refused by the filesystem, it creates an NTFS alternate data stream —
// measured 2026-09-29, notes.md listed as 0 bytes with the content hidden in a
// stream nothing here reads. The rest fail to write anyway; refusing them here
// says why, instead of surfacing an EINVAL.
var WINDOWS_RESERVED_CHARS = /[<>:"|?*\u0000-\u001f]/;

// Bundle/concept names become path segments. Refuse anything that could escape,
// hide data, or leave a file Windows cannot open (B2b, 2026-09-29 audit).
function badSegment(name) {
  var s = String(name || '');
  if (!s) return 'empty name';
  if (/[\\/]/.test(s)) return 'path separator in name: ' + s;
  if (s.indexOf('..') !== -1) return 'traversal in name: ' + s;
  if (/^[.\s]|[.\s]$/.test(s)) return 'name may not start or end with a dot or space: ' + s;
  if (s.length > MAX_NAME_LENGTH) return 'name longer than ' + MAX_NAME_LENGTH + ' characters';
  if (WINDOWS_RESERVED_CHARS.test(s)) return 'reserved character in name (one of : < > " | ? * or a control character): ' + JSON.stringify(s);
  if (okf.isWindowsDeviceName(s)) return 'reserved device name: ' + s;
  return null;
}

// A concept file is markdown and nothing else. okf_export is tier 2, which the
// default autonomy ceiling (AUTONOMOUS_MAX_TIER=2) allows with no confirmation,
// so without this a custom filename of "run.bat" put an executable-typed file
// into the vault (measured 2026-09-29). Checked on the FINAL name, custom or
// generated — a generated one always passes (200,000 fuzzed titles, independent
// review, same day).
function badConceptFilename(name) {
  var bad = badSegment(name);
  if (bad) return bad;
  if (!/\.md$/i.test(String(name))) return 'a concept filename must end in .md: ' + name;
  return null;
}

function buildTools(ctx) {
  var vault = ctx && ctx.vault;

  function requireVault() {
    if (!vault || typeof vault.vaultPath !== 'function') {
      return 'vault required (fs-store) — okf tools are unavailable';
    }
    return null;
  }

  // Resolve a path inside vault/Knowledge, with the traversal guard.
  function bundleRel(bundle, file) {
    return file ? path.posix.join(KNOWLEDGE_ROOT, bundle, file) : path.posix.join(KNOWLEDGE_ROOT, bundle);
  }

  // ---- okf_export ---------------------------------------------------------
  async function okf_export(args) {
    var missing = requireVault();
    if (missing) return fail(missing);
    var a = args || {};

    var bundle = String(a.bundle || '').trim();
    var bad = badSegment(bundle);
    if (bad) return fail('invalid bundle name — ' + bad);

    var concepts = a.concepts;
    if (!Array.isArray(concepts) || !concepts.length) {
      return fail('concepts must be a non-empty array of {type, title, body, ...} objects');
    }
    if (concepts.length > MAX_CONCEPTS) {
      return fail('too many concepts in one call: ' + concepts.length + ' (max ' + MAX_CONCEPTS + ')');
    }

    var stamp = new Date().toISOString();
    var written = [];
    var rejected = [];

    for (var i = 0; i < concepts.length; i++) {
      var c = concepts[i] || {};
      var type = String(c.type || '').trim();
      if (!type) {
        rejected.push({ index: i, title: c.title || null, error: 'type is required (the one mandatory OKF key)' });
        continue;
      }
      var filename = c.filename ? String(c.filename) : okf.conceptFilename(c.title || type + '-' + (i + 1));
      var badFile = badConceptFilename(filename);
      // The remedy is in the message (src/core/CLAUDE.md, Refusals): the model reads prose.
      if (badFile) { rejected.push({ index: i, error: 'invalid filename — ' + badFile + '. Omit `filename` and a safe one is generated from the title.' }); continue; }
      if (okf.isReservedFilename(filename)) {
        rejected.push({ index: i, error: filename + ' is a reserved OKF filename (index.md / log.md)' });
        continue;
      }

      var doc = Object.assign({}, c);
      delete doc.filename;
      doc.type = type;
      // Marked as produced by MYTHOS. `verified` is deliberately NOT set here:
      // an export checked nothing.
      doc.generated = true;
      doc.generated_at = stamp;
      if (c.title) doc.title = String(c.title);

      var text;
      try {
        text = okf.serialize(doc);
      } catch (err) {
        rejected.push({ index: i, title: c.title || null, error: 'serialize failed: ' + (err && err.message) });
        continue;
      }
      try {
        vault.writeText(bundleRel(bundle, filename), text);
      } catch (err) {
        rejected.push({ index: i, error: 'write failed: ' + (err && err.message) });
        continue;
      }
      written.push({ file: filename, type: type, title: doc.title || null, bytes: text.length });
    }

    // index.md is the bundle's optional directory listing. Writing it makes the
    // export self-describing for a consumer that has never seen it.
    if (written.length && a.writeIndex !== false) {
      var indexBody = ['# ' + bundle, '', 'Exported by MYTHOS at ' + stamp + '.', '']
        .concat(written.map(function(w) {
          return '- [' + (w.title || w.file) + '](' + w.file + ') — ' + w.type;
        }))
        .join('\n');
      try {
        vault.writeText(bundleRel(bundle, 'index.md'), okf.serialize({
          type: 'Bundle Index',
          title: bundle,
          generated: true,
          generated_at: stamp,
          concept_count: written.length,
          body: indexBody
        }));
      } catch (err) {
        rejected.push({ index: -1, error: 'index.md write failed: ' + (err && err.message) });
      }
    }

    if (!written.length) {
      return fail('nothing was exported', { rejected: rejected });
    }
    return ok({
      bundle: bundle,
      dir: vault.vaultPath(bundleRel(bundle)),
      written: written,
      count: written.length,
      // Never silently drop a concept the caller asked to export.
      rejected: rejected.length ? rejected : undefined
    });
  }

  // ---- okf_list -----------------------------------------------------------
  async function okf_list(args) {
    var missing = requireVault();
    if (missing) return fail(missing);
    var a = args || {};

    if (a.bundle) {
      // Trimmed like okf_export and okf_import, so "notes " lists the bundle
      // export wrote as "notes" instead of refusing it (independent review,
      // 2026-09-29; the mismatch predates B2b).
      var listBundle = String(a.bundle).trim();
      var badB = badSegment(listBundle);
      if (badB) return fail('invalid bundle name — ' + badB);
      var files;
      try {
        files = vault.listFiles(bundleRel(listBundle));
      } catch (_) {
        files = [];
      }
      var mdFiles = (files || []).filter(function(f) { return /\.md$/i.test(f.name || f); });
      if (!mdFiles.length) return ok({ bundle: listBundle, concepts: [], note: 'bundle is empty or does not exist' });
      var concepts = mdFiles.map(function(f) {
        var name = f.name || f;
        var parsed = okf.parse(vault.readText(bundleRel(listBundle, name), ''));
        return parsed.ok
          ? { file: name, type: parsed.doc.type, title: parsed.doc.title || null, reserved: okf.isReservedFilename(name) }
          : { file: name, error: parsed.error };
      });
      return ok({ bundle: listBundle, concepts: concepts, count: concepts.length });
    }

    var dirs;
    try {
      dirs = vault.listFiles(KNOWLEDGE_ROOT) || [];
    } catch (_) {
      dirs = [];
    }
    return ok({ bundles: dirs.map(function(d) { return d.name || d; }), root: vault.vaultPath(KNOWLEDGE_ROOT) });
  }

  // ---- okf_import ---------------------------------------------------------
  async function okf_import(args) {
    var missing = requireVault();
    if (missing) return fail(missing);
    var a = args || {};
    var bundle = String(a.bundle || '').trim();
    var bad = badSegment(bundle);
    if (bad) return fail('invalid bundle name — ' + bad);

    var files;
    try {
      files = vault.listFiles(bundleRel(bundle)) || [];
    } catch (_) {
      files = [];
    }
    var mdFiles = files.filter(function(f) { return /\.md$/i.test(f.name || f); });
    if (!mdFiles.length) return fail('no OKF documents found in bundle: ' + bundle);

    var docs = [];
    var malformed = [];
    mdFiles.forEach(function(f) {
      var name = f.name || f;
      if (a.includeIndex !== true && okf.isReservedFilename(name)) return;   // index.md/log.md are bundle metadata
      var parsed = okf.parse(vault.readText(bundleRel(bundle, name), ''));
      if (!parsed.ok) {
        // Reported, not skipped-in-silence: a file that failed to parse is the
        // single most useful thing to know about an imported bundle.
        malformed.push({ file: name, error: parsed.error });
        return;
      }
      docs.push(Object.assign({ file: name }, parsed.doc));
    });

    if (a.type) {
      var wanted = String(a.type).toLowerCase();
      docs = docs.filter(function(d) { return String(d.type).toLowerCase() === wanted; });
    }

    return ok({
      bundle: bundle,
      documents: docs,
      count: docs.length,
      malformed: malformed.length ? malformed : undefined,
      // An imported document is somebody else's claim. MYTHOS did not verify
      // any of it, and saying so is cheaper than a wrong answer later.
      note: 'imported as-is; frontmatter `verified` reflects what the producer asserted, not a MYTHOS check'
    });
  }

  return [
    {
      name: 'okf_export',
      description: 'Write knowledge to vault/Knowledge/<bundle>/ as Open Knowledge Format markdown (YAML frontmatter + body). Each concept needs a `type`; everything else is optional and preserved. Exports are marked generated, never verified. Reports any concept it refused.',
      params: {
        bundle: 'string — bundle directory name (no path separators)',
        concepts: 'array — [{type, title?, body?, ...any frontmatter keys}]; `type` is required per concept',
        writeIndex: 'boolean (optional) — also write the bundle\'s index.md listing (default true)'
      },
      needs_result: true,
      fn: okf_export
    },
    {
      name: 'okf_list',
      description: 'List OKF bundles in the vault, or the concepts inside one bundle with their type and title. Read-only.',
      params: {
        bundle: 'string (optional) — list this bundle\'s concepts; omit to list the bundles themselves'
      },
      needs_result: true,
      fn: okf_list
    },
    {
      name: 'okf_import',
      description: 'Read an OKF bundle from vault/Knowledge/<bundle>/ back into structured documents. Unknown `type` values are valid per spec and are returned as-is. Malformed files are reported, never silently skipped.',
      params: {
        bundle: 'string — bundle directory name',
        type: 'string (optional) — return only documents of this type',
        includeIndex: 'boolean (optional) — include the reserved index.md/log.md files (default false)'
      },
      needs_result: true,
      fn: okf_import
    }
  ];
}

function registerFromOkf(hub, ctx) {
  var tools = buildTools(ctx);
  for (var i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = {
  registerFromOkf: registerFromOkf,
  buildTools: buildTools,
  // Exported for tests:
  badSegment: badSegment,
  badConceptFilename: badConceptFilename
};
