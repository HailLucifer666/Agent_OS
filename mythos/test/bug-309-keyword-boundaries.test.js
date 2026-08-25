'use strict';

// test/bug-309-keyword-boundaries.test.js — BUG-309, and the requirement half of
// BUG-312.
//
// THE BUG. risk-classifier.js matches its keyword tables with String.indexOf and
// no word boundary. The 2026-08-22 AI-news-digest build wrote itself a spec
// containing "base 16px typography using Geist font pairing". 'typo' is a
// tiny-fix keyword. "typography" contains it. So a from-scratch landing page was
// classified as a typo fix, gatePath() collapsed to ['artifact'], and
// requiresResearch / requiresReview / requiresVisual all went false.
//
// WHY NOT HYPOTHETICAL. Pipeline/shipped/pipe-1787402245811-455.json in the
// operator's vault carries "risk": "tiny-fix" for that build. Two earlier,
// near-identical cards for the same request carry "risk": "feature" — they simply
// did not happen to contain the word typography. The consequences were not
// theoretical either: no web grounding, no reviewer (yet reviewStatus:"approved"),
// no visual gate, and the resolved ui-ux-pro-max design system discarded, because
// the only generation that would have seen it was the research rebuild that never
// ran.
//
// design/verify.js has the same shape at :137-158, and its 'dark' check is
// additionally negation-blind: a spec saying "light theme, not dark" demands a
// dark theme.
//
// WHAT THIS FILE PINS. Three things, and the third matters most:
//   1. the reported defect no longer reproduces
//   2. the CLASS cannot come back — a sweep over real English words that contain
//      a keyword as a substring
//   3. INFLECTIONS STILL MATCH. A naive strict-boundary fix stops "adding",
//      "updated" and "renamed" from matching 'add', 'update', 'rename', silently
//      re-classifying ordinary work. That is the most likely way to get this
//      fix wrong, so it is pinned before the fix, not after.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const risk = require('../src/core/effectors/risk-classifier.js');
const { createVerifier } = require('../src/core/design/verify.js');

// The exact string from the shipped card. Not paraphrased — the whole point is
// that this specific text misclassified.
const SHIPPED_SPEC =
  'Build a static, single-page AI news digest landing page. Premium, sleek, '
  + 'minimal dark theme, electric blue accents (base 16px typography using Geist '
  + 'font pairing). Content (Aug 15-22 2026): Header with marquee breaking news '
  + 'banner (live-updating). Hero section for Top Story: UN Secretary-General '
  + 'labels India primary host for Global South AI Summit.';

describe('BUG-309 — risk classifier keyword boundaries', () => {
  test('the shipped spec is a feature build, not a typo fix', () => {
    assert.strictEqual(risk.classify(SHIPPED_SPEC), 'feature',
      '"typography" contains "typo"; a landing-page build must not gate as tiny-fix');
  });

  test('the collapsed gate is what made it matter', () => {
    // Pins the consequence, so a later change to GATE_PATHS cannot quietly make
    // the misclassification look harmless while it is still wrong.
    assert.deepStrictEqual(risk.gatePath('tiny-fix'), ['artifact']);
    assert.strictEqual(risk.requiresResearch('tiny-fix'), false);
    assert.strictEqual(risk.requiresReview('tiny-fix'), false);
    assert.strictEqual(risk.requiresVisual('tiny-fix'), false);
    // ...and that a feature build does still get the full gate.
    assert.strictEqual(risk.requiresResearch('feature'), true);
    assert.strictEqual(risk.requiresReview('feature'), true);
    assert.strictEqual(risk.requiresVisual('feature'), true);
  });

  // Each row: a real English word that CONTAINS a keyword as a substring, the
  // class that keyword wrongly produces, and the class the text should get.
  const EMBEDDED = [
    {
      note: 'typo inside typography',
      text: 'clean typography and a type scale for the docs page',
      wrong: 'tiny-fix',
      want: 'feature',
    },
    {
      note: 'system inside systematic — outranks the real quick-win keyword',
      text: 'systematic cleanup: update the changelog',
      wrong: 'feature',
      want: 'quick-win',
    },
    {
      note: 'add inside address',
      text: 'address bar spacing tweaks',
      wrong: 'quick-win',
      want: 'feature',
    },
    {
      note: 'change inside exchange',
      text: 'exchange rate column alignment',
      wrong: 'quick-win',
      want: 'feature',
    },
  ];

  for (const row of EMBEDDED) {
    test(`embedded keyword does not match: ${row.note}`, () => {
      const got = risk.classify(row.text);
      assert.notStrictEqual(got, row.wrong,
        `"${row.text}" classified as ${row.wrong} — a keyword matched inside a longer word`);
      assert.strictEqual(got, row.want);
    });
  }

  // THE REGRESSION GUARD ON THE FIX ITSELF. A strict-boundary matcher breaks
  // every one of these, and every one is ordinary phrasing an operator uses.
  const INFLECTIONS = [
    { text: 'adding a second button to the toolbar', want: 'quick-win' },
    { text: 'updated the pricing copy', want: 'quick-win' },
    { text: 'renamed the status field', want: 'tiny-fix' },
    { text: 'improvements to the export flow', want: 'quick-win' },
    { text: 'refactoring the session store', want: 'architecture-change' },
    { text: 'migrating the vault to the new root', want: 'architecture-change' },
    { text: 'fix spelling on the settings screen', want: 'tiny-fix' },
    { text: 'implement a dashboard for the fleet', want: 'feature' },
  ];

  for (const row of INFLECTIONS) {
    test(`inflection still matches: "${row.text}" -> ${row.want}`, () => {
      assert.strictEqual(risk.classify(row.text), row.want,
        'a word-boundary fix must not stop ordinary inflected forms from matching');
    });
  }

  test('precedence is unchanged: redesign still outranks design', () => {
    assert.strictEqual(risk.classify('redesign the landing page'), 'architecture-change');
  });

  test('an empty or missing spec still defaults to full rigor', () => {
    assert.strictEqual(risk.classify(''), 'feature');
    assert.strictEqual(risk.classify(null), 'feature');
    assert.strictEqual(risk.classify(undefined), 'feature');
  });
});

