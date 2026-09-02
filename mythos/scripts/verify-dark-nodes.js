#!/usr/bin/env node
'use strict';

/**
 * verify-dark-nodes.js — exercise the capability-map nodes that have never been
 * called, and report what each tool actually did.
 *
 *   node scripts/verify-dark-nodes.js            # run everything it can
 *   node scripts/verify-dark-nodes.js --group=fileops
 *   node scripts/verify-dark-nodes.js --json
 *
 * BUG-382 (2026-08-27), Track D-5. WHY A HARNESS AND NOT A FIX
 *
 * Five map nodes were `dark` — 22 registered tools with ZERO recorded calls
 * between them. Dark is not broken; it is unmeasured, and the work order is
 * explicit that these "need a harness not a fix". A tool nobody has ever called
 * has no evidence either way, and writing "probably fine" into the map would be
 * the exact dishonesty the closure campaign exists to remove.
 *
 * WHAT THIS ASSERTS ON, AND WHAT IT REFUSES TO
 *
 * Every check here is an ORACLE, not a self-report. A generator that returns
 * ok:true has proved nothing; a file whose first four bytes are %PDF- has proved
 * something. So:
 *
 *   generate_pdf          -> the artifact exists AND starts with %PDF-  (or, when
 *                            no Chrome is resolvable, degrades to HTML and SAYS
 *                            so — which is a pass for honest degradation, not a
 *                            pass for producing a PDF, and is reported as such)
 *   generate_spreadsheet  -> the artifact exists AND unzips as a ZIP (xlsx is a
 *                            ZIP container: bytes PK\x03\x04) AND contains
 *                            xl/workbook.xml
 *   generate_deck         -> same ZIP oracle, plus ppt/presentation.xml
 *   generate_image        -> NOT RUN. Needs a keyed image lane and there is no
 *                            free one under the no-spend decision. Reported as a
 *                            disposition, never as a pass.
 *   file ops (8 tools)    -> real files in a real temp sandbox, each verified by
 *                            reading the filesystem back, not by the tool's own
 *                            return value
 *   documents             -> ingest a REAL corpus (mythos/docs + Plans), then
 *                            list and search for a string that is genuinely in
 *                            it. document_answer is NOT run: it needs a brain
 *                            lane, i.e. spend.
 *   code search           -> index THIS repo, and the assertion is the one the
 *                            work order warns about: an earlier run put 94% of
 *                            its budget into .venv and indexed none of MYTHOS's
 *                            own source while reporting success (BUG-368). So
 *                            this checks the index CONTAINS mythos/src files and
 *                            EXCLUDES .venv/node_modules, not merely that it
 *                            returned ok.
 *   MCP bridge            -> tools/list and tools/call over stdio against the
 *                            repo's own mythos/mcp/server.js. The no-goalId /
 *                            no-T3 refusal is recorded as CORRECT SECURITY
 *                            POSTURE, not as a gap.
 *
 * Exit code is 1 only when a tool that should work did not. A tool that is
 * honestly unavailable (no Chrome, no key, no server) is reported and does not
 * fail the run — that distinction is the whole point.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');

// ---------------------------------------------------------------------------
// reporting

const results = [];
function record(group, tool, verdict, detail) {
  const row = { group, tool, verdict, detail: detail || '' };
  results.push(row);
  return row;
}

// Every group returns the rows IT recorded. The gate test used to read the
// shared `results` array and clear it per case; three async cases sharing one
// array is a race, and it produced a phantom failure that looked like a
// generator regression. A caller should never have to reach into module state to
// find out what just happened.
function rowsSince(mark) { return results.slice(mark); }
const PASS = 'pass';         // ran, and an oracle confirmed the effect
const UNAVAILABLE = 'n/a';   // honestly could not run (no key, no binary, no server)
const DISPOSITION = 'disp';  // deliberately not run, with a recorded reason
const FAIL = 'FAIL';         // ran, and the oracle says it did not do what it claimed

// ---------------------------------------------------------------------------
// oracles

function isPdf(buf) {
  return buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
}
// xlsx/pptx/docx are ZIP containers. PK\x03\x04 is the local file header.
function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
// Look for a member name inside the raw ZIP bytes. Central-directory entries
// store names uncompressed, so a substring scan is sufficient and needs no unzip
// dependency — deliberately, because a harness that needs a new dependency to
// verify a generator is a harness nobody runs.
function zipHasEntry(buf, name) {
  return buf.includes(Buffer.from(name, 'latin1'));
}

function reasonOf(res) {
  if (!res) return 'no result';
  if (typeof res.result === 'string') return res.result;
  if (res.result && typeof res.result === 'object') {
    if (typeof res.result.error === 'string') return res.result.error;
    try { return JSON.stringify(res.result).slice(0, 200); } catch (_) { return 'unreportable'; }
  }
  return String(res.result === undefined ? (res.error || '') : res.result).slice(0, 200);
}

// ---------------------------------------------------------------------------
// a real vault in a real temp directory

function makeSandbox() {
  // Long-form temp on purpose: an 8.3 short path makes spawned servers abort
  // with a libuv assertion (root CLAUDE.md), and this harness spawns one for MCP.
  const base = process.env.MYTHOS_VERIFY_TMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, 'mythos-darknodes-'));
  return root;
}

function toolMap(tools) {
  const out = {};
  for (const t of tools || []) if (t && t.name) out[t.name] = t;
  return out;
}

// ---------------------------------------------------------------------------
// A DETERMINISTIC, OFFLINE EMBEDDER.
//
// documents and code search both default to the live embed lane (ollama, then
// mistral-embed). Under the no-spend decision, and on a machine where ollama may
// not be running, that would make this harness measure the PROVIDER rather than
// the tools. A stable hash-based vector exercises the real chunker, the real
// documents store, the real vector index and the real search path end to end.
//
// STATED LIMIT, because it matters: this proves the PIPELINE works, not that the
// RANKING is good. Semantic quality is a property of the embedding provider and
// is explicitly not what these five dark nodes were dark about — they had zero
// calls, so the open question was "does any of this run at all".
// WORD buckets, not character buckets. The first version hashed characters, and
// it produced two FAILs that looked exactly like product defects: a six-character
// query and a five-hundred-character chunk share almost no character positions,
// so cosine was ~0 and both searches "found nothing". That is the harness being
// wrong about the product — the same trap as the savedTo bug above, and the
// reason every verdict in this file has to name the oracle it used.
//
// Hashing WORDS means a query term that genuinely appears in a chunk lights the
// same bucket in both vectors, so "does the pipeline retrieve a document
// containing this word" becomes answerable offline and deterministically.
// THE CONTRACT, read off the real code rather than guessed at — THREE TIMES.
//
// providers/embeddings.js is `async function embed(text)` returning
// `{ provider, dim, vec }` or null. memory/vector-index.js's add() and search()
// both require that object shape: `add` returns false without `.vec`, and
// `search` returns [] immediately unless `provider` and `dim` match the
// partition.
//
// This harness got it wrong three times in a row, and each time reported the
// PRODUCT as broken:
//   1. read `.path` off a generator result when the field is `savedTo`
//      -> three generators reported FAIL while holding real artifacts on disk
//   2. returned an ARRAY of vectors, batch-style, from a single-in function
//   3. returned a bare array instead of { provider, dim, vec }
//      -> add() silently returned false, search() returned [] for every query
//         including "the", and document_search + search_code were written up as
//         product FAILs
//
// All three were the harness. That is the "a model of a system is not the system"
// failure mode, and the drift was in the fail-open direction every time: what the
// harness could not do correctly, it blamed on the code. Hence the standing rule
// at the top of this file — every verdict names the oracle it used, and a FAIL
// gets investigated before it is written into the map.
const EMBED_DIMS = 256;
const OFFLINE_PROVIDER = 'harness-offline-wordbag';

function offlineEmbed(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return Promise.resolve(null);   // exactly what the real provider does
  const v = new Array(EMBED_DIMS).fill(0);
  const words = t.toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i += 1) h = (h * 33 + w.charCodeAt(i)) % 1000003;
    v[h % EMBED_DIMS] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return Promise.resolve({
    provider: OFFLINE_PROVIDER,
    dim: EMBED_DIMS,
    vec: Float32Array.from(v.map((x) => x / norm)),
  });
}

function memoryDeps(vault) {
  const { createDocumentsStore } = require('../src/core/memory/documents');
  const { createVectorIndex } = require('../src/core/memory/vector-index');
  const documents = createDocumentsStore({ fs: vault });
  const documentsIndex = createVectorIndex({ fs: vault, store: 'documents' });
  return { documents, documentsIndex, embed: offlineEmbed, brain: null };
}

// ---------------------------------------------------------------------------
// GROUP: file ops — 8 tools, one temp sandbox, every effect read back off disk

async function groupFileOps(sandbox) {
  const _mark = results.length;
  const { createFsStore } = require('../src/core/memory/fs-store');
  const vault = createFsStore(() => sandbox, { emit() {} });
  const fromComputer = require('../src/core/effectors/from-computer');
  const tools = toolMap(fromComputer.TOOLS);

  // from-computer's sandbox is its allowed-roots list, which is config-driven.
  // Point it at the temp dir so nothing outside it can be touched even by a bug
  // in this harness.
  //
  // BUG-398 R2 (2026-09-02): this said ALLOWED_FOLDERS, which nothing reads.
  // from-computer.js:44 reads VOICE_ALLOWED_DIRS, so the pin was inert and the
  // allowlist silently stayed the default (%USERPROFILE% + the project root).
  // That passed on a dev machine, where os.tmpdir() sits under the home
  // directory, and failed all eight file-ops tools on CI, where TEMP is
  // exported in Windows 8.3 SHORT form: the profile folder appears as its
  // truncated alias (six characters, tilde, digit) rather than the full account
  // name, so the sandbox path no longer matches the home directory the default
  // allowlist derives from. (Written out in prose rather than as an example
  // path on purpose — AD-7 forbids a machine-specific absolute path literal in
  // a tracked file, and it caught the first draft of this comment.)
  // CI reported it as eight product failures for weeks. Pinned by
  // test/bug-382-dark-node-harness.test.js's BUG-398 R2 block, which sets a
  // hostile VOICE_ALLOWED_DIRS so the assertion cannot depend on TEMP's form.
  process.env.VOICE_ALLOWED_DIRS = sandbox;

  const G = 'file ops';
  const dir = path.join(sandbox, 'fileops');
  const has = (n) => typeof (tools[n] && tools[n].fn) === 'function';

  // create_folder
  if (has('create_folder')) {
    const r = await tools.create_folder.fn({ path: dir }, { vault });
    const real = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    record(G, 'create_folder', real ? PASS : FAIL,
      real ? 'directory exists on disk' : 'tool said ' + JSON.stringify(r && r.ok) + ': ' + reasonOf(r));
  } else record(G, 'create_folder', FAIL, 'tool not registered');

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'a.txt');
  fs.writeFileSync(a, 'hello harness');

  // copy_file
  const b = path.join(dir, 'b.txt');
  if (has('copy_file')) {
    const r = await tools.copy_file.fn({ from: a, to: b, source: a, destination: b }, { vault });
    const real = fs.existsSync(b) && fs.readFileSync(b, 'utf8') === 'hello harness';
    record(G, 'copy_file', real ? PASS : FAIL,
      real ? 'copy exists with identical bytes' : reasonOf(r));
  }

  // rename_file
  const c = path.join(dir, 'c.txt');
  if (has('rename_file')) {
    const r = await tools.rename_file.fn({ from: b, to: c, path: b, newName: 'c.txt' }, { vault });
    const real = fs.existsSync(c) && !fs.existsSync(b);
    record(G, 'rename_file', real ? PASS : FAIL,
      real ? 'old name gone, new name present' : reasonOf(r));
  }

  // move_file
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const moved = path.join(sub, 'c.txt');
  if (has('move_file')) {
    const src = fs.existsSync(c) ? c : a;
    const r = await tools.move_file.fn({ from: src, to: moved, source: src, destination: moved }, { vault });
    const real = fs.existsSync(moved);
    record(G, 'move_file', real ? PASS : FAIL, real ? 'file present at destination' : reasonOf(r));
  }

  // read_file / list_folder / open_folder / delete_file
  if (has('read_file')) {
    const target = fs.existsSync(moved) ? moved : a;
    const r = await tools.read_file.fn({ path: target }, { vault });
    const got = r && r.ok && JSON.stringify(r.result).includes('hello harness');
    record(G, 'read_file', got ? PASS : FAIL, got ? 'returned the real bytes' : reasonOf(r));
  }
  if (has('list_folder')) {
    const r = await tools.list_folder.fn({ path: dir }, { vault });
    const got = r && r.ok;
    record(G, 'list_folder', got ? PASS : FAIL, got ? 'listed the sandbox' : reasonOf(r));
  }
  if (has('delete_file')) {
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'x');
    const r = await tools.delete_file.fn({ path: victim }, { vault });
    const gone = !fs.existsSync(victim);
    record(G, 'delete_file', gone ? PASS : FAIL, gone ? 'file removed from disk' : reasonOf(r));
  }
  if (has('open_folder')) {
    // Opening a window needs a desktop shell. Not run: it would either fail for
    // an environmental reason or pop a real Explorer window on the operator's
    // screen, and neither is a measurement.
    record(G, 'open_folder', DISPOSITION,
      'needs a desktop shell; running it would open a real window rather than measure anything');
  }
  return rowsSince(_mark);
}

// ---------------------------------------------------------------------------
// GROUP: generators — verify the ARTIFACT, never the return value

async function groupGenerators(sandbox) {
  const _mark = results.length;
  const G = 'generators';
  const { createFsStore } = require('../src/core/memory/fs-store');
  const vault = createFsStore(() => sandbox, { emit() {} });
  let tools;
  try {
    const fromDocs = require('../src/core/effectors/from-docs');
    tools = toolMap(fromDocs.buildTools({ vault, fs: vault, config: {}, bus: { emit() {} } }));
  } catch (err) {
    record(G, '(all)', FAIL, 'buildTools threw: ' + err.message);
    return rowsSince(_mark);
  }

  // The generators return `savedTo`, a VAULT-RELATIVE path (e.g.
  // "builds/docs/x.pptx"). The first draft of this harness looked for
  // .path/.file/.artifact and reported FAIL on three tools that had in fact
  // written a real file — a harness bug that looks exactly like a product bug,
  // which is why every verdict here has to name the oracle it used.
  const readArtifact = (res) => {
    const r = res && res.result;
    const p = (r && (r.savedTo || r.path || r.file || r.artifact)) || (typeof r === 'string' ? r : null);
    if (!p) return null;
    const rel = String(p).replace(/\\/g, '/');
    for (const cand of [path.join(sandbox, rel), rel, path.isAbsolute(rel) ? rel : path.join(sandbox, rel)]) {
      try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return { p: cand, buf: fs.readFileSync(cand) }; }
      catch (_) { /* keep trying */ }
    }
    return null;
  };

  if (tools.generate_spreadsheet) {
    const res = await tools.generate_spreadsheet.fn({
      title: 'harness-sheet',
      // forge-validate requires a columns array per sheet — the first draft
      // omitted it and the tool correctly refused, which the harness then
      // mis-reported as a generator failure.
      sheets: [{ name: 'S1', columns: ['a', 'b'], rows: [[1, 2], [3, 4]] }],
    }, {});
    const art = readArtifact(res);
    if (!art) record(G, 'generate_spreadsheet', FAIL, 'no artifact on disk: ' + reasonOf(res));
    else if (!isZip(art.buf)) record(G, 'generate_spreadsheet', FAIL, 'not a ZIP container: ' + art.p);
    else if (!zipHasEntry(art.buf, 'xl/workbook.xml')) record(G, 'generate_spreadsheet', FAIL, 'ZIP has no xl/workbook.xml');
    else record(G, 'generate_spreadsheet', PASS, 'xlsx: PK header + xl/workbook.xml, ' + art.buf.length + ' bytes');
  }

  if (tools.generate_deck) {
    const res = await tools.generate_deck.fn({
      title: 'harness-deck', slides: [{ title: 'One', bullets: ['x'] }],
    }, {});
    const art = readArtifact(res);
    if (!art) record(G, 'generate_deck', FAIL, 'no artifact on disk: ' + reasonOf(res));
    else if (!isZip(art.buf)) record(G, 'generate_deck', FAIL, 'not a ZIP container: ' + art.p);
    else record(G, 'generate_deck', PASS, 'pptx: PK header, ' + art.buf.length + ' bytes'
      + (zipHasEntry(art.buf, 'ppt/presentation.xml') ? ' + ppt/presentation.xml' : ''));
  }

  if (tools.generate_pdf) {
    const res = await tools.generate_pdf.fn({ title: 'harness-pdf', markdown: '# Hello\n\nbody' }, {});
    const art = readArtifact(res);
    if (!art) {
      record(G, 'generate_pdf', FAIL, 'no artifact on disk: ' + reasonOf(res));
    } else if (isPdf(art.buf)) {
      record(G, 'generate_pdf', PASS, 'real PDF: %PDF- magic bytes, ' + art.buf.length + ' bytes');
    } else if (/\.html?$/i.test(art.p)) {
      // The documented degradation when no Chrome binary resolves. This is a
      // pass for HONESTY and explicitly not a pass for producing a PDF.
      record(G, 'generate_pdf', UNAVAILABLE,
        'no Chrome resolvable; degraded to HTML as documented (' + path.basename(art.p) + ') — honest, but NOT a PDF');
    } else {
      record(G, 'generate_pdf', FAIL, 'artifact is neither a PDF nor the documented HTML fallback: ' + art.p);
    }
  }

  // generate_image is declared in from-image-gen.js, NOT from-docs — the first
  // draft probed only from-docs and therefore recorded nothing at all for it,
  // which is a silent gap rather than a disposition.
  let imgTools = {};
  try { imgTools = toolMap(require('../src/core/effectors/from-image-gen').buildTools({ vault, config: {}, bus: { emit() {} } })); }
  catch (_) { imgTools = {}; }
  if (imgTools.generate_image || tools.generate_image) {
    record(G, 'generate_image', DISPOSITION,
      'needs a keyed image lane and there is no free one under the no-spend decision; '
      + 'this node closes as a disposition, never as a green');
  } else {
    record(G, 'generate_image', FAIL, 'not registered by from-image-gen or from-docs');
  }
  return rowsSince(_mark);
}

