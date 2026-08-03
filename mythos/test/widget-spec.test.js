'use strict';

// test/widget-spec.test.js — Phase C3 generative UI: the server-side
// validator (src/core/effectors/widget-spec.js) that gates a Hermes-generated
// WIDGET SPEC build target, plus proof that content passing that gate still
// can't break out of markup/attributes once it reaches the fixed HUD renderer
// (ui/public/js/widgets/kinds/dynamic.js). Two different concerns on purpose:
// widget-spec.js only vets SHAPE (never markup, but strings are still just
// strings at that layer); dynamic.js is the only place those strings ever
// touch a DOM tree, and it is what actually has to escape them.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const widgetSpec = require('../src/core/effectors/widget-spec');

describe('widget-spec — validateWidgetSpec (server-side gate for the Hermes widget build target)', () => {
  it('rejects a non-object candidate', () => {
    assert.equal(widgetSpec.validateWidgetSpec(null).ok, false);
    assert.equal(widgetSpec.validateWidgetSpec('a string').ok, false);
    assert.equal(widgetSpec.validateWidgetSpec([1, 2]).ok, false);
  });

  it('rejects a missing kind', () => {
    const res = widgetSpec.validateWidgetSpec({ title: 'X' });
    assert.equal(res.ok, false);
    assert.match(res.reason, /kind is required/);
  });

  it('rejects an unknown widget kind outright — never rendered', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'iframe-embed', src: 'https://evil.example' });
    assert.equal(res.ok, false);
    assert.match(res.reason, /unknown widget kind "iframe-embed"/);
  });

  it('accepts a known static registry kind with no extra props', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'system' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.spec, { kind: 'system' });
  });

  it('rejects a static kind carrying any extra prop — static mounts take no data', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'system', title: 'hijacked' });
    assert.equal(res.ok, false);
    assert.match(res.reason, /accepts no props/);
  });

  it('accepts a valid dynamic spec and normalizes layout casing', () => {
    const res = widgetSpec.validateWidgetSpec({
      kind: 'dynamic', title: 'Build Status', layout: 'STAT',
      items: [{ label: 'Passing', value: 42, tone: 'gold' }],
      footer: 'as of now',
    });
    assert.equal(res.ok, true);
    assert.equal(res.spec.layout, 'stat');
    assert.equal(res.spec.footer, 'as of now');
  });

  it('rejects a dynamic spec missing a title', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'dynamic', layout: 'stat', items: [] });
    assert.equal(res.ok, false);
    assert.match(res.reason, /title is required/);
  });

  it('rejects a dynamic spec with an invalid layout enum', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'dynamic', title: 'X', layout: 'carousel', items: [] });
    assert.equal(res.ok, false);
    assert.match(res.reason, /layout must be one of/);
  });

  it('rejects more than 8 items', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ label: 'l' + i, value: i }));
    const res = widgetSpec.validateWidgetSpec({ kind: 'dynamic', title: 'X', layout: 'list', items });
    assert.equal(res.ok, false);
    assert.match(res.reason, /at most 8 entries/);
  });

  it('rejects an item with a bad tone enum', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'dynamic', title: 'X', layout: 'list', items: [{ label: 'a', value: 1, tone: 'danger' }] });
    assert.equal(res.ok, false);
    assert.match(res.reason, /tone must be one of/);
  });

  it('rejects an item missing label or value', () => {
    assert.equal(widgetSpec.validateWidgetSpec({ kind: 'dynamic', title: 'X', layout: 'list', items: [{ value: 1 }] }).ok, false);
    assert.equal(widgetSpec.validateWidgetSpec({ kind: 'dynamic', title: 'X', layout: 'list', items: [{ label: 'a' }] }).ok, false);
  });

  it('rejects a non-string footer', () => {
    const res = widgetSpec.validateWidgetSpec({ kind: 'dynamic', title: 'X', layout: 'text', items: [], footer: 123 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /footer must be a string/);
  });

  it('adversarial: shape validation accepts malicious strings as inert data (content is not this layer\'s job)', () => {
    const res = widgetSpec.validateWidgetSpec({
      kind: 'dynamic',
      title: '<script>alert(1)</script>',
      layout: 'text',
      items: [{ label: '"><img src=x onerror=alert(1)>', value: 'javascript:alert(1)' }],
      footer: '"><svg onload=alert(1)>',
    });
    assert.equal(res.ok, true);
    assert.equal(res.spec.title, '<script>alert(1)</script>');
  });
});

