'use strict';

// skills/build-pack.js — intent → skill router for build lanes.
//
// Two layers of skill involvement, both automatic (no slash commands):
//
//   1. ESSENCE INJECTION (synchronous, always-on). Free/low-context brain
//      models produce slop without guidance, so every build prompt gets the
//      hand-distilled SKILL-CORE.md essences for its deliverable kind:
//        UI/frontend  → taste-frontend + ui-ux-pro-max
//        code/backend → ponytail + karpathy-guidelines
//      This is the existing behavior; build-pack.packBlock(text) is unchanged.
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
// The router is data-driven: ROUTES maps a kind to the skill-tool invocation
// (script + arg-builder). Adding a new route (e.g. app-builds →
// using-superpowers, research → deep-research) is one entry.

var loader = require('./loader');
var runSkillTool = require('./run-skill-tool');

var UI_RE = /\b(landing|web ?page|website|web ?app|ui|ux|frontend|front-end|portfolio|dashboard|design|redesign|html|css|storefront|blog|home ?page|interface|screen|mockup)\b/i;

var PACKS = {
  ui: ['taste-frontend', 'ui-ux-pro-max'],
  code: ['ponytail', 'karpathy-guidelines'],
};

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

// Skill-tool routes: kind → { skill, script, buildArgs(brief) }.
// Only kinds with a runnable skill tool belong here. Others rely on essences.
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
};

function classifyDeliverable(text) {
  return UI_RE.test(String(text || '')) ? 'ui' : 'code';
}

// Composed essence block for an explicit pack kind ('ui' | 'code'), or '' if
// nothing is available. Callers prepend it to the build prompt. SYNC only —
// this is the discipline layer, present on every build regardless of whether
// the skill's real tool runs.
function packBlockFor(kind) {
  var names = PACKS[kind] || PACKS.code;
  var parts = [];
  names.forEach(function(name) {
    var essence = loader.loadEssence(name);
    if (essence) parts.push(essence);
  });
  if (!parts.length) return '';
  return 'BUILD DISCIPLINE (follow while producing the deliverable):\n\n' +
    parts.join('\n\n---\n\n');
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
  var kind = classifyDeliverable(brief);
  var route = ROUTES[kind];
  if (!route) return null;
  // Fast no-exec probe: skip the execFile round-trip when obviously absent.
  if (!runSkillTool.skillToolAvailable(route.skill, route.script)) return null;
  var args = route.buildArgs(brief);
  return runSkillTool.runSkillTool(route.skill, route.script, args, { timeoutMs: 30000 });
}

module.exports = {
  classifyDeliverable: classifyDeliverable,
  designQuery: designQuery,
  packBlock: packBlock,
  packBlockFor: packBlockFor,
  resolveSkillTool: resolveSkillTool,
  _PACKS: PACKS,
  _ROUTES: ROUTES,
};