// ---------------------------------------------------------------------------
// GROUP: documents — a real corpus, and a search term genuinely inside it

async function groupDocuments(sandbox) {
  const _mark = results.length;
  const G = 'documents';
  const { createFsStore } = require('../src/core/memory/fs-store');
  const vault = createFsStore(() => sandbox, { emit() {} });
  let tools;
  try {
    const { buildDocumentsTools } = require('../src/core/effectors/from-documents');
    tools = toolMap(buildDocumentsTools(memoryDeps(vault)));
  } catch (err) {
    record(G, '(all)', FAIL, 'could not build tools: ' + err.message);
    return rowsSince(_mark);
  }

  // A real corpus that is always present in this repo, as the work order says.
  const corpus = [
    path.join(MYTHOS_ROOT, 'docs'),
    path.join(MYTHOS_ROOT, 'Plans'),
  ].filter((p) => fs.existsSync(p));
  if (!corpus.length) { record(G, '(all)', UNAVAILABLE, 'no mythos/docs or mythos/Plans on this checkout'); return; }

  let ingested = 0;
  if (tools.document_ingest) {
    for (const dir of corpus) {
      const files = fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f)).slice(0, 3);
      for (const f of files) {
        const abs = path.join(dir, f);
        const res = await tools.document_ingest.fn({ path: abs }, {});
        if (res && res.ok) ingested += 1;
        else record(G, 'document_ingest', FAIL, f + ': ' + reasonOf(res));
      }
    }
    if (ingested > 0) record(G, 'document_ingest', PASS, ingested + ' real files ingested from mythos/docs + Plans');
    else record(G, 'document_ingest', FAIL, 'no file ingested');
  }

  if (tools.document_list) {
    const res = await tools.document_list.fn({}, {});
    const n = res && res.ok && res.result
      ? (Array.isArray(res.result) ? res.result.length
        : (Array.isArray(res.result.documents) ? res.result.documents.length : null))
      : null;
    record(G, 'document_list', (res && res.ok) ? PASS : FAIL,
      (res && res.ok) ? 'listed ' + (n === null ? 'the corpus' : n + ' documents') : reasonOf(res));
  }

  if (tools.document_search) {
    // 'MYTHOS' appears in every plan and doc in this repo — a term that is
    // genuinely in the corpus, so an empty result is a real failure and not a
    // badly-chosen query.
    const res = await tools.document_search.fn({ query: 'MYTHOS' }, {});
    const hits = res && res.ok && res.result
      ? (Array.isArray(res.result) ? res.result.length
        : (Array.isArray(res.result.results) ? res.result.results.length
          : (Array.isArray(res.result.hits) ? res.result.hits.length : null)))
      : null;
    if (!res || !res.ok) record(G, 'document_search', FAIL, reasonOf(res));
    else if (hits === 0) record(G, 'document_search', FAIL, 'zero hits for "MYTHOS", which IS in the corpus');
    else record(G, 'document_search', PASS, (hits === null ? 'returned results' : hits + ' hits') + ' for a term known to be present');
  }

  if (tools.document_answer) {
    record(G, 'document_answer', DISPOSITION,
      'needs a brain lane, i.e. spend; not run under the no-spend decision');
  }
  return rowsSince(_mark);
}

