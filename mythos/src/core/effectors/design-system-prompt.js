'use strict';

// effectors/design-system-prompt.js — BUG-310: resolve the design system and
// prepend it to a build prompt, in one place, for callers that need it BEFORE
// the prompt is handed to the engine.
//
// WHY THIS MODULE EXISTS. agent-actions.js had this logic inline, twice
// (executePipelineCard and buildKanbanCard), and in both cases inside run() —
// which build-runner.js calls at the END of pump(), after the first generation,
// after verification, and after the whole refine loop. Reassigning the prompt
// variable there could not affect anything already generated, so on any build
// that skipped research (and therefore skipped the one generation inside run()
// that read it), a 30-second ui-ux-pro-max subprocess ran and its output was
// discarded in full. Measured on the 2026-08-22 AI-news-digest build: the page
// shipped declaring font-family 'Geist' with no @import for it.
//
// Extracting rather than inlining the fix twice also keeps agent-actions.js
// under the ceiling test/file-size-ratchet.test.js records for it — that file is
// already oversized debt, and the ratchet is one-directional.
//
// THE DESIGN SYSTEM IS AN ENHANCEMENT, NEVER A GATE. Every failure path here
// returns the prompt unchanged. A missing skill, a missing Python, a thrown
// resolver — none of them may turn a cosmetic weakness into a failed build.

var buildPack = require('../skills/build-pack');
var designSystemEngine = require('../design/system');

// Returns `prompt` with a design-system block prepended, or `prompt` unchanged.
//
// `brief` is the clean topic (card text), NOT the assembled prompt — the
// resolver keyword-matches its whole argument against the skill's pattern/style/
// typography databases, so handing it prompt boilerplate lets the boilerplate
// choose the design. build-pack.js's designQuery() header records the live
// incident that taught that.
async function prependDesignSystem(prompt, brief) {
  try {
    var dsBlock = await buildPack.resolveDesignSystemTool(brief);
    if (!dsBlock) {
      // Falls back to the home-grown substitute only when the real skill tool
      // is absent — same order as before, just reachable now.
      var ds = designSystemEngine.generateDesignSystem(brief);
      dsBlock = designSystemEngine.formatDesignSystemForPrompt(ds);
    }
    if (dsBlock) return dsBlock + '\n\n' + prompt;
  } catch (_) { /* best-effort — see the header */ }
  return prompt;
}

module.exports = { prependDesignSystem: prependDesignSystem };
