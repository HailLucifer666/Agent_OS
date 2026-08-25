'use strict';

// test/hud-url-scheme-gate.test.js — the HUD's URL-scheme gate, plus a source
// guard on the sinks that were missing it.
//
// app.js's open-web handler did `window.open(p.url || 'https://news.google.com')`
// with no scheme check at all. p.url is untrusted by this codebase's own account
// (web-panel.js:6-10): it comes from web-search results, fetched page content
// and model output. window.open honours javascript:, data: and file: exactly as
// happily as http(s), and no extra operator click is needed — completing a
// web-lookup the operator already asked for is enough.
//
// Four private copies of a safeUrl()/safeHref() check already existed elsewhere
// in the HUD; app.js imported none of them. ui/public/js/url.js is now the
// shared one. The four originals are deliberately left in place for now — this
// file pins the shared module's behaviour and pins the sinks that were fixed, it
// does not force a migration that has not happened yet.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { pathToFileURL } = require('node:url');

const JS_DIR = nodePath.join(__dirname, '..', 'ui', 'public', 'js');

function read(rel) {
  return nodeFs.readFileSync(nodePath.join(JS_DIR, rel.split('/').join(nodePath.sep)), 'utf8');
}

describe('ui/public/js/url.js — the shared scheme gate', () => {
  let safeUrl, safeSameOriginUrl, escapeAttr;

  before(async () => {
    const mod = await import(pathToFileURL(nodePath.join(JS_DIR, 'url.js')).href);
    ({ safeUrl, safeSameOriginUrl, escapeAttr } = mod);
  });

  it('accepts ordinary http(s) URLs, case-insensitively, trimming whitespace', () => {
    assert.equal(safeUrl('https://news.example/story'), 'https://news.example/story');
    assert.equal(safeUrl('http://news.example'), 'http://news.example');
    assert.equal(safeUrl('  https://news.example  '), 'https://news.example');
    assert.equal(safeUrl('HTTPS://News.Example'), 'HTTPS://News.Example');
  });

  it('refuses every scheme that turns a link into code or a local file', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///C:/Windows/win.ini',
      'vbscript:msgbox(1)',
      'blob:https://news.example/abc',
    ]) {
      assert.equal(safeUrl(hostile), null, hostile + ' must be refused');
      assert.equal(safeSameOriginUrl(hostile), null, hostile + ' must be refused');
    }
  });

  it('refuses non-strings, empty strings and whitespace', () => {
    for (const junk of [null, undefined, 0, {}, [], '', '   ']) {
      assert.equal(safeUrl(junk), null);
      assert.equal(safeSameOriginUrl(junk), null);
    }
  });

  it('safeSameOriginUrl allows a root-relative path but not a protocol-relative one', () => {
    assert.equal(safeSameOriginUrl('/vault/builds/site/index.html'), '/vault/builds/site/index.html');
    assert.equal(safeSameOriginUrl('//evil.example/a'), null,
      'a protocol-relative URL is a different origin wearing a same-origin costume');
    assert.equal(safeSameOriginUrl('vault/relative.html'), null,
      'a bare relative path resolves against whatever the current page is — refuse it');
    assert.equal(safeUrl('/vault/builds/site/index.html'), null,
      'safeUrl stays http(s)-only; the same-origin variant is opt-in');
  });

  it('escapeAttr closes the quote that the textContent/innerHTML trick leaves open', () => {
    assert.equal(escapeAttr('a" onload=alert(1) x="b'), 'a&quot; onload=alert(1) x=&quot;b');
    assert.equal(escapeAttr('<&>'), '&lt;&amp;&gt;');
    assert.equal(escapeAttr(null), '');
    assert.equal(escapeAttr(undefined), '');
  });
});

describe('the HUD sinks that reach window.open / href / src are gated at the source', () => {
  it('app.js open-web routes p.url through safeUrl and does not fall back on a reject', () => {
    const src = read('app.js');
    assert.match(src, /import \{ safeUrl \} from '\.\/url\.js';/,
      'app.js must import the shared gate rather than growing a fifth private copy');
    const handler = src.slice(src.indexOf("subscribe(['open-web']"), src.indexOf("subscribe(['open-web']") + 1400);
    assert.match(handler, /safeUrl\(p\.url\)/,
      'the model-supplied URL must go through the gate');
    assert.doesNotMatch(handler, /window\.open\(p\.url/,
      'the raw payload URL must never reach window.open');
    // Falling back to the default page on a rejected URL would open something
    // other than what was asked for and still ack mounted:true — a silent lie.
    assert.match(handler, /mounted: false[\s\S]{0,120}http\(s\)/,
      'a rejected URL must be acked as a failure with a reason, not silently substituted');
  });

  it('forge.js and pipeline.js escape attributes and gate the URLs they build', () => {
    const forge = read('views/forge.js');
    assert.doesNotMatch(forge, /src="\$\{escapeHtml\(/,
      'escapeHtml leaves `"` intact, so it cannot guard an attribute');
    assert.match(forge, /safeSameOriginUrl\(p\.previewUrl\)/);
    assert.match(forge, /title="preview of \$\{escapeAttr\(p\.name\)\}"/);

    const pipeline = read('views/pipeline.js');
    assert.doesNotMatch(pipeline, /href="\$\{escapeHtml\(card\.artifact\.path\)\}"/);
    assert.match(pipeline, /escapeAttr\(safeSameOriginUrl\(card\.artifact\.path\)/);
  });

  it('engagements.js escapes the model-authored stage type in both positions', () => {
    const src = read('views/engagements.js');
    assert.doesNotMatch(src, /engag-stage-type-badge \$\{stage\.type\}/,
      'stage.type is LLM-authored and was interpolated raw into a class attribute');
    assert.match(src, /engag-stage-type-badge \$\{escapeAttr\(stage\.type\)\}">\$\{escapeHtml\(stage\.type\)\}/);
  });

  it('the news widget refuses a hostile feed link instead of rendering it clickable', () => {
    const src = read('widgets/kinds/news.js');
    assert.match(src, /function safeUrl\(/,
      'the news widget renders third-party RSS links and needs its own gate');
    assert.doesNotMatch(src, /href="\$\{escapeHtml\(it\.link\)\}"/,
      'the raw feed link must not become an href');
    assert.match(src, /const href = safeUrl\(it\.link\);/);
  });
});
