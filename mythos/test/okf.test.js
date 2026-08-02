'use strict';

// okf.test.js — Open Knowledge Format serialization + the effector's guards.
//
// OKF's conformance rule is unusually small and unusually easy to get wrong in
// the strict direction: `type` is the ONLY required key, and a consumer MUST
// tolerate a type it has never seen. A parser that rejects unknown types, or
// that drops frontmatter keys it does not recognize, is not an OKF consumer —
// it is a private format wearing OKF's file extension. Both directions are
// asserted here.
//
// The other thing under test is round-tripping. An interchange format that
// loses data on export→import is worse than no export at all, because the loss
// is invisible until someone else's tool reads the bundle.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const okf = require('../src/core/memory/okf');
const fromOkf = require('../src/core/effectors/from-okf');
const { createFsStore } = require('../src/core/memory/fs-store');
const { tempVaultDir, cleanupVaultDir } = require('./helpers');

describe('okf — serialize / parse', function() {

  it('a minimal conforming document is just `type` plus a body', function() {
    const text = okf.serialize({ type: 'Playbook', body: '# Steps\n\n1. First action\n2. Second action' });
    assert.match(text, /^---\ntype: Playbook\n---\n\n# Steps/);
    const back = okf.parse(text);
    assert.equal(back.ok, true, back.error);
    assert.equal(back.doc.type, 'Playbook');
    assert.match(back.doc.body, /1\. First action/);
  });

  it('refuses to serialize without a type — the one mandatory key', function() {
    assert.throws(() => okf.serialize({ body: 'no type here' }), /type/);
    assert.throws(() => okf.serialize({ type: '   ', body: 'x' }), /type/);
  });

  it('accepts an unregistered type — the spec requires tolerating unknown kinds', function() {
    const res = okf.parse('---\ntype: Something Nobody Has Defined\n---\n\nbody text\n');
    assert.equal(res.ok, true, 'an unknown type is VALID; rejecting it makes this a private format');
    assert.equal(res.doc.type, 'Something Nobody Has Defined');
  });

  it('preserves arbitrary extra frontmatter keys and body sections', function() {
    const original = {
      type: 'Metric',
      title: 'Weekly active operators',
      tags: ['product', 'north-star'],
      sources: ['vault/Episodic/2026-08-01.jsonl'],
      verified: false,
      stale_after: '2026-12-31',
      some_future_key: 'must survive a consumer that has never heard of it',
      nested: { owner: 'growth', tier: 1 },
      body: '## Definition\n\nCount of distinct operators.\n\n## Query\n\n```sql\nSELECT 1\n```'
    };
    const round = okf.parse(okf.serialize(original));
    assert.equal(round.ok, true, round.error);
    assert.equal(round.doc.title, original.title);
    assert.deepEqual(round.doc.tags, original.tags);
    assert.deepEqual(round.doc.sources, original.sources);
    assert.equal(round.doc.verified, false);
    assert.equal(round.doc.stale_after, '2026-12-31');
    assert.equal(round.doc.some_future_key, original.some_future_key);
    assert.deepEqual(round.doc.nested, original.nested);
    assert.equal(round.doc.body.trim(), original.body.trim());
  });

  it('round-trips scalars that YAML would otherwise re-type', function() {
    const round = okf.parse(okf.serialize({
      type: 'Reference',
      version: '1.10',            // must stay a string, not become 1.1
      answer: 'no',               // must stay a string, not become false
      empty: '',
      colonic: 'key: value inside a string',
      body: 'x'
    }));
    assert.equal(round.ok, true, round.error);
    assert.equal(round.doc.version, '1.10');
    assert.equal(round.doc.answer, 'no');
    assert.equal(round.doc.empty, '');
    assert.equal(round.doc.colonic, 'key: value inside a string');
  });

  it('rejects a document with no frontmatter, and says why', function() {
    const res = okf.parse('# Just a markdown file\n\nNo frontmatter here.\n');
    assert.equal(res.ok, false);
    assert.match(res.error, /no YAML frontmatter/);
  });

  it('rejects frontmatter without a type rather than returning a hollow doc', function() {
    const res = okf.parse('---\ntitle: Missing its type\n---\n\nbody\n');
    assert.equal(res.ok, false);
    assert.match(res.error, /`type` is required/);
  });

  it('never produces a reserved filename for a concept', function() {
    assert.equal(okf.conceptFilename('Index'), 'index-concept.md');
    assert.equal(okf.conceptFilename('log'), 'log-concept.md');
    assert.equal(okf.conceptFilename('Weekly Active Operators'), 'weekly-active-operators.md');
    assert.equal(okf.conceptFilename(''), 'concept.md');
    assert.equal(okf.isReservedFilename('INDEX.MD'), true);
  });
});

describe('okf effector — export / list / import', function() {
  let dir;
  let vault;
  let tools;

  function tool(name) {
    const t = tools.filter(x => x.name === name)[0];
    assert.ok(t, 'missing tool ' + name);
    return t.fn;
  }

  beforeEach(function() {
    dir = tempVaultDir();
    vault = createFsStore(() => dir, null);
    tools = fromOkf.buildTools({ vault });
  });

  afterEach(function() {
    cleanupVaultDir(dir);
  });

  it('exports a bundle with an index and reads it back unchanged', async function() {
    const res = await tool('okf_export')({
      bundle: 'ops',
      concepts: [
        { type: 'Playbook', title: 'Restart the voice stack', body: '1. Stop\n2. Start' },
        { type: 'Metric', title: 'Wake word false positives', body: 'Per day.', tags: ['voice'] }
      ]
    });
    assert.equal(res.ok, true, JSON.stringify(res.result));
    assert.equal(res.result.count, 2);
    assert.ok(fs.existsSync(path.join(dir, 'Knowledge', 'ops', 'index.md')), 'index.md must be written');

    const back = await tool('okf_import')({ bundle: 'ops' });
    assert.equal(back.ok, true, JSON.stringify(back.result));
    assert.equal(back.result.count, 2, 'index.md must not be imported as a concept by default');
    const metric = back.result.documents.filter(d => d.type === 'Metric')[0];
    assert.equal(metric.title, 'Wake word false positives');
    assert.deepEqual(metric.tags, ['voice']);
  });

  it('marks exports generated but never verified', async function() {
    await tool('okf_export')({ bundle: 'claims', concepts: [{ type: 'Reference', title: 'A', body: 'x' }] });
    const back = await tool('okf_import')({ bundle: 'claims' });
    const doc = back.result.documents[0];
    assert.equal(doc.generated, true);
    assert.ok(doc.generated_at, 'an export must record when it was produced');
    assert.equal(doc.verified, undefined,
      'an export verified nothing — asserting otherwise is the dishonest-ok pattern in file form');
  });

  it('refuses a bundle or filename that would escape the vault', async function() {
    for (const bad of ['../escape', 'a/b', 'a\\b', '..']) {
      const res = await tool('okf_export')({ bundle: bad, concepts: [{ type: 'X', body: 'y' }] });
      assert.equal(res.ok, false, 'must refuse bundle: ' + bad);
      assert.match(res.result.error, /invalid bundle name/);
    }
    const res = await tool('okf_export')({
      bundle: 'ok',
      concepts: [{ type: 'X', body: 'y', filename: '../../evil.md' }]
    });
    assert.equal(res.ok, false);
    assert.match(res.result.rejected[0].error, /invalid filename/);
  });

  it('refuses to write a reserved filename as a concept', async function() {
    const res = await tool('okf_export')({
      bundle: 'ok',
      concepts: [{ type: 'X', body: 'y', filename: 'log.md' }]
    });
    assert.equal(res.ok, false);
    assert.match(res.result.rejected[0].error, /reserved OKF filename/);
  });

  it('reports a concept it refused instead of dropping it silently', async function() {
    const res = await tool('okf_export')({
      bundle: 'partial',
      concepts: [
        { type: 'Playbook', title: 'Good', body: 'ok' },
        { title: 'No type at all', body: 'nope' }
      ]
    });
    assert.equal(res.ok, true, 'one good concept still exports');
    assert.equal(res.result.count, 1);
    assert.equal(res.result.rejected.length, 1);
    assert.match(res.result.rejected[0].error, /type is required/);
  });

  it('reports a malformed file on import rather than skipping it in silence', async function() {
    await tool('okf_export')({ bundle: 'mixed', concepts: [{ type: 'Playbook', title: 'Fine', body: 'ok' }] });
    fs.writeFileSync(path.join(dir, 'Knowledge', 'mixed', 'broken.md'), '# no frontmatter\n', 'utf8');
    const back = await tool('okf_import')({ bundle: 'mixed' });
    assert.equal(back.ok, true);
    assert.equal(back.result.count, 1);
    assert.ok(back.result.malformed, 'a file that failed to parse is the most useful thing to report');
    assert.equal(back.result.malformed[0].file, 'broken.md');
  });

  it('filters by type on import', async function() {
    await tool('okf_export')({
      bundle: 'typed',
      concepts: [
        { type: 'Metric', title: 'M1', body: 'a' },
        { type: 'Playbook', title: 'P1', body: 'b' }
      ]
    });
    const only = await tool('okf_import')({ bundle: 'typed', type: 'metric' });
    assert.equal(only.result.count, 1);
    assert.equal(only.result.documents[0].title, 'M1');
  });

  it('lists bundles and their concepts', async function() {
    await tool('okf_export')({ bundle: 'alpha', concepts: [{ type: 'Playbook', title: 'A', body: 'x' }] });
    const bundles = await tool('okf_list')({});
    assert.ok(bundles.result.bundles.indexOf('alpha') !== -1);

    const inside = await tool('okf_list')({ bundle: 'alpha' });
    const names = inside.result.concepts.map(c => c.file).sort();
    assert.deepEqual(names, ['a.md', 'index.md']);
    assert.equal(inside.result.concepts.filter(c => c.file === 'index.md')[0].reserved, true);
  });

  it('reports an empty or absent bundle honestly', async function() {
    const listed = await tool('okf_list')({ bundle: 'nothing-here' });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.result.concepts, []);
    assert.match(listed.result.note, /empty or does not exist/);

    const imported = await tool('okf_import')({ bundle: 'nothing-here' });
    assert.equal(imported.ok, false, 'importing a bundle that is not there must not look like an empty success');
  });
});
