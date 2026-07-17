'use strict';

// skills/loader.js — discovers external ZCode skills from a curated allowlist.
//
// Problem this solves: Mythos is a standalone Node process with its own brain
// and tool system. The skills at ~/.zcode/skills/* belong to the ZCode CLI
// runtime and were completely invisible to Mythos — the model was never told
// they exist. This loader bridges that gap by reading a curated allowlist,
// parsing each skill's SKILL.md frontmatter, and exposing a compact catalog
// for prompt injection plus on-demand full-content loading.
//
// The allowlist (mythos/skills.allowlist) is human-edited: one skill name per
// line, '#' comments allowed. This keeps the prompt lean (only curated skills)
// rather than injecting all 167 available skills into every brain call.
//
// Resolves ~/.zcode from USERPROFILE (Windows) or HOME (Unix), never hardcoded.

var fs = require('fs');
var path = require('path');

var ALLOWLIST_PATH = path.join(__dirname, '..', '..', '..', 'skills.allowlist');

// Repo-local vendored skills (mythos/skills/<name>/SKILL.md) — resolved FIRST
// so a fresh clone works with zero external installs (open-source portability).
// ~/.zcode/skills remains the fallback for skills not vendored into the repo.
var REPO_SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills');

function zcodeRoot() {
  var home = process.env.USERPROFILE || process.env.HOME || '';
  return home ? path.join(home, '.zcode') : '';
}

function skillsDir() {
  return path.join(zcodeRoot(), 'skills');
}

// Read + parse the allowlist into a de-duplicated list of skill names.
function readAllowlist() {
  try {
    var raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
  } catch (_) {
    return [];
  }
  var seen = {};
  var names = [];
  raw.split('\n').forEach(function(line) {
    var name = line.trim();
    if (!name || name.charAt(0) === '#') return;
    if (seen[name]) return;
    seen[name] = true;
    names.push(name);
  });
  return names;
}

// Minimal YAML frontmatter parser: extract `name` and `description` from the
// ---delimited block at the top of a SKILL.md. No dep — the frontmatter is
// flat key:value, not nested.
function parseFrontmatter(text) {
  var fm = {};
  var m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return fm;
  var body = m[1];
  // description may span multiple lines or be quoted. Handle the common
  // single-line and double-quoted forms; fall back to greedy to end-of-value.
  var nameM = body.match(/^name:\s*(.+)$/m);
  if (nameM) fm.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  // description: try double-quoted, single-quoted, then bare-to-EOL
  var descM = body.match(/^description:\s*"([\s\S]*?)"\s*$/m)
    || body.match(/^description:\s*'([\s\S]*?)'\s*$/m)
    || body.match(/^description:\s*(.+)$/m);
  if (descM) fm.description = descM[1].trim().replace(/\s+/g, ' ');
  return fm;
}

function skillPath(name) {
  var local = path.join(REPO_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(local)) return local;
  return path.join(skillsDir(), name, 'SKILL.md');
}

// Build the catalog: [{ name, description }] for each allowlisted skill that
// actually exists on disk. Missing skills are silently skipped (the allowlist
// is advisory, not a hard contract — a skill may be removed upstream).
var cachedCatalog = null;

// Names from the allowlist that failed to resolve on the most recent
// loadCatalog() call (fresh clones commonly miss the ~/.zcode/skills/*
// fallback packs — 11 of 16 today, since only 5 are vendored into the repo).
// Not an error per-file (the allowlist is advisory), but silently dropping
// two-thirds of it with no signal anywhere is the dishonest-ok pattern this
// handoff targets — callers that have a logger can surface it (see
// loadCatalog(opts.logger) below; main.js's boot sequence is the one that does).
var lastMissing = [];

function loadCatalog(opts) {
  if (cachedCatalog) return cachedCatalog;
  var dir = skillsDir();
  var catalog = [];
  var missing = [];
  readAllowlist().forEach(function(name) {
    var p = skillPath(name);
    try {
      var raw = fs.readFileSync(p, 'utf8');
      var fm = parseFrontmatter(raw);
      catalog.push({
        name: fm.name || name,
        description: fm.description || '(no description available)'
      });
    } catch (_) {
      // Skill missing or unreadable — skip. Not an error condition, but
      // recorded so a caller with a logger can warn about the gap.
      missing.push(name);
    }
  });
  lastMissing = missing;
  if (opts && opts.logger && missing.length) {
    opts.logger.warn('skills.loader.missing-packs', { missing: missing, resolved: catalog.length, allowlisted: catalog.length + missing.length });
  }
  cachedCatalog = catalog;
  return catalog;
}

// Load the full SKILL.md body (frontmatter stripped) for on-demand use.
// Called by the use_skill tool when the model decides to apply a skill.
function loadContent(name) {
  if (!name) return null;
  try {
    var raw = fs.readFileSync(skillPath(name), 'utf8');
    // Strip frontmatter for prompt injection — the body is the guidance.
    return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
  } catch (_) {
    return null;
  }
}

// Load the condensed essence (SKILL-CORE.md, repo-local vendored skills only).
// Build-lane prompts inject essences, not full skills — the free/low-context
// brain models can't afford 80KB of guidance per call. Returns null when the
// skill has no essence (callers skip it — never a hard failure).
function loadEssence(name) {
  if (!name) return null;
  try {
    var raw = fs.readFileSync(path.join(REPO_SKILLS_DIR, name, 'SKILL-CORE.md'), 'utf8');
    return raw.trim();
  } catch (_) {
    return null;
  }
}

// Compact one-line-per-skill block for prompt injection.
function catalogBlock() {
  var cat = loadCatalog();
  if (!cat.length) return '';
  var lines = ['SKILLS AVAILABLE (methodology + design guides — call use_skill with the name to load full guidance):'];
  cat.forEach(function(s) {
    // Truncate description to keep the prompt lean (~120 chars per skill).
    var desc = s.description.length > 120 ? s.description.slice(0, 117) + '...' : s.description;
    lines.push('- ' + s.name + ': ' + desc);
  });
  return lines.join('\n');
}

function refresh(opts) {
  cachedCatalog = null;
  return loadCatalog(opts);
}

module.exports = {
  loadCatalog: loadCatalog,
  loadContent: loadContent,
  loadEssence: loadEssence,
  catalogBlock: catalogBlock,
  refresh: refresh,
  // Exports for testing
  _parseFrontmatter: parseFrontmatter,
  _readAllowlist: readAllowlist,
  _skillPath: skillPath,
  _ALLOWLIST_PATH: ALLOWLIST_PATH,
};
