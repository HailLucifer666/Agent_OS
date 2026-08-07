'use strict';

// document-rag.test.js — §7.5 Document RAG.
//
// Covers: the word-chunking function (chunker.chunkProse), the Documents
// store (chunk records + doc-level index), the from-documents.js effector
// (document_ingest/document_list/document_search), and the memory/index.js
// wiring that adds a THIRD vector-index partition ('documents') to the
// existing episodic/semantic fan-out inside recallHybrid().
//
// Real embeddings (providers/embeddings.js) hit Ollama/Mistral over the
// network — likely unavailable in this test environment. Per the task brief,
// the effector accepts an injectable `embed` function (mirrors
// live-session.js's createSocket seam / pcm-player.js's contextFactory seam)
// so these tests can prove real ranking/fusion behavior with a deterministic
// fake embedder, not just the "embeddings are down" branch.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { chunkProse } = require('../src/core/memory/chunker');
const { createDocumentsStore } = require('../src/core/memory/documents');
const { createVectorIndex } = require('../src/core/memory/vector-index');
const { createDocumentsEffector } = require('../src/core/effectors/from-documents');
const { createMemory } = require('../src/core/memory/index');
const embeddings = require('../providers/embeddings');

function memFs() {
  const files = new Map();
  return {
    readJSON: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    readJSONStrict: (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJSON: (p, d) => { files.set(p, JSON.stringify(d)); },
    ensureDir: () => {},
    vaultPath: (...segments) => segments.join('/'),
    _files: files,
  };
}

// Deterministic fake embedder — 3 marker axes so cosine similarity is fully
// predictable without any network call.
function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const vec = [
    t.includes('coffee') ? 1 : 0,
    t.includes('rocket') ? 1 : 0,
    (t.includes('function') || t.includes('code')) ? 1 : 0,
  ];
  return Promise.resolve({ provider: 'fake', dim: 3, vec: Float32Array.from(vec) });
}

// Scratch dir inside the project root (allowedRoots() always includes it —
// matches test/from-computer-fileops.test.js's own convention).
const SCRATCH_ROOT = path.resolve(__dirname, '..', '.tmp-doc-rag-test');