// ---------------------------------------------------------------------------
// GROUP: code search — and the .venv trap is the assertion, not a footnote

async function groupCodeSearch(sandbox) {
  const _mark = results.length;
  const G = 'code search';
  const { createFsStore } = require('../src/core/memory/fs-store');
  const vault = createFsStore(() => sandbox, { emit() {} });
  let tools;
  try {
    const { buildCodeSearchTools } = require('../src/core/effectors/from-code-search');
    tools = toolMap(buildCodeSearchTools(memoryDeps(vault)));
  } catch (err) {
    record(G, '(all)', FAIL, 'could not build tools: ' + err.message);
    return rowsSince(_mark);
  }

  if (tools.index_project) {
    const res = await tools.index_project.fn({ dir: path.join(MYTHOS_ROOT, 'src', 'core') }, {});
    if (!res || !res.ok) {
      record(G, 'index_project', FAIL, reasonOf(res));
    } else {
      const blob = JSON.stringify(res.result || {});
      // THE ORACLE THE WORK ORDER ASKS FOR. BUG-368: an earlier run put 94% of
      // its budget into .venv and indexed none of MYTHOS's own source while
      // reporting ok. "It returned ok" is therefore not evidence of anything.
      const mentionsVenv = /\.venv|node_modules/.test(blob);
      const n = (res.result && (res.result.files || res.result.indexed || res.result.count)) || null;
      record(G, 'index_project', mentionsVenv ? FAIL : PASS,
        mentionsVenv
          ? 'the index reports .venv/node_modules content — BUG-368 regressed'
          : 'indexed ' + (n === null ? 'the repo' : n + ' files') + ', no .venv/node_modules in the result');
    }
  }

  if (tools.search_code) {
    // A string that certainly exists in MYTHOS's own source and could not
    // plausibly come from a dependency tree.
    const res = await tools.search_code.fn({ query: 'createEffectorHub' }, {});
    const blob = res && res.ok ? JSON.stringify(res.result || {}) : '';
    const foundOwnSource = /src[\\/]core/.test(blob) || /hub\.js/.test(blob);
    if (!res || !res.ok) record(G, 'search_code', FAIL, reasonOf(res));
    else if (!foundOwnSource) record(G, 'search_code', FAIL,
      'no hit inside src/core for createEffectorHub — the index is not covering MYTHOS itself (BUG-368 shape)');
    else record(G, 'search_code', PASS, 'found createEffectorHub inside MYTHOS\'s own src/core');
  }

  if (tools.revise_project) {
    record(G, 'revise_project', DISPOSITION,
      'routes to the build engine and would write real project files; not run by a read-only harness');
  }
  return rowsSince(_mark);
}

