'use strict';

// test/dynamic-widget-spec-validation.test.js — Item 11 "Generative UI".
// Pure server-side validator tests for the spawn_widget effector
// (src/core/effectors/from-widgets.js). No DOM/jsdom — this codebase has zero
// DOM-test precedent for other widget kinds (kinds/web-result.js etc. are
// manual-verification-only), so client-side rendering in
// ui/public/js/widgets/kinds/dynamic.js is verified by code-review trace, not
// a browser harness, matching that convention.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fakeBus } = require('./helpers');
const { buildTools } = require('../src/core/effectors/from-widgets');

function makeSpawnWidget() {
  const bus = fakeBus();
  const built = buildTools({ bus: bus });
  const tool = built.TOOLS.find((t) => t.name === 'spawn_widget');
  return { fn: tool.fn, bus: bus };
}

describe('spawn_widget effector: server-side spec validation', () => {
  it('accepts a well-formed spec (valid layout, <=8 items, string title) and emits ui.open-web', () => {
    const { fn, bus } = makeSpawnWidget();
    const result = fn({
      title: 'Server Status',
      layout: 'stat',
      items: [
        { label: 'CPU', value: '42%', tone: 'gold' },
        { label: 'Memory', value: '3.2GB' },
      ],
      footer: 'Updated just now',
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.widgetType, 'dynamic');
    assert.equal(result.result.layout, 'stat');
    assert.equal(result.result.title, 'Server Status');
    assert.equal(result.result.items.length, 2);

    const emitted = bus._emitted();
    const uiEvent = emitted.find((e) => e.type === 'ui.open-web');
    assert.ok(uiEvent, 'ui.open-web must be emitted on a valid spec');
    assert.equal(uiEvent.payload.widgetType, 'dynamic');
  });

  it('rejects an unknown/invalid layout value and emits nothing', () => {
    const { fn, bus } = makeSpawnWidget();
    const result = fn({
      title: 'Bad Layout',
      layout: 'carousel', // not in stat|list|table|text
      items: [],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /layout/i);
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0);
  });

  it('rejects an items array with more than 8 entries and emits nothing', () => {
    const { fn, bus } = makeSpawnWidget();
    const items = [];
    for (let i = 0; i < 9; i += 1) items.push({ label: 'L' + i, value: i });
    const result = fn({
      title: 'Too Many Items',
      layout: 'list',
      items: items,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /items/i);
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0);
  });

  it('rejects a non-string title and emits nothing', () => {
    const { fn, bus } = makeSpawnWidget();
    const result = fn({
      title: 12345,
      layout: 'text',
      items: [],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.result), /title/i);
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0);
  });

  it('rejects a title over 60 characters', () => {
    const { fn, bus } = makeSpawnWidget();
    const result = fn({
      title: 'x'.repeat(61),
      layout: 'text',
      items: [],
    });
    assert.equal(result.ok, false);
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0);
  });

  it('rejects an item with an invalid tone', () => {
    const { fn, bus } = makeSpawnWidget();
    const result = fn({
      title: 'Bad Tone',
      layout: 'list',
      items: [{ label: 'A', value: '1', tone: 'danger' }],
    });
    assert.equal(result.ok, false);
    assert.equal(bus._emitted().filter((e) => e.type === 'ui.open-web').length, 0);
  });

  it('accepts a spec with items omitted (empty default) for text layout', () => {
    const { fn } = makeSpawnWidget();
    const result = fn({ title: 'Plain Note', layout: 'text' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.items, []);
  });
});
