'use strict';

// effectors/forge-prompts.js — pure, dependency-free JSON/path helpers shared
// by the Forge build pipeline (P22) and forge-runner.js (Phase 2 of the
// Hermes orchestration change). No fs, no brain, no LLM client. Phase 3
// removed the brain.think-era prompt builders (buildManifestPrompt et al.) —
// The build engine gets its own prompts now (see forge-runner.js) — but the
// extraction/safety primitives below are still load-bearing: forge-runner.js
// reuses extractJsonObject/sanitizeManifestFiles to parse Hermes's plan
// output rather than reimplementing a second JSON extractor (Invariant 7).

function stripThinkBlocks(raw) {
  return String(raw == null ? '' : raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// 3-tier: direct JSON.parse → fenced ```json block → brace-scan depth-match.
// Operates on already-think-stripped text. Never throws; returns null on failure.
function extractJsonObject(raw) {
  const text = stripThinkBlocks(raw);
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* tier 2 */ }
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    try { return JSON.parse(m[1].trim()); } catch (_) { /* keep scanning fences */ }
  }
  const braceStart = text.indexOf('{');
  const bracketStart = text.indexOf('[');
  let start = -1;
  if (braceStart !== -1 && bracketStart !== -1) start = Math.min(braceStart, bracketStart);
  else start = Math.max(braceStart, bracketStart);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; } }
    }
  }
  return null;
}

// Reject empty, leading '/', drive-letter, or any '..' segment. Normalizes '\'→'/'.
function isUnsafePath(norm) {
  if (typeof norm !== 'string') return true;
  const p = norm.replace(/\\/g, '/').trim();
  if (!p) return true;
  if (p.charAt(0) === '/') return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  const segs = p.split('/');
  for (let i = 0; i < segs.length; i++) { if (segs[i] === '..') return true; }
  return false;
}

// Drop malformed/unsafe/duplicate entries (honest partial accept — never throws);
// normalize '\'→'/'; cap at hardCap.
function sanitizeManifestFiles(rawFiles, hardCap) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rawFiles)) return out;
  for (let i = 0; i < rawFiles.length; i++) {
    if (out.length >= hardCap) break;
    const f = rawFiles[i];
    if (!f) continue;
    let p = typeof f === 'string' ? f : f.path;
    if (typeof p !== 'string') continue;
    p = p.replace(/\\/g, '/').trim();
    if (isUnsafePath(p) || seen.has(p)) continue;
    seen.add(p);
    const purpose = (f && typeof f.purpose === 'string') ? f.purpose.slice(0, 300) : '';
    out.push({ path: p, purpose: purpose, status: 'pending', attempts: 0, error: null, summary: null });
  }
  return out;
}

module.exports = {
  stripThinkBlocks,
  extractJsonObject,
  isUnsafePath,
  sanitizeManifestFiles,
};
