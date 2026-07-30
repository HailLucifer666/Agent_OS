'use strict';

// skills/loader.js — discovers external agent skills from a curated allowlist.
//
// Problem this solves: Mythos is a standalone Node process with its own brain
// and tool system. Agent skills installed for a HOST CLI (Claude Code, ZCode)
// live outside the repo and were completely invisible to Mythos — the model was
// never told they exist. This loader bridges that gap by reading a curated
// allowlist, parsing each skill's SKILL.md frontmatter, and exposing a compact
// catalog for prompt injection plus on-demand full-content loading.
//
// The allowlist (mythos/skills.allowlist) is human-edited: one skill name per
// line, '#' comments allowed. This keeps the prompt lean (only curated skills)
// rather than injecting all 167 available skills into every brain call.
//
// MULTI-ROOT RESOLUTION (2026-07-31 fix). This used to resolve exactly ONE
// external root — `~/.zcode/skills` — and nothing else. On a machine driving
// Mythos from Claude Code (the documented setup) that directory does not exist,
// so every non-vendored skill silently failed to resolve. Two real consequences,
// both invisible in testing:
//   * loadCatalog() dropped most of the allowlist, so those skills were absent
//     from every prompt.
//   * skills/build-pack.js probes '<skill>/scripts/search.py' to run a REAL
//     design-system lookup. It always missed, so every UI build quietly fell
//     back to design/system.js's bundled-CSV substitute while the operator
//     believed their installed ui-ux-pro-max was driving the output.
// Roots are now an ORDERED candidate list, searched first-match-wins:
//   1. $MYTHOS_SKILLS_DIR   — explicit override, path.delimiter-separated.
//   2. <home>/.claude/skills                                  (personal skills)
//   3. <home>/.claude/plugins/marketplaces/<pack>/src         (plugin packs)
//   4. <home>/.claude/plugins/marketplaces/<pack>/.claude/skills
//   5. <home>/.zcode/skills                          (original, back-compat)
// Both plugin layouts in 3/4 are real and observed in the wild — a pack may put
// its skills under src/ or under a nested .claude/skills/. Home is always
// derived from USERPROFILE/HOME; nothing here is ever a hardcoded user path
// (see test/skills-external-roots.test.js, which asserts that too).

var fs = require('fs');
var path = require('path');

var ALLOWLIST_PATH = path.join(__dirname, '..', '..', '..', 'skills.allowlist');

// Repo-local vendored skills (mythos/skills/<name>/SKILL.md) — resolved FIRST
// so a fresh clone works with zero external installs (open-source portability).
// External roots are the fallback for skills not vendored into the repo.
var REPO_SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills');

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

// Read the override fresh every call — never cached. An operator who exports
// MYTHOS_SKILLS_DIR and restarts must see it take effect, and the tests change
// it between cases.
function overrideRoots() {
  var raw = process.env.MYTHOS_SKILLS_DIR;
  if (!raw) return [];
  return String(raw).split(path.delimiter)
    .map(function(p) { return p.trim(); })
    .filter(function(p) { return p.length > 0; });
}

// Enumerate <home>/.claude/plugins/marketplaces/*/{src,.claude/skills}. A
// readdir, not a hardcoded pack list, so installing a new plugin pack needs no
// code change. Unreadable/absent -> [] (never throws: a missing plugin
// directory is the normal case, not an error).
function pluginRoots(home) {
  if (!home) return [];
  var marketplaces = path.join(home, '.claude', 'plugins', 'marketplaces');
  var packs;
  try {
    packs = fs.readdirSync(marketplaces, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; });
  } catch (_) {
    return [];
  }
  var roots = [];
  packs.forEach(function(pack) {
    roots.push(path.join(marketplaces, pack, 'src'));
    roots.push(path.join(marketplaces, pack, '.claude', 'skills'));
  });
  return roots;
}

