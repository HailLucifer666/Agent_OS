'use strict';

// test/keyed-list.test.js — focused coverage for keyedList() in
// ui/public/js/dom.js, the reconcile primitive every HUD list renders
// through. There is no DOM harness in this repo (see
// dynamic-widget-spec-validation.test.js's header for the convention), but
// keyedList touches only a tiny node surface — children, dataset.key,
// insertBefore, firstChild, nextSibling, remove — so a hand-rolled fake
// container covers it without jsdom or any new dependency, the same
// zero-dep stub approach ui-wiring-smoke.test.js uses.
//
// What this guards (task C2): duplicate keys silently orphan the first node
// (it stays pinned forever, never removed) and keyless children all collapse
// onto one "undefined" key. keyedList now warns on both — bounded to one warn
// per offending key per reconcile pass because this is a 24/7 HUD — while
// deliberately keeping the old reconciliation semantics (degrade, don't
// throw). These tests pin both the warns and the unchanged semantics.

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DOM_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'public', 'js', 'dom.js')
).href;

let keyedList;

// --- minimal fake DOM -------------------------------------------------------

function fakeNode(key) {
  return {
    dataset: key === undefined ? {} : { key },
    nextSibling: null,
    removed: false,
    _container: null,
    remove() {
      this.removed = true;
      if (this._container) {
        const i = this._container.nodes.indexOf(this);
        if (i !== -1) this._container.nodes.splice(i, 1);
        refresh(this._container);
      }
    },
  };
}

function fakeContainer(initialNodes) {
  const c = {
    nodes: initialNodes.slice(),
    get children() { return this.nodes.slice(); },
    get firstChild() { return this.nodes[0] || null; },
    insertBefore(node, after) {
      const i = this.nodes.indexOf(node);
      if (i !== -1) this.nodes.splice(i, 1);
      if (after == null) this.nodes.push(node);
      else {
        const j = this.nodes.indexOf(after);
        this.nodes.splice(j === -1 ? this.nodes.length : j, 0, node);
      }
      node._container = c;
      refresh(c);
    },
  };
  for (const n of c.nodes) n._container = c;
  refresh(c);
  return c;
}

function refresh(c) {
  c.nodes.forEach((n, i) => { n.nextSibling = c.nodes[i + 1] || null; });
}

const keysOf = (c) => c.nodes.map((n) => n.dataset.key);

// --- console.warn capture ----------------------------------------------------

let warns = [];
const realWarn = console.warn;

before(async () => {
  ({ keyedList } = await import(DOM_URL));
  console.warn = (...args) => warns.push(args.join(' '));
});

afterEach(() => { warns = []; });

// Restore even if a test throws mid-capture — this file must not leak a
// swallowed console.warn into the rest of the suite.
process.on('exit', () => { console.warn = realWarn; });

// renderFn that records every node it builds, so "reused, not rebuilt" is
// directly observable.
function makeRender() {
  const built = [];
  const render = (item) => {
    const n = fakeNode(undefined);
    n.item = item;
    built.push(n);
    return n;
  };
  return { built, render };
}

describe('keyedList: normal reconciliation', () => {
  it('reuses existing nodes by key, inserts new ones, removes gone ones — no warns', () => {
    const keep = fakeNode('a');
    const c = fakeContainer([keep, fakeNode('gone')]);
    const { built, render } = makeRender();

    keyedList(c, ['a', 'b'], (x) => x, render);

    assert.deepEqual(keysOf(c), ['a', 'b']);
    assert.equal(c.nodes[0], keep, 'existing node reused in place');
    assert.equal(built.length, 1, 'only the new key was rendered');
    assert.equal(built[0].dataset.key, 'b');
    assert.equal(c.nodes[1].removed, false);
    assert.deepEqual(warns, [], 'clean reconcile must not warn');
  });

  it('reorders via insertBefore when key order changed, without rebuilding', () => {
    const a = fakeNode('a');
    const b = fakeNode('b');
    const c = fakeContainer([a, b]);
    const { built, render } = makeRender();

    keyedList(c, ['b', 'a'], (x) => x, render);

    assert.deepEqual(keysOf(c), ['b', 'a']);
    assert.equal(c.nodes[0], b);
    assert.equal(c.nodes[1], a);
    assert.equal(built.length, 0, 'reorder must not render new nodes');
    assert.deepEqual(warns, []);
  });

  it('calls updateFn on every reused node', () => {
    const a = fakeNode('a');
    const c = fakeContainer([a]);
    const patched = [];

    keyedList(c, ['a'], (x) => x, () => fakeNode(undefined), (node, item) => patched.push([node, item]));

    assert.deepEqual(patched, [[a, 'a']]);
    assert.deepEqual(warns, []);
  });
});

