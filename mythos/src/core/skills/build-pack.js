'use strict';

// skills/build-pack.js — intent → skill router for build lanes.
//
// Two layers of skill involvement, both automatic (no slash commands):
//
//   1. ESSENCE INJECTION (synchronous, always-on). Free/low-context brain
//      models produce slop without guidance, so every build prompt gets the
//      hand-distilled SKILL-CORE.md essences for its deliverable kind (see
//      PACKS below). This is the existing behavior; packBlock(text) is
//      unchanged in shape.
//
//   2. SKILL-TOOL INVOCATION (async, auto-routed, graceful-degrading). When
//      the deliverable is UI/frontend AND the ui-ux-pro-max skill is installed
//      with its real scripts/search.py tool, run it to resolve a genuine
//      design system from the skill's full CSV database (192 palettes / 84
//      styles / 74 font pairings) — instead of the weaker home-grown
//      substitute in design/system.js. Returns null if the skill or Python is
//      absent; callers fall back to designSystemEngine in that case. Never
//      blocks a build.
//
// The router is data-driven: ROUTES maps a kind to the skill-tool invocation.
//
// WHICH LEVER FOR WHICH SKILL (the distinction this router is built on):
// an "essence" skill is guidance the build model FOLLOWS, so injecting its text
// works (ponytail, karpathy-guidelines, taste-frontend, ui-ux-pro-max, the
// superpowers methodology skills). A "tool-driver" skill is guidance on how to
// RUN an external tool (agent-reach, strix-security, browser-use,
// desktop-commander, okf-knowledge) — pasting its doc into a one-shot artifact
// prompt does nothing, because the model cannot execute a paragraph. Those
// belong in ROUTES, where the tool runs and its OUTPUT is injected.
//
// Deliberately NOT wired here:
//   * strix-security as a generation-time tool — Strix scans a target that
//     already exists, so it cannot run while the artifact is being generated.
//     Its essence primes the model at build time; the actual scan stays the
//     security_scan effector the brain invokes AFTER a build, gated by that
//     effector's authorized_by rule. Do not "fix" this by adding a ROUTES
//     entry for it: it would run against an empty directory and report nothing.
//   * browser-use / desktop-commander / okf-knowledge — brain-called effectors
//     and MCP tools, not build-generation skills.

var loader = require('./loader');
var runSkillTool = require('./run-skill-tool');
var { execFile } = require('child_process');

// Classification regexes, applied in the documented precedence order below.
var UI_RE = /\b(landing|web ?page|website|web ?app|ui|ux|frontend|front-end|portfolio|dashboard|design|redesign|html|css|storefront|blog|home ?page|interface|screen|mockup)\b/i;
// Stems, not whole words: "investigate"/"analysis"/"summarise" must all match,
// and a trailing \b after a stem like `investigat` never matches.
var RESEARCH_RE = /\b(research|analy[sz]|report|investigat|deep.?dive|summar|competitive|market|literature)/i;
// Deliberately narrow — real security work, not any brief that mentions a
// password field. "secure login page" stays a UI build (UI_RE wins first).
var SECURITY_RE = /\b(pentest|vulnerab|security audit|threat model|auth flow|owasp|exploit)/i;
var APP_RE = /\b(app|full.?stack|backend|api|server|database|multi.?file|system|service|cli tool)\b/i;

// Essence packs per deliverable kind. Each addition earns its place:
var PACKS = {
  // hallmark (anti-slop hard rules: honest copy, locked tokens, mobile floor,
  // pre-emit self-critique) and diagram-design (deletion-first schematic
  // discipline) joined 2026-08-14. diagram-design sits LAST so the budget cap
  // drops it first — it matters for the subset of UI briefs that are diagrams,
  // while the other three carry every page build.
  ui: ['taste-frontend', 'hallmark', 'ui-ux-pro-max', 'diagram-design'],
  code: ['ponytail', 'karpathy-guidelines'],
  // Full builds are multi-file and long-lived: root-cause discipline and an
  // explicit finish-check matter more here than in a single-file snippet.
  // NOTE: test-driven-development is deliberately omitted — its red→green loop
  // has no meaning in one-shot artifact generation, so injecting it would be
  // cargo-cult discipline the model can only pantomime.
  app: ['ponytail', 'karpathy-guidelines', 'systematic-debugging', 'verification-before-completion'],
  // Discipline only; the actual fetch is a ROUTES entry (agent-reach), because
  // research needs data, not a paragraph about research.
  research: ['ponytail', 'karpathy-guidelines'],
  // strix-security's essence primes the security surface at generation time;
  // the scan itself is a post-build effector (see the header note).
  security: ['ponytail', 'karpathy-guidelines', 'strix-security'],
};

// Composed-block budget. app/security stack 3–4 essences (~1–2 KB each) against
// a free/low-context build model, so the composition needs a ceiling the way
// each individual essence already has one (skills-build-pack.test.js asserts
// < 4000 per essence). 8000 is sized to fit the largest real pack (app, ~6.2 KB
// today) with headroom — a smaller cap would silently drop the very essences
// that pack exists to add.
var MAX_PACK_CHARS = 8000;

