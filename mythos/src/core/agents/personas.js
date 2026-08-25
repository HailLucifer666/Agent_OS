'use strict';

// agents/personas.js — specialized agent persona registry. Each role has a
// markdown file defining its expertise, standards and disposition. Loaded on
// demand and cached. Used by the kanban reviewer/reality-checker seats and by
// the mission orchestrator's builder agents.
//
// RESOLUTION ORDER (2026-08-15 fix). This used to resolve exactly ONE directory,
// `mythos/vault/Personas/` — which is GITIGNORED and did not exist. So
// loadPersona() returned null for every role on every machine, and every seat
// that asked for a persona silently got the global identity instead. Nothing
// threw; the reviewer simply reviewed as generic MYTHOS. Two consequences worth
// naming, because neither is visible in a diff or a test run:
//   * The specialised seats were specialised in name only. The lane rewire of
//     2026-08-14 moved the reviewer and reality-checker onto a 4/4 reasoning
//     model, which makes the missing brief MORE costly, not less — a strong
//     model with no brief is confidently generic.
//   * A gitignored directory can never ship. Authoring personas there would
//     have fixed one machine and no clone, which the repo's open-source
//     portability rule forbids.
// Roots are now an ORDERED candidate list, first match wins:
//   1. $MYTHOS_PERSONAS_DIR — explicit override, path.delimiter-separated.
//   2. mythos/vault/Personas/ — the OPERATOR's own edits. First among the
//      built-ins on purpose: it is their data, and a customisation that loses
//      to a shipped default is a customisation that does nothing.
//   3. mythos/personas/ — tracked defaults, so a fresh clone has real personas
//      with zero setup. This is the same repo-local-so-a-clone-works discipline
//      skills/loader.js applies to vendored skills.
//
// WHAT BELONGS IN A PERSONA FILE, and what must not: the persona is the SYSTEM
// identity — who this agent is, what it is expert in, what it refuses to do.
// The task and the output contract (the JSON shape, the criteria list) live in
// the caller's preamble (review-rubric.js's buildReviewerPreamble and
// REALITY_CHECK_PREAMBLE). Restating the JSON shape in a persona file would
// create a second source of truth for it, and the two would drift.

var fs = require('fs');
var path = require('path');

var MYTHOS_ROOT = path.join(__dirname, '..', '..', '..');
var VAULT_PERSONAS_DIR = path.join(MYTHOS_ROOT, 'vault', 'Personas');
var REPO_PERSONAS_DIR = path.join(MYTHOS_ROOT, 'personas');

var cache = {};

// Read the override fresh every call — never cached at module load. An operator
// who exports MYTHOS_PERSONAS_DIR and restarts must see it take effect, and the
// tests change it between cases. Same rule skills/loader.js states for
// MYTHOS_SKILLS_DIR, for the same reason.
function overrideRoots() {
  var raw = process.env.MYTHOS_PERSONAS_DIR;
  if (!raw) return [];
  return String(raw).split(path.delimiter)
    .map(function(p) { return p.trim(); })
    .filter(function(p) { return p.length > 0; });
}

function roots() {
  return overrideRoots().concat([VAULT_PERSONAS_DIR, REPO_PERSONAS_DIR]);
}

// Reject anything that could escape the persona directories. Role names reach
// here from pickBuilderPersona() and from literal call sites today, but a role
// string is exactly the kind of value that later arrives from a config file or
// a model, and path.join('..','..','etc','passwd') would read it.
function isSafeRole(role) {
  return typeof role === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(role);
}

function loadPersona(role) {
  if (!role) return null;
  if (!isSafeRole(role)) return null;
  if (Object.prototype.hasOwnProperty.call(cache, role)) return cache[role];
  var candidates = roots();
  for (var i = 0; i < candidates.length; i++) {
    try {
      var content = fs.readFileSync(path.join(candidates[i], role + '.md'), 'utf8');
      cache[role] = content.trim();
      return cache[role];
    } catch (err) {
      // Missing in this root is the normal case, not an error — try the next.
    }
  }
  // Cache the miss too. Without this, a role with no file re-stats every root on
  // every call, and the reviewer seat runs on every build.
  cache[role] = null;
  return null;
}

function listPersonas() {
  var seen = {};
  var out = [];
  var candidates = roots();
  for (var i = 0; i < candidates.length; i++) {
    var entries;
    try {
      entries = fs.readdirSync(candidates[i]);
    } catch (err) {
      continue; // absent root is normal
    }
    for (var j = 0; j < entries.length; j++) {
      if (!entries[j].endsWith('.md')) continue;
      var name = entries[j].slice(0, -3);
      if (name === 'README') continue; // documentation, not a persona
      if (seen[name]) continue;        // earlier root already won
      seen[name] = true;
      out.push(name);
    }
  }
  return out;
}

// Test seam. The cache is keyed by role and deliberately caches misses, so a
// test that changes MYTHOS_PERSONAS_DIR between cases must clear it or it is
// asserting against the previous case's answer.
function _resetCache() {
  cache = {};
}

// Pick the best persona for a kanban card based on its title/detail content
function pickBuilderPersona(cardTitle, cardDetail) {
  var text = ((cardTitle || '') + ' ' + (cardDetail || '')).toLowerCase();
  var frontendKeywords = ['ui', 'ux', 'page', 'landing', 'frontend', 'design', 'css', 'layout', 'component', 'navigation', 'dashboard', 'form', 'button', 'hero', 'sidebar', 'interface'];
  for (var i = 0; i < frontendKeywords.length; i++) {
    if (text.includes(frontendKeywords[i])) return 'frontend-builder';
  }
  return 'backend-builder';
}

module.exports = {
  loadPersona: loadPersona,
  listPersonas: listPersonas,
  pickBuilderPersona: pickBuilderPersona,
  _resetCache: _resetCache,
  _internal: { VAULT_PERSONAS_DIR: VAULT_PERSONAS_DIR, REPO_PERSONAS_DIR: REPO_PERSONAS_DIR, roots: roots, isSafeRole: isSafeRole },
};
