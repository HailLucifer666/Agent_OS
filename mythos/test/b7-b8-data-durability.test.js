'use strict';

// B7/B8 data-durability fixes (2026-08-08 audit).
//
// B7: readJSON() returns the SAME fallback for a missing file and a corrupt
// one (fs-store.js:61-77). readJSONStrict() throws instead. This file proves
// the three remaining read-mutate-write sites that were still on the lenient
// reader now refuse to truncate real data on a corrupt file:
//   - leash/checkpoints.js (approval history)
//   - memory/documents.js (document index)
//   (a third, security/pin-lock.js, was deleted with the PIN on 2026-09-23;
//   its two cases went with it — there is no pin.json left to protect)
//
// B8: memory/index.js's mergeConsolidatedTopics() deleted the source
// consolidated-* topics BEFORE confirming semantic.write() succeeded, and
// semantic.write() degrades (returns {ref:null,degraded:true}) instead of
// throwing on failure — so the old try/catch around it never caught
// anything. This file proves the reordered write-then-verify-then-delete
// sequence: on a failing write, the sources survive and the failure throws.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFsStore } = require('../src/core/memory/fs-store');
const { createCheckpointRegistry } = require('../src/core/leash/checkpoints');
const { createDocumentsStore } = require('../src/core/memory/documents');
const { createMemory } = require('../src/core/memory/index');

function tmpVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b7b8-'));
  return { dir, store: createFsStore(() => dir, null) };
}

function fakeAudit() {
  return { write: () => ({ ok: true }) };
}

describe('B7 — leash/checkpoints.js history read-mutate-write', () => {
  let dir, store;
  beforeEach(() => { ({ dir, store } = tmpVault()); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('init() throws on a corrupt checkpoint-history.json instead of loading []', () => {
    const file = path.join(dir, 'Checkpoints', 'checkpoint-history.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[ {"id":"checkpoint-1","status":"approved"}, ', 'utf8'); // truncated

    const bus = { emit() {} };
    const reg = createCheckpointRegistry({ config: { CHECKPOINT_TTL_MS: 1800000 }, bus, auditWriter: fakeAudit(), fs: store });
    const result = reg.init();

    assert.equal(result.degraded, true, 'init() must report degraded rather than pretending it loaded an empty history');
    // The corrupt file must NOT have been overwritten with an empty array —
    // persistence must be suspended after a failed load.
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('checkpoint-1'), 'corrupt history file must survive untouched');
  });

  it('a resolve() after a degraded init() does not overwrite the corrupt history file', async () => {
    const file = path.join(dir, 'Checkpoints', 'checkpoint-history.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[ {"id":"checkpoint-1","status":"approved"}, ', 'utf8');

    const bus = { emit() {} };
    const reg = createCheckpointRegistry({ config: { CHECKPOINT_TTL_MS: 1800000 }, bus, auditWriter: fakeAudit(), fs: store });
    reg.init();

    const view = reg.create({ kind: 'plan-approval', goalId: 'g1' });
    await reg.accept(view.id, 'system'); // finalize() runs here — must not persist over the corrupt file

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('checkpoint-1'), 'finalize() after a degraded init() must not truncate the real history');
  });
});

describe('B7 — memory/documents.js index read-mutate-write', () => {
  let dir, store;
  beforeEach(() => { ({ dir, store } = tmpVault()); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

  it('registerDocument throws on a corrupt Documents/index.json instead of wiping it', () => {
    const file = path.join(dir, 'Documents', 'index.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "docs": [ {"docId":"doc-1","title":"real doc"} ], ', 'utf8'); // truncated

    const documents = createDocumentsStore({ fs: store });
    assert.throws(() => documents.registerDocument({ docId: 'doc-2', title: 'new doc' }), /unparseable JSON|EJSONCORRUPT|corrupt/i);

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('doc-1'), 'registerDocument must not have overwritten the corrupt index with a fresh one');
  });
});

describe('B8 — memory/index.js mergeConsolidatedTopics write-then-delete', () => {
  let dir, originalVaultRoot;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-b8-'));
    originalVaultRoot = process.env.MYTHOS_VAULT_ROOT;
    process.env.MYTHOS_VAULT_ROOT = dir;
    fs.mkdirSync(path.join(dir, 'Semantic'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Episodic'), { recursive: true });
  });

  afterEach(() => {
    if (originalVaultRoot === undefined) delete process.env.MYTHOS_VAULT_ROOT;
    else process.env.MYTHOS_VAULT_ROOT = originalVaultRoot;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  function writeTopic(name, facts) {
    const content = '## ' + name + '\n\n<!-- {"id":"sem-' + name + '","ts":' + Date.now() + ',"confidence":0.6} -->\n' +
      facts.map((f) => '- ' + f).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'Semantic', name + '.md'), content);
  }

  function listConsolidated() {
    return fs.readdirSync(path.join(dir, 'Semantic')).filter((n) => /^consolidated-/.test(n));
  }

  it('a failing semantic.write leaves the source consolidated-* topics intact and the failure throws', async () => {
    writeTopic('consolidated-1', ['fact one']);
    writeTopic('consolidated-2', ['fact two']);
    writeTopic('consolidated-3', ['fact three']);

    const brain = {
      think: async (opts) => {
        if (opts.source === 'memory:consolidate-merge') {
          return { content: 'ok', parsed: { facts: ['fact one', 'fact two', 'fact three'] }, offline: false };
        }
        return { content: null, parsed: null, offline: true };
      }
    };

    const events = [];
    const bus = { emit: (type, payload) => events.push({ type, payload }) };
    const memory = createMemory({
      config: { MYTHOS_VAULT_ROOT: dir, CONSOLIDATE_MERGE_MIN: 3, EPISODIC_RETENTION_DAYS: 30 },
      bus,
      logger: { info() {}, warn() {}, error() {} },
      brain,
    });
    await memory.init();

    // Force semantic.write to fail exactly the way it does in production: it
    // never throws, it degrades and returns {ref:null, degraded:true}.
    memory.semantic.write = () => ({ ref: null, degraded: true });

    // consolidate() stays best-effort overall (matches every other step in
    // it), so the failure surfaces as a loud health.anomaly rather than an
    // unhandled rejection — but the sources must still be untouched.
    await memory.consolidate({});

    const anomaly = events.find((e) => e.type === 'health.anomaly' && e.payload && e.payload.kind === 'consolidate-merge-failed');
    assert.ok(anomaly, 'a failed merge write must surface as health.anomaly, not vanish silently');
    assert.match(anomaly.payload.error, /semantic\.write failed|degraded/i);

    assert.equal(listConsolidated().length, 3, 'source consolidated-* topics must survive a failed write');
  });
});