describe('BUG-312 (requirement half) — design-element keywords', () => {
  // verify.js needs a brain with think(). Its LLM self-check is best-effort and
  // wrapped in try/catch, so a brain returning nothing useful exercises the
  // rule-based path only — which is the path under test.
  function verifierWithFakeBrain() {
    return createVerifier({ brain: { think: async () => ({ content: '' }) } });
  }

  // A minimally valid page, so the structural checks add no noise: DOCTYPE,
  // title, viewport, one media query. Deliberately LIGHT-themed, and its title
  // shares words with every spec below so the title-relevance check stays quiet.
  const LIGHT_PAGE = [
    '<!DOCTYPE html>',
    '<html><head><title>Neonatal Ward Information Page</title>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<style>body{background:#ffffff;color:#111111}',
    '@media (max-width:600px){body{font-size:14px}}</style>',
    '</head><body><h1>Neonatal Ward Information</h1>',
    '<section class="hero"><p>Visiting hours and ward contacts.</p></section>',
    '</body></html>',
  ].join('');

  test('a spec that says "not dark" does not require a dark theme', async () => {
    const v = verifierWithFakeBrain();
    const out = await v.verify(LIGHT_PAGE, 'A neonatal ward information page. Light theme, not dark.');
    assert.deepStrictEqual(out.issues.filter((i) => i.includes('dark.theme')), [],
      'the spec rules dark out explicitly; requiring it is negation-blindness');
  });

  test('"neonatal" does not require a particle effect', async () => {
    const v = verifierWithFakeBrain();
    const out = await v.verify(LIGHT_PAGE, 'A neonatal ward information page, light theme.');
    // 'particle' is in SOFT_ELEMENTS, so a miss lands in warnings, NOT issues.
    // Checking only issues here made this test pass vacuously on the broken code
    // — the substring DID match, it just could not hard-fail. Assert on both
    // buckets so the assertion is about the match, not about its severity.
    const both = out.issues.concat(out.warnings);
    assert.deepStrictEqual(both.filter((i) => i.includes('particle')), [],
      '"neon" matched inside "neonatal"');
  });

  test('"spectacular" does not require a CTA', async () => {
    const v = verifierWithFakeBrain();
    const out = await v.verify(LIGHT_PAGE, 'A spectacular neonatal ward information page, light theme.');
    assert.deepStrictEqual(out.issues.filter((i) => i.includes(': cta')), [],
      '"cta" matched inside "spectacular"');
  });

  test('a genuine dark-theme requirement still fires on a light page', async () => {
    const v = verifierWithFakeBrain();
    const out = await v.verify(LIGHT_PAGE, 'A premium dark theme ward information page.');
    assert.strictEqual(out.issues.filter((i) => i.includes('dark.theme')).length, 1,
      'the rule must still catch a light page that was asked to be dark');
  });
});
