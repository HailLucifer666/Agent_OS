'use strict';

// BUG-373 — a bug number MENTIONED in a commit message counted as ALLOCATING
// it, so a sentence explaining a renumber blocked every commit from a checkout.
//
// This is the second instance of one defect. The first was markdown: a plan
// document that discussed BUG-999 made the number live, the maximum jumped to
// 999 and the ratchet ticked, and the gate blocked a commit whose only sin was
// explaining the gate. That was fixed with `isDoc` — documentation is not
// allocation. Commit messages are documentation too, and did not get the same
// treatment.
//
// HOW IT BIT, 2026-08-27. Two sessions were handed BUG-371 by `--next` within
// one minute (correctly — the window is between asking and writing, and neither
// entry existed yet). The second session renumbered to 372 by amending. Its
// commit body still read "...gemini,kokoro,edge,piper (BUG-371)", so 371 was
// "in use" and undeclared in that tree, the ratchet went 136 -> 137, and EVERY
// commit from that checkout was blocked — not only ones citing a number.
//
// The trap underneath it: `git commit --amend` runs the hook while HEAD is
// still the OLD commit, so the amend that removes the citation is itself
// blocked by the citation it is removing. Proved in a throwaway repo. A gate
// that reads HEAD cannot be satisfied by rewriting HEAD.
//
// WHAT THIS COSTS, measured rather than estimated. The claim this change was
// argued against — "~20 legacy bugs exist only in commit messages, and the
// ratchet is the only thing that points at them" — is FALSE. Measured on
// 2026-08-27: 130 undeclared numbers appear in code, and exactly SIX appear
// only in commit messages (43, 44, 45, 132, 145, 318). Of the BUG-323..342
// block that claim named, ZERO are commit-only. So the ratchet loses sight of
// six numbers, and `--undeclared-in-commits` names all six — which is strictly
// more actionable than the aggregate count that hid them.
//
// The asymmetry is deliberate and matches `isDoc`: commit messages still count
// toward the MAXIMUM, so `--next` can never hand out a number a branch has
// taken. Over-reporting the maximum only makes the next free number larger,
// which is the safe direction.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const lint = require('../scripts/lint-bug-registry.js');

// A number that exists ONLY as prose in a commit message on HEAD.
const commitOnly = (n) => ({
  declaredTimes: new Map(),
  mentionedInBugs: new Set(),
  inCommits: new Map([[n, new Set(['deadbeef'])]]),
  inCommitsHead: new Map([[n, new Set(['deadbeef'])]]),
  inSource: new Map(),
});

