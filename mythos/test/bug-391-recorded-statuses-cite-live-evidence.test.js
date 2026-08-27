'use strict';

// BUG-391 — the last 28 entries were recorded by hand, and this re-runs every
// citation they were recorded on.
//
// BUG-389 and BUG-390 taught the register to READ statuses that were already
// written. These 28 had none in any convention, so each was checked individually
// against the artifact its own `**Fix.**` section names, and the result written
// back as a `**Status:**` line that cites what was checked.
//
// A citation nobody re-runs decays into the same unverifiable prose these entries
// started as. If somebody renames `titleSatisfiesQuery`, BUG-085's recorded status
// becomes a false claim carrying generator authority — worse than the gap it
// replaced. So every citation is machine-readable and every one is re-checked here.
//
// Run: cd mythos && node --test test/bug-391-recorded-statuses-cite-live-evidence.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const BUGS_FILE = path.join(REPO, 'BUGS.md');
const text = fs.readFileSync(BUGS_FILE, 'utf8');

// `**Status:** ✅ FIXED. Verified in source <date> (BUG-391): `SYM` in `FILE`.`
const CITE = /Verified in source \d{4}-\d{2}-\d{2} \(BUG-391\): `([^`]+)` in `([^`]+)`/g;
const TEST_CITE = /Regression test `([^`]+)` present/g;

function all(re) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags);
  while ((m = r.exec(text)) !== null) out.push(m);
  return out;
}

describe('BUG-391 — every hand-recorded status re-checks against the tree', () => {
  const cites = all(CITE);

  it('found the citations it is meant to police', () => {
    // A guard that silently matches nothing passes forever. This repo has been
    // bitten by exactly that, so the count is asserted before the contents.
    assert.ok(cites.length >= 25,
      `expected the BUG-391 sweep's citations, found ${cites.length}. If entries were `
      + 'reworded, update this guard rather than deleting it');
  });

  it('every cited file exists', () => {
    for (const [, , file] of cites) {
      assert.ok(fs.existsSync(path.join(REPO, file)), `cited file is gone: ${file}`);
    }
  });

  it('every cited artifact is still in the file that was cited', () => {
    // Substring matching is not enough, and mutation caught it: renaming
    // `titleSatisfiesQuery` to `titleSatisfiesQueryRenamed` left the citation
    // "true" under includes(), so the guard survived the exact change it exists
    // to catch. The symbol must stand alone — not be part of a longer identifier.
    // \b is wrong here because these citations include `picsum.photos`,
    // `operator-profile` and `Resolve-UIAElement`, so the boundary is defined as
    // "not an identifier character" instead.
    const standalone = (body, sym) => {
      const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^A-Za-z0-9_$])' + esc + '($|[^A-Za-z0-9_$])').test(body);
    };
    for (const [, sym, file] of cites) {
      const body = fs.readFileSync(path.join(REPO, file), 'utf8');
      assert.ok(standalone(body, sym),
        `${file} no longer contains \`${sym}\`. A recorded status cites it as the evidence `
        + 'the fix landed, so either the fix was reverted or the status is now false');
    }
  });

  it('every cited regression test still exists', () => {
    const tests = all(TEST_CITE);
    assert.ok(tests.length >= 5, `expected the named regression tests, found ${tests.length}`);
    for (const [, f] of tests) {
      assert.ok(fs.existsSync(path.join(REPO, f)), `cited regression test is gone: ${f}`);
    }
  });

  it('no citation points at a test file as its source evidence', () => {
    // The oracle that was rejected during BUG-390: a fix confirmed by its own test
    // proves the test exists, not that the product changed. Source and test are
    // cited in separate clauses on purpose.
    for (const [, sym, file] of cites) {
      assert.ok(!/(^|\/)test\//.test(file.replace(/\\/g, '/')),
        `BUG-391 cites ${file} for \`${sym}\`, but a test file cannot be the source evidence`);
    }
  });
});

describe('BUG-391 — the register has no unreadable entries left', () => {
  const { parseBugs, classify, openSetFrom } = require('../scripts/build-index.js');

  it('nothing is unrecorded', () => {
    const openSet = openSetFrom(text).set;
    const states = parseBugs(text).map((b) => ({ n: b.n, s: classify(b, openSet) }));
    const unrec = states.filter((x) => x.s === 'unrecorded');
    assert.equal(unrec.length, 0,
      'unrecorded: ' + unrec.map((x) => x.n).join(', ')
      + '. 133 -> 36 (BUG-389) -> 28 (BUG-390) -> 0 (BUG-391). A new one means an entry '
      + 'was filed with no status, which is the thing to fix at the source.');
  });

  it('the recorded 28 read as fixed, not as verified', () => {
    // Source presence proves the fix LANDED. It does not prove it works, and the
    // difference is the whole distinction between the two states in this register.
    const openSet = openSetFrom(text).set;
    const byN = new Map(parseBugs(text).map((b) => [b.n, classify(b, openSet)]));
    for (const n of [47, 49, 55, 85, 93, 97, 256]) {
      assert.equal(byN.get(n), 'fixed', `BUG-${n} should read fixed`);
    }
  });
});