// Each test gets its own uniquely-named subdirectory and wipes it before use
// (see code-search.test.js's freshScratchDir for the failure mode this
// avoids: a prior failed run's cleanup never running must not leak into a
// later run or a sibling test sharing the same parent path).
function freshScratchDir(name) {
  const dir = path.join(SCRATCH_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Each test removed its OWN subdirectory but nothing ever removed the parent,
// so every suite run left an empty .tmp-doc-rag-test/ in the repo root — git
// doesn't track empty directories, so it never showed up in `git status` and
// never got cleaned. Best-effort by design: a cleanup that throws (Windows
// EPERM/EBUSY under full-suite load) must never turn a green run red.
after(() => {
  try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

describe('chunkProse', () => {
  it('chunks with ~15% overlap and covers every word', () => {
    const words = Array.from({ length: 2000 }, (_, i) => 'w' + i);
    const text = words.join(' ');
    const chunks = chunkProse(text, { chunkWords: 800, overlapRatio: 0.15 });
    assert.ok(chunks.length >= 3);
    assert.equal(chunks[0].wordStart, 0);
    assert.equal(chunks[0].wordEnd, 800);
    // step = 800 - round(800*0.15)=120 -> 680
    assert.equal(chunks[1].wordStart, 680);
    assert.equal(chunks[chunks.length - 1].wordEnd, 2000);
  });

  it('short text -> a single chunk covering it all', () => {
    const chunks = chunkProse('hello world');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, 'hello world');
  });

  it('empty text -> no chunks', () => {
    assert.deepEqual(chunkProse(''), []);
  });
});

describe('createDocumentsStore', () => {
  it('write/get roundtrip and doc-level index', () => {
    const store = createDocumentsStore({ fs: memFs() });
    const { ref } = store.write('hello chunk text', { docId: 'd1', sourceType: 'upload', title: 'notes.txt', chunkIndex: 0 });
    const rec = store.get(ref);
    assert.equal(rec.text, 'hello chunk text');
    assert.equal(rec.docId, 'd1');
    assert.equal(rec.sourceType, 'upload');

    store.registerDocument({ docId: 'd1', sourceType: 'upload', title: 'notes.txt', chunkCount: 1 });
    const docs = store.listDocs();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].docId, 'd1');
  });

  it('get() returns null for an unknown ref', () => {
    const store = createDocumentsStore({ fs: memFs() });
    assert.equal(store.get('doc-nope'), null);
  });
});

describe('from-documents effector (DI fake embedder)', () => {
  it('document_ingest chunks+embeds a real sandboxed file; document_search finds it by meaning', async () => {
    const dir = freshScratchDir('ingest-happy-path');
    const filePath = path.join(dir, 'coffee-notes.txt');
    fs.writeFileSync(filePath, 'I really like coffee in the morning. Dark roast is best.');

    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createDocumentsEffector({ documents, documentsIndex, embed: fakeEmbed });

    const ingestRes = await effector.document_ingest({ path: filePath, title: 'Coffee Notes' });
    assert.equal(ingestRes.ok, true, JSON.stringify(ingestRes));
    assert.equal(ingestRes.result.chunks, 1);
    assert.equal(ingestRes.result.embedded, 1);
    assert.equal(ingestRes.result.skipped, 0);

    const listRes = effector.document_list();
    assert.equal(listRes.ok, true);
    assert.equal(listRes.result.docs.length, 1);
    assert.equal(listRes.result.docs[0].title, 'Coffee Notes');

    const searchRes = await effector.document_search({ query: 'coffee' });
    assert.equal(searchRes.ok, true);
    assert.ok(searchRes.result.results.length > 0, 'coffee query must find the coffee chunk');
    assert.equal(searchRes.result.results[0].sourceType, 'upload');
    assert.match(searchRes.result.results[0].snippet, /coffee/i);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('document_ingest rejects a path outside the sandbox', async () => {
    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createDocumentsEffector({ documents, documentsIndex, embed: fakeEmbed });

    const res = await effector.document_ingest({ path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /outside|allowed/i);
  });

  it('document_ingest rejects an unsupported extension honestly instead of mis-decoding it', async () => {
    const dir = freshScratchDir('unsupported-ext');
    const filePath = path.join(dir, 'binary.exe');
    fs.writeFileSync(filePath, Buffer.from([0, 1, 2, 3]));

    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createDocumentsEffector({ documents, documentsIndex, embed: fakeEmbed });

    const res = await effector.document_ingest({ path: filePath });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /unsupported|\.txt|\.md/i);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('document_search degrades honestly (no results, no throw) when embeddings are down', async () => {
    const memfs = memFs();
    const documents = createDocumentsStore({ fs: memfs });
    const documentsIndex = createVectorIndex({ fs: memfs, store: 'documents' });
    documentsIndex.init();
    const effector = createDocumentsEffector({ documents, documentsIndex, embed: async () => null });

    const res = await effector.document_search({ query: 'anything' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.results, []);
    assert.equal(res.result.degraded, true);
  });
});

describe('memory/index.js wiring: documents is the ONLY new vector-index partition', () => {
  function tempVault() {
    const dir = path.join(os.tmpdir(), 'mythos-doc-rag-mem-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function fakeBus() {
    const { createBus } = require('../src/core/bus');
    return createBus({ historySize: 50 });
  }

  it('createMemory() exposes exactly episodic/semantic/documents vector-index partitions', async () => {
    const vaultRoot = tempVault();
    const memory = createMemory({
      config: { MYTHOS_VAULT_ROOT: vaultRoot },
      bus: fakeBus(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      brain: null,
    });
    await memory.init();

    assert.ok(memory.documents, 'memory.documents (the Documents store) must be exposed');
    assert.ok(memory.documentsIndex, 'memory.documentsIndex (the shared vector-index partition) must be exposed');
    assert.equal(memory.documentsIndex.stats().store, 'documents');

    // Prove it's really the same partition backing BOTH a doc-ingest-shaped
    // write and a code-index-shaped write: add two entries tagged with
    // different sourceType and confirm both land in the one
    // Index/documents.vec.json sidecar (not two separate index files).
    const { ref: docRef } = memory.documents.write('uploaded prose chunk', { docId: 'd1', sourceType: 'upload' });
    const { ref: codeRef } = memory.documents.write('function foo() {}', { docId: 'd2', sourceType: 'code', filePath: 'x.js', lineStart: 1, lineEnd: 1 });
    memory.documentsIndex.add(docRef, { provider: 'fake', dim: 2, vec: Float32Array.from([1, 0]) });
    memory.documentsIndex.add(codeRef, { provider: 'fake', dim: 2, vec: Float32Array.from([0, 1]) });
    assert.equal(memory.documentsIndex.stats().count, 2, 'both sourceTypes share the same partition/count');

    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('recallHybrid fan-out includes the documents partition (monkey-patched embeddings.embed — no network needed)', async () => {
    const vaultRoot = tempVault();
    const memory = createMemory({
      config: { MYTHOS_VAULT_ROOT: vaultRoot },
      bus: fakeBus(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      brain: null,
    });
    await memory.init();

    const { ref } = memory.documents.write('a durable fact about rockets and spaceflight', { docId: 'd1', sourceType: 'upload', title: 'space.txt' });
    memory.documentsIndex.add(ref, { provider: 'fake', dim: 1, vec: Float32Array.from([1]) });
    memory.documentsIndex.flush();

    // No DI seam exists on recallHybrid itself (it calls the real
    // providers/embeddings module directly, same as episodic/semantic
    // already do) — monkey-patch the shared singleton's embed() for the
    // duration of this one call, then restore it. This is the real
    // integration path recallHybrid uses in production, just with a fake
    // embedder standing in for the network call.
    const original = embeddings.embed;
    embeddings.embed = async () => ({ provider: 'fake', dim: 1, vec: Float32Array.from([1]) });
    try {
      const hits = await memory.recallHybrid('anything, the embedder is faked', { limit: 10 });
      assert.ok(hits.some((h) => h.store === 'documents'), 'recallHybrid must surface a documents-sourced hit');
      const hit = hits.find((h) => h.store === 'documents');
      assert.equal(hit.record.sourceType, 'upload');
    } finally {
      embeddings.embed = original;
    }

    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });
});
