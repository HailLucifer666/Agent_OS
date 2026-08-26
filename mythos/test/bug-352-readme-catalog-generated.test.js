'use strict';

// BUG-352 (part 2) — the README effector catalog was hand-typed and had drifted
// into three separate lies at once, none of which any gate could see:
//
//   * the pie summed to 108 and the table to 107, against a real 179 — the two
//     halves of one section disagreeing with each other AND with the code;
//   * TEN whole modules were absent (android 14, cua 4, whatsapp 4, doc-RAG 4,
//     okf 3, mcp 3, code-search 2, app-reply, image-gen, strix);
//   * two rows named things that no longer exist — a `Hermes Build Engine |
//     hermes_task` row for an engine deleted in the W6 dsh swap, and a
//     `Voice | speak` row for an effector removed 2026-07-31 as dead code.
//
// AD-10 says tool counts are generated, never hand-typed. The counts elsewhere
// in the README already were; this section was the one place a human still
// typed them, so it is the one place that drifted.
//
// These assertions read the README as TEXT and compare it to what the effector
// directory actually registers. They are deliberately independent of how the
// section is produced — a future rewrite of the generator does not get to
// invalidate the guard, and the guard cannot pass by agreeing with a generator
// that is itself wrong.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeEffectorTools,
  effectorCatalogBlock,
  EFFECTOR_LABELS,
  PIE_MIN_SLICE,
} = require('../scripts/sync-test-count.js');

const README = path.join(__dirname, '..', '..', 'README.md');

// Row shape: | **Label** | `from-x.js` | 12 | `a`, `b`, … |
// Anchored on the backticked module filename so the label column is free to be
// restyled without unhooking the guard.
const ROW_RE = /^\|[^|]*\|\s*`(from-[a-z0-9-]+\.js)`\s*\|\s*(\d+)\s*\|/gm;

function catalogRows() {
  const text = fs.readFileSync(README, 'utf8');
  const rows = new Map();
  for (const m of text.matchAll(ROW_RE)) rows.set(m[1], Number(m[2]));
  return rows;
}