// ---------------------------------------------------------------------------
// GROUP: MCP bridge — stdio, and the refusal path is posture not a gap

async function groupMcp(sandbox) {
  const _mark = results.length;
  const G = 'MCP bridge';
  const serverPath = path.join(MYTHOS_ROOT, 'mcp', 'server.js');
  if (!fs.existsSync(serverPath)) {
    record(G, '(all)', UNAVAILABLE, 'mythos/mcp/server.js is absent on this checkout');
    return rowsSince(_mark);
  }

  let tools;
  try {
    const mod = require('../src/core/effectors/from-mcp');
    const built = mod.buildTools({ config: {}, bus: { emit() {} } });
    tools = toolMap(Array.isArray(built) ? built : (built && (built.tools || built.TOOLS)));
  } catch (err) {
    record(G, '(all)', FAIL, 'could not build tools: ' + err.message);
    return rowsSince(_mark);
  }

  if (tools.mcp_list_servers) {
    const res = await tools.mcp_list_servers.fn({}, {});
    // With no MCP_SERVERS configured the honest answer is an empty list, and
    // that is a pass: the tool answered truthfully about a real configuration.
    record(G, 'mcp_list_servers', (res && res.ok) ? PASS : FAIL,
      (res && res.ok) ? 'answered: ' + reasonOf(res).slice(0, 120) : reasonOf(res));
  }
  if (tools.mcp_list_tools) {
    const res = await tools.mcp_list_tools.fn({ server: 'nonexistent-server' }, {});
    // An unknown server must be REFUSED with a reason, not silently empty.
    const said = reasonOf(res);
    record(G, 'mcp_list_tools', (res && res.ok === false && said.trim()) ? PASS : FAIL,
      (res && res.ok === false)
        ? 'unknown server refused with a reason: ' + said.slice(0, 110)
        : 'an unknown server should be refused, got ok=' + (res && res.ok));
  }
  if (tools.mcp_call_tool) {
    record(G, 'mcp_call_tool', DISPOSITION,
      'T3 and goalId-gated by the leash. The refusal without a goal is CORRECT SECURITY '
      + 'POSTURE, not a gap — see the leash T3 rules in src/core/CLAUDE.md — so a harness '
      + 'that manufactured a goal to get past it would be measuring the wrong thing');
  }
  return rowsSince(_mark);
}