describe('keyedList: duplicate keys', () => {
  it('warns once per duplicate key and does not throw', () => {
    const c = fakeContainer([]);
    const { render } = makeRender();

    // Three items, two sharing a key -> exactly one warn for that key.
    keyedList(c, ['x', 'dup', 'dup'], (x) => x, render);

    assert.equal(warns.length, 1, 'one warn per offending key per pass');
    assert.match(warns[0], /duplicate key "dup"/);
  });

  it('keeps the old semantics: duplicate items render two same-key nodes (the map is built once, before iteration)', () => {
    const c = fakeContainer([]);
    const { built, render } = makeRender();

    keyedList(c, ['dup', 'dup'], (x) => x, render);

    // Both duplicates render fresh nodes because `existing` was built from
    // the (empty) children list before iteration and is never updated during
    // it — this is how two children with one key end up in the container.
    assert.equal(built.length, 2);
    assert.deepEqual(keysOf(c), ['dup', 'dup']);
    assert.equal(warns.length, 1);
  });

  it('keeps the old semantics: two same-key children overwrite one map slot — the first node is orphaned, never removed', () => {
    const dupA = fakeNode('dup');
    const dupB = fakeNode('dup');
    const c = fakeContainer([dupA, dupB]);
    const { built, render } = makeRender();

    keyedList(c, ['dup'], (x) => x, render);

    // dupB overwrote dupA's map slot at build time; cleanup only walks the
    // map, so dupA is pinned forever — the pre-C2 behavior, deliberately
    // unchanged (this task adds observability, not a behavior change).
    assert.equal(dupA.removed, false, 'orphaned first node is never removed');
    assert.equal(dupB.removed, false);
    assert.equal(built.length, 0, 'existing node reused');
    assert.deepEqual(keysOf(c), ['dup', 'dup']);
  });

  it('warns again on a later pass (the bound is per pass, not forever)', () => {
    const c = fakeContainer([]);
    const { render } = makeRender();

    keyedList(c, ['dup', 'dup'], (x) => x, render);
    assert.equal(warns.length, 1);
    warns = [];

    keyedList(c, ['dup', 'dup'], (x) => x, render);
    assert.equal(warns.length, 1, 'next reconcile pass warns again');
  });
});

describe('keyedList: keyless children', () => {
  it('warns once for keyless children and does not throw', () => {
    // Two children with no data-key: both collapse onto the "undefined" key,
    // but the warn fires once (per offending key, here "keyless").
    const c = fakeContainer([fakeNode(undefined), fakeNode(undefined)]);
    const { render } = makeRender();

    keyedList(c, [], (x) => x, render);

    assert.equal(warns.length, 1, 'one warn for keyless children per pass');
    assert.match(warns[0], /no data-key/);
  });

  it('keeps the old semantics: keyless children collapse to one map slot; one is orphaned', () => {
    const k1 = fakeNode(undefined);
    const k2 = fakeNode(undefined);
    const c = fakeContainer([k1, k2]);
    const { built, render } = makeRender();

    keyedList(c, [undefined], (x) => x, render);

    // k2 overwrote k1's map slot (both keyed `undefined`). The item's key is
    // the STRING "undefined" (String(undefined)), which never matches the map
    // slot keyed `undefined` — so a fresh node is rendered, k2 is removed in
    // cleanup, and k1 is orphaned forever. Pre-C2 behavior, unchanged.
    assert.equal(built.length, 1);
    assert.equal(k2.removed, true);
    assert.equal(k1.removed, false, 'first keyless child is orphaned, never removed');
    assert.deepEqual(keysOf(c), ['undefined', undefined]);
  });
});

describe('keyedList: keyFn receives the item index (memory-widget fix shape)', () => {
  it('lets colliding values take distinct keys via summary#index', () => {
    const c = fakeContainer([]);
    const { built, render } = makeRender();
    const items = [{ summary: 'same' }, { summary: 'same' }, { summary: 'other' }];

    keyedList(c, items, (e, i) => e.summary + '#' + i, render);

    assert.deepEqual(keysOf(c), ['same#0', 'same#1', 'other#2']);
    assert.equal(built.length, 3);
    assert.deepEqual(warns, [], 'index-suffixed keys must not collide');
  });
});