// ui-ux-pro-max's search.py keyword-matches the WHOLE query string against its
// pattern / style / typography databases, so passing the raw card text let the
// ARTICLE CONTENT choose the design.
//
// Live on 2026-07-31 (operator-reported): a news-digest card whose copy
// mentioned "price-performance", "security tests" and "agents" resolved to
// pattern "Pricing Page + CTA", style "Trust & Authority" (certificate and
// security badges) and JetBrains Mono for both heading and body. The built page
// therefore carried a <section id="pricing">, ISO/SOC2/GDPR badge carousel and
// terminal typography — for a news site. The same brief with the content
// stripped resolves to Newsreader/Roboto and an editorial section order.
//
// So the query is the design INTENT only: the leading design sentence, plus any
// style word that appears later in the brief and would otherwise be lost.
var CONTENT_MARKER_RE = /\b(main feature|headline|supporting stor|based on|featuring|content:|stories:|articles:|copy:|topics?:)\b/i;
var STYLE_WORDS = [
  'dark mode', 'dark-themed', 'dark theme', 'light mode', 'glassmorphism',
  'neumorphism', 'claymorphism', 'brutalist', 'minimal', 'editorial',
  'premium', 'luxury', 'playful', 'corporate', 'retro', 'bento', 'neon',
];
var MAX_QUERY_CHARS = 160;

function designQuery(brief) {
  var text = String(brief == null ? '' : brief).replace(/\s+/g, ' ').trim();
  if (!text) return 'web landing page';

  var head = text;
  var marker = text.search(CONTENT_MARKER_RE);
  if (marker > 20) head = head.slice(0, marker);
  var sentence = head.search(/\.\s/);
  if (sentence > 20) head = head.slice(0, sentence);
  head = head.slice(0, MAX_QUERY_CHARS).trim().replace(/[,;:.]+$/, '');
  if (!head) return 'web landing page';

  var lower = head.toLowerCase();
  var tail = text.slice(head.length).toLowerCase();
  var missed = STYLE_WORDS.filter(function (w) {
    return tail.indexOf(w) !== -1 && lower.indexOf(w) === -1;
  });
  return missed.length ? head + ' ' + missed.join(' ') : head;
}

// ---- agent-reach (research route) ------------------------------------------
// agent-reach is a pip-installed CLI, not a script vendored inside the skill
// dir, so it cannot go through run-skill-tool's interpreter path. Same shape as
// socialResearchForBuild() in effectors/agent-actions.js: probe once, cache,
// degrade to null. Kept here rather than imported because agent-actions builds
// its probe inside a factory closure; duplicating ~15 lines beats exporting a
// second agent-reach path out of the effector layer.
var agentReachAvailable = null;

function isAgentReachAvailable() {
  if (agentReachAvailable !== null) return Promise.resolve(agentReachAvailable);
  return new Promise(function(resolve) {
    execFile('agent-reach', ['--version'], { timeout: 3000, windowsHide: true }, function(err) {
      agentReachAvailable = !err;
      resolve(agentReachAvailable);
    });
  });
}

