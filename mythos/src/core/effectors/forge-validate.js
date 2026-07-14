'use strict';

// effectors/forge-validate.js — deterministic file validation + safe write for
// the Forge pipeline (P22). Node builtins only (path, vm), zero deps, no LLM.
// validateFileContent is a cheap parse-only gate; writeProjectFile enforces a
// hard path-traversal guard before any fs write.

const path = require('path');
const vm = require('vm');
const { isUnsafePath } = require('./forge-prompts');

const PROJECTS_REL = 'builds/projects';

// Cheap, deterministic sanity gate — never executes the file.
function validateFileContent(relPath, content) {
  const c = String(content == null ? '' : content);
  if (!c.trim()) return { ok: false, error: 'empty file content' };
  const ext = (String(relPath).match(/\.([a-z0-9]+)$/i) || [null, ''])[1].toLowerCase();
  try {
    if (ext === 'json') { JSON.parse(c); return { ok: true }; }
    if (ext === 'js' || ext === 'mjs') { new vm.Script(c, { filename: String(relPath) }); return { ok: true }; }
    if (ext === 'html' || ext === 'htm') return validateHtml(c);
    if (ext === 'css') {
      const open = (c.match(/{/g) || []).length;
      const close = (c.match(/}/g) || []).length;
      if (open !== close) return { ok: false, error: 'unbalanced braces' };
      return { ok: true };
    }
    return { ok: true }; // non-empty already asserted
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'validation error' };
  }
}

function validateHtml(c) {
  if (!/<html[\s>]/i.test(c) || !/<\/html>/i.test(c)) return { ok: false, error: 'HTML missing <html>...</html>' };
  // "balanced-ish": every tag-open ('<' followed by a letter, '/', or '!') needs a
  // '>'. JS comparisons ('i < n') do not count as tag-opens, so they don't skew it.
  const tagOpens = (c.match(/<[a-zA-Z!/]/g) || []).length;
  const gt = (c.match(/>/g) || []).length;
  if (gt < tagOpens) return { ok: false, error: 'unbalanced angle brackets' };
  return { ok: true };
}

function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

function uniqueSlug(base, isTaken) {
  let slug = base;
  for (let i = 2; isTaken(slug); i += 1) slug = base + '-' + i;
  return slug;
}

// Path-traversal guard: reject isUnsafePath, resolve the full path, and assert it
// lives under vault/builds/projects/<slug>/ before writing.
function writeProjectFile(vault, slug, relPath, content) {
  const clean = String(relPath == null ? '' : relPath).replace(/\\/g, '/').trim();
  if (isUnsafePath(clean)) throw new Error('unsafe path rejected: ' + relPath);
  const baseRel = path.join(PROJECTS_REL, slug);
  const baseAbs = vault.vaultPath(baseRel);
  const fullAbs = path.resolve(baseAbs, clean);
  const prefix = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (!fullAbs.startsWith(prefix)) throw new Error('path traversal blocked: ' + relPath);
  vault.writeText(path.join(baseRel, clean), content);
  return { rel: '/vault/' + PROJECTS_REL + '/' + slug + '/' + clean, abs: fullAbs };
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

// Regex-extract the public surface (deterministic, no 2nd LLM call) so later
// files can reuse exact ids/selectors/names, plus a 400-char head.
function summarizeGeneratedFile(relPath, content) {
  const c = String(content || '');
  const ext = (String(relPath).match(/\.([a-z0-9]+)$/i) || [null, ''])[1].toLowerCase();
  let surface = [];
  if (ext === 'html' || ext === 'htm') {
    surface = (c.match(/\bid="([^"]{1,40})"/g) || []).slice(0, 20).map(function (m) { return '#' + m.slice(4, -1); });
  } else if (ext === 'css') {
    surface = (c.match(/[.#][A-Za-z0-9_-]{1,40}\s*{/g) || []).slice(0, 20).map(function (m) { return m.replace(/\s*{$/, ''); });
  } else if (ext === 'js' || ext === 'mjs') {
    surface = (c.match(/(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g) || []).slice(0, 20).map(function (m) { return m.replace(/\s+/g, ' '); });
  }
  const surfaceStr = surface.length ? 'Public surface: ' + surface.join(', ') + '\n' : '';
  return surfaceStr + 'Head:\n' + c.slice(0, 400);
}

module.exports = {
  validateFileContent,
  writeProjectFile,
  slugify,
  uniqueSlug,
  computePreviewUrl,
  summarizeGeneratedFile,
  PROJECTS_REL,
};
