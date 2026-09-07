'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, context, name) {
  const source = fs.readFileSync(path.join(__dirname, '../ui/public/js', file), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/export (?=(?:async )?function)/g, '');
  vm.createContext(context);
  vm.runInContext(source + '\nthis.entry = ' + name, context);
  return context.entry;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(r => setImmediate(r));

function auditHarness() {
  const response = deferred();
  let callback, options, html = '', unsubscribed = 0;
  const render = load('views/audit.js', {
    console, AbortController,
    fetch: (_url, opts) => { options = opts; return response.promise; },
    subscribe: (_types, fn) => { callback = fn; return () => { callback = null; unsubscribed++; }; },
  }, 'render');
  const list = { set innerHTML(v) { html = v; } };
  const mount = { innerHTML: '', querySelector: () => list };
  return { render, mount, response, emit: payload => callback?.({ payload }),
    get html() { return html; }, get options() { return options; }, get unsubscribed() { return unsubscribed; } };
}

test('audit retains live events arriving while the historical snapshot is pending, without duplicate ids', async () => {
  const h = auditHarness();
  const cleanup = h.render(h.mount);
  h.emit({ id: 'aud-2', ts: 2, tool: 'concurrent_sentinel', tier: 2, decision: 'allow' });
  h.response.resolve({ ok: true, json: async () => ({ entries: [
    { id: 'aud-2', ts: 2, tool: 'concurrent_sentinel', tier: 2, decision: 'allow' },
    { id: 'aud-1', ts: 1, tool: 'historical_sentinel', tier: 1, decision: 'allow' },
  ] }) });
  await tick();
  h.emit({ id: 'aud-3', ts: 3, tool: 'after_snapshot', tier: 2, decision: 'deny' });
  assert.equal((h.html.match(/concurrent_sentinel/g) || []).length, 1);
  assert.ok(h.html.indexOf('after_snapshot') < h.html.indexOf('concurrent_sentinel'));
  assert.ok(h.html.indexOf('concurrent_sentinel') < h.html.indexOf('historical_sentinel'));
  (await cleanup)();
});

test('audit preserves an event absent from the older snapshot', async () => {
  const h = auditHarness();
  const cleanup = h.render(h.mount);
  h.emit({ id: 'aud-new', tool: 'new_event', tier: 2, decision: 'allow' });
  h.response.resolve({ ok: true, json: async () => ({ entries: [] }) });
  await tick();
  assert.match(h.html, /new_event/);
  (await cleanup)();
});

test('audit cleanup is available before fetch completes and ignores a late response', async () => {
  const h = auditHarness();
  const cleanup = h.render(h.mount);
  assert.equal(typeof cleanup, 'function', 'closing a loading panel must not wait for a network response');
  cleanup();
  assert.equal(h.unsubscribed, 1);
  assert.equal(h.options.signal.aborted, true);
  const before = h.html;
  h.response.resolve({ ok: true, json: async () => ({ entries: [{ id: 'late', tool: 'late_response' }] }) });
  await tick();
  assert.equal(h.html, before);
});

function overlayHarness(loader) {
  let focusCount = 0;
  function element() {
    const children = new Map();
    return { style: {}, innerHTML: '', addEventListener() {}, remove() {}, contains: () => false,
      focus() { focusCount++; }, replaceChildren() {},
      querySelector(s) { if (!children.has(s)) children.set(s, element()); return children.get(s); } };
  }
  const manager = load('overlay/overlay-manager.js', {
    document: { createElement: element, getElementById: () => null, addEventListener() {}, removeEventListener() {}, activeElement: null },
    getPanel: () => ({ title: 'AUDIT', loader, mutating: false }), emitRefresh() {},
  }, 'createOverlayManager')({ appendChild() {} });
  return { manager, get focusCount() { return focusCount; } };
}

test('closing before the module loads never mounts a detached view', async () => {
  const loading = deferred();
  let renders = 0;
  const h = overlayHarness(() => loading.promise);
  const pending = h.manager.openPanel('audit');
  h.manager.close('audit');
  loading.resolve({ render() { renders++; return () => {}; } });
  await pending;
  assert.equal(renders, 0);
  assert.equal(h.focusCount, 0);
  h.manager.cleanup();
});

test('a closed asynchronous view releases its late cleanup without touching the reopened panel', async () => {
  const rendering = deferred();
  let renders = 0, cleaned = 0;
  const h = overlayHarness(async () => ({ render() { renders++; return renders === 1 ? rendering.promise : () => { cleaned++; }; } }));
  const pending = h.manager.openPanel('audit');
  await tick();
  h.manager.close('audit');
  await h.manager.openPanel('audit');
  rendering.resolve(() => { cleaned++; });
  await pending;
  assert.equal(cleaned, 1, 'late cleanup from old instance must be released');
  assert.equal(h.manager.isOpen('audit'), true);
  assert.equal(h.focusCount, 1, 'only reopened current panel may focus');
  h.manager.close('audit');
  assert.equal(cleaned, 2);
  h.manager.cleanup();
});
