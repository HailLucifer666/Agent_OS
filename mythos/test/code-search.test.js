'use strict';

// code-search.test.js — §7.11 semantic code search.
//
// Covers: the boundary-aware code chunker (chunker.chunkCode), and the
// from-code-search.js effector (index_project/search_code) — which MUST
// reuse the exact same Documents store + `documents` vector-index partition
// that from-documents.js (§7.5) writes to, differentiated only by
// sourceType:'code' on each chunk. This file's most important test proves
// that invariant directly: indexing code populates the SAME
// Index/documents.vec.json sidecar a document ingest would, not a second one.
//
// Same DI-seam approach as document-rag.test.js: embed is injectable so
// these tests exercise real ranking behavior with a deterministic fake
// embedder instead of only the "embeddings are down" branch.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { chunkCode } = require('../src/core/memory/chunker');
const { createDocumentsStore } = require('../src/core/memory/documents');
const { createVectorIndex } = require('../src/core/memory/vector-index');
const { createCodeSearchEffector } = require('../src/core/effectors/from-code-search');
const { createDocumentsEffector } = require('../src/core/effectors/from-documents');

function memFs() {
  const files = new Map();
  return {
    readJSON: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJSON: (p, d) => { files.set(p, JSON.stringify(d)); },
    ensureDir: () => {},
    vaultPath: (...segments) => segments.join('/'),
    _files: files,
  };
}

function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const vec = [
    t.includes('coffee') ? 1 : 0,
    (t.includes('function') || t.includes('foo') || t.includes('bar')) ? 1 : 0,
  ];
  return Promise.resolve({ provider: 'fake', dim: 2, vec: Float32Array.from(vec) });
}

const SCRATCH_ROOT = path.resolve(__dirname, '..', '.tmp-code-search-test');

// Each test gets its own uniquely-named subdirectory (not just SCRATCH_ROOT
// itself) and wipes it before use — a prior failed run leaving files behind
// (its own end-of-test cleanup never reached) must never leak into a later
// run or a sibling test sharing the same parent path.
function freshScratchDir(name) {
  const dir = path.join(SCRATCH_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Each test removed its OWN subdirectory but nothing ever removed the parent,
// so every suite run left an empty .tmp-code-search-test/ in the repo root —
// git doesn't track empty directories, so it never showed up in `git status`
// and never got cleaned. Best-effort by design: a cleanup that throws (Windows
// EPERM/EBUSY under full-suite load) must never turn a green run red.
after(() => {
  try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

describe('chunkCode', () => {
  it('keeps a small file with two top-level functions as separate chunks when it exceeds maxLines', () => {
    const fnA = 'function foo() {\n' + Array.from({ length: 5 }, (_, i) => '  var a' + i + ' = ' + i + ';').join('\n') + '\n}\n';
    const fnB = 'function bar() {\n' + Array.from({ length: 5 }, (_, i) => '  var b' + i + ' = ' + i + ';').join('\n') + '\n}\n';
    const text = fnA + fnB;
    const chunks = chunkCode(text, { maxLines: 5 });
    assert.ok(chunks.length >= 2, 'two functions bigger than maxLines combined must split into >=2 chunks');
    assert.ok(chunks.some((c) => c.text.includes('function foo')));
    assert.ok(chunks.some((c) => c.text.includes('function bar')));
    // No chunk should contain both functions' full bodies split mid-function —
    // each chunk's lineStart/lineEnd must be a contiguous, valid range.
    for (const c of chunks) {
      assert.ok(c.lineEnd > c.lineStart - 1);
      assert.equal(typeof c.lineStart, 'number');
    }
  });

  it('small functions under the cap stay merged into one chunk', () => {
    const text = 'function a() { return 1; }\nfunction b() { return 2; }\n';
    const chunks = chunkCode(text, { maxLines: 200 });
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.includes('function a'));
    assert.ok(chunks[0].text.includes('function b'));
  });

  it('a file with no recognizable boundaries (e.g. markdown/JSON) still gets capped by line count', () => {
    const lines = Array.from({ length: 30 }, (_, i) => 'plain line ' + i);
    const chunks = chunkCode(lines.join('\n'), { maxLines: 10 });
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].lineStart, 1);
    assert.equal(chunks[0].lineEnd, 10);
    assert.equal(chunks[2].lineEnd, 30);
  });

  it('empty text -> no chunks', () => {
    assert.deepEqual(chunkCode(''), []);
  });
});

describe('from-code-search effector (DI fake embedder)', () => {
  it('index_project walks a real sandboxed dir, chunks+embeds code files; search_code finds by meaning with file:line info', async () => {
    const dir = freshScratchDir('index-project');
    fs.writeFileSync(path.join(dir, 'sample.js'), "function foo() {\n  return 'bar';\n}\n");
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'ignored.js'), 'function shouldNotBeIndexed() {}\n');

    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createCodeSearchEffector({ documents, documentsIndex, embed: fakeEmbed });

    const res = await effector.index_project({ dir: dir });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result.filesIndexed, 1, 'node_modules must be skipped');
    assert.ok(res.result.chunks >= 1);
    assert.equal(res.result.embedded, res.result.chunks);

    const searchRes = await effector.search_code({ query: 'function foo' });
    assert.equal(searchRes.ok, true);
    assert.ok(searchRes.result.results.length > 0);
    assert.match(searchRes.result.results[0].filePath, /sample\.js$/);
    assert.equal(typeof searchRes.result.results[0].lineStart, 'number');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('index_project rejects a directory outside the sandbox', async () => {
    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createCodeSearchEffector({ documents, documentsIndex, embed: fakeEmbed });

    const res = await effector.index_project({ dir: 'C:\\Windows\\System32' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /outside|allowed/i);
  });

  it('search_code degrades honestly (no results, no throw) when embeddings are down', async () => {
    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createCodeSearchEffector({ documents, documentsIndex, embed: async () => null });

    const res = await effector.search_code({ query: 'anything' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.results, []);
    assert.equal(res.result.degraded, true);
  });
});

describe('invariant: code indexing and document ingest share ONE vector-index partition', () => {
  it('a doc-ingest write and a code-index write land in the same fs-store key (Index/documents.vec.json), same store instance', async () => {
    const dir = freshScratchDir('invariant');
    const docFile = path.join(dir, 'notes.txt');
    fs.writeFileSync(docFile, 'a document about coffee brewing techniques');
    const codeFile = path.join(dir, 'lib.js');
    fs.writeFileSync(codeFile, "function bar() {\n  return 42;\n}\n");

    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();

    const docsEffector = createDocumentsEffector({ documents, documentsIndex, embed: fakeEmbed });
    const codeEffector = createCodeSearchEffector({ documents, documentsIndex, embed: fakeEmbed });

    await docsEffector.document_ingest({ path: docFile });
    await codeEffector.index_project({ dir: dir });
    documentsIndex.flush();

    // Only one sidecar file was ever written for the vector index, and it
    // holds items from BOTH sourceTypes — proves there is no second
    // createVectorIndex(...) partition anywhere in this feature.
    const vecFiles = [...memfs._files.keys()].filter((k) => k.startsWith('Index/'));
    assert.deepEqual(vecFiles, ['Index/documents.vec.json'], 'exactly one vector-index sidecar must exist for this feature');

    const stats = documentsIndex.stats();
    assert.equal(stats.store, 'documents');
    assert.ok(stats.count >= 2, 'both the doc chunk and at least one code chunk are in the same partition');

    const docsList = documents.listDocs();
    assert.ok(docsList.some((d) => d.sourceType === 'upload'));
    assert.ok(docsList.some((d) => d.sourceType === 'code'));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
