'use strict';

// memory/okf.js — Open Knowledge Format (OKF) serialization.
//
// OKF is a vendor-neutral way to represent knowledge as plain markdown with
// YAML frontmatter (GoogleCloudPlatform/knowledge-catalog, spec v0.2). The
// frontmatter is the queryable part; the body is prose a human or a model can
// read. That makes it the right shape for handing MYTHOS's knowledge to
// something else, and for receiving somebody else's.
//
// WHAT THE SPEC ACTUALLY REQUIRES — and this is the whole contract:
//   * `type` is the ONLY required frontmatter key. A short descriptive string.
//   * Type values are NOT centrally registered. A consumer must tolerate a
//     type it has never seen rather than rejecting the document.
//   * Arbitrary extra frontmatter keys and arbitrary body sections are
//     explicitly allowed and must not break a consumer.
//   * `index.md` and `log.md` are reserved filenames within a bundle.
// Everything else (resource, tags, sources, generated, verified, status,
// stale_after) is conventional, not mandatory.
//
// WHY A HAND-ROLLED SERIALIZER. The subset of YAML frontmatter OKF uses is
// flat scalars, string lists and the occasional nested map — the same size of
// problem skills/loader.js already hand-parses, and adding a YAML dependency
// to this repo for it would be the trade ponytail exists to refuse. The parser
// is deliberately conservative: anything it cannot represent is preserved as a
// raw string rather than silently reshaped, because a lossy round-trip through
// an interchange format is worse than no export at all.
//
// HONESTY. `generated` and `verified` mean what they say. serialize() will not
// invent them; a caller that sets verified:true is asserting something was
// actually checked, and okf_export marks what MYTHOS produced as generated.

var RESERVED_FILENAMES = ['index.md', 'log.md'];

// Windows device names (2026-09-29 audit, B2b). Measured on this Windows 11
// build (25H2) the same day, and corrected after independent review: only BARE
// names are still devices here. cmd cannot create or open a file called "aux";
// Node, which reaches the disk through \\?\ paths that skip the device rules,
// creates one that cmd then lists but cannot open. With an extension ("con.md",
// "COM0.md") cmd creates, reads and deletes an ordinary file. Windows 10 and
// older treat "NUL.txt" as NUL — Microsoft's naming documentation says so; not
// measured here — and a vault moves between machines, so the extension forms
// are refused as well, along with trailing spaces before the extension and the
// COM/LPT digits that documentation lists (0-9 and the superscripts ¹²³).
var WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)\s*(\..*)?$/i;

function isWindowsDeviceName(name) {
  return WINDOWS_DEVICE_NAME.test(String(name || ''));
}

// ---------------------------------------------------------------------------
// Scalar encoding
// ---------------------------------------------------------------------------

// Quote when the value could otherwise be misread as YAML: leading/trailing
// space, a leading indicator character, something that would parse as a
// number/bool/null, or anything containing a colon-space or a newline.
function needsQuoting(value) {
  if (value === '') return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/:\s|\s#/.test(value)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return true;
  return false;
}

function encodeScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return isFinite(value) ? String(value) : 'null';
  var text = String(value);
  if (text.indexOf('\n') !== -1) {
    // Multi-line: fold to a single line rather than emitting a block scalar.
    // A block scalar round-trips badly through a minimal parser, and the one
    // that shipped here read `>` as the value itself (see loader.js).
    text = text.replace(/\s*\n\s*/g, ' ').trim();
  }
  if (needsQuoting(text)) return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return text;
}

function encodeValue(key, value, indent) {
  var pad = indent || '';
  if (Array.isArray(value)) {
    if (!value.length) return pad + key + ': []';
    var items = value.map(function(v) { return pad + '  - ' + encodeScalar(v); });
    return pad + key + ':\n' + items.join('\n');
  }
  if (value && typeof value === 'object') {
    var keys = Object.keys(value);
    if (!keys.length) return pad + key + ': {}';
    var nested = keys.map(function(k) { return encodeValue(k, value[k], pad + '  '); });
    return pad + key + ':\n' + nested.join('\n');
  }
  return pad + key + ': ' + encodeScalar(value);
}

// ---------------------------------------------------------------------------
// serialize — { type, ...frontmatter, body } -> an OKF markdown document
// ---------------------------------------------------------------------------
function serialize(doc) {
  var d = doc || {};
  var type = String(d.type || '').trim();
  if (!type) throw new Error('OKF requires a non-empty `type` (the one mandatory key)');

  var body = d.body === undefined || d.body === null ? '' : String(d.body);
  var frontmatter = {};
  Object.keys(d).forEach(function(k) {
    if (k === 'body' || k === 'type') return;
    if (d[k] === undefined) return;
    frontmatter[k] = d[k];
  });

  // `type` first: it is the required key, and a reader scanning the head of a
  // file should hit it immediately.
  var lines = ['---', encodeValue('type', type, '')];
  Object.keys(frontmatter).forEach(function(k) {
    lines.push(encodeValue(k, frontmatter[k], ''));
  });
  lines.push('---');
  // Blank line between the frontmatter block and the body — every OKF example
  // has one, and a markdown renderer needs it before a heading.
  return lines.join('\n') + '\n\n' + body.replace(/\s+$/, '') + '\n';
}

