'use strict';

// test/ui-escaping.test.js — the markdown link sanitizer used by the engagement
// spec preview.
//
// Why this one client-side thing gets a test when the rest of the HUD does not
// (see dynamic-widget-spec-validation.test.js's header for the no-DOM-harness
// convention): renderMarkdown() escapes its input with the
// `div.textContent -> div.innerHTML` trick, which leaves `"` intact, and then
// interpolated the captured link URL straight into href="$2". Spec markdown is
// LLM-authored from operator prompts, so `[x](" onmouseover=alert(1) y=")` broke
// out of the attribute. safeHref() is the pure, DOM-free function that closes it,
// so it can be tested directly with no jsdom and no new dependency.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'components', 'engagement', 'SpecPreviewCard.js')
).href;

async function loadSafeHref() {
  const mod = await import(MODULE_URL);
  return mod.safeHref;
}

describe('safeHref: markdown link URL sanitizer', () => {
  it('passes through an ordinary https URL unchanged', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
  });

  it('passes through an ordinary http URL', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref('http://example.com/'), 'http://example.com/');
  });

  it('rejects a javascript: URL', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref('javascript:alert(1)'), null);
  });

  it('rejects a javascript: URL disguised with whitespace and mixed case', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref('  JaVaScRiPt:alert(1)'), null);
  });

  it('rejects a data: URL', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null);
  });

  it('escapes a double quote so the href attribute cannot be broken out of', async () => {
    const safeHref = await loadSafeHref();
    const out = safeHref('https://example.com/" onmouseover="alert(1)');
    assert.ok(out, 'an http(s) URL must survive sanitization');
    assert.ok(!out.includes('"'), `raw quote must not survive: ${out}`);
    assert.match(out, /&quot;/);
  });

  it('rejects a relative or scheme-less URL rather than guessing a scheme', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref('/local/path'), null);
    assert.equal(safeHref('example.com'), null);
  });

  it('rejects empty and non-string input', async () => {
    const safeHref = await loadSafeHref();
    assert.equal(safeHref(''), null);
    assert.equal(safeHref(null), null);
    assert.equal(safeHref(undefined), null);
  });
});