function runAgentReach(args) {
  return new Promise(function(resolve) {
    execFile('agent-reach', args, { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 512 }, function(err, stdout) {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

var MAX_RESEARCH_CHARS = 1600;

// Query reddit + hackernews for community discussion on the brief's topic.
// Returns null when agent-reach is absent or returns nothing — the caller then
// builds exactly as it does today.
async function researchForBrief(brief) {
  var topic = designQuery(brief).slice(0, 120);
  if (!topic) return null;
  if (!await isAgentReachAvailable()) return null;
  try {
    var results = [];
    var reddit = await runAgentReach(['reddit', '--query', topic, '--limit', '2']);
    if (reddit) results.push('[reddit] ' + reddit.slice(0, 600));
    var hn = await runAgentReach(['hackernews', '--query', topic, '--limit', '2']);
    if (hn) results.push('[hackernews] ' + hn.slice(0, 600));
    if (!results.length) return null;
    var out = results.join('\n');
    return out.length > MAX_RESEARCH_CHARS ? out.slice(0, MAX_RESEARCH_CHARS) + '\n[...truncated]' : out;
  } catch (_) {
    return null;
  }
}

// Skill-tool routes: kind → { skill, script + buildArgs(brief) } for scripts
// run through run-skill-tool, or { skill, run(brief), inject(out) } for a
// skill whose tool is a plain CLI. Only kinds with a runnable skill tool belong
// here; every other kind relies on essences alone.
var ROUTES = {
  ui: {
    skill: 'ui-ux-pro-max',
    script: 'scripts/search.py',
    // --design-system resolves a full design system (pattern/style/colors/
    // typography/effects) from the skill's database; -f markdown keeps it
    // prompt-friendly. --stack html-tailwind matches what this pipeline
    // actually emits (one self-contained HTML file using Tailwind), so the
    // guidance comes back for the right stack instead of a generic one.
    buildArgs: function(brief) {
      return [designQuery(brief), '--design-system', '-f', 'markdown', '--stack', 'html-tailwind'];
    },
  },
  research: {
    skill: 'agent-reach',
    // The skill doc must be installed for the route to be considered skill-
    // backed; the CLI probe inside run() is what actually gates execution.
    script: 'SKILL.md',
    run: researchForBrief,
    inject: function(out) {
      return 'RESEARCH FINDINGS (ground the build in these — community signal, verify facts):\n' + out;
    },
  },
};

// Deliverable kind, first match wins in this documented order:
//   ui       — visual briefs win outright ("secure login page" is a UI build
//              that happens to mention auth).
//   research — a report/analysis, not an artifact to run.
//   security — real security work (checked before app so "audit this API"
//              routes to security, not app).
//   app      — multi-file / backend / service builds.
//   code     — the default.
// Still returns a single string kind, so the pre-existing 'ui' | 'code'
// contract and its callers are unchanged.
function classifyDeliverable(text) {
  var s = String(text || '');
  if (UI_RE.test(s)) return 'ui';
  if (RESEARCH_RE.test(s)) return 'research';
  if (SECURITY_RE.test(s)) return 'security';
  if (APP_RE.test(s)) return 'app';
  return 'code';
}

// Composed essence block for an explicit pack kind ('ui' | 'code'), or '' if
// nothing is available. Callers prepend it to the build prompt. SYNC only —
// this is the discipline layer, present on every build regardless of whether
// the skill's real tool runs.
// maxChars overrides MAX_PACK_CHARS — only the test uses it, to exercise the
// truncation branch without depending on how large the vendored essences
// happen to be today.
function packBlockFor(kind, maxChars) {
  var cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : MAX_PACK_CHARS;
  var names = PACKS[kind] || PACKS.code;
  var header = 'BUILD DISCIPLINE (follow while producing the deliverable):\n\n';
  var sep = '\n\n---\n\n';
  var parts = [];
  var dropped = [];
  var used = header.length;
  // Compose in pack order (highest-priority essence first) and stop before the
  // cap rather than emitting an oversized block. Anything dropped is named in
  // the output — a silently shortened discipline block reads as "the model was
  // told all of this" when it wasn't.
  names.forEach(function(name) {
    var essence = loader.loadEssence(name);
    if (!essence) return;
    var cost = essence.length + (parts.length ? sep.length : 0);
    if (used + cost > cap) { dropped.push(name); return; }
    parts.push(essence);
    used += cost;
  });
  if (!parts.length) return '';
  var block = header + parts.join(sep);
  if (dropped.length) {
    block += '\n\n[build-pack: omitted for prompt budget — ' + dropped.join(', ') + ']';
  }
  return block;
}

// Convenience: classify a deliverable description, then compose its pack.
function packBlock(text) {
  return packBlockFor(classifyDeliverable(text));
}

// Auto-route a brief through its skill's real tool. Returns the tool's output
// (a design system, research brief, etc.) as a string, or null if:
//   - the kind has no skill-tool route (e.g. plain code builds), or
//   - the skill isn't installed / the script is absent / Python is missing, or
//   - the tool exits non-zero / times out.
// Callers must handle null by falling back to their existing resolver.
async function resolveSkillTool(brief) {
  return resolveSkillToolFor(classifyDeliverable(brief), brief);
}

// Same contract, but for a caller that already knows the kind (hermes-runner
// derives it from the Forge manifest, not from the brief text alone).
async function resolveSkillToolFor(kind, brief) {
  var route = ROUTES[kind];
  if (!route) return null;
  // Fast no-exec probe: skip the round-trip when the skill is obviously absent.
  if (!runSkillTool.skillToolAvailable(route.skill, route.script)) return null;
  if (typeof route.run === 'function') {
    var out = await route.run(brief);
    if (!out) return null;
    return route.inject ? route.inject(out) : out;
  }
  var args = route.buildArgs(brief);
  return runSkillTool.runSkillTool(route.skill, route.script, args, { timeoutMs: 30000 });
}

// Design-system slot only: the UI route, or null for every other kind.
//
// agent-actions.js calls this for EVERY card (its `designSystem` flag is a
// dependency-present check, not a UI check) and falls back to
// design/system.js when it returns null. Before the research route existed,
// resolveSkillTool() happened to behave this way for free. It no longer does —
// a research-shaped card would fetch agent-reach here AND again in
// socialResearchForBuild(), paying twice for the same topic and injecting it
// twice. Naming the slot keeps that path exactly as it was.
async function resolveDesignSystemTool(brief) {
  if (classifyDeliverable(brief) !== 'ui') return null;
  return resolveSkillToolFor('ui', brief);
}

module.exports = {
  classifyDeliverable: classifyDeliverable,
  designQuery: designQuery,
  packBlock: packBlock,
  packBlockFor: packBlockFor,
  resolveSkillTool: resolveSkillTool,
  resolveSkillToolFor: resolveSkillToolFor,
  resolveDesignSystemTool: resolveDesignSystemTool,
  _PACKS: PACKS,
  _ROUTES: ROUTES,
  _MAX_PACK_CHARS: MAX_PACK_CHARS,
  // Exported so a test can assert the honest degradation path instead of
  // depending on whether this machine happens to have agent-reach installed.
  _agentReachAvailable: isAgentReachAvailable,
};