// The ordered candidate roots, override first. Exported so an operator whose
// skills silently fail to resolve can see exactly where Mythos looked instead
// of guessing — the diagnostic that would have made this bug obvious.
function externalSkillRoots() {
  var home = homeDir();
  var roots = overrideRoots();
  if (home) {
    roots.push(path.join(home, '.claude', 'skills'));
    roots = roots.concat(pluginRoots(home));
    roots.push(path.join(home, '.zcode', 'skills'));
  }
  // De-duplicate while preserving order.
  var seen = {};
  return roots.filter(function(r) {
    if (seen[r]) return false;
    seen[r] = true;
    return true;
  });
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

function exists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

// Repo-vendored first (fresh-clone determinism), then each external root in
// order. Returns the LAST candidate when nothing exists, so callers that read
// it get a sensible ENOENT path rather than ''.
function skillPath(name) {
  var local = path.join(REPO_SKILLS_DIR, name, 'SKILL.md');
  if (exists(local)) return local;
  var roots = externalSkillRoots();
  for (var i = 0; i < roots.length; i++) {
    var candidate = path.join(roots[i], name, 'SKILL.md');
    if (exists(candidate)) return candidate;
  }
  return roots.length ? path.join(roots[roots.length - 1], name, 'SKILL.md') : local;
}

// Resolve a skill's directory. Repo-local (mythos/skills/<name>/) is checked
// first so a fresh clone works with zero external installs, then every external
// root in order.
// NOTE: many skills are vendored repo-local as essence-only (SKILL-CORE.md,
// no scripts/data), while their full install with tooling lives in a host CLI's
// skill directory. For locating runnable assets prefer resolveSkillFile() below,
// which checks every location for the specific file. Returns '' if no dir exists.
function skillDir(name) {
  var local = path.join(REPO_SKILLS_DIR, name);
  if (exists(local)) return local;
  var roots = externalSkillRoots();
  for (var i = 0; i < roots.length; i++) {
    var external = path.join(roots[i], name);
    if (exists(external)) return external;
  }
  return '';
}

// Resolve a specific asset within a skill, checking EVERY known location and
// returning the SKILL ROOT dir that contains the file. This is the correct
// resolver for runnable assets (scripts/search.py, data/*.csv): a skill may be
// vendored repo-local as essence-only while its tooling lives in a host CLI's
// install. Returns the skill root (e.g. .../ui-ux-pro-max), or '' if no location
// has the file. Callers append relPath to the returned dir to get the full
// script path, and use the returned dir as cwd so the script can reach
// sibling assets (data/*.csv) via relative paths.
//
// External roots are searched BEFORE the repo-vendored copy here (unlike
// skillPath/skillDir): the vendored copies are deliberately essence-only, so a
// real installed skill's tooling should win when it exists.
function resolveSkillFile(name, relPath) {
  var roots = externalSkillRoots();
  for (var i = 0; i < roots.length; i++) {
    if (exists(path.join(roots[i], name, relPath))) return path.join(roots[i], name);
  }
  if (exists(path.join(REPO_SKILLS_DIR, name, relPath))) return path.join(REPO_SKILLS_DIR, name);
  return '';
}

// Does a file exist relative to ANY known skill dir location? Used by
// run-skill-tool.js to probe whether a skill ships a runnable tool before
// shelling out. Returns false if the skill or the file is absent everywhere.
function skillFileExists(name, relPath) {
  return resolveSkillFile(name, relPath) !== '';
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
  skillDir: skillDir,
  skillFileExists: skillFileExists,
  resolveSkillFile: resolveSkillFile,
  // Where Mythos actually looks for external skills, in order. Exported as a
  // first-class diagnostic: the 2026-07-31 bug was invisible precisely because
  // nothing could report the searched roots.
  externalSkillRoots: externalSkillRoots,
  // Exports for testing
  _parseFrontmatter: parseFrontmatter,
  _readAllowlist: readAllowlist,
  _skillPath: skillPath,
  _skillDir: skillDir,
  _ALLOWLIST_PATH: ALLOWLIST_PATH,
};
