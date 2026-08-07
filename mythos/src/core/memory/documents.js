'use strict';

const crypto = require('crypto');

// documents.js — Documents store (§7.5 Document RAG + §7.11 code search share
// this — see memory/index.js's `vecIndexes.documents` comment for why there is
// only ONE vector-index partition for both). Chunk-level records live one
// file per chunk under vault/Documents/chunks/<ref>.json — mirrors
// vector-index.js's one-sidecar-per-store shape, avoids one giant JSON file
// growing unboundedly, and a single-chunk get() never needs to load the whole
// corpus. Doc-level metadata (one row per ingested document, not per chunk)
// lives in vault/Documents/index.json for document_list().

function createDocumentsStore({ fs }) {
  if (!fs || typeof fs.readJSON !== 'function' || typeof fs.writeJSON !== 'function' || typeof fs.readJSONStrict !== 'function') {
    throw new Error('createDocumentsStore requires a vault fs-store with readJSON/readJSONStrict/writeJSON');
  }

  const INDEX_PATH = 'Documents/index.json';

  function chunkPath(ref) {
    return 'Documents/chunks/' + ref + '.json';
  }

  function nextRef() {
    return 'doc-' + crypto.randomUUID();
  }

  // write(text, meta) -> { ref } — stores one chunk's full text + metadata.
  // meta: { docId, sourceType: 'upload'|'code', title|filePath, chunkIndex,
  //         lineStart?, lineEnd? }. fs.writeJSON (fs-store.js's writeText)
  // creates the Documents/chunks/ directory on demand — no manual ensureDir.
  function write(text, meta) {
    meta = meta || {};
    const ref = nextRef();
    const record = Object.assign({ ref: ref, text: String(text || ''), ts: Date.now() }, meta);
    fs.writeJSON(chunkPath(ref), record);
    return { ref: ref };
  }

  function get(ref) {
    if (!ref) return null;
    try {
      return fs.readJSON(chunkPath(ref), null);
    } catch (_) {
      return null;
    }
  }

  // registerDocument(docMeta) — upserts one row into the doc-level index,
  // keyed by docId. docMeta: { docId, sourceType, title|filePath, chunkCount }
  //
  // B7: read-mutate-write on INDEX_PATH — readJSON() would read a corrupt
  // index.json as the empty fallback, and the writeJSON below would then
  // commit that empty index over the real one, dropping every document's
  // metadata and orphaning its chunks. readJSONStrict throws instead, so the
  // corruption surfaces here rather than being silently written away.
  function registerDocument(docMeta) {
    if (!docMeta || !docMeta.docId) return null;
    const index = fs.readJSONStrict(INDEX_PATH, { docs: [] });
    const docs = Array.isArray(index.docs) ? index.docs : [];
    const idx = docs.findIndex(function(d) { return d.docId === docMeta.docId; });
    const row = Object.assign({ ts: Date.now() }, docMeta);
    if (idx !== -1) docs[idx] = row;
    else docs.push(row);
    fs.writeJSON(INDEX_PATH, { docs: docs });
    return row;
  }

  // listDocs() -> doc-level metadata (not per-chunk).
  function listDocs() {
    const index = fs.readJSON(INDEX_PATH, { docs: [] });
    return Array.isArray(index.docs) ? index.docs : [];
  }

  return { write: write, get: get, registerDocument: registerDocument, listDocs: listDocs, nextRef: nextRef };
}

module.exports = { createDocumentsStore };
