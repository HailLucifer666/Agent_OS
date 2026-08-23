'use strict';

// test/bug-327-design-query-non-fix.test.js
//
// A DELIBERATE NON-FIX, PINNED. The 2026-08-23 plan asked designQuery() to stop
// "incidental nouns choosing the design": strip the quoted product name, strip
// layout nouns (cards, grid, hero, section, header, footer), and pass the brief's
// light/dark mode explicitly so the resolved palette could not contradict it.
//
// Measured against the real ui-ux-pro-max skill on the real brief before writing
// any of it, and the measurement said don't:
//
//   query                                                    style
//   Build a premium dark AI-digest landing page called
//     "MYTHOS Digest" with five story cards                  Bento Box Grid
//   ... product name removed                                 Bento Box Grid
//   ... "cards" removed                                      Vibrant & Block-based
//   ... both removed                                         Vibrant & Block-based
//
// THE PRODUCT NAME IS INERT — identical resolution in both pairs. So is the
// hyphen: "AI digest" and "AI-digest" resolve identically, and so do
// "dark-themed e-commerce storefront" and "dark themed e commerce storefront".
//
// STRIPPING "cards" MAKES IT WORSE. That noun is what selects Bento Box Grid, a
// card-grid style, for a five-card digest. Without it the answer is "Vibrant &
// Block-based", whose own keywords are "bold, energetic, playful... gaming,
// social media, youth-focused". The incidental noun was indeed choosing the
// design language — and choosing better than the proposed fix would have.
//
// THE MODE HAS NOWHERE TO GO. search.py accepts no mode flag (--domain, --stack,
// --design-system, --project-name, --format, --persist, --page, --output-dir),
// and the palette ignores the word "dark": six of seven realistic dark briefs
// returned a LIGHT Background (#F8FAFC / #FAFAFA / #FEF2F2). Only the bare query
// "dark mode" returns #020617, and a two-word query discards every other piece
// of intent. What actually handles the contradiction is one layer down and is
// prose the build model demonstrably followed — the artifact shipped #0A0A0A
// surfaces from a block whose Background was #F8FAFC. So the last group here
// guards that instruction rather than adding a second mechanism beside it.
//
// This file exists so the next session does not re-run the measurement, and so
// that changing any of it is a decision with a red test in front of it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { designQuery } = require('../src/core/skills/build-pack');

const REAL_BRIEF =
  'Build a premium dark AI-digest landing page called "MYTHOS Digest" with five story cards';

describe('BUG-327 — designQuery keeps what the brief actually said', () => {
  it('keeps the layout noun that selects the design language', () => {
    // Removing "cards" swaps Bento Box Grid for a youth-focused gaming style.
    assert.match(designQuery(REAL_BRIEF), /\bcards\b/,
      'stripping this measurably picked a worse style — see the header');
  });

  it('keeps the quoted product name, because removing it changes nothing', () => {
    assert.match(designQuery(REAL_BRIEF), /MYTHOS Digest/,
      'measured inert in two independent pairs; removing it is churn, not a fix');
  });

  it('still strips the article copy, which is the case that DID matter', () => {
    // The 2026-07-31 fix this function exists for. Unchanged.
    const withContent = 'Dark-themed news digest landing page. Main feature headline: ' +
      'OpenAI agents compromised other systems during security tests.';
    const q = designQuery(withContent);
    assert.match(q, /news digest/i);
    assert.doesNotMatch(q, /security tests/i);
  });

  it('does not invent a style word the brief never used', () => {
    // "editorial" is the one word that moves the type pairing to
    // Newsreader/Roboto; "news" alone does not. Adding it here would be this
    // function choosing the design, which is the thing it exists to prevent.
    assert.doesNotMatch(designQuery(REAL_BRIEF), /\beditorial\b/i);
  });
});

// CORRECTED BY BUG-331 — read this before trusting the header above.
//
// The reasoning in this file's header is right about designQuery and WRONG about
// the mode. It concluded that the palette contradiction was "already handled one
// layer down, in prose the model demonstrably followed", on the evidence of one
// live run. Three runs of the same brief:
//
//   run 1  palette Background #F8FAFC  -> page #0A0A0A   followed
//   run 2  palette Background #FFFBEB  -> page #FFFBEB   ignored
//   run 3  palette Background #FFFBEB  -> page #FFFBEB   ignored
//
// and runs 2 and 3 produced no artifact at all, because the verifier correctly
// rejected them for "missing required design element: dark.theme". An
// instruction obeyed one time in three is not a mechanism. The palette is now
// reconciled before the model ever sees it — see
// design-system-prompt.js's reconcileMode and
// test/bug-331-palette-must-not-contradict-the-brief.test.js.
//
// The group below still stands and still matters: the prose instruction is what
// tells the model HOW to build on the ramp it is handed, and nothing else in the
// suite would notice it being edited away.
describe('BUG-327 — the dark-ramp instruction is the real mode fix', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'effectors', 'agent-actions.js'), 'utf8');

  it('both build preambles tell the model to derive a dark ramp, not invert the palette', () => {
    // Deliberately loose: the assertion is that the instruction is still there
    // for both entry points, not that its wording is frozen.
    const preambles = source.split('PLANNER_PREAMBLE');
    assert.ok(preambles.length >= 2, 'the preamble layout changed — re-read before editing this');
    const deliverable = preambles[0];
    const builder = preambles.slice(1).join('PLANNER_PREAMBLE');

    for (const [name, text] of [['DELIVERABLE_PREAMBLE', deliverable], ['BUILDER_PREAMBLE', builder]]) {
      assert.match(text, /dark/i, name + ' no longer mentions a dark theme at all');
      assert.match(text, /near-black/i,
        name + ' lost the dark-ramp instruction. Without it the model inverts a light palette, '
        + 'which is what made earlier dark pages look cheap — and the resolved palette is light '
        + 'on essentially every dark brief.');
    }
  });

  it('both preambles still say the design block is tokens, not a section list', () => {
    // The other half of the same 2026-07-31 lesson: the block's "Sections:" list
    // put a pricing table and security badges on a news digest.
    assert.match(source, /NOT a content outline|task decides which\s*\n?\s*.{0,40}sections exist|decides which sections exist/i,
      'the "the idea wins over the block" instruction is gone');
  });
});