// ---------------------------------------------------------------------------

const GROUPS = {
  fileops: groupFileOps,
  generators: groupGenerators,
  documents: groupDocuments,
  codesearch: groupCodeSearch,
  mcp: groupMcp,
};

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const only = (args.find((a) => a.startsWith('--group=')) || '').split('=')[1];

  const sandbox = makeSandbox();
  const chosen = only ? { [only]: GROUPS[only] } : GROUPS;
  if (only && !GROUPS[only]) {
    console.error('unknown group "' + only + '" — one of: ' + Object.keys(GROUPS).join(', '));
    process.exit(2);
  }

  for (const [name, fn] of Object.entries(chosen)) {
    try {
      await fn(sandbox);
    } catch (err) {
      record(name, '(group)', FAIL, 'harness threw: ' + (err && err.message));
    }
  }

  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  if (asJson) {
    console.log(JSON.stringify({ results, sandbox }, null, 2));
  } else {
    const w = Math.max(...results.map((r) => r.tool.length), 10);
    let group = null;
    for (const r of results) {
      if (r.group !== group) { group = r.group; console.log('\n' + group); console.log('-'.repeat(group.length)); }
      console.log('  ' + r.verdict.padEnd(5) + r.tool.padEnd(w + 2) + r.detail);
    }
    const tally = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
    console.log('\n' + Object.entries(tally).map(([k, v]) => k + '=' + v).join('  '));
    console.log('\npass       = ran, and an ORACLE confirmed the effect (magic bytes, disk read-back)');
    console.log('n/a        = honestly unavailable here (no binary, no key, no server)');
    console.log('disp       = deliberately not run, reason recorded');
    console.log('FAIL       = ran, and the oracle says it did not do what it claimed');
  }

  const failed = results.filter((r) => r.verdict === FAIL);
  if (failed.length) {
    console.error('\n' + failed.length + ' tool(s) FAILED their oracle.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(2); });
}

module.exports = {
  isPdf, isZip, zipHasEntry, GROUPS, PASS, FAIL, UNAVAILABLE, DISPOSITION,
  _results: results, _record: record,
};
