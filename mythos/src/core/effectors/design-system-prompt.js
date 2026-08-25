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
var executionChecks = require('../design/execution-checks');
var keywordMatch = require('./keyword-match');

// ---- BUG-331: a palette that contradicts the brief is not handed over --------
//
// MEASURED, AND IT CORRECTS AN EARLIER CALL OF MINE. BUG-327 declined to fix the
// light-palette-for-a-dark-brief problem on the grounds that the preambles
// already tell the model to "derive a real dark ramp: a near-black neutral
// surface... never just swap Background and Foreground", and that the artifact
// shipped #0A0A0A surfaces from a block whose Background was #F8FAFC. That was
// ONE sample. Three live runs of the same brief:
//
//   run 1  palette Background #F8FAFC (light)  -> page #0A0A0A   instruction followed
//   run 2  palette Background #FFFBEB (cream)  -> page #FFFBEB   instruction ignored
//   run 3  palette Background #FFFBEB (cream)  -> page #FFFBEB   instruction ignored
//
// Runs 2 and 3 were then correctly rejected by the verifier for "missing
// required design element: dark.theme", so the brief produced NO artifact at all.
// A prose instruction the model follows one time in three is not a mechanism.
//
// Six of seven realistic dark briefs resolve to a light Background (#F8FAFC /
// #FAFAFA / #FEF2F2 / #FFFBEB), and search.py has no mode flag to ask with — see
// build-pack.js's designQuery header for that measurement. So the contradiction
// is fixed where it is detectable: in the block we compose. The values below are
// not a new opinion, they are the preamble's own recipe made concrete, and only
// the surface tokens change — pattern, style, typography, effects and the accent
// HUE all still come from the resolved system.
var DARK_RAMP = {
  'Background': '#0A0A0B',
  'Foreground': '#E6E8EB',
  'Secondary': '#141416',
  'Muted': '#1C1C20',
  'Border': '#2A2A30',
  'On Primary': '#FFFFFF',
  'Primary': '#141416',
};

// "dark mode", "dark theme", "dark-themed" — and NOT "light theme, not dark",
// which is why this asks the negation-aware matcher rather than a regex. Same
// helper design/verify.js uses for the same word.
function briefAsksForDark(brief) {
  return keywordMatch.matchesAny(String(brief || '').toLowerCase(),
    ['dark', 'dark mode', 'dark theme', 'dark-themed', 'oled', 'near-black'],
    { negationAware: true });
}

// The Colors table rows look like:
//   | Background | `#FFFBEB` | `--color-background` |
// Only the hex inside the backticks is rewritten, so the block stays otherwise
// byte-identical — this is deliberately not a markdown rewrite.
function rowPattern(role) {
  return new RegExp('(\\|\\s*' + role.replace(/ /g, '\\s+') + '\\s*\\|\\s*`)(#[0-9a-fA-F]{3,8})(`)');
}

function backgroundOf(block) {
  var m = rowPattern('Background').exec(block);
  return m ? m[2] : null;
}

// Returns the block unchanged unless the brief asks for dark AND the resolved
// Background is light AND it can be read. Anything unreadable is left alone —
// an unknown palette is not evidence of a light one.
function reconcileMode(block, brief) {
  if (!block || !briefAsksForDark(brief)) return block;
  var bg = backgroundOf(block);
  if (!bg) return block;
  var l = executionChecks.colorLightness(bg);
  if (l == null || l <= executionChecks.DARK_MAX_LIGHTNESS) return block;

  var out = block;
  Object.keys(DARK_RAMP).forEach(function (role) {
    out = out.replace(rowPattern(role), function (_all, head, _hex, tail) {
      return head + DARK_RAMP[role] + tail;
    });
  });
  return out + '\n\n'
    + '> MODE RECONCILED: the request asks for a DARK interface and the palette above resolved\n'
    + '> with a light surface (' + bg + '). The surface tokens have been replaced with a\n'
    + '> near-black ramp and are the ones to use. Everything else — pattern, style,\n'
    + '> typography, effects, and the accent hue — is unchanged. Do not reintroduce the light\n'
    + '> surface, and do not simply invert it: build on the ramp given.';
}

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
    // BUG-331: never hand over a palette that contradicts the brief's mode.
    if (dsBlock) return reconcileMode(dsBlock, brief) + '\n\n' + prompt;
  } catch (_) { /* best-effort — see the header */ }
  return prompt;
}

module.exports = {
  prependDesignSystem: prependDesignSystem,
  reconcileMode: reconcileMode,
  briefAsksForDark: briefAsksForDark,
  _DARK_RAMP: DARK_RAMP,
};
