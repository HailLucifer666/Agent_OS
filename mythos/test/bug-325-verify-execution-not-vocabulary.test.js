'use strict';

// test/bug-325-verify-execution-not-vocabulary.test.js
//
// THE BUG. design/verify.js checked that an artifact TALKED about the things the
// spec asked for. DESIGN_ELEMENT_PATTERNS' entry for 'hero' is satisfied by the
// bare regex /hero/i. Nothing anywhere asked whether the page does what it
// declares.
//
// WHY IT IS NOT HYPOTHETICAL. Measured 2026-08-23 on the artifact this pipeline
// shipped for a premium-dark AI-digest brief:
//
//     font-family: 'Roboto', sans-serif       -> 0 <link>, 0 @import
//     font-family: 'Newsreader', serif        -> 0 <link>, 0 @import
//
// Claude's page for the identical brief loaded 48 faces from the same two
// families. Both models had chosen the same design system; MYTHOS was handed the
// @import line verbatim in its prompt and did not use it. The verifier passed
// the page.
//
// Run over the 25 artifacts sitting in the operator's vault, these checks flag
// 5 — four named-but-unloaded faces (Newsreader, Roboto, Plus Jakarta Sans,
// Geist) and one 36px landing-page headline. Zero false positives. That is the
// population, not a projection.
//
// BOTH FIXTURES ARE REAL FILES from that comparison, kept in
// test/fixtures/build-artifacts/. A real failing input beats a synthetic one:
// the synthetic version of this test would have been written against whatever
// shape the author imagined, and the shape that shipped was
// `font-family: 'Roboto', sans-serif` with the <head> simply missing a line.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checks = require('../src/core/design/execution-checks');
const { createVerifier } = require('../src/core/design/verify');

const FIXTURES = path.join(__dirname, 'fixtures', 'build-artifacts');
const SPEC = 'premium dark AI-digest landing page with five story cards';

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// The verifier's LLM self-check is advisory; a brain that returns nothing leaves
// only the rule-based half under test, which is the half this bug is about.
function verifier() {
  return createVerifier({ brain: { think: async () => ({ content: '' }) } });
}

describe('BUG-325 — the artifact that shipped', () => {
  it('fails the font rule, naming both families', () => {
    const found = checks.run(fixture('mythos-ai-digest-2026-08-23.html'), SPEC);
    const text = found.issues.join('\n');
    assert.match(text, /font-family "Roboto" is named but never loaded/);
    assert.match(text, /font-family "Newsreader" is named but never loaded/);
  });

  it('says how to fix it, not just that it is wrong', () => {
    const found = checks.run(fixture('mythos-ai-digest-2026-08-23.html'), SPEC);
    assert.match(found.issues[0], /<link rel="stylesheet"> or @import/);
    assert.match(found.issues[0], /display=swap/);
  });

  it('is blocked by the verifier rather than shipped', async () => {
    const result = await verifier().verify(fixture('mythos-ai-digest-2026-08-23.html'), SPEC);
    assert.equal(result.pass, false, 'the artifact that shipped must not pass');
    assert.ok(result.issues.some((i) => /never loaded/.test(i)));
  });
});

describe('BUG-325 — the artifact that got it right', () => {
  it('passes clean', () => {
    const found = checks.run(fixture('claude-ai-digest-2026-08-23.html'), SPEC);
    assert.deepEqual(found.issues, [], 'no issues expected: ' + found.issues.join(' | '));
  });

  it('passes the whole verifier', async () => {
    const result = await verifier().verify(fixture('claude-ai-digest-2026-08-23.html'), SPEC);
    assert.equal(result.pass, true, 'issues: ' + result.issues.join(' | '));
  });

  // The reason it passes is not an accident of wording: it writes
  // `font-family:var(--serif)` with `--serif:'Newsreader',Georgia,...` on :root.
  // A check that read var(--serif) as a font NAME would accuse every
  // well-organised page of the defect it exists to catch.
  it('resolves a font named through a CSS custom property', () => {
    const html = [
      '<!DOCTYPE html><html><head>',
      '<link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400&display=swap" rel="stylesheet">',
      '<style>:root{--serif:\'Newsreader\',Georgia,serif}h1{font-family:var(--serif);font-size:4rem}</style>',
      '</head><body><h1>Hi</h1></body></html>',
    ].join('');
    assert.deepEqual(checks.run(html, SPEC).issues, []);
  });

  it('does not chase a custom property it cannot resolve', () => {
    const html = '<!DOCTYPE html><html><head><style>h1{font-family:var(--nowhere)}</style></head><body>x</body></html>';
    assert.deepEqual(checks.run(html, 'a page').issues, []);
  });
});

