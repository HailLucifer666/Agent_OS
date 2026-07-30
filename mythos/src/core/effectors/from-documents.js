'use strict';

// effectors/from-documents.js — §7.5 Document RAG. Uploaded prose documents
// (txt/md) are chunked (chunker.chunkProse), embedded via
// providers/embeddings.js, and written into the Documents store + the SHARED
// `documents` vector-index partition that from-code-search.js (§7.11) also
// writes to — see memory/index.js's `vecIndexes` comment for why a second
// createVectorIndex(...) call anywhere in this feature would be the wrong
// turn. Differentiated by `sourceType` on each chunk record, not a second
// index.

const path = require('path');
const fsSync = require('fs');
const crypto = require('crypto');
const { effectorFromTool } = require('./adapter');
const { resolveSandboxed } = require('./from-computer');
const { chunkProse } = require('../memory/chunker');
const defaultEmbeddings = require('../../../providers/embeddings');

const ALLOWED_EXT = new Set(['.txt', '.md']);
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB — prose documents, generous but bounded

function ok(result) { return { ok: true, result: result }; }
function fail(reason) { return { ok: false, result: reason }; }

// createDocumentsEffector({ documents, documentsIndex, embed }) — `embed` is
// an injectable seam (mirrors live-session.js's createSocket / pcm-player.js's
// contextFactory precedent): defaults to the real providers/embeddings.embed,
// but tests can inject a deterministic fake embedder to prove real
// ranking/fusion behavior instead of only the "embeddings are down" branch.
function createDocumentsEffector({ documents, documentsIndex, embed }) {
  if (!documents) throw new Error('createDocumentsEffector requires a documents store');
  if (!documentsIndex) throw new Error('createDocumentsEffector requires a documentsIndex (vector-index partition)');
  const embedFn = embed || defaultEmbeddings.embed;

  async function document_ingest(args) {
    const rawPath = args && args.path;
    const title = args && args.title;
    const sandboxed = resolveSandboxed(rawPath);
    if (!sandboxed.ok) return fail(sandboxed.reason);

    const ext = path.extname(sandboxed.resolved).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return fail('Unsupported file type "' + ext + '" — document_ingest only reads .txt/.md (refuses to mis-decode binary).');
    }

    let text;
    try {
      const stat = fsSync.statSync(sandboxed.resolved);
      if (!stat.isFile()) return fail('Not a file: ' + sandboxed.resolved);
      if (stat.size > MAX_READ_BYTES) {
        return fail('File is too large to ingest (' + Math.round(stat.size / 1024) + 'KB, limit ' + (MAX_READ_BYTES / 1024 / 1024) + 'MB).');
      }
      text = fsSync.readFileSync(sandboxed.resolved, 'utf8');
    } catch (err) {
      return fail(err.message);
    }

    const docId = crypto.randomUUID();
    const docTitle = title || path.basename(sandboxed.resolved);
    const chunks = chunkProse(text);
    let embedded = 0;
    let skipped = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const { ref } = documents.write(chunk.text, {
        docId: docId,
        sourceType: 'upload',
        title: docTitle,
        filePath: sandboxed.resolved,
        chunkIndex: i,
      });
      let embedding = null;
      try { embedding = await embedFn(chunk.text); } catch (_) { embedding = null; }
      if (embedding) {
        documentsIndex.add(ref, embedding);
        embedded++;
      } else {
        // Embeddings down for this chunk — degrade per-chunk, not the whole
        // ingest. The chunk text is already stored and will simply not be
        // vector-searchable until a later reindex.
        skipped++;
      }
    }

    documents.registerDocument({
      docId: docId,
      sourceType: 'upload',
      title: docTitle,
      filePath: sandboxed.resolved,
      chunkCount: chunks.length,
    });

    return ok({ docId: docId, title: docTitle, chunks: chunks.length, embedded: embedded, skipped: skipped });
  }

  function document_list() {
    return ok({ docs: documents.listDocs() });
  }

  async function document_search(args) {
    const query = String((args && args.query) || '').trim();
    if (!query) return fail('query required');
    const embedding = await embedFn(query);
    if (!embedding) return ok({ results: [], degraded: true, reason: 'embeddings unavailable' });

    const hits = documentsIndex.search(embedding, 10);
    const results = [];
    for (const h of hits) {
      const rec = documents.get(h.ref);
      if (!rec) continue;
      results.push({
        ref: h.ref,
        score: h.score,
        docId: rec.docId,
        sourceType: rec.sourceType,
        title: rec.title,
        filePath: rec.filePath,
        lineStart: rec.lineStart,
        lineEnd: rec.lineEnd,
        snippet: String(rec.text || '').slice(0, 200),
      });
    }
    return ok({ results: results });
  }

  return { document_ingest: document_ingest, document_list: document_list, document_search: document_search };
}

function buildDocumentsTools(ctx) {
  const effector = createDocumentsEffector(ctx);
  return [
    { name: 'document_ingest', description: 'Ingest a text or markdown document: chunks it, embeds each chunk, and stores it in searchable document memory.', params: { path: 'string', title: 'string (optional)' }, danger: false, fn: function(args) { return effector.document_ingest(args); }, needs_result: true },
    { name: 'document_list', description: 'List previously ingested documents (title, source, chunk count).', params: {}, danger: false, fn: function() { return effector.document_list(); }, needs_result: true },
    { name: 'document_search', description: 'Search ingested documents by meaning (semantic search over document chunks).', params: { query: 'string' }, danger: false, fn: function(args) { return effector.document_search(args); }, needs_result: true },
  ];
}

function registerFromDocuments(hub, ctx) {
  const tools = buildDocumentsTools(ctx);
  for (let i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = { createDocumentsEffector, buildDocumentsTools, registerFromDocuments };