describe('BUG-352 part 2 — the README effector catalog is generated from the real modules', () => {
  test('every module that registers tools has a catalog row with its real count', () => {
    const real = computeEffectorTools();
    const rows = catalogRows();

    const missing = Object.keys(real.perFile).filter((f) => !rows.has(f));
    assert.deepStrictEqual(missing, [],
      'these modules register tools but the README catalog never mentions them — '
      + 'the exact failure that hid 10 modules and 72 tools from every reader');

    const wrong = Object.entries(real.perFile)
      .filter(([file, ids]) => rows.get(file) !== ids.length)
      .map(([file, ids]) => `${file}: README says ${rows.get(file)}, real ${ids.length}`);
    assert.deepStrictEqual(wrong, [], 'catalog counts must match the registered tool arrays');
  });

  test('no catalog row names a module that no longer exists', () => {
    const real = computeEffectorTools();
    const stale = [...catalogRows().keys()].filter((f) => !(f in real.perFile));
    assert.deepStrictEqual(stale, [],
      'a row for a deleted module is how `Hermes Build Engine | hermes_task` survived '
      + 'the engine swap — the catalog must not outlive its subject');
  });

  test('the catalog table sums to the real total', () => {
    const real = computeEffectorTools();
    const sum = [...catalogRows().values()].reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, real.total,
      'the table is the detailed view of the headline number; if they differ the README '
      + 'disagrees with itself');
  });

  test('the pie chart sums to the real total', () => {
    const text = fs.readFileSync(README, 'utf8');
    const pie = text.match(/pie showData title Tool Distribution\r?\n([\s\S]*?)```/);
    assert.ok(pie, 'the Tool Distribution pie must still exist');
    const slices = [...pie[1].matchAll(/:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
    assert.ok(slices.length > 0, 'the pie must have slices');
    const sum = slices.reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, computeEffectorTools().total,
      'the pie summed to 108 while the table summed to 107 and the code registered 179 — '
      + 'a grouped "Other" slice must carry the tools it groups, not drop them');
  });
});

// The label map is the one hand-written thing left in this section, so it is the
// one thing that can still rot. It is only safe because it fails loudly in both
// directions — a module with no label, and a label with no module. These drive
// each direction with a synthetic perFile rather than the real directory, so
// they keep testing the guard after the real module list changes.
describe('BUG-352 part 2 — the label map cannot rot silently', () => {
  const realFile = Object.keys(EFFECTOR_LABELS)[0];

  const allLabelled = () => Object.fromEntries(Object.keys(EFFECTOR_LABELS).map((f) => [f, ['a']]));

  test('a module with no label is a hard error, not an omitted row', () => {
    assert.throws(
      () => effectorCatalogBlock({ ...allLabelled(), 'from-brand-new.js': ['shiny_tool'] }, '\n'),
      (err) => {
        assert.match(err.message, /from-brand-new\.js/, 'the failure must name the module');
        assert.match(err.message, /EFFECTOR_LABELS/, 'and name what to add it to');
        return true;
      },
      'adding a from-*.js and forgetting the label must break the build, because the '
      + 'alternative is a catalog that quietly omits it — which is the bug being fixed',
    );
  });

  test('a label whose module is gone is a hard error, not a surviving row', () => {
    const missingOne = allLabelled();
    delete missingOne[realFile];
    assert.throws(
      () => effectorCatalogBlock(missingOne, '\n'),
      (err) => {
        assert.match(err.message, /register no tools/, 'the failure must say why the label is wrong');
        assert.match(err.message, new RegExp(realFile.replace('.', '\\.')), 'and name which label');
        return true;
      },
      'this is the exact shape of the deleted Hermes engine keeping its catalog row',
    );
  });

  test('when both directions are wrong at once, both are named', () => {
    // The first draft checked the two directions in sequence, so an unlabelled
    // new module made all 29 real labels look orphaned and the error told the
    // reader to delete every one of them. A message that misdirects when two
    // things are wrong is worse than no message, because it is followed.
    const both = allLabelled();
    delete both[realFile];
    both['from-brand-new.js'] = ['shiny_tool'];
    assert.throws(() => effectorCatalogBlock(both, '\n'), (err) => {
      assert.match(err.message, /from-brand-new\.js/, 'the unlabelled module must be named');
      assert.match(err.message, /register no tools/, 'and the orphaned label must also be named');
      return true;
    });
  });

  test('the grouped pie slice carries every tool it groups', () => {
    const perFile = {};
    for (const file of Object.keys(EFFECTOR_LABELS).slice(0, 4)) perFile[file] = ['a'];
    const block = effectorCatalogBlock(
      { ...perFile, ...Object.fromEntries(Object.keys(EFFECTOR_LABELS).slice(4).map((f) => [f, ['a']])) },
      '\n',
    );
    const slice = block.match(/"Other \((\d+) modules[^"]*\)" : (\d+)/);
    assert.ok(slice, 'modules under the slice threshold must be grouped, not dropped');
    assert.strictEqual(Number(slice[1]), Object.keys(EFFECTOR_LABELS).length,
      'every below-threshold module must be counted in the group');
    assert.strictEqual(Number(slice[2]), Object.keys(EFFECTOR_LABELS).length,
      'and so must every one of their tools — one tool each here');
  });

  test('regenerating without a change is byte-identical, so --check cannot flap', () => {
    const perFile = computeEffectorTools().perFile;
    assert.strictEqual(effectorCatalogBlock(perFile, '\r\n'), effectorCatalogBlock(perFile, '\r\n'));
  });

  test('the block is emitted with the line ending it is given', () => {
    const perFile = { [realFile]: ['a'], ...Object.fromEntries(
      Object.keys(EFFECTOR_LABELS).slice(1).map((f) => [f, ['a']])) };
    const crlf = effectorCatalogBlock(perFile, '\r\n');
    assert.ok(crlf.includes('\r\n'), 'README.md on this repo is CRLF; a hardcoded \\n block '
      + 'never matches its own sentinels and --write inserts a second copy (the ROADMAP block '
      + 'shipped exactly that bug on 2026-07-30)');
    assert.ok(!effectorCatalogBlock(perFile, '\n').includes('\r'), 'and LF stays LF');
  });

  test('PIE_MIN_SLICE is a named threshold, not a magic number in the output', () => {
    assert.ok(Number.isInteger(PIE_MIN_SLICE) && PIE_MIN_SLICE > 1);
  });
});
