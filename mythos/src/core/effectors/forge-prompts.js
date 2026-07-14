'use strict';

// effectors/forge-prompts.js — pure, LLM-shaped helpers for the Forge build
// pipeline (P22). No fs, no brain, no state. Manifest/file/revision prompt
// builders plus extraction that NEVER throws: tryExtractManifest/…RevisionTargets
// always fall back to parsing result.content when result.parsed is absent
// (the D-48-class robustness). extractJsonObject is reimplemented locally (not
// imported from brain) so this module is testable without a brain dep and
// operates on already-<think>-stripped text.

const MANIFEST_SCHEMA_HINT =
  '{"name": "short project name", "kind": "app" | "website", ' +
  '"files": [{"path": "relative/forward-slash/path", "purpose": "what this file does"}], ' +
  '"techNotes": "shared conventions every file must follow"}';

const REVISION_SCHEMA_HINT =
  '{"files": ["relative/path/of/file/to/change", "..."], "notes": "what to change and why"}';

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

// Strip <think> blocks and a fence that wraps the WHOLE output; returns raw
// file content ready to validate/write.
function cleanRawOutput(raw) {
  let content = stripThinkBlocks(raw);
  const fence = content.match(/^```[a-z0-9]*\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) content = fence[1].trim();
  return content;
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

// Never throws. null → caller does one repair re-prompt. offline/aborted → null.
function tryExtractManifest(result, ctx, maxFiles) {
  if (!result || result.offline || result.aborted) return null;
  let obj = result.parsed;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = extractJsonObject(result.content);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const files = sanitizeManifestFiles(obj.files, maxFiles);
  if (!files.length) return null;
  const kind = obj.kind === 'website' ? 'website'
    : obj.kind === 'app' ? 'app' : ((ctx && ctx.kind) || 'app');
  const name = (typeof obj.name === 'string' && obj.name.trim())
    ? obj.name.trim().slice(0, 80) : ((ctx && ctx.name) || 'project');
  const techNotes = typeof obj.techNotes === 'string' ? obj.techNotes.slice(0, 600) : '';
  return { name: name, kind: kind, files: files, techNotes: techNotes };
}

// Never throws. Returns { files:[path], notes } or null.
function tryExtractRevisionTargets(result) {
  if (!result || result.offline || result.aborted) return null;
  let obj = result.parsed;
  if (!obj || typeof obj !== 'object') obj = extractJsonObject(result.content);
  if (!obj) return null;
  const rawFiles = Array.isArray(obj) ? obj : obj.files;
  if (!Array.isArray(rawFiles)) return null;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawFiles.length; i++) {
    const f = rawFiles[i];
    let p = typeof f === 'string' ? f : (f && f.path);
    if (typeof p !== 'string') continue;
    p = p.replace(/\\/g, '/').trim();
    if (isUnsafePath(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  if (!out.length) return null;
  const notes = (!Array.isArray(obj) && typeof obj.notes === 'string') ? obj.notes.slice(0, 600) : '';
  return { files: out, notes: notes };
}

function buildManifestPrompt(spec, kind) {
  const kindLine = kind === 'website'
    ? 'This is a WEBSITE — the files array MUST list index.html FIRST.'
    : 'This is an APP.';
  return [
    'You are the Forge build planner. Produce a file plan (manifest) for the build request below.',
    kindLine,
    'Respond with ONE JSON object and NOTHING else — no markdown fence, no commentary.',
    'Every file path must be RELATIVE with forward slashes: no leading slash, no drive letter, no "..".',
    'Keep the plan minimal but complete — only the files a working deliverable actually needs.',
    'Schema: ' + MANIFEST_SCHEMA_HINT,
    '',
    'BUILD REQUEST: ' + spec,
  ].join('\n');
}

function buildRepairPrompt(spec, kind, badContent) {
  return buildManifestPrompt(spec, kind) +
    '\n\nYour previous reply was NOT valid JSON matching the schema. Reply again with ONLY the JSON object, nothing else. Your previous reply was:\n' +
    String(badContent == null ? '' : badContent).slice(0, 1000);
}

function summariesBlock(doneSummaries) {
  if (!doneSummaries || !doneSummaries.length) return '(none yet — this is the first file)';
  return doneSummaries.map(function (s) { return '### ' + s.path + '\n' + (s.summary || ''); }).join('\n\n');
}

function fullPlanBlock(manifest) {
  return manifest.files.map(function (f) {
    return '- ' + f.path + (f.purpose ? ' — ' + f.purpose : '');
  }).join('\n');
}

function buildFilePrompt(manifest, file, doneSummaries) {
  return [
    'You are the Forge build agent generating ONE file of a multi-file ' + manifest.kind + ' called "' + manifest.name + '".',
    manifest.techNotes ? 'Shared conventions (ALL files follow these): ' + manifest.techNotes : '',
    '',
    'FULL FILE PLAN:',
    fullPlanBlock(manifest),
    '',
    'ALREADY-GENERATED FILES (reuse their exact ids, classes, function and variable names — never redefine or rename them):',
    summariesBlock(doneSummaries),
    '',
    'Generate ONLY this one file: ' + file.path,
    file.purpose ? 'Its purpose: ' + file.purpose : '',
    'Output the RAW file content only — no markdown fence, no commentary before or after.',
  ].filter(Boolean).join('\n');
}

function buildRetryPrompt(manifest, file, doneSummaries, error) {
  return buildFilePrompt(manifest, file, doneSummaries) +
    '\n\nYour previous attempt at this file FAILED validation: ' + String(error || 'invalid content') +
    '. Produce a corrected, complete, valid version of ' + file.path + ' — raw content only.';
}

// Target-selection prompt: which files must change for the requested revision.
function buildRevisionPrompt(manifest, feedback) {
  return [
    'You are the Forge build agent. The operator asked to revise the ' + manifest.kind + ' "' + manifest.name + '".',
    'Requested change: ' + feedback,
    '',
    'FULL FILE PLAN:',
    fullPlanBlock(manifest),
    '',
    'Decide the MINIMAL set of files that must be regenerated for this change (a new file may be added if truly required).',
    'Respond with ONE JSON object and NOTHING else — no fence, no commentary.',
    'Schema: ' + REVISION_SCHEMA_HINT,
  ].join('\n');
}

module.exports = {
  MANIFEST_SCHEMA_HINT,
  REVISION_SCHEMA_HINT,
  stripThinkBlocks,
  extractJsonObject,
  isUnsafePath,
  cleanRawOutput,
  sanitizeManifestFiles,
  tryExtractManifest,
  tryExtractRevisionTargets,
  buildManifestPrompt,
  buildRepairPrompt,
  buildFilePrompt,
  buildRetryPrompt,
  buildRevisionPrompt,
};
