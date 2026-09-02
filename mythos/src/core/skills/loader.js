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
// line, '#' comments allowed, and a leading '?' marking an entry as OPTIONAL
// (host-installed only, expected to be absent on a fresh clone). This keeps the
// prompt lean (only curated skills) rather than injecting all 167 available
// skills into every brain call.
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
    // Third layout: <pack>/skills/<name>. Real packs in the wild use all three
    // (frontend-ui-engineering ships this way), and a skill in an unsearched
    // layout fails exactly like an uninstalled one — silently.
    roots.push(path.join(marketplaces, pack, 'skills'));
  });
  return roots;
}

// Enumerate <home>/.claude/plugins/installed/*/skills. A pack the host CLI has
// INSTALLED (as opposed to merely having its marketplace checked out) lands
// here, and this layout was unsearched until 2026-08-02 — the same silent
// failure mode as the three marketplace layouts above. Absent/unreadable -> [].
function installedRoots(home) {
  if (!home) return [];
  var installed = path.join(home, '.claude', 'plugins', 'installed');
  var packs;
  try {
    packs = fs.readdirSync(installed, { withFileTypes: true })
      .filter(function(e) { return e.isDirectory(); })
      .map(function(e) { return e.name; });
  } catch (_) {
    return [];
  }
  return packs.map(function(pack) { return path.join(installed, pack, 'skills'); });
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
    roots = roots.concat(installedRoots(home));
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

// Read + parse the allowlist into de-duplicated entries.
//
// A leading '?' marks the entry OPTIONAL: a skill MYTHOS uses when the host CLI
// happens to have it installed, but which is deliberately not vendored (too
// large, or it needs a database this repo does not ship). Optional entries that
// fail to resolve are the NORMAL case on a fresh clone and must not be reported
// as missing — otherwise the honest "these allowlisted skills are absent"
// warning fires on every clean machine and stops being read, which defeats the
// point of having it. A plain entry that fails to resolve is still a real
// problem and is still reported.
function readAllowlistEntries() {
  var raw;
  try {
    raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
  } catch (_) {
    return [];
  }
  var seen = {};
  var entries = [];
  raw.split('\n').forEach(function(line) {
    var text = line.trim();
    if (!text || text.charAt(0) === '#') return;
    var optional = text.charAt(0) === '?';
    var name = optional ? text.slice(1).trim() : text;
    if (!name || seen[name]) return;
    seen[name] = true;
    entries.push({ name: name, optional: optional });
  });
  return entries;
}

// Names only — the shape every existing caller expects.
function readAllowlist() {
  return readAllowlistEntries().map(function(e) { return e.name; });
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
  // YAML block scalars ('description: >' / '|' / '>-' / '|-'). The bare-to-EOL
  // branch above captures only the indicator character, so caveman and ponytail
  // both shipped a catalog description of literally ">" — the one line the model
  // ever sees about a skill, replaced by punctuation. Gather the indented
  // continuation lines instead. Upstream skills use this form freely, so
  // handling it here is what keeps a verbatim vendored SKILL.md usable.
  if (fm.description && /^[>|][-+]?$/.test(fm.description)) {
    fm.description = blockScalar(body, 'description');
  }
  if (fm.name && /^[>|][-+]?$/.test(fm.name)) {
    fm.name = blockScalar(body, 'name');
  }
  return fm;
}

// Collect the indented continuation lines of a YAML block scalar, folded into a
// single line. Stops at the first line that is neither blank nor indented —
// i.e. the next top-level key.
function blockScalar(body, key) {
  var lines = body.split(/\r?\n/);
  var start = -1;
  for (var i = 0; i < lines.length; i++) {
    if (new RegExp('^' + key + ':\\s*[>|][-+]?\\s*$').test(lines[i])) { start = i; break; }
  }
  if (start === -1) return '';
  var collected = [];
  for (var j = start + 1; j < lines.length; j++) {
    var line = lines[j];
    if (/^\s*$/.test(line)) { collected.push(''); continue; }
    if (!/^\s/.test(line)) break;          // next top-level key
    collected.push(line.trim());
  }
  return collected.join(' ').replace(/\s+/g, ' ').trim();
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

// Optional ('?'-prefixed) entries that did not resolve. Absence here is
// expected, so these are never warned about — but they are still recorded, so
// an operator asking "why is ui-ux-pro-max not in the catalog on this machine"
// gets an answer instead of silence.
var lastMissingOptional = [];

function loadCatalog(opts) {
  if (cachedCatalog) return cachedCatalog;
  var catalog = [];
  var missing = [];
  var missingOptional = [];
  readAllowlistEntries().forEach(function(entry) {
    var name = entry.name;
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
      // recorded so a caller with a logger can warn about the gap. An entry
      // marked optional ('?name') is expected to be absent on a fresh clone,
      // so it is tracked separately and never warned about.
      if (entry.optional) missingOptional.push(name);
      else missing.push(name);
    }
  });
  lastMissing = missing;
  lastMissingOptional = missingOptional;
  if (opts && opts.logger && missing.length) {
    opts.logger.warn('skills.loader.missing-packs', { missing: missing, resolved: catalog.length, allowlisted: catalog.length + missing.length });
  }
  cachedCatalog = catalog;
  return catalog;
}

// Load the full SKILL.md body (frontmatter stripped) for on-demand use.
// Called by the use_skill tool when the model decides to apply a skill.
// BUG-266 lane 8A.2 — THE LOADER USED TO DISAGREE WITH ITSELF ABOUT WHETHER A
// SKILL EXISTS.
//
// `loadEssence` prefers the repo-vendored `SKILL-CORE.md` and falls back to an
// installed `SKILL.md`. This function read `SKILL.md` and nothing else. So a
// skill vendored essence-only — `ui-ux-pro-max` is the deliberate case, holding
// `LICENSE` + `SKILL-CORE.md` because the full 45 KB doc needs a Python CSV
// database this repo does not carry — was loadable by one half of the loader and
// NULL to the other. `use_skill('ui-ux-pro-max')` answered "not found" for a
// skill that IS vendored and IS driving every UI build through `loadEssence()`.
//
// MEASURED 2026-09-02, and it corrects this ticket's own claim. The entry says
// `ui-ux-pro-max` is phantom "on every machine". It is not: with a host CLI's
// skill directory present, `skillPath` falls through to the external root and
// this returned 44,380 characters. The contradiction reproduces on a FRESH
// CLONE — external roots absent, `loadContent` NULL, `loadEssence` 1,807 chars —
// which is the same population as lane 8A.1 rather than a separate "every
// machine" defect.
//
// THE FALLBACK IS LABELLED, AND THAT IS THE LOAD-BEARING PART. Returning the
// condensed core silently, in a call whose contract is "the complete skill
// instructions", is a quiet downgrade of exactly the kind this repo keeps
// finding: the model would apply a 26-line summary believing it held the full
// guide, and report accordingly. The prefix states what arrived and what did
// not, so a thin answer is legible as thin.
var ESSENCE_ONLY_NOTICE =
  '[CONDENSED CORE ONLY — the full skill is not installed on this machine, so this is the '
  + "repo-vendored essence (SKILL-CORE.md), not the complete guide. Apply it, but do not claim "
  + 'you consulted the full skill, and say so if the task needs detail this does not cover.]';

function loadContent(name) {
  if (!name) return null;
  try {
    var raw = fs.readFileSync(skillPath(name), 'utf8');
    // Strip frontmatter for prompt injection — the body is the guidance.
    return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
  } catch (_) { /* no SKILL.md anywhere — fall through to the vendored essence */ }
  try {
    var core = fs.readFileSync(path.join(REPO_SKILLS_DIR, name, 'SKILL-CORE.md'), 'utf8');
    var body = core.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    return body ? ESSENCE_ONLY_NOTICE + '\n\n' + body : null;
  } catch (_) {
    return null;
  }
}

// How much of an external SKILL.md to use when it has no vendored essence.
// Enough to carry the skill's actual guidance, small enough that several can
// share one build prompt.
var ESSENCE_FALLBACK_LINES = 40;
var ESSENCE_FALLBACK_CHARS = 4000;

// Load the condensed essence for build-lane prompt injection. Build prompts
// inject essences, not full skills — the free/low-context brain models can't
// afford 80KB of guidance per call.
//
// Prefers the repo-vendored SKILL-CORE.md (hand-condensed, ~26 lines). Falls
// back to the HEAD of an installed skill's own SKILL.md, so a skill cloned from
// GitHub into any search root contributes to builds immediately instead of
// needing someone to hand-write an essence into this repo first. Without the
// fallback, `git clone`ing a skill made it visible to use_skill but left it
// silently absent from the automatic injection every UI build depends on.
//
// Returns null when the skill has no essence anywhere (callers skip it — never a
// hard failure).
function loadEssence(name) {
  if (!name) return null;
  try {
    var raw = fs.readFileSync(path.join(REPO_SKILLS_DIR, name, 'SKILL-CORE.md'), 'utf8');
    return raw.trim();
  } catch (_) { /* no vendored essence — try the installed skill itself */ }
  try {
    var dir = resolveSkillFile(name, 'SKILL.md');
    if (!dir) return null;
    var full = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    // Drop frontmatter: it is metadata for the loader, not guidance for a build.
    var body = full.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    if (!body) return null;
    var head = body.split(/\r?\n/).slice(0, ESSENCE_FALLBACK_LINES).join('\n');
    return head.slice(0, ESSENCE_FALLBACK_CHARS).trim() || null;
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
  // Which allowlist entries failed to resolve on the last loadCatalog().
  // required[] is a real gap; optional[] is the expected fresh-clone state.
  lastMissing: function() { return { required: lastMissing.slice(), optional: lastMissingOptional.slice() }; },
  // Exports for testing
  _parseFrontmatter: parseFrontmatter,
  _readAllowlist: readAllowlist,
  _readAllowlistEntries: readAllowlistEntries,
  _skillPath: skillPath,
  _skillDir: skillDir,
  _ALLOWLIST_PATH: ALLOWLIST_PATH,
};
