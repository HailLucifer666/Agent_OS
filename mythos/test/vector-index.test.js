'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createVectorIndex, rrfMerge, cosine } = require('../src/core/memory/vector-index');

function memFs() {
  const files = new Map();
  return {
    readJSON: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJSON: (p, d) => { files.set(p, JSON.stringify(d)); },
    _files: files,
  };
}

function emb(provider, vec) { return { provider, dim: vec.length, vec: Float32Array.from(vec) }; }

describe('cosine', () => {
  it('identical=1, orthogonal=0, zero-safe', () => {
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-6);
    assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-6);
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });
});

describe('vector index', () => {
  it('adds, searches best-first, replaces same ref', () => {
    const ix = createVectorIndex({ fs: memFs(), store: 'episodic' });
    ix.init();
    ix.add('a', emb('ollama', [1, 0, 0]));
    ix.add('b', emb('ollama', [0, 1, 0]));
    ix.add('c', emb('ollama', [0.9, 0.1, 0]));
    const hits = ix.search(emb('ollama', [1, 0, 0]), 2);
    assert.equal(hits[0].ref, 'a');
    assert.equal(hits[1].ref, 'c');
    ix.add('a', emb('ollama', [0, 0, 1])); // replace
    assert.equal(ix.stats().count, 3);
  });

  it('provider switch resets partition; mismatched query returns empty', () => {
    const ix = createVectorIndex({ fs: memFs(), store: 'episodic' });
    ix.init();
    ix.add('a', emb('ollama', [1, 0]));
    assert.equal(ix.search(emb('mistral', [1, 0]), 5).length, 0);
    ix.add('b', emb('mistral', [1, 0, 0])); // switch resets
    assert.equal(ix.stats().count, 1);
    assert.equal(ix.stats().provider, 'mistral');
  });

  it('persists via flush and reloads', () => {
    const fs = memFs();
    const ix = createVectorIndex({ fs, store: 'semantic' });
    ix.init();
    ix.add('x', emb('ollama', [0.5, 0.5]));
    ix.flush();
    const ix2 = createVectorIndex({ fs, store: 'semantic' });
    const loaded = ix2.init();
    assert.equal(loaded.count, 1);
    assert.equal(ix2.search(emb('ollama', [0.5, 0.5]), 1)[0].ref, 'x');
  });
});

describe('rrfMerge', () => {
  it('item ranked high in both lists wins', () => {
    const kw = [{ ref: 'a' }, { ref: 'b' }, { ref: 'c' }];
    const vec = [{ ref: 'b' }, { ref: 'a' }, { ref: 'd' }];
    const merged = rrfMerge([kw, vec]);
    assert.deepEqual(merged.slice(0, 2).map((m) => m.ref).sort(), ['a', 'b']);
    assert.ok(merged.find((m) => m.ref === 'd')); // vector-only result survives
  });
});
