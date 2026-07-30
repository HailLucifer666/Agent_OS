'use strict';

// chunker.js — pure text-chunking functions shared by Document RAG (§7.5,
// from-documents.js) and semantic code search (§7.11, from-code-search.js).
// No tokenizer dependency in this repo (and none added here) — "tokens" are
// approximated as whitespace-split words. Simple, consistent, good enough for
// bounding chunk size; documented explicitly so the approximation is visible.

const DEFAULT_CHUNK_WORDS = 800;
const DEFAULT_OVERLAP_RATIO = 0.15;
const DEFAULT_MAX_LINES = 200;

// chunkProse(text, opts) -> [{ text, wordStart, wordEnd }]
// Blind word-count split with overlap, no structural awareness — used for
// uploaded prose documents (txt/md). wordStart/wordEnd are word-index offsets
// (not byte offsets), 0-based, end exclusive.
function chunkProse(text, opts) {
  opts = opts || {};
  const chunkWords = opts.chunkWords || DEFAULT_CHUNK_WORDS;
  const overlapRatio = opts.overlapRatio != null ? opts.overlapRatio : DEFAULT_OVERLAP_RATIO;
  const overlapWords = Math.max(0, Math.round(chunkWords * overlapRatio));
  const step = Math.max(1, chunkWords - overlapWords);

  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks = [];
  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(start + chunkWords, words.length);
    chunks.push({ text: words.slice(start, end).join(' '), wordStart: start, wordEnd: end });
    if (end >= words.length) break;
  }
  return chunks;
}

// Boundary-aware line-scan chunker for source code. Splits preferentially on
// top-level function/class/def/arrow-function/module.exports boundaries
// (JS/TS/Python) so a chunk doesn't cut a function in half where avoidable.
// Files with no recognizable boundaries (markdown, JSON, ...) fall back to a
// plain line-count cap. Capped at maxLines per chunk, same bounding spirit as
// chunkProse's word cap.
const BOUNDARY_RE = /^(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|def\b|const\s+\w+\s*=\s*(async\s*)?\(|module\.exports\s*=)/;

// chunkCode(text, opts) -> [{ text, lineStart, lineEnd }]
// lineStart/lineEnd are 1-based, inclusive line numbers.
function chunkCode(text, opts) {
  opts = opts || {};
  const maxLines = opts.maxLines || DEFAULT_MAX_LINES;
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length === 1 && lines[0] === '') return [];

  // Top-level (no leading whitespace) construct-start line indices.
  const boundaries = [0];
  for (let i = 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && BOUNDARY_RE.test(lines[i])) boundaries.push(i);
  }
  boundaries.push(lines.length);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (boundaries[i] < boundaries[i + 1]) segments.push([boundaries[i], boundaries[i + 1]]);
  }
  if (segments.length === 0) return [];

  const chunks = [];
  function flush(start, end) {
    if (end > start) chunks.push({ text: lines.slice(start, end).join('\n'), lineStart: start + 1, lineEnd: end });
  }

  let curStart = segments[0][0];
  let curEnd = curStart;
  for (const [segStart, segEnd] of segments) {
    if (segEnd - segStart > maxLines) {
      // Oversized single segment (whole file with no boundaries at all, or
      // one huge function/class) — flush whatever was accumulated, then
      // hard-split this segment by line count since there's no finer
      // boundary available to respect.
      flush(curStart, curEnd > curStart ? curEnd : curStart);
      for (let s = segStart; s < segEnd; s += maxLines) {
        flush(s, Math.min(s + maxLines, segEnd));
      }
      curStart = segEnd;
      curEnd = segEnd;
      continue;
    }
    if (segEnd - curStart > maxLines && curEnd > curStart) {
      flush(curStart, curEnd);
      curStart = segStart;
    }
    curEnd = segEnd;
  }
  flush(curStart, curEnd);
  return chunks;
}

module.exports = { chunkProse, chunkCode, DEFAULT_CHUNK_WORDS, DEFAULT_OVERLAP_RATIO, DEFAULT_MAX_LINES };
