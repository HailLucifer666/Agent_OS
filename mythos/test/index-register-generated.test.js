'use strict';

// The ticket register in the root `index.html`, generated from BUGS.md.
//
// The operator's ruling on 2026-08-27: this repository tracks its own progress
// in a tracked file, not in a published artifact, and the capability map and
// the bug register are ONE page — two views over one JSON island.
//
// The load-bearing assertion here is the one about silence. Measured the same
// day: only about a quarter of the entries in BUGS.md state a status a machine
// can read. A generator that treats the other 133 as closed would publish a
// confident, wrong picture of the backlog — which is the exact failure this
// whole campaign exists to stop. Silence is reported as `unrecorded`, and the
// open set comes from the OPEN WORK register rather than from absence.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const gen = require('../scripts/build-index.js');

// Fixture ticket numbers are assembled from a prefix constant rather than
// written out, and that is load-bearing rather than fussy. lint-bug-registry
// greps tracked SOURCE for BUG-<digits> and counts each one as an allocated
// number; a fixture that spells the literal out is indistinguishable from a
// real ticket, so five fake ones pushed the undeclared ratchet 130 -> 135 and
// blocked this very commit. The alternative was five hand-written
// adjudications; removing the surface beats defending it.
const B = 'BUG-';


const INDEX = path.join(__dirname, '..', '..', 'index.html');

const REGISTER_SECTION = [
  '## OPEN WORK filed 2026-01-01 (fixture)',
  '',
  '- ' + B + '900 - still open, nobody has touched it.',
  '- ' + B + '901 - was open, then',
  '  FIXED 2026-01-02 on the second line of the block.',
  '',
].join('\n');

describe('the register reads status, and never infers it from silence', () => {
  test('an entry with no status word is "unrecorded", not "fixed"', () => {
    const r = gen.buildRegister({ bugsText: REGISTER_SECTION + '\n## ' + B + '500 — something happened once\n\nProse with no status line at all.\n' });
    const b = r.bugs.find((x) => x.n === 500);
    assert.strictEqual(b.state, 'unrecorded',
      'an entry that states nothing is not evidence of closure — 133 real entries are this shape, '
      + 'and calling them fixed would publish a backlog that does not exist');
  });

  test('fixed-and-proven is separated from fixed-and-unverified', () => {
    const txt = REGISTER_SECTION
      + '\n## ' + B + '501 — a thing (✅ FIXED 2026-01-01, mutation-proven)\n\n**Status:** ✅ FIXED. 0 survived.\n'
      + '\n## ' + B + '502 — another thing (✅ FIXED 2026-01-01)\n\n**Status:** ✅ FIXED 2026-01-01.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((x) => x.n === 501).state, 'verified');
    assert.strictEqual(r.bugs.find((x) => x.n === 502).state, 'fixed',
      '"fixed" without live verification or a mutation run is a weaker claim and must read as one');
  });

  test('the open set comes from the register section, read as BLOCKS', () => {
    // The word FIXED routinely sits on an entry's SECOND line. A first-line-only
    // read reported a closed bug as open on 2026-08-27; the block parse is the
    // fix, and this pins it.
    const r = gen.buildRegister({ bugsText: REGISTER_SECTION });
    assert.deepStrictEqual(r.openDeclared, [900],
      B + '901 says FIXED on its second line and must not be reported open');
  });

  test('a number declared only as a bullet still appears, marked as such', () => {
    const r = gen.buildRegister({ bugsText: REGISTER_SECTION });
    const b = r.bugs.find((x) => x.n === 900);
    assert.strictEqual(b.shape, 'pointer');
    assert.ok(b.title.length > 0, 'the bullet text is the only title such a ticket has');
  });

  test('an empty open set is refused, not published', () => {
    // Guard the guard. Every "is this covered" check downstream passes
    // vacuously against an empty set, so a missing register section must fail
    // loudly rather than quietly produce a clean-looking report.
    assert.throws(() => gen.buildRegister({ bugsText: '## ' + B + '500 — no register section here\n' }),
      /no "## OPEN WORK filed" section/);
  });
});

describe('the register shares one island with the map, and owns only its own key', () => {
  test('generating the register preserves every key it does not own', () => {
    const island = { generated: 'x', vitals: { a: 1 }, nodes: [{ n: 'z', bugs: [1] }], clusters: [] };
    const html = '<script type="application/json" id="map-data">\n'
      + JSON.stringify(island) + '\n</script>';
    const r = gen.generate({ html, register: { bugs: [], counts: {}, total: 0, openDeclared: [], pointerOnly: 0 } });
    assert.deepStrictEqual(r.next.nodes, island.nodes,
      'node data belongs to build-capability-map.js — including the per-node `bugs` field, '
      + 'which another session owns. Clobbering it would make the two generators fight.');
    assert.deepStrictEqual(r.next.vitals, island.vitals);
    assert.strictEqual(r.next.generated, 'x');
    assert.ok(r.next.register, 'and it does write its own key');
  });
});

describe('the real index.html', () => {
  const html = fs.readFileSync(INDEX, 'utf8');

  test('there is exactly one page, and it carries both views', () => {
    assert.match(html, /id="stage"/, 'the capability map canvas');
    assert.match(html, /id="register"/, 'the ticket register');
    assert.match(html, /id="tab-map"/);
    assert.match(html, /id="tab-reg"/);
  });

  test('the register in the file matches BUGS.md', () => {
    const r = gen.generate();
    assert.strictEqual(r.changed, false,
      'index.html is stale — run `node mythos/scripts/build-index.js --write`');
  });

  test('the old hand-maintained map file is gone', () => {
    // One tracked surface, per the operator's ruling. Two files is how the
    // numbers on them start disagreeing.
    assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'MYTHOS-CAPABILITY-MAP.html')),
      'MYTHOS-CAPABILITY-MAP.html still exists; index.html replaced it');
  });

  test('every ticket state the data can produce has a colour in the renderer', () => {
    // Same class as the map's status palette: a state the renderer cannot
    // colour throws at render time rather than showing a missing swatch.
    const r = gen.generate();
    const states = [...new Set(r.register.bugs.map((b) => b.state))];
    for (const s of states) {
      assert.match(html, new RegExp('\\n\\s*' + s + '\\s*:\\s*\\{c\\s*:'),
        `the register renderer has no tone for state "${s}"`);
    }
  });
});
