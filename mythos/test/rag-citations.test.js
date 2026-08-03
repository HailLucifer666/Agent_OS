'use strict';

// rag-citations.test.js — §7.5 Document RAG, closing the "answers carry no
// sources" gap: document_answer must return { answer, sources: [{ ref, docId,
// span }] } and satisfy the effector evidence contract (src/core/effectors/
// evidence.js) — ok:true only alongside a real 'chunk-file' oracle, never a
// bare ok:true.
//
// Uses a REAL fs-store rooted under os.tmpdir() (not the in-memory fake other
// document tests use) specifically so this file's central assertion is
// against actual bytes on disk: every ref returned in sources[] must resolve
// to a real Documents/chunks/<ref>.json file, not just an in-process Map.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFsStore } = require('../src/core/memory/fs-store');
const { createDocumentsStore } = require('../src/core/memory/documents');
const { createVectorIndex } = require('../src/core/memory/vector-index');
const { createDocumentsEffector } = require('../src/core/effectors/from-documents');
const evidence = require('../src/core/effectors/evidence');

function fakeEmbed(text) {
  const t = String(text).toLowerCase();
  const vec = [
    t.includes('coffee') ? 1 : 0,
    t.includes('astronomy') ? 1 : 0,
  ];
  return Promise.resolve({ provider: 'fake', dim: 2, vec: Float32Array.from(vec) });
}

// document_ingest's path goes through resolveSandboxed (from-computer.js),
// which only allows the project root and the user's home directory — the OS
// temp dir (os.tmpdir()) is NOT one of them, so a real fs-store for this test
// must live under the repo, same convention code-search.test.js already uses
// for its own scratch dir.
const SCRATCH_ROOT = path.resolve(__dirname, '..', '.tmp-rag-citations-test');
let counter = 0;
function freshVaultRoot() {
  const dir = path.join(SCRATCH_ROOT, 'run-' + (counter++));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  try { fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
});

function makeEffector(brain) {
  const vaultRoot = freshVaultRoot();
  const store = createFsStore(() => vaultRoot);
  const documents = createDocumentsStore({ fs: store });
  const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
  documentsIndex.init();
  const effector = createDocumentsEffector({ documents, documentsIndex, embed: fakeEmbed, brain });
  return { effector, vaultRoot };
}

describe('document_answer (§7.5 RAG with citations)', () => {
  it('returns sources whose refs each resolve to a real chunk file on disk', async () => {
    const { effector, vaultRoot } = makeEffector(null);
    const docPath = path.join(vaultRoot, 'notes.txt');
    fs.writeFileSync(docPath, 'a document about coffee brewing techniques and espresso ratios');

    const ingestRes = await effector.document_ingest({ path: docPath });
    assert.equal(ingestRes.ok, true, JSON.stringify(ingestRes));

    const res = await effector.document_answer({ query: 'coffee brewing' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(typeof res.result.answer, 'string');
    assert.ok(res.result.answer.length > 0);
    assert.ok(Array.isArray(res.result.sources));
    assert.ok(res.result.sources.length > 0, 'a matching query must cite at least one source');

    // THE oracle: every ref must be a real file under Documents/chunks/.
    for (const source of res.result.sources) {
      assert.equal(typeof source.ref, 'string');
      assert.equal(typeof source.docId, 'string');
      assert.ok(source.span && typeof source.span === 'object');
      const chunkFile = path.join(vaultRoot, 'Documents', 'chunks', source.ref + '.json');
      assert.ok(fs.existsSync(chunkFile), 'ref ' + source.ref + ' must resolve to a real chunk file: ' + chunkFile);
      const onDisk = JSON.parse(fs.readFileSync(chunkFile, 'utf8'));
      assert.equal(onDisk.ref, source.ref);
      assert.equal(onDisk.docId, source.docId);
    }
  });

  it('conforms to the evidence contract: ok:true carries a real chunk-file oracle', async () => {
    const { effector, vaultRoot } = makeEffector(null);
    const docPath = path.join(vaultRoot, 'notes.txt');
    fs.writeFileSync(docPath, 'a document about coffee brewing techniques');
    await effector.document_ingest({ path: docPath });

    const res = await effector.document_answer({ query: 'coffee' });
    assert.equal(res.ok, true);
    assert.equal(evidence.isVerified(res), true, 'a matched answer must be independently verified, not a bare ok:true');
    assert.equal(res.evidence.oracle, 'chunk-file');
    assert.match(res.evidence.observed, /cited chunk/);
  });

  it('no matching chunks -> honest unverified:true, never a bare ok:true', async () => {
    const { effector } = makeEffector(null);
    // Nothing ingested at all — the index is empty.
    const res = await effector.document_answer({ query: 'anything' });
    assert.equal(res.ok, true, 'unverified is not the same as failed');
    assert.equal(res.unverified, true);
    assert.match(res.reason, /\S/);
    assert.deepEqual(res.result.sources, []);
    assert.equal(evidence.isVerified(res), false);
  });

  it('embeddings unavailable -> honest unverified:true', async () => {
    const vaultRoot = freshVaultRoot();
    const store = createFsStore(() => vaultRoot);
    const documents = createDocumentsStore({ fs: store });
    const documentsIndex = createVectorIndex({ fs: store, store: 'documents' });
    documentsIndex.init();
    const effector = createDocumentsEffector({ documents, documentsIndex, embed: async () => null });

    const res = await effector.document_answer({ query: 'coffee' });
    assert.equal(res.ok, true);
    assert.equal(res.unverified, true);
    assert.match(res.reason, /embeddings unavailable/);
  });

  it('empty query is rejected', async () => {
    const { effector } = makeEffector(null);
    const res = await effector.document_answer({ query: '  ' });
    assert.equal(res.ok, false);
  });

  it('uses an injected brain to compose the answer when available, still only citing real sources', async () => {
    const { effector, vaultRoot } = makeEffector({
      think: async () => ({ offline: false, content: 'Coffee is brewed with hot water [1].' }),
    });
    const docPath = path.join(vaultRoot, 'notes.txt');
    fs.writeFileSync(docPath, 'a document about coffee brewing techniques and espresso ratios');
    await effector.document_ingest({ path: docPath });

    const res = await effector.document_answer({ query: 'coffee brewing' });
    assert.equal(res.ok, true);
    assert.equal(res.result.answer, 'Coffee is brewed with hot water [1].');
    assert.ok(res.result.sources.length > 0);
  });

  it('degrades to an extractive answer when the brain is offline', async () => {
    const { effector, vaultRoot } = makeEffector({
      think: async () => ({ offline: true }),
    });
    const docPath = path.join(vaultRoot, 'notes.txt');
    fs.writeFileSync(docPath, 'a document about coffee brewing techniques and espresso ratios');
    await effector.document_ingest({ path: docPath });

    const res = await effector.document_answer({ query: 'coffee brewing' });
    assert.equal(res.ok, true);
    assert.match(res.result.answer, /\[1\]/, 'extractive fallback numbers its citations like the brain-composed path');
  });
});