describe('BUG-373 — prose in a commit message is not an allocation', () => {
  test('a number cited only in a commit message does not enter the ratchet', () => {
    // The exact shape that blocked a whole checkout: ed85f79's body said
    // "(BUG-371)" while its subject and its entry both said 372.
    const report = lint.buildReport(commitOnly(371));
    assert.deepStrictEqual(report.undeclared, [],
      'a sentence mentioning a number is discussing it, not claiming it — and a gate that '
      + 'blocks every commit from a checkout over a sentence gets switched off');
  });

  test('but it is still LISTED, so it is not lost', () => {
    // The whole objection to this change was that the ratchet was the only
    // thing pointing at commit-only numbers. Naming them beats counting them.
    const report = lint.buildReport(commitOnly(371));
    assert.deepStrictEqual(report.undeclaredInCommits, [371]);
  });

  test('and it still raises the MAXIMUM, which is the safe direction', () => {
    // Same asymmetry as isDoc. Over-reporting the maximum can only make the
    // next free number larger; under-reporting it hands out a number a branch
    // has already taken, which is how BUG-280 and BUG-360 happened.
    const report = lint.buildReport(commitOnly(371));
    assert.strictEqual(report.max, 371);
    assert.strictEqual(report.nextFree, 372);
  });

  test('the generated register quotes bug numbers without allocating them', () => {
    // Sixth firing of this class, 2026-08-27. `index.html` is the generated
    // ticket register: it QUOTES entries out of BUGS.md, so every number it
    // displays was counted as a fresh allocation in code. The register of the
    // backlog was raising the backlog count by existing — adding the
    // ticket-detail panel took undeclared 130 -> 137 with no work filed.
    //
    // It is documentation by the same test markdown passes: a view OF the
    // registry, not a consumer of it.
    const report = lint.buildReport({
      declaredTimes: new Map(),
      mentionedInBugs: new Set(),
      inCommits: new Map(),
      inCommitsHead: new Map(),
      inSource: new Map([[402, new Set(['index.html'])]]),
    });
    assert.deepStrictEqual(report.undeclared, [],
      'a number displayed by the generated register is being shown, not claimed');
    assert.strictEqual(report.max, 402,
      'but it still raises the maximum — the safe direction, same as markdown');
  });

  test('a number in some OTHER html file does still count as code', () => {
    // The exemption is for the one generated register, not for HTML in general.
    // A hand-written page citing a bug number is using it like any other source.
    const report = lint.buildReport({
      declaredTimes: new Map(),
      mentionedInBugs: new Set(),
      inCommits: new Map(),
      inCommitsHead: new Map(),
      inSource: new Map([[403, new Set(['mythos/ui/public/dashboard.html'])]]),
    });
    assert.deepStrictEqual(report.undeclared, [403],
      'widening this to every .html would quietly stop the gate seeing a whole file type');
  });

  test('a number used in CODE with no entry still blocks — that is the real backlog', () => {
    const report = lint.buildReport({
      declaredTimes: new Map(),
      mentionedInBugs: new Set(),
      inCommits: new Map(),
      inCommitsHead: new Map(),
      inSource: new Map([[400, new Set(['mythos/src/core/effectors/from-pc.js'])]]),
    });
    assert.deepStrictEqual(report.undeclared, [400],
      'a defect whose number is in the source but has no BUGS.md entry is an undocumented '
      + 'bug, which is exactly what the ratchet exists to hold down');
    assert.deepStrictEqual(report.undeclaredInCommits, [],
      'and it must not also appear in the commit listing');
  });

  test('a number in BOTH code and a commit counts once, as code', () => {
    const report = lint.buildReport({
      declaredTimes: new Map(),
      mentionedInBugs: new Set(),
      inCommits: new Map([[400, new Set(['deadbeef'])]]),
      inCommitsHead: new Map([[400, new Set(['deadbeef'])]]),
      inSource: new Map([[400, new Set(['mythos/src/core/effectors/from-pc.js'])]]),
    });
    assert.deepStrictEqual(report.undeclared, [400]);
    assert.deepStrictEqual(report.undeclaredInCommits, [],
      'the commit listing is for numbers the ratchet can no longer see — a number the '
      + 'ratchet already holds must not be reported twice');
  });

  test('a declared number appears in neither', () => {
    const report = lint.buildReport({
      declaredTimes: new Map([[400, 1]]),
      mentionedInBugs: new Set(),
      inCommits: new Map([[400, new Set(['deadbeef'])]]),
      inCommitsHead: new Map([[400, new Set(['deadbeef'])]]),
      inSource: new Map([[400, new Set(['mythos/src/core/effectors/from-pc.js'])]]),
    });
    assert.deepStrictEqual(report.undeclared, []);
    assert.deepStrictEqual(report.undeclaredInCommits, []);
  });

  test('the commit listing is HEAD-scoped like the ratchet, not --all', () => {
    // Otherwise the listing depends on which branches a machine happens to
    // have fetched, and two people at the same commit see different output.
    const report = lint.buildReport({
      declaredTimes: new Map(),
      mentionedInBugs: new Set(),
      inCommits: new Map([[500, new Set(['deadbeef'])]]),
      inCommitsHead: new Map([[400, new Set(['deadbeef'])]]),
      inSource: new Map(),
    });
    assert.deepStrictEqual(report.undeclaredInCommits, [400],
      'the branch-only number 500 must raise the maximum without entering the listing');
    assert.strictEqual(report.max, 500);
  });
});

describe('BUG-373 — against the real repository', () => {
  const report = lint.buildReport();

  test('the measured split is what the change was costed against', () => {
    // If these move a lot, the cost argument above needs re-measuring rather
    // than re-asserting. Bounds, not equalities: the backlog is allowed to
    // shrink, and numbers get declared over time.
    assert.ok(report.undeclared.length <= lint.UNDECLARED_BASELINE,
      `${report.undeclared.length} undeclared in code, above baseline ${lint.UNDECLARED_BASELINE}`);
    assert.ok(report.undeclaredInCommits.length <= 12,
      `${report.undeclaredInCommits.length} commit-only numbers; measured 6 on 2026-08-27. `
      + 'A jump means commit messages are being used to file bugs, and the listing needs to '
      + 'become a gate rather than a report.');
  });

  test('the six measured commit-only numbers are named, not counted', () => {
    // The objection this answers: the ratchet reported an aggregate nobody
    // could act on, which is why these are still undeclared.
    for (const n of report.undeclaredInCommits) {
      assert.ok(Number.isInteger(n) && n > 0 && n < 999, `bad entry ${n}`);
    }
    assert.ok(!report.undeclaredInCommits.some((n) => report.undeclared.includes(n)),
      'the two lists must be disjoint');
  });

  test('the ratchet no longer counts commit prose, so the baseline had to drop', () => {
    // A baseline left at the old value would be 6 above reality and stop
    // biting — the drift the sibling test in lint-bug-registry.test.js guards.
    assert.ok(lint.UNDECLARED_BASELINE < 136,
      'the baseline still carries the six commit-only numbers it no longer counts');
  });
});
