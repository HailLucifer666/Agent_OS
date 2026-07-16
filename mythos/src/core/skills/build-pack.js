'use strict';

// skills/build-pack.js — per-deliverable skill-essence injection for build
// lanes. Free/low-context brain models produce slop without guidance and
// can't afford full skills, so build prompts get the hand-distilled
// SKILL-CORE.md essences (mythos/skills/<name>/SKILL-CORE.md, ~1-2KB each):
//   UI/frontend deliverable → taste-frontend + ui-ux-pro-max
//   everything else (code)  → ponytail + karpathy-guidelines
// Missing essences are skipped silently — the pack degrades to whatever is
// vendored, never blocks a build.

var loader = require('./loader');

var UI_RE = /\b(landing|web ?page|website|web ?app|ui|ux|frontend|front-end|portfolio|dashboard|design|redesign|html|css|storefront|blog|home ?page|interface|screen|mockup)\b/i;

var PACKS = {
  ui: ['taste-frontend', 'ui-ux-pro-max'],
  code: ['ponytail', 'karpathy-guidelines']
};

function classifyDeliverable(text) {
  return UI_RE.test(String(text || '')) ? 'ui' : 'code';
}

// Composed essence block for an explicit pack kind ('ui' | 'code'), or '' if
// nothing is available. Callers prepend it to the build prompt.
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

module.exports = {
  classifyDeliverable: classifyDeliverable,
  packBlock: packBlock,
  packBlockFor: packBlockFor,
  _PACKS: PACKS
};
