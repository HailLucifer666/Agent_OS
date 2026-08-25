'use strict';

// test/bug-313-verifier-must-see-content.test.js — BUG-313.
//
// THE BUG. design/verify.js asks an LLM "does the deliverable match the spec
// topic? is the content about the right topic?" and hands it
// `content.slice(0, 2000)`. On a single-file page with an inline <style> block —
// which is what DELIVERABLE_PREAMBLE explicitly instructs the model to produce
// ("all CSS/JS inline") — the first 2000 characters are entirely CSS. The judge
// is asked about content it has never been shown.
//
// WHY NOT HYPOTHETICAL. Measured on the artifact shipped 2026-08-22:
//
//     total chars: 5436 | <body> at: 3329 | first 2000 chars contain <body>? false
//
// The judge answered honestly and said so in its own warning — "Hero section
// content not visible in snippet—cannot confirm 'UN Secretary-General lab' topic
// match" — and the build shipped anyway. That warning was the only thing standing
// between the operator and a page whose topic had never been checked.
//
// WHAT THIS PINS. The sample the judge receives must contain the artifact's
// actual content, must still contain the <title> (the judge is asked about the
// title too), and must stay bounded — this runs on every build and the prompt
// budget is real.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createVerifier, _judgeSample } = require('../src/core/design/verify');

// Roughly the shape the pipeline actually emits: a long inline <style>, then the
// content. Padded so <body> sits well past the old 2000-char cut.
function pageWithBigStyle(bodyHtml) {
  var css = [];
  for (var i = 0; i < 90; i++) {
    css.push('.filler-' + i + ' { margin-bottom: 1rem; padding: 0.5rem; border-radius: 8px; }');
  }
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>AI News Digest Landing Page</title>',
    '<style>', css.join('\n'), '</style>',
    '</head><body>',
    bodyHtml,
    '</body></html>',
  ].join('\n');
}

const BODY = [
  '<h1>AI News Digest</h1>',
  '<section class="hero"><h2>UN Secretary-General labels India primary host for Global South AI Summit</h2></section>',
  '<article><h3>India surges past APAC in AI adoption</h3></article>',
].join('');

const SPEC = 'Build an AI news digest landing page. Top story: UN Secretary-General labels India primary host for Global South AI Summit.';

describe('BUG-313 — the judge sample must contain the content', () => {
  test('the shipped artifact shape puts <body> past the old 2000-char cut', () => {
    // Pins the premise rather than asserting it in prose.
    const html = pageWithBigStyle(BODY);
    assert.ok(html.indexOf('<body>') > 2000,
      'fixture must reproduce the real shape: <body> at ' + html.indexOf('<body>'));
    assert.ok(html.slice(0, 2000).indexOf('<body>') === -1);
  });

  test('the sample contains the body content, not only CSS', () => {
    const sample = _judgeSample(pageWithBigStyle(BODY), 2000);
    assert.match(sample, /AI News Digest/);
    assert.match(sample, /UN Secretary-General labels India primary host/,
      'the judge is asked about the topic; it must be able to see it');
  });

  test('the sample still contains the title', () => {
    // The judge is asked "is the title derived from the spec, not an invented
    // brand name?" — dropping the head to make room for the body would break
    // the other half of the same question.
    const sample = _judgeSample(pageWithBigStyle(BODY), 2000);
    assert.match(sample, /<title>AI News Digest Landing Page<\/title>/);
  });

  test('the sample stays bounded — this runs on every build', () => {
    const huge = pageWithBigStyle(BODY + '<p>' + 'x'.repeat(20000) + '</p>');
    const sample = _judgeSample(huge, 2000);
    assert.ok(sample.length <= 2400,
      'sample was ' + sample.length + ' chars; the prompt budget is real');
  });

  test('a page with no inline style is unchanged in substance', () => {
    const plain = '<!DOCTYPE html><html><head><title>T</title></head><body><h1>Hello</h1></body></html>';
    const sample = _judgeSample(plain, 2000);
    assert.match(sample, /<h1>Hello<\/h1>/);
    assert.match(sample, /<title>T<\/title>/);
  });

  test('markdown deliverables pass through untouched', () => {
    const md = '# AI News Digest\n\nGuterres told the summit that India is the right host.\n';
    assert.strictEqual(_judgeSample(md, 2000), md);
  });

  test('empty and missing input do not throw', () => {
    assert.strictEqual(_judgeSample('', 2000), '');
    assert.strictEqual(_judgeSample(null, 2000), '');
    assert.strictEqual(_judgeSample(undefined, 2000), '');
  });

  test('a <style> block INSIDE <body> does not crowd out the content', () => {
    // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT. Neutralising the
    // style elision left all the other assertions green — the head/body split
    // alone was enough for them, because their <style> sits in <head> and the
    // body slice starts after it. It is NOT enough when the style block is
    // inside body, which is legal and which the build model does emit: the body
    // budget is then spent on CSS and the content falls off the end again. So
    // the elision earns its place here, or it should be deleted.
    var css = [];
    for (var i = 0; i < 90; i++) {
      css.push('.in-body-' + i + ' { margin: 1rem; padding: 0.5rem; border-radius: 8px; }');
    }
    const html = [
      '<!DOCTYPE html><html><head><title>Snake Game</title></head><body>',
      '<style>', css.join('\n'), '</style>',
      '<h1>Distinctive Body Headline</h1>',
      '</body></html>',
    ].join('\n');
    const sample = _judgeSample(html, 2000);
    assert.match(sample, /Distinctive Body Headline/,
      'a style block inside body pushed the content out of the sample');
  });

  test('script bodies are elided too — they are not content either', () => {
    const withScript = [
      '<!DOCTYPE html><html><head><title>Game</title></head><body>',
      '<script>' + 'var a=1;'.repeat(400) + '</script>',
      '<h1>Snake Game</h1>',
      '</body></html>',
    ].join('');
    const sample = _judgeSample(withScript, 2000);
    assert.match(sample, /<h1>Snake Game<\/h1>/);
    assert.ok(sample.indexOf('var a=1;var a=1;var a=1;') === -1,
      'the script body should be elided, not sampled');
  });
});

describe('BUG-313 — the verifier actually uses it', () => {
  test('the prompt sent to the judge carries the body content', async () => {
    // The wiring, not just the helper — an unused helper fixes nothing.
    let seen = '';
    const brain = {
      think: async (args) => {
        seen = String((args.messages && args.messages[0] && args.messages[0].content) || '');
        return { offline: false, parsed: { pass: true, issues: [] } };
      },
    };
    const v = createVerifier({ brain });
    await v.verify(pageWithBigStyle(BODY), SPEC);
    // ASSERT ON SOMETHING ONLY THE DELIVERABLE CONTAINS. The first draft of this
    // test matched /UN Secretary-General labels India primary host/, which is in
    // the SPEC — and the spec is quoted into the prompt, so it passed against the
    // unfixed code. A sub-headline the spec never mentions, and the literal
    // <title> tag, can only come from the artifact.
    assert.match(seen, /India surges past APAC in AI adoption/,
      'the judge was asked about content it could not see');
    assert.match(seen, /<title>AI News Digest Landing Page<\/title>/,
      'and it must still see the title tag');
  });
});
