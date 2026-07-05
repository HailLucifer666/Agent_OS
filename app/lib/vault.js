// vault.js — filesystem helpers for the "Agentic OS" Obsidian-compatible vault.
const fs = require('fs');
const path = require('path');

// Read live each call so tests (and future backup/versioning tooling) can
// point VAULT_ROOT at an isolated dir without require-order coupling.
function vaultRoot() {
  return process.env.VAULT_ROOT || path.join(__dirname, '..', 'vault');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function vaultPath(...segments) {
  return path.join(vaultRoot(), ...segments);
}

function readText(relPath, fallback = '') {
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
  fs.writeFileSync(full, content, 'utf8');
}

function readJSON(relPath, fallback) {
  const raw = readText(relPath, null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
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
      .filter((f) => !ext || f.endsWith(ext))
      .map((f) => ({ name: f, path: path.join(relDir, f), full: path.join(full, f) }));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Extract [[wiki-links]] from markdown text. Supports Obsidian forms:
// [[Page]], [[Page|alias]], [[Page#section]], [[Page#section|alias]].
function extractLinks(text) {
  const links = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    links.push(m[1].trim());
  }
  return links;
}

module.exports = {
  vaultRoot,
  ensureDir,
  vaultPath,
  readText,
  writeText,
  readJSON,
  writeJSON,
  listFiles,
  extractLinks,
};
