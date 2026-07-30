'use strict';

// effectors/from-code-search.js — §7.11 semantic code search. Reuses the
// exact same Documents store + `documents` vector-index partition that
// from-documents.js (§7.5) writes to — differentiated by sourceType:'code'
// on each chunk, NOT a second index. See memory/index.js's `vecIndexes`
// comment for why a second createVectorIndex(...) call here would be wrong.

const path = require('path');
const fsSync = require('fs');
const crypto = require('crypto');
const { effectorFromTool } = require('./adapter');
const { resolveSandboxed, isInsideAllowedRoots, allowedRoots } = require('./from-computer');
const { chunkCode } = require('../memory/chunker');
const defaultEmbeddings = require('../../../providers/embeddings');

const CODE_EXT = new Set(['.js', '.ts', '.py', '.md', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'vault', '.vscode', 'dist', 'build', 'coverage', '.next', '_archive']);
const MAX_FILES = 2000;
const MAX_CHUNKS = 5000;
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1MB per file, matches from-computer.js's read_file cap

function ok(result) { return { ok: true, result: result }; }
function fail(reason) { return { ok: false, result: reason }; }

// index_project's own default when `dir` is omitted — from-code-search.js is
// at src/core/effectors/ — 4 levels up reaches the mythos/ project root
// (same derivation from-computer.js's allowedRoots() fallback already uses).
function projectRoot() {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

// Recursive file walk capped at MAX_FILES, skipping irrelevant directories
// and symlinked directories (a symlink deeper in the tree could otherwise
// walk outside the sandbox even though the top-level dir passed the check).
function walk(dir, out, budget) {
  if (out.files.length >= budget) { out.truncated = true; return; }
  let entries;
  try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    if (out.files.length >= budget) { out.truncated = true; return; }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out, budget);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXT.has(ext)) out.files.push(path.join(dir, entry.name));
    }
  }
}

// createCodeSearchEffector({ documents, documentsIndex, embed }) — same DI
// seam as from-documents.js's createDocumentsEffector, same reasoning.
function createCodeSearchEffector({ documents, documentsIndex, embed }) {
  if (!documents) throw new Error('createCodeSearchEffector requires a documents store');
  if (!documentsIndex) throw new Error('createCodeSearchEffector requires a documentsIndex (vector-index partition)');
  const embedFn = embed || defaultEmbeddings.embed;

  async function index_project(args) {
    const rawDir = (args && args.dir && String(args.dir).trim()) || projectRoot();
    const sandboxed = resolveSandboxed(rawDir);
    if (!sandboxed.ok) return fail(sandboxed.reason);
    if (!isInsideAllowedRoots(sandboxed.resolved)) {
      return fail('"' + rawDir + '" is outside the folders I can access. I\'m limited to: ' + allowedRoots().join('; ') + '.');
    }

    let stat;
    try { stat = fsSync.statSync(sandboxed.resolved); } catch (err) { return fail(err.message); }
    if (!stat.isDirectory()) return fail('Not a directory: ' + sandboxed.resolved);

    const out = { files: [], truncated: false };
    walk(sandboxed.resolved, out, MAX_FILES);

    const docId = crypto.randomUUID();
    let chunkCount = 0;
    let embedded = 0;
    let skipped = 0;
    let filesIndexed = 0;
    let truncatedByChunkCap = false;

    for (const filePath of out.files) {
      if (truncatedByChunkCap) break;
      let text;
      try {
        const fstat = fsSync.statSync(filePath);
        if (fstat.size > MAX_FILE_BYTES) continue;
        text = fsSync.readFileSync(filePath, 'utf8');
      } catch (_) { continue; }

      const chunks = chunkCode(text);
      if (chunks.length === 0) continue;
      filesIndexed++;
      for (const chunk of chunks) {
        if (chunkCount >= MAX_CHUNKS) { truncatedByChunkCap = true; break; }
        chunkCount++;
        const { ref } = documents.write(chunk.text, {
          docId: docId,
          sourceType: 'code',
          filePath: filePath,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
        });
        let embedding = null;
        try { embedding = await embedFn(chunk.text); } catch (_) { embedding = null; }
        if (embedding) { documentsIndex.add(ref, embedding); embedded++; }
        else skipped++; // embeddings down for this chunk — degrade per-chunk, keep the chunk stored
      }
    }

    documents.registerDocument({
      docId: docId,
      sourceType: 'code',
      title: sandboxed.resolved,
      filePath: sandboxed.resolved,
      chunkCount: chunkCount,
    });

    return ok({
      docId: docId,
      dir: sandboxed.resolved,
      filesScanned: out.files.length,
      filesIndexed: filesIndexed,
      chunks: chunkCount,
      embedded: embedded,
      skipped: skipped,
      truncated: !!(out.truncated || truncatedByChunkCap),
    });
  }

  async function search_code(args) {
    const query = String((args && args.query) || '').trim();
    if (!query) return fail('query required');
    const embedding = await embedFn(query);
    if (!embedding) return ok({ results: [], degraded: true, reason: 'embeddings unavailable' });

    const hits = documentsIndex.search(embedding, 20);
    const results = [];
    for (const h of hits) {
      const rec = documents.get(h.ref);
      if (!rec || rec.sourceType !== 'code') continue;
      results.push({
        ref: h.ref,
        score: h.score,
        filePath: rec.filePath,
        lineStart: rec.lineStart,
        lineEnd: rec.lineEnd,
        snippet: String(rec.text || '').slice(0, 200),
      });
      if (results.length >= 10) break;
    }
    return ok({ results: results });
  }

  return { index_project: index_project, search_code: search_code };
}

function buildCodeSearchTools(ctx) {
  const effector = createCodeSearchEffector(ctx);
  return [
    { name: 'index_project', description: 'Walk a project directory (defaults to the project root) and index its source files for semantic code search.', params: { dir: 'string (optional)' }, danger: false, fn: function(args) { return effector.index_project(args || {}); }, needs_result: true },
    { name: 'search_code', description: 'Search indexed source code by meaning; each hit reports the file path and line range.', params: { query: 'string' }, danger: false, fn: function(args) { return effector.search_code(args); }, needs_result: true },
  ];
}

function registerFromCodeSearch(hub, ctx) {
  const tools = buildCodeSearchTools(ctx);
  for (let i = 0; i < tools.length; i++) hub.register(effectorFromTool(tools[i]));
  return { count: tools.length };
}

module.exports = { createCodeSearchEffector, buildCodeSearchTools, registerFromCodeSearch };