describe('BUG-325 — families that need no loading', () => {
  // THE GUARD HAD THE DEFECT IT EXISTS TO CATCH. The first run of these checks
  // over the vault reported `system-ui` as an unloaded webfont: the name is
  // normalised (hyphens to spaces) before comparison, and the list it was
  // compared against was not. Both sides are normalised now.
  const SYSTEM = [
    'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system',
    'sans-serif', 'serif', 'monospace', 'Georgia', 'Times New Roman', 'Segoe UI',
    'Helvetica Neue', 'inherit',
  ];

  for (const family of SYSTEM) {
    it('never asks for a stylesheet for ' + family, () => {
      const html = '<!DOCTYPE html><html><head><style>body{font-family:' + family +
        '}h1{font-size:3rem}</style></head><body><h1>x</h1></body></html>';
      assert.deepEqual(checks.run(html, 'a page').issues, [],
        family + ' must not be treated as a webfont');
    });
  }

  it('still flags Roboto, which is only a system face on Android', () => {
    const html = '<!DOCTYPE html><html><head><style>body{font-family:Roboto,sans-serif}</style></head><body>x</body></html>';
    assert.match(checks.run(html, 'a page').issues.join(''), /Roboto/);
  });
});

describe('BUG-325 — the ways a page can legitimately load a face', () => {
  const cases = [
    ['a Google Fonts link', '<link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@400;700&display=swap" rel="stylesheet">'],
    ['a Google Fonts @import', '<style>@import url(\'https://fonts.googleapis.com/css2?family=Newsreader&display=swap\');</style>'],
    ['a self-hosted stylesheet named after the family', '<link rel="stylesheet" href="/assets/newsreader.css">'],
    ['a local @font-face', '<style>@font-face{font-family:\'Newsreader\';src:url(data:font/woff2;base64,AA)}</style>'],
  ];

  for (const [label, head] of cases) {
    it('accepts ' + label, () => {
      const html = '<!DOCTYPE html><html><head>' + head +
        '<style>h1{font-family:\'Newsreader\',serif;font-size:4rem}</style></head><body><h1>x</h1></body></html>';
      assert.deepEqual(checks.run(html, 'a page').issues, [], label + ' should satisfy the rule');
    });
  }

  it('decodes + as a space in a family parameter', () => {
    const loaded = checks._loadedFonts('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400">');
    assert.ok(loaded.families.indexOf('plus jakarta sans') !== -1, JSON.stringify(loaded.families));
  });

  it('warns rather than fails when display=swap is missing', () => {
    const html = '<!DOCTYPE html><html><head>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader">' +
      '<style>h1{font-family:Newsreader,serif;font-size:4rem}</style></head><body><h1>x</h1></body></html>';
    const found = checks.run(html, 'a page');
    assert.deepEqual(found.issues, []);
    assert.match(found.warnings.join(''), /display=swap/);
  });
});

describe('BUG-325 — the headline has to be a headline', () => {
  function page(css, spec) {
    return checks.run('<!DOCTYPE html><html><head><style>' + css +
      '</style></head><body><h1>Headline</h1><p>Body copy here.</p></body></html>', spec || SPEC);
  }

  it('fails a headline smaller than twice the body copy', () => {
    const found = page('body{font-size:16px}h1{font-size:20px}');
    assert.match(found.issues.join(''), /largest heading is 20px against 16px body/);
  });

  it('fails a landing-page headline under the desktop floor', () => {
    const found = page('body{font-size:14px}h1{font-size:36px}');
    assert.match(found.issues.join(''), /36px — a landing page headline is at least 40px/);
  });

  it('accepts the same 36px headline when the spec is not a landing page', () => {
    const found = page('body{font-size:14px}h1{font-size:36px}', 'a snake game');
    assert.deepEqual(found.issues, []);
  });

  it('reads the desktop end of a clamp() scale', () => {
    assert.equal(checks._sizeToPx('clamp(2.4rem, 6.4vw, 4.75rem)', 16), 76);
    assert.deepEqual(page('body{font-size:17px}h1{font-size:clamp(2.4rem,6.4vw,4.75rem)}').issues, []);
  });

  // A mobile override is a smaller size for a smaller screen, not a defect. The
  // check takes the MAXIMUM declared anywhere, so an @media block that shrinks
  // the headline can never produce a finding — which is why the artifact that
  // shipped (2.5rem, dropping to 2rem under 768px) is not failed on size.
  it('is not fooled by a media-query override into failing a good scale', () => {
    const found = page('body{font-size:16px}h1{font-size:4rem}@media(max-width:768px){h1{font-size:1.5rem}}');
    assert.deepEqual(found.issues, []);
  });

  it('says nothing when no heading size is declared at all', () => {
    // The UA stylesheet makes an h1 2em, which already clears the ratio. An
    // unmeasurable page gets no finding rather than a guessed one.
    const found = page('body{font-size:16px}');
    assert.deepEqual(found.issues, []);
  });

  it('ignores em, whose value depends on the parent chain', () => {
    assert.equal(checks._sizeToPx('2em', 16), null);
    assert.deepEqual(page('body{font-size:16px}h1{font-size:2em}').issues, []);
  });
});