// Rendering-safety: prove the strings that pass validateWidgetSpec still
// cannot escape into markup or an attribute once the fixed HUD renderer gets
// them. This is the "registry-driven rendering out" half of the contract —
// dynamic.js is browser ESM, imported via file:// URL the same way
// test/widgets-ported.test.js reaches the other ported kinds/*.js modules.
describe('kinds/dynamic.js — the only renderer a validated widget spec ever reaches', () => {
  let mountDynamicWidget;
  before(async () => {
    const url = pathToFileURL(
      path.join(__dirname, '..', 'ui', 'public', 'js', 'widgets', 'kinds', 'dynamic.js')
    ).href;
    ({ mountDynamicWidget } = await import(url));
  });

  function render(payload) {
    const el = { innerHTML: '' };
    mountDynamicWidget(el, payload);
    return el.innerHTML;
  }

  it('a validated spec with a double-quote in a value cannot break out into an attribute', () => {
    const validated = widgetSpec.validateWidgetSpec({
      kind: 'dynamic', title: 'X', layout: 'stat',
      items: [{ label: 'Note', value: '"><img src=x onerror=alert(1)>' }],
    });
    assert.equal(validated.ok, true);
    const html = render(validated.spec);
    // The quote must be gone from the raw output (nothing to break an
    // attribute open with) and the tag must be neutralized.
    assert.equal(html.indexOf('"><img'), -1);
    assert.equal(html.indexOf('<img'), -1);
    // Positively assert the escaped form is what landed. An OR-chain over
    // several "one of these probably appears" candidates passes for the wrong
    // reasons — the payload must be present AND inert, both stated exactly.
    // Positively assert the escaped form is what landed. An OR-chain over
    // several "one of these probably appears" candidates passes for the wrong
    // reasons — state exactly what the output must contain.
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the tag must survive only as escaped text');
    // The repo's escapeHtml does NOT escape a double-quote (proven 2026-08-02 in
    // the markdown link renderer, fixed there with safeHref). That is survivable
    // ONLY because this value lands in TEXT content, where a bare quote is inert
    // and the escaped `<` means no tag can be opened around it. The same value
    // interpolated into an attribute would be a break-out — which is precisely
    // why the renderer must never do that, and why this asserts the text path.
    assert.equal(html.indexOf('value="'), -1, 'the payload must never be interpolated into an attribute');
  });

  it('a <script> tag in the title/footer is neutralized to inert text, not executed markup', () => {
    const validated = widgetSpec.validateWidgetSpec({
      kind: 'dynamic', title: 'X', layout: 'text',
      items: [{ label: 'a', value: 'b' }],
      footer: '<script>alert(1)</script>',
    });
    assert.equal(validated.ok, true);
    const html = render(validated.spec);
    assert.equal(html.indexOf('<script>'), -1);
    assert.ok(html.indexOf('&lt;script&gt;') !== -1);
  });

  it('a javascript: URL never becomes an href — it only ever appears as escaped text content', () => {
    const validated = widgetSpec.validateWidgetSpec({
      kind: 'dynamic', title: 'X', layout: 'list',
      items: [{ label: 'Link', value: 'javascript:alert(1)' }],
    });
    assert.equal(validated.ok, true);
    const html = render(validated.spec);
    assert.equal(html.indexOf('href='), -1);
    assert.ok(html.indexOf('javascript:alert(1)') !== -1); // present, but as plain text, never wired as a URL
  });

  it('unknown layout renders the escaped literal, not the raw enum string as markup', () => {
    const html = render({ layout: '<b>weird</b>', items: [] });
    assert.equal(html.indexOf('<b>weird</b>'), -1);
    assert.ok(html.indexOf('&lt;b&gt;weird&lt;/b&gt;') !== -1);
  });
});
