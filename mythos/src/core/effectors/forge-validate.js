'use strict';

// effectors/forge-validate.js — deterministic, dependency-free helpers for
// the Forge pipeline (P22). Node builtins only (fs, path), zero deps, no LLM.
// Phase 3 of the Hermes orchestration change removed validateFileContent/
// writeProjectFile/summarizeGeneratedFile: Hermes writes its own files inside
// its own HERMES_WRITE_SAFE_ROOT-enforced sandbox now, so the per-file
// content-validate-then-write path (and its path-traversal guard, which
// HERMES_WRITE_SAFE_ROOT replaces) is dead. What's left is slug/URL bookkeeping
// plus walkProjectFiles, which hermes-runner.js uses to poll a build's output
// directory.

const fs = require('fs');
const path = require('path');

const PROJECTS_REL = 'builds/projects';

// Directory names that are build noise, not build output — skipped so a
// Hermes run that does `npm install` doesn't report thousands of
// node_modules files as "progress" (see walkProjectFiles below).
const WALK_SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build', '.next']);

function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

function uniqueSlug(base, isTaken) {
  let slug = base;
  for (let i = 2; isTaken(slug); i += 1) slug = base + '-' + i;
  return slug;
}

// index.html → any .html → any .md → null. Returns a /vault-relative URL.
function computePreviewUrl(slug, files) {
  const paths = (files || []).map(function (f) { return typeof f === 'string' ? f : (f && f.path); }).filter(Boolean);
  const pick = paths.find(function (p) { return /(^|\/)index\.html$/i.test(p); })
    || paths.find(function (p) { return /\.html?$/i.test(p); })
    || paths.find(function (p) { return /\.md$/i.test(p); });
  if (!pick) return null;
  return '/vault/' + PROJECTS_REL + '/' + slug + '/' + pick;
}

// Recursive walk returning dirAbs-relative, forward-slash, sorted paths.
// Used by hermes-runner.js to poll a Hermes build's output directory
// (Invariant 5 — readdir polling, never fs.watch, which has a documented
// crash on this Node/Windows build; see test/sensors-file.test.js). Skips
// WALK_SKIP noise dirs. Never throws — a missing/unreadable directory is
// honestly an empty list, since a build that hasn't written anything yet
// (or a race against directory creation) is not an error condition here.
function walkProjectFiles(dirAbs, _rel, _out) {
  const rel = _rel || '';
  const out = _out || [];
  let entries;
  try { entries = fs.readdirSync(path.join(dirAbs, rel), { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    if (WALK_SKIP.has(e.name)) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walkProjectFiles(dirAbs, childRel, out);
    else out.push(childRel);
  }
  return out.sort();
}

module.exports = {
  slugify,
  uniqueSlug,
  computePreviewUrl,
  walkProjectFiles,
  PROJECTS_REL,
};
