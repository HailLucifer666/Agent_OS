'use strict';

// test/bug-331-palette-must-not-contradict-the-brief.test.js
//
// THIS CORRECTS AN EARLIER CALL, AND THE CORRECTION IS THE POINT. BUG-327
// declined to fix "the resolved palette is light on a dark brief", reasoning that
// both build preambles already tell the model to "derive a real dark ramp: a
// near-black neutral surface... never just swap Background and Foreground", and
// that the shipped artifact had #0A0A0A surfaces from a block whose Background
// was #F8FAFC. That was ONE sample.
//
// Three live end-to-end runs of the same one-shot brief:
//
//   run 1  palette Background #F8FAFC (light)  -> page #0A0A0A   instruction followed
//   run 2  palette Background #FFFBEB (cream)  -> page #FFFBEB   instruction ignored
//   run 3  palette Background #FFFBEB (cream)  -> page #FFFBEB   instruction ignored
//
// Runs 2 and 3 were then correctly rejected by the verifier — "missing required
// design element: dark.theme" — after a retry, so the brief produced NO artifact
// at all. A prose instruction obeyed one time in three is not a mechanism, and
// six of seven realistic dark briefs resolve to a light Background (#F8FAFC /
// #FAFAFA / #FEF2F2 / #FFFBEB). search.py has no mode flag to ask with.
//
// So the contradiction is now resolved where it is detectable: in the block this
// repo composes. The values are the preamble's own recipe made concrete, not a
// new opinion, and only the surface tokens move — pattern, style, typography,
// effects and the accent all stay as the skill resolved them.
//
// After the fix, the same brief ran to completion with a page at lightness 0.039
// and four of its five headlines matching the research brief verbatim.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dsp = require('../src/core/effectors/design-system-prompt');
const checks = require('../src/core/design/execution-checks');

// The real shape search.py emits, with the cream palette from run 2.
const LIGHT_BLOCK = [
  '## Design System: AI DIGEST LANDING PAGE',
  '',
  '### Pattern',
  '- **Name:** Scroll-Triggered Storytelling',
  '',
  '### Style',
  '- **Name:** Vibrant & Block-based',
  '',
  '### Colors',
  '| Role | Hex | CSS Variable |',
  '|------|-----|--------------|',
  '| Primary | `#78716C` | `--color-primary` |',
  '| On Primary | `#FFFFFF` | `--color-on-primary` |',
  '| Secondary | `#92400E` | `--color-secondary` |',
  '| Accent/CTA | `#D97706` | `--color-accent` |',
  '| Background | `#FFFBEB` | `--color-background` |',
  '| Foreground | `#1C1917` | `--color-foreground` |',
  '| Muted | `#FEF3C7` | `--color-muted` |',
  '| Border | `#FDE68A` | `--color-border` |',
  '',
  '### Typography',
  '- **Heading:** Newsreader',
  '- **Body:** Roboto',
].join('\n');

function bgOf(block) {
  const m = /\|\s*Background\s*\|\s*`(#[0-9a-fA-F]+)`/.exec(block);
  return m && m[1];
}

describe('BUG-331 — a dark brief is never handed a light surface', () => {
  it('replaces the light surface with a near-black ramp', () => {
    const out = dsp.reconcileMode(LIGHT_BLOCK, 'premium dark AI-digest landing page');
    const bg = bgOf(out);
    assert.notEqual(bg, '#FFFBEB', 'the cream surface survived');
    const l = checks.colorLightness(bg);
    assert.ok(l <= checks.DARK_MAX_LIGHTNESS, bg + ' has lightness ' + l);
  });

  it('keeps the accent exactly as the skill resolved it', () => {
    const out = dsp.reconcileMode(LIGHT_BLOCK, 'premium dark landing page');
    assert.match(out, /\| Accent\/CTA \| `#D97706`/, 'the accent is the palette\'s own identity');
  });

  it('keeps pattern, style and typography untouched', () => {
    const out = dsp.reconcileMode(LIGHT_BLOCK, 'premium dark landing page');
    assert.match(out, /Scroll-Triggered Storytelling/);
    assert.match(out, /Vibrant & Block-based/);
    assert.match(out, /\*\*Heading:\*\* Newsreader/);
    assert.match(out, /\*\*Body:\*\* Roboto/);
  });

  it('says what it did and why, in the block itself', () => {
    const out = dsp.reconcileMode(LIGHT_BLOCK, 'premium dark landing page');
    assert.match(out, /MODE RECONCILED/);
    assert.match(out, /#FFFBEB/, 'the value it overrode must be named');
    assert.match(out, /do not simply invert/i, 'the failure mode is worth naming too');
  });

  it('leaves a foreground light enough to read on the new surface', () => {
    const out = dsp.reconcileMode(LIGHT_BLOCK, 'premium dark landing page');
    const fg = /\|\s*Foreground\s*\|\s*`(#[0-9a-fA-F]+)`/.exec(out)[1];
    assert.ok(checks.colorLightness(fg) > 0.7, 'foreground ' + fg + ' would be dark-on-dark');
  });
});

describe('BUG-331 — it only fires when it should', () => {
  it('does nothing when the brief never asked for dark', () => {
    assert.equal(dsp.reconcileMode(LIGHT_BLOCK, 'a bright airy storefront'), LIGHT_BLOCK);
  });

  it('does nothing when the palette is already dark', () => {
    const dark = LIGHT_BLOCK.replace('`#FFFBEB`', '`#09090B`');
    assert.equal(dsp.reconcileMode(dark, 'premium dark landing page'), dark);
  });

  it('respects a negated request', () => {
    // "light theme, not dark" must not be turned into a dark page — the verifier
    // learned this lesson as BUG-312 and the same trap is here.
    assert.equal(dsp.briefAsksForDark('light theme, not dark'), false);
    assert.equal(dsp.reconcileMode(LIGHT_BLOCK, 'light theme, not dark'), LIGHT_BLOCK);
  });

  it('leaves an unreadable palette alone rather than guessing', () => {
    // An unknown surface is not evidence of a light one.
    const odd = LIGHT_BLOCK.replace('`#FFFBEB`', '`hsl(48 96% 96%)`');
    assert.equal(dsp.reconcileMode(odd, 'premium dark landing page'), odd);
    const none = LIGHT_BLOCK.replace(/\| Background \|.*\n/, '');
    assert.equal(dsp.reconcileMode(none, 'premium dark landing page'), none);
  });

  it('never throws on junk, because a design system may not fail a build', () => {
    for (const input of [null, undefined, '', 'not a design system at all']) {
      assert.doesNotThrow(() => dsp.reconcileMode(input, 'dark page'));
    }
  });
});
