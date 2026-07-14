'use strict';

// util/html-text.js — dependency-free HTML → readable text. Native string ops
// only, no DOM library. Shared by web-fetch.js (page body extraction) and the
// DDG search provider (snippet cleanup). Deliberately lossy: strips script/
// style/nav/header/footer, turns block elements into newlines, drops all other
// tags, decodes entities, and collapses whitespace. Good enough for feeding a
// synthesis LLM — not a fidelity-preserving renderer.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', deg: '°', middot: '·',
  laquo: '«', raquo: '»', bull: '•', euro: '€',
  pound: '£', cent: '¢', sect: '§',
};

const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|tr|table|section|article|h[1-6]|blockquote|pre|hr|dd|dt|dl)\b[^>]*>/gi;
const DROP_BLOCKS = /<(script|style|nav|header|footer|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

function decodeEntities(str) {
  if (!str) return '';
  return String(str).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, function (m, body) {
    if (body.charAt(0) === '#') {
      var code;
      if (body.charAt(1) === 'x' || body.charAt(1) === 'X') code = parseInt(body.slice(2), 16);
      else code = parseInt(body.slice(1), 10);
      if (isNaN(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    var key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '');
}

function extractTitle(html) {
  var m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  if (!m) return '';
  return decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim();
}

function htmlToText(html, opts) {
  opts = opts || {};
  var maxChars = opts.maxChars || 0;
  var out = String(html || '');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(DROP_BLOCKS, ' ');
  out = out.replace(BLOCK_TAGS, '\n');
  out = stripTags(out);
  out = decodeEntities(out);
  // Collapse runs of spaces/tabs, then trim each line and squeeze blank lines.
  out = out.replace(/[ \t\f\v\r]+/g, ' ');
  out = out.split('\n').map(function (l) { return l.trim(); }).filter(function (l, i, arr) {
    return l.length > 0 || (i > 0 && arr[i - 1].length > 0);
  }).join('\n').trim();
  if (maxChars && out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

module.exports = { decodeEntities, stripTags, extractTitle, htmlToText };
