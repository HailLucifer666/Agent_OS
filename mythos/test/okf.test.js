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

// 2026-09-29 audit, B2b. okf_export is tier 2, which the default autonomy
// ceiling allows with no confirmation, and a concept's custom `filename` was
// checked only for separators, "..", and a leading/trailing dot or space.
// Measured the same day on Windows 11 (25H2), in a scratch directory:
//   - "run.bat" was accepted and written as-is: an executable-typed file in the
//     vault, from a tool that never asks.
//   - Node created a bare "aux" — and so would create a bundle DIRECTORY named
//     "con" — that cmd lists but cannot open: Node reaches the disk through \\?\
//     paths, which skip the device rules, and cmd does not. Names WITH an
//     extension ("con.md", "COM0.md") are ordinary files on this build: cmd
//     created, read and deleted them (independent review, confirmed). They are
//     refused anyway because Windows 10 and older reserve them too, per
//     Microsoft's naming documentation (not measured here).
//   - "notes.md:hidden.exe" created an NTFS alternate data stream: notes.md
//     listed as 0 bytes, the content sat in a stream okf_list and okf_import
//     never read.
// Every assertion below checks the DISK as well as the return value: a refusal
// that still wrote the file would pass a return-value test.
//
// STAGE 1, 2026-09-29: tests 1-6 below failed on the unfixed code; test 7 (the
// adjacent names that must keep working) passed before and after.
// PROVEN ABLE TO FAIL, 2026-09-29 — nine mutations, each diffed, run, and
// restored from a byte copy, each turning the named test red:
//   drop the .md check (1); let ":" through (2, 5); device regex without the
//   trailing-space form (3), without superscript digits (3), bare names only
//   (3, 6); no length limit (4, 5); generated device names not suffixed (6); the
//   effector checking the segment instead of the final filename (1); refuse the
//   concept but still write a file (1, 2, 3, 4 — the disk assertions, not the
//   return values, are what catch this one).
// After independent review (Opus), same day, four more, each red: delete
// okf_import's bundle guard (this one PASSED the first version of test 5, whose
// ok:false also holds for a merely absent bundle — it now asserts the reason);
// let COM0 through; stop okf_list trimming; read through the untrimmed name.
describe('okf_export — every final filename is a plain .md name (B2b)', function() {
  let dir;
  let tools;

  beforeEach(function() {
    dir = tempVaultDir();
    tools = fromOkf.buildTools({ vault: createFsStore(() => dir, null) });
  });

  afterEach(function() {
    cleanupVaultDir(dir);
  });

  function tool(name) {
    return tools.filter(x => x.name === name)[0].fn;
  }

  function onDisk(bundle) {
    const d = path.join(dir, 'Knowledge', bundle);
    return fs.existsSync(d) ? fs.readdirSync(d) : [];
  }

  async function exportOne(filename, bundle) {
    return tool('okf_export')({ bundle: bundle || 'b', writeIndex: false, concepts: [{ type: 'X', body: 'y', filename }] });
  }

  it('refuses a custom filename that does not end in .md, and writes nothing', async function() {
    for (const name of ['run.bat', 'notes.txt', 'page.html', 'x.md.exe', 'noext']) {
      const res = await exportOne(name);
      assert.equal(res.ok, false, name);
      assert.match(res.result.rejected[0].error, /must end in \.md/, name);
      assert.match(res.result.rejected[0].error, /Omit `filename` and a safe one is generated from the title/, 'the refusal names the way forward');
    }
    assert.deepEqual(onDisk('b'), []);
  });

  it('refuses ":" and every other character Windows gives meaning to — no alternate data stream is created', async function() {
    for (const name of ['notes.md:hidden.exe', 'a:b.md', 'a<b.md', 'a>b.md', 'a"b.md', 'a|b.md', 'a?b.md', 'a*b.md', 'tab\there.md', 'nul\u0000.md']) {
      const res = await exportOne(name);
      assert.equal(res.ok, false, JSON.stringify(name));
      assert.match(res.result.rejected[0].error, /reserved character/, JSON.stringify(name));
    }
    assert.deepEqual(onDisk('b'), [], 'not even the 0-byte host file of a stream may appear');
  });

  it('refuses a Windows device name in any case, with or without an extension', async function() {
    for (const name of ['con.md', 'CON.md', 'Con .md', 'nul.md', 'Aux.md', 'prn.md', 'com1.md', 'LPT9.md',
      'conin$.md', 'CONOUT$.md', 'com\u00b9.md', 'aux.tar.md', 'com0.md', 'LPT0.md']) {
      const res = await exportOne(name);
      assert.equal(res.ok, false, name);
      assert.match(res.result.rejected[0].error, /reserved device name/, name);
    }
    assert.deepEqual(onDisk('b'), []);
  });

  it('refuses an over-long filename', async function() {
    const res = await exportOne('a'.repeat(200) + '.md');
    assert.equal(res.ok, false);
    assert.match(res.result.rejected[0].error, /longer than/);
    assert.deepEqual(onDisk('b'), []);
  });

  it('applies the same rules to the bundle name, on export and on read', async function() {
    for (const bundle of ['con', 'NUL', 'a:b', 'x'.repeat(200)]) {
      const res = await tool('okf_export')({ bundle, concepts: [{ type: 'X', body: 'y' }] });
      assert.equal(res.ok, false, bundle);
      assert.match(res.result.error, /invalid bundle name/, bundle);
      // The REASON is asserted, not only ok:false: okf_import returns ok:false for
      // any bundle that merely does not exist, so a bare ok check here passed with
      // the guard deleted (independent review, 2026-09-29).
      assert.match((await tool('okf_list')({ bundle })).result.error, /invalid bundle name/, 'okf_list ' + bundle);
      assert.match((await tool('okf_import')({ bundle })).result.error, /invalid bundle name/, 'okf_import ' + bundle);
    }
    assert.equal(fs.existsSync(path.join(dir, 'Knowledge')), false, 'no bundle directory may be created');
  });

  it('makes a GENERATED name safe instead of refusing it — a title is not a filename', async function() {
    const res = await tool('okf_export')({
      bundle: 'gen',
      writeIndex: false,
      concepts: [{ type: 'X', title: 'CON', body: 'a' }, { type: 'X', title: 'nul', body: 'b' }, { type: 'X', title: 'Com1', body: 'c' }]
    });
    assert.equal(res.ok, true, JSON.stringify(res.result));
    assert.deepEqual(onDisk('gen').sort(), ['com1-concept.md', 'con-concept.md', 'nul-concept.md']);
  });

  it('okf_list trims the bundle name the way export and import do', async function() {
    await tool('okf_export')({ bundle: 'notes', writeIndex: false, concepts: [{ type: 'X', title: 'A', body: 'x' }] });
    const listed = await tool('okf_list')({ bundle: 'notes ' });
    assert.equal(listed.ok, true, JSON.stringify(listed.result));
    assert.equal(listed.result.bundle, 'notes');
    assert.deepEqual(listed.result.concepts.map(c => c.file), ['a.md']);
    assert.equal(listed.result.concepts[0].type, 'X', 'the concept must be READ through the trimmed name too');
  });

  // The adjacent cases: names that merely LOOK like the refused ones must keep working.
  it('still accepts ordinary .md names, including ones that start like a device name', async function() {
    const names = ['my-notes.md', 'Notes.MD', 'console.md', 'com10.md', 'nullable.md', 'auxiliary.md', 'a.b.md'];
    for (const name of names) {
      const res = await exportOne(name, 'fine');
      assert.equal(res.ok, true, name + ': ' + JSON.stringify(res.result));
    }
    assert.deepEqual(onDisk('fine').sort(), names.slice().sort());
  });
});