describe('BUG-325 — a dark page is dark whether or not it says so', () => {
  // The measurement that forced this: Claude's artifact contains the word
  // "dark" zero times and is #09090B behind every pixel. verify.js hard-failed
  // it for "missing required design element: dark.theme".
  it('reads the surface Claude\'s page actually paints', () => {
    const d = checks.pageDarkness(fixture('claude-ai-digest-2026-08-23.html'));
    assert.equal(d.known, true, 'the body background must be readable');
    assert.equal(d.dark, true, 'lightness was ' + d.lightness);
    assert.equal(/\bdark\b/i.test(fixture('claude-ai-digest-2026-08-23.html')), false,
      'the fixture must keep saying "dark" nowhere — that is the whole point');
  });

  it('lets a measured dark surface satisfy the spec word', async () => {
    const result = await verifier().verify(fixture('claude-ai-digest-2026-08-23.html'), SPEC);
    assert.ok(!result.issues.some((i) => /dark\.theme/.test(i)), result.issues.join(' | '));
  });

  it('follows background:var(--token) to the token value', () => {
    const html = '<!DOCTYPE html><html><head><style>:root{--bg:#0A0A0B}body{background:var(--bg)}' +
      '</style></head><body>x</body></html>';
    assert.equal(checks.pageDarkness(html).dark, true);
  });

  it('does not call a light page dark', () => {
    const html = '<!DOCTYPE html><html><head><style>body{background:#FAFAFA}</style></head><body>x</body></html>';
    const d = checks.pageDarkness(html);
    assert.equal(d.known, true);
    assert.equal(d.dark, false);
  });

  it('reports unknown rather than guessing when no surface colour is declared', () => {
    assert.equal(checks.pageDarkness('<!DOCTYPE html><html><body>x</body></html>').known, false);
  });

  it('reads short hex, rgb() and the keyword black', () => {
    assert.deepEqual(checks._parseColor('#000', {}, 0), [0, 0, 0]);
    assert.deepEqual(checks._parseColor('rgb(10, 10, 12)', {}, 0), [10, 10, 12]);
    assert.deepEqual(checks._parseColor('black', {}, 0), [0, 0, 0]);
  });

  // Only <style> contents are CSS. Reading the whole document as CSS made the
  // text before the first brace one giant "selector" carrying both `html` and
  // `h1`, so one rule was read as both the body rule and the heading rule and
  // the check reported "256px against 256px".
  it('treats only <style> contents as CSS', () => {
    const sheet = checks._stylesheet('<html><head><link href="x"><style>h1{font-size:4rem}</style></head>');
    assert.equal(sheet.trim(), 'h1{font-size:4rem}');
  });
});

describe('BUG-325 — what the checks decline to touch', () => {
  it('leaves a markdown deliverable alone', () => {
    const md = '# AI Digest\n\nA paragraph naming Newsreader and Roboto without loading either.\n';
    assert.deepEqual(checks.run(md, SPEC), { issues: [], warnings: [] });
  });

  it('flags a stub page as a warning, never as a failure', () => {
    const stub = '<!DOCTYPE html><html><head><title>x</title></head><body><p>Cannot reach the web.</p></body></html>';
    const found = checks.run(stub, SPEC);
    assert.deepEqual(found.issues, []);
    assert.match(found.warnings.join(''), /stub, not a page/);
  });

  // DELIVERABLE_PREAMBLE instructs the model to fetch photographs from
  // picsum.photos. A rule banning remote images would fail builds for obeying
  // the brief this same pipeline issues — the trap grounding-check.js already
  // documented declining. Pinned so it is not "tightened" later by accident.
  it('does not ban the remote photo host the brief itself sanctions', () => {
    const html = '<!DOCTYPE html><html><head><style>body{font-family:Georgia,serif}h1{font-size:4rem}</style></head>' +
      '<body><h1>x</h1><img src="https://picsum.photos/seed/one/800/400" alt="a street"></body></html>';
    assert.deepEqual(checks.run(html, SPEC).issues, []);
  });
});
