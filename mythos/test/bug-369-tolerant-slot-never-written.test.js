'use strict';

// BUG-369 — a slot marked `tolerant` was skipped by --write as well as --check,
// so the number it guards froze permanently.
//
// The tolerance itself is correct and stays. The README tests badge carries the
// PASS count, and pass legitimately varies by machine: fixture-gated tests
// t.skip() honestly on a fresh clone or a CI runner and run as passes on a
// provisioned machine. Strict equality there made --check unsatisfiable on the
// operator's machine and CI at the same time.
//
// But "do not FAIL on a mismatch" was implemented as "do not LOOK at this slot
// at all", and the two are not the same thing. `applySlots` hit the tolerant
// branch before the write branch and `continue`d, so no --write has moved that
// badge since the tolerance landed. Measured 2026-08-27: the badge read
// `tests-6139%20pass` while every strict slot in the same file read 6436 — the
// most-visible number in the repository, 297 behind and structurally unable to
// catch up.
//
// This is the same shape as the guard class recorded in the closure campaign: a
// check weakened to stop a false failure stopped doing its job entirely. The fix
// keeps the tolerance where it belongs (--check does not fail) and restores the
// half that was never in question (--write records what was measured).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require('../scripts/sync-test-count.js');

// AD-7: derived from os.tmpdir(), never a literal path.
function tempReadme(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug369-'));
  const file = path.join(dir, 'README.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const badge = (n) => `[![Tests](https://img.shields.io/badge/tests-${n}%20pass-2dd4bf)](x)\n`;
const strict = (n) => `A living system with an OODA loop, immune system, and ${n} tests.\n`;

const TOLERANT_SLOT = (file, value) => ({
  file, value, tolerant: true, pattern: /(tests-)(\d+)(%20pass-)/,
});
const STRICT_SLOT = (file, value) => ({
  file, value, pattern: /(immune system, and )(\d+)( tests\.)/,
});

describe('BUG-369 — a tolerant slot is presence-only for --check, not for --write', () => {
  test('write mode updates a tolerant slot whose value has drifted', () => {
    const file = tempReadme(badge(6139));
    const report = [];

    sync.applySlots({}, 'write', report, [TOLERANT_SLOT(file, 6436)]);

    assert.match(fs.readFileSync(file, 'utf8'), /tests-6436%20pass-/,
      'the badge must carry the count that was actually measured — a slot nothing can '
      + 'ever write is a number nobody can ever correct');
  });

  test('check mode still does not call a drifted tolerant slot stale', () => {
    // The deliberate NON-CHANGE, locked in. Pass varies by machine (honest
    // fixture skips), so --check must stay satisfiable on the operator's
    // machine and on a CI runner at the same time. If a later change makes
    // tolerance strict, this fails and says why.
    const file = tempReadme(badge(6139));
    const report = [];

    const stale = sync.applySlots({}, 'check', report, [TOLERANT_SLOT(file, 6436)]);

    assert.strictEqual(stale, 0, 'a tolerant mismatch is not staleness');
    assert.deepStrictEqual(report, [], 'and it must not be reported as one');
    assert.match(fs.readFileSync(file, 'utf8'), /tests-6139%20pass-/,
      'check mode must never write');
  });

  test('a tolerant slot whose pattern vanished is still reported loudly', () => {
    // Presence is the whole job tolerance leaves behind. A README restyle that
    // unhooks the badge must fail, or the slot silently guards nothing — the
    // exact way the effector badge drifted to 143-vs-138 in July.
    const file = tempReadme('no badge here at all\n');
    const report = [];

    const stale = sync.applySlots({}, 'check', report, [TOLERANT_SLOT(file, 6436)]);

    assert.strictEqual(stale, 1);
    assert.match(report.join('\n'), /MISSING PATTERN/);
  });

  test('a strict slot in the same file is unaffected either way', () => {
    // Both slots write to one file through the byFile map. The tolerant branch
    // used to `continue` BEFORE seeding that map, which is why restoring the
    // write path has to be checked against a second slot rather than alone: a
    // naive fix that writes each slot independently loses the other's edit.
    const file = tempReadme(badge(6139) + strict(6000));
    const report = [];

    sync.applySlots({}, 'write', report, [
      TOLERANT_SLOT(file, 6436),
      STRICT_SLOT(file, 6436),
    ]);

    const after = fs.readFileSync(file, 'utf8');
    assert.match(after, /tests-6436%20pass-/, 'tolerant slot written');
    assert.match(after, /and 6436 tests\./, 'strict slot written — neither edit clobbers the other');
  });

  test('the real README badge slot is the only tolerant one', () => {
    // Scope check for the fix. If a second tolerant slot appears later, its
    // author has to decide deliberately whether writing it is correct too,
    // rather than inheriting this ruling by accident.
    const tolerant = sync.readmeSlots({ tests: 1, pass: 1, effectors: 1, providers: 1, sensors: 1, deps: 1 })
      .filter((s) => s.tolerant);
    assert.strictEqual(tolerant.length, 1);
    assert.match(String(tolerant[0].pattern), /%20pass/);
  });
});