// ---------------------------------------------------------------------------
// Scalar decoding
// ---------------------------------------------------------------------------
function decodeScalar(raw) {
  var text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '';
  var quoted = text.match(/^"([\s\S]*)"$/) || text.match(/^'([\s\S]*)'$/);
  if (quoted) return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^(false|no|off)$/i.test(text)) return false;
  if (/^(null|~)$/i.test(text)) return null;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text);
  // Inline flow list: [a, b, c]
  var flow = text.match(/^\[([\s\S]*)\]$/);
  if (flow) {
    return flow[1].split(',').map(function(p) { return decodeScalar(p); }).filter(function(v) { return v !== ''; });
  }
  return text;
}

// Parse an indented YAML block into a plain object. Handles flat keys, block
// lists ('  - item') and one level of nesting — the shapes OKF actually uses.
// Anything else is kept as its raw string rather than guessed at.
function parseBlock(lines, startIndex, baseIndent) {
  var result = {};
  var i = startIndex;
  while (i < lines.length) {
    var line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    var indent = line.match(/^\s*/)[0].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; }        // consumed by a nested call

    var trimmed = line.trim();
    if (trimmed.charAt(0) === '#') { i++; continue; }

    var sep = trimmed.indexOf(':');
    if (sep === -1) { i++; continue; }
    var key = trimmed.slice(0, sep).trim();
    var rest = trimmed.slice(sep + 1).trim();

    if (rest) {
      result[key] = decodeScalar(rest);
      i++;
      continue;
    }

    // Empty value: either a block list or a nested map. Look ahead.
    var j = i + 1;
    var childIndent = null;
    while (j < lines.length && /^\s*$/.test(lines[j])) j++;
    if (j < lines.length) childIndent = lines[j].match(/^\s*/)[0].length;

    if (childIndent !== null && childIndent > baseIndent && lines[j].trim().charAt(0) === '-') {
      var list = [];
      while (j < lines.length) {
        if (/^\s*$/.test(lines[j])) { j++; continue; }
        var itemIndent = lines[j].match(/^\s*/)[0].length;
        if (itemIndent <= baseIndent || lines[j].trim().charAt(0) !== '-') break;
        list.push(decodeScalar(lines[j].trim().slice(1)));
        j++;
      }
      result[key] = list;
      i = j;
      continue;
    }

    if (childIndent !== null && childIndent > baseIndent) {
      result[key] = parseBlock(lines, j, childIndent);
      // Skip past the nested block.
      while (j < lines.length && (/^\s*$/.test(lines[j]) || lines[j].match(/^\s*/)[0].length >= childIndent)) j++;
      i = j;
      continue;
    }

    result[key] = '';
    i++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// parse — an OKF markdown document -> { ok, doc } | { ok:false, error }
// Never throws. A document without frontmatter is not OKF; say so plainly
// rather than returning an empty object that reads like a valid parse.
// ---------------------------------------------------------------------------
function parse(text) {
  var raw = String(text === undefined || text === null ? '' : text);
  var m = raw.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n([\s\S]*))?$/);
  if (!m) {
    return { ok: false, error: 'not an OKF document: no YAML frontmatter block at the top of the file' };
  }
  var frontmatter = parseBlock(m[1].split(/\r?\n/), 0, 0);
  var body = m[2] === undefined ? '' : m[2];

  var type = frontmatter.type;
  if (typeof type !== 'string' || !type.trim()) {
    return { ok: false, error: 'not a conforming OKF document: `type` is required and must be a non-empty string' };
  }

  // Unknown types are VALID by spec — a consumer must tolerate them. This is
  // returned as data, never as a rejection.
  var doc = Object.assign({}, frontmatter, { type: type.trim(), body: body.replace(/^\r?\n/, '') });
  return { ok: true, doc: doc };
}

// A concept filename GENERATED from a title. A title is not a filename, so a slug
// that lands on a reserved OKF name (index.md, log.md) or a Windows device name
// (con.md, nul.md, com1.md) is suffixed, never refused. A filename the caller
// SUPPLIES is the opposite case: from-okf.js refuses a reserved one rather than
// renaming it, because silently rewriting a name somebody asked for is how a
// guard becomes a surprise. (This comment used to say reserved names were
// refused here; the code has always renamed them.)
function conceptFilename(title) {
  var slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug) slug = 'concept';
  var name = slug + '.md';
  if (RESERVED_FILENAMES.indexOf(name) !== -1 || isWindowsDeviceName(name)) name = slug + '-concept.md';
  return name;
}

function isReservedFilename(name) {
  return RESERVED_FILENAMES.indexOf(String(name || '').toLowerCase()) !== -1;
}

module.exports = {
  serialize: serialize,
  parse: parse,
  conceptFilename: conceptFilename,
  isReservedFilename: isReservedFilename,
  isWindowsDeviceName: isWindowsDeviceName,
  RESERVED_FILENAMES: RESERVED_FILENAMES,
  // Exported for tests:
  _encodeScalar: encodeScalar,
  _decodeScalar: decodeScalar
};
