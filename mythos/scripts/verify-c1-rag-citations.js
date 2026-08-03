#!/usr/bin/env node
// Live verification for C1 (RAG with citations): document_answer must return
// sources[] whose refs resolve to REAL chunk files on disk, and must carry the
// 'chunk-file' evidence oracle rather than a bare ok:true.
//
// The unit tests use a fake embed function, so they prove the shape but not
// that a real retrieval path produces resolvable citations. This runs the real
// embeddings provider and then re-checks every cited ref against the actual
// vault/Documents/chunks/<ref>.json file.
//
// Writes into a THROWAWAY vault under the OS temp dir — never the operator's
// real vault. Cleans up on exit.
//
// Usage: node scripts/verify-c1-rag-citations.js
// Exit 0 = citations verified live. Exit 1 = they are not trustworthy.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (_) {}

const { createMemory } = require(path.join(ROOT, 'src/core/memory/index.js'));
const { createDocumentsEffector } = require(path.join(ROOT, 'src/core/effectors/from-documents.js'));

// os.tmpdir() on Windows returns the 8.3 short form (ARGHYA~1), which the
// effector sandbox compares as a plain string against the long home path and
// rejects. realpathSync.native expands it; harmless everywhere else.
let tmpBase = os.tmpdir();
try { tmpBase = fs.realpathSync.native(tmpBase); } catch (_) {}
const vaultRoot = fs.mkdtempSync(path.join(tmpBase, 'mythos-c1-'));
const docPath = path.join(vaultRoot, 'source-doc.md');

// Deliberately specific content: a generic answer that ignored the retrieved
// chunks would still read fine, so the assertions below check the CITATIONS
// resolve, not that the prose looks plausible.
fs.writeFileSync(docPath, [
  '# Kestrel Protocol',
  '',
  '## Handshake',
  'The Kestrel handshake uses a 47-byte preamble followed by a rotating nonce.',
  'A peer that omits the preamble is dropped without a reply.',
  '',
  '## Backoff',
  'On a failed handshake, Kestrel backs off for 900 milliseconds, then doubles',
  'the interval up to a ceiling of 12 seconds before giving up entirely.',
  '',
  '## Framing',
  'Every Kestrel frame carries a 4-byte length prefix and a trailing CRC32.',
  'Frames larger than 64 kilobytes are rejected at the parser boundary.',
].join('\n'));

function cleanup() {
  try { fs.rmSync(vaultRoot, { recursive: true, force: true }); } catch (_) {}
}

const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}  ${detail}`);
}

(async () => {
  console.log('C1 live verification — real embeddings, throwaway vault at ' + vaultRoot + '\n');

  const config = { MYTHOS_VAULT_ROOT: vaultRoot };
  const bus = { emit: () => {} };
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const memory = createMemory({ config, bus, logger, brain: null });

  const effector = createDocumentsEffector({
    documents: memory.documents,
    documentsIndex: memory.documentsIndex,
    brain: null,
  });

  const ingested = await effector.document_ingest({ path: docPath, title: 'Kestrel Protocol' });
  if (!ingested || ingested.ok === false) {
    console.error('ABORT: ingest failed — ' + JSON.stringify(ingested));
    cleanup();
    process.exit(1);
  }
  // ok() wraps its payload under .result — read through it, not off the top.
  const ing = ingested.result || ingested;
  console.log(`ingested ${ing.chunks} chunks, embedded=${ing.embedded}, skipped=${ing.skipped}\n`);

  if (!ing.embedded) {
    console.error('ABORT: no chunk was embedded — the embeddings provider is unavailable, so');
    console.error('retrieval cannot run and any "pass" below would be vacuous.');
    cleanup();
    process.exit(1);
  }

  const res = await effector.document_answer({ query: 'How long does Kestrel back off after a failed handshake?' });

  const payload = (res && res.result) || res || {};
  const sources = payload.sources || [];
  record('sources[] is non-empty', sources.length > 0, `${sources.length} source(s)`);

  // The point of C1: every ref must be a real file on disk, checked here
  // independently of the effector's own oracle loop.
  let resolved = 0;
  const missing = [];
  for (const s of sources) {
    const chunkFile = path.join(vaultRoot, 'Documents', 'chunks', s.ref + '.json');
    if (fs.existsSync(chunkFile)) resolved++;
    else missing.push(s.ref);
  }
  record('every cited ref resolves to a chunk file', sources.length > 0 && missing.length === 0,
    missing.length === 0 ? `${resolved}/${sources.length} refs found on disk`
                         : `missing: ${missing.join(', ')}`);

  const spansOk = sources.every(s => s.span && (
    (s.span.lineStart != null && s.span.lineEnd != null) ||
    (s.span.wordStart != null && s.span.wordEnd != null)));
  record('every source carries a span', sources.length > 0 && spansOk,
    spansOk ? 'all spans present' : 'at least one source has no span');

  const docIdsOk = sources.every(s => typeof s.docId === 'string' && s.docId.length > 0);
  record('every source carries a docId', sources.length > 0 && docIdsOk,
    docIdsOk ? 'all docIds present' : 'at least one source has no docId');

  // Evidence contract: ok:true is only acceptable alongside a real oracle.
  const ev = res && res.evidence;
  const oracleOk = !!ev && ev.oracle === 'chunk-file';
  record("evidence oracle is 'chunk-file'", oracleOk,
    oracleOk ? `observed: ${String(ev.observed).slice(0, 90)}...`
             : `evidence=${JSON.stringify(ev)} unverified=${res && res.unverified}`);

  const answerText = payload.answer || '';
  record('answer is non-empty', answerText.trim().length > 0, `${answerText.length} chars`);

  console.log('');
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(err => {
  console.error('verification threw: ' + ((err && err.stack) || err));
  cleanup();
  process.exit(1);
});
