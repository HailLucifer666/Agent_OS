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
// The evidence contract: document_answer cites chunks by ref, and a citation
// is only honest if the ref resolves to a real chunk file — see evidence.js's
// 'chunk-file' oracle.
const evidence = require('./evidence');

const ALLOWED_EXT = new Set(['.txt', '.md']);
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2MB — prose documents, generous but bounded
const BRAIN_TIMEOUT_MS = 12000; // mirrors planner/daily.js's brainCompose timeout

function ok(result) { return { ok: true, result: result }; }
function fail(reason) { return { ok: false, result: reason }; }

// createDocumentsEffector({ documents, documentsIndex, embed, brain }) —
// `embed` is an injectable seam (mirrors live-session.js's createSocket /
// pcm-player.js's contextFactory precedent): defaults to the real
// providers/embeddings.embed, but tests can inject a deterministic fake
// embedder to prove real ranking/fusion behavior instead of only the
// "embeddings are down" branch. `brain` is optional — document_answer degrades
// to an extractive (quote-the-passages) answer when it's absent or offline,
// same graceful-degrade shape as planner/daily.js's brainCompose.
function createDocumentsEffector({ documents, documentsIndex, embed, brain }) {
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
        // wordStart/wordEnd (chunkProse's own offsets) — needed so
        // document_answer can report a citation span, same role lineStart/
        // lineEnd plays for code chunks in from-code-search.js.
        wordStart: chunk.wordStart,
        wordEnd: chunk.wordEnd,
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

  // composeAnswer — grounds the answer in the retrieved passages only, never
  // in brain.think's own general knowledge. Falls back to an extractive quote
  // of the top passages (no brain wired, brain offline, or the call errors) —
  // an extractive answer is still honestly citable, just not synthesized.
  async function composeAnswer(query, passages) {
    if (brain && typeof brain.think === 'function') {
      try {
        const numbered = passages.map(function(p, i) { return '[' + (i + 1) + '] ' + p; }).join('\n\n');
        const result = await Promise.race([
          brain.think({
            // lane 'memory' (2026-08-14) — grounded retrieval-answering, the
            // same class of work as memory consolidation, moved off the
            // trivial/formatting lane with it.
            lane: 'memory',
            messages: [{ role: 'user', content:
              'Answer the question using ONLY the passages below, and cite them inline like [1]. ' +
              'If the passages do not contain the answer, say so plainly instead of guessing.\n\n' +
              'Question: ' + query + '\n\nPassages:\n' + numbered }],
            source: 'document-answer',
          }),
          new Promise(function(resolve) {
            const t = setTimeout(function() { resolve(null); }, BRAIN_TIMEOUT_MS);
            if (t.unref) t.unref();
          }),
        ]);
        if (result && !result.offline && result.content) return String(result.content).trim();
      } catch (_) { /* fall through to the extractive answer below */ }
    }
    return passages.map(function(p, i) { return '[' + (i + 1) + '] ' + p.slice(0, 300); }).join('\n\n');
  }

  // document_answer(args) -> { answer, sources: [{ ref, docId, span }] }.
  // The recall/answer path GAP this closes: document_search already returned
  // raw chunk hits, but nothing composed an answer or named which chunks it
  // came from. Every source's ref is only kept once documents.get(ref) proves
  // the chunk file is actually there — see the evidence.verifiedOk call below,
  // oracle 'chunk-file'.
  async function document_answer(args) {
    const query = String((args && args.query) || '').trim();
    if (!query) return fail('query required');
    const limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 5, 1), 10);

    const embedding = await embedFn(query);
    if (!embedding) {
      return evidence.unverified(ok({ answer: '', sources: [] }),
        'embeddings unavailable — cannot retrieve source chunks to ground an answer');
    }

    const hits = documentsIndex.search(embedding, limit);
    const sources = [];
    const passages = [];
    for (const h of hits) {
      const rec = documents.get(h.ref);
      // A stale vector-index entry (chunk file missing/deleted) must never be
      // cited — this loop IS the 'chunk-file' oracle check.
      if (!rec) continue;
      const span = (rec.lineStart != null && rec.lineEnd != null)
        ? { lineStart: rec.lineStart, lineEnd: rec.lineEnd }
        : { wordStart: rec.wordStart, wordEnd: rec.wordEnd };
      sources.push({ ref: h.ref, docId: rec.docId, span: span });
      passages.push(rec.text);
    }

    if (sources.length === 0) {
      return evidence.unverified(ok({ answer: '', sources: [] }), 'no document chunks matched this query');
    }

    const answer = await composeAnswer(query, passages);

    return evidence.verifiedOk(ok({ answer: answer, sources: sources }), {
      oracle: 'chunk-file',
      expected: query,
      observed: sources.length + ' cited chunk(s) resolved to real files on disk: ' +
        sources.map(function(s) { return s.ref; }).join(', '),
    });
  }

  return { document_ingest: document_ingest, document_list: document_list, document_search: document_search, document_answer: document_answer };
}

function buildDocumentsTools(ctx) {
  const effector = createDocumentsEffector(ctx);
  return [
    { name: 'document_ingest', description: 'Ingest a text or markdown document: chunks it, embeds each chunk, and stores it in searchable document memory.', params: { path: 'string', title: 'string (optional)' }, danger: false, fn: function(args) { return effector.document_ingest(args); }, needs_result: true },
    { name: 'document_list', description: 'List previously ingested documents (title, source, chunk count).', params: {}, danger: false, fn: function() { return effector.document_list(); }, needs_result: true },
    { name: 'document_search', description: 'Search ingested documents by meaning (semantic search over document chunks).', params: { query: 'string' }, danger: false, fn: function(args) { return effector.document_search(args); }, needs_result: true },
    { name: 'document_answer', description: 'Answer a question grounded in ingested documents; returns the answer plus the exact chunks it was cited from.', params: { query: 'string', limit: 'number (optional)' }, danger: false, fn: function(args) { return effector.document_answer(args); }, needs_result: true },
  ];
}

function registerFromDocuments(hub, ctx) {
  const tools = buildDocumentsTools(ctx);
  for (let i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = { createDocumentsEffector, buildDocumentsTools, registerFromDocuments };
