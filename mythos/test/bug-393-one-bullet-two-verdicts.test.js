'use strict';

// BUG-393 — one OPEN WORK bullet produced two contradictory verdicts, because
// two readers in the same file read the same words by different rules.
//
// `build-index.js` reads a register bullet twice:
//
//   openSetFrom()  decides declared-open vs explicitly-closed by looking for
//                  FIXED / RESOLVED / CLOSED / SATISFIED anywhere in the block.
//   classify()     decides the entry's state, and for a pointer entry reads the
//                  SAME bullet through bulletPartial ("FIXED ... NOT yet").
//
// A half-done bullet says both words. So openSetFrom called it CLOSED and
// skipped it, while classify called it OPEN — and nothing ever compared the two.
// This is not a hypothetical: BUG-352's bullet reads "COUNTER FIXED 2026-08-27
// ...; the README catalog table and pie are NOT yet generated", and on
// 2026-08-28 it was the only contradiction among the register's 13 bullets.
//
// WHY THE DIRECTION OF THE FIX MATTERS. openSetFrom is aligned TO classify, not
// the reverse, and the safety argument is one-way: openSetFrom is an ADDITIVE
// override (`if (openSet.has(n)) return 'open'`), so teaching it to keep a
// half-done bullet open can only ever move an entry toward open. The opposite
// fix — teaching classify to honour the closure filter — would have closed a
// half-done ticket on the strength of the half that landed, which is the exact
// failure BUG-390 built bulletPartial to stop.
//
// THE VACUOUS-GUARD HALF, which is how this was found at all. The live-data
// check in bug-389's suite is `for (const n of openSet) ...`, and a loop over an
// empty set is a green that asserts nothing. On this base the declared set still
// holds BUG-392, so that loop is live TODAY — but it goes empty the moment
// BUG-392's bullet closes, and it was observed empty on that branch (PR #56).
// The mechanism it protects survives in a fixture (`new Set([389])`), so
// coverage would not go to zero; the live-data cross-check would. Every
// live-data assertion below therefore asserts its POPULATION first, so an empty
// register is a stated failure rather than a silent pass.
//
// MUTATION PROOF, 2026-08-28. Six mutations, each confirmed to have APPLIED by
// sha256 before its result was believed, each restored sha256-identical. 6 of 6
// caught, 0 survived, 0 unscored.
//
//   M1  the halfDone guard removed from openSetFrom (the defect itself)  -> 4 red
//   M2  bulletHalfDone loose in segment one (id -> closure word)         -> 1 red
//   M3  its vocabulary narrowed to FIXED alone                          -> 1 red
//   M4  the guard inverted                                              -> 8 red
//   M5  BUG-352's stale bullet head restored (the data half)            -> 1 red
//   M6  bulletHalfDone loose in segment two (closure word -> NOT-yet)   -> 1 red
//
// TWO of these tests exist BECAUSE of that run, and both holes were invisible to
// reading. M3 was predicted before it was run — every other case here pairs
// "NOT yet" with FIXED, so narrowing the vocabulary to one of four words would
// have survived. **M2 actually survived the first run.** bulletHalfDone has two
// independently tight segments, and the nested-number test only exercised the
// second, because its foreign bug number sits after FIXED; loosening the first
// segment changed behaviour with nothing watching. The fixture that puts a
// foreign number BEFORE the closure word was added for it, and M6 was added so
// the second segment has a mutation of its own rather than sharing M2's.
//
// The adjacent cases that must keep PASSING are asserted alongside, or the guard
// has no bounds: a plainly closed bullet stays closed, and a bullet with a
// closure word but no qualifier is not open.
//
// Run: cd mythos && node --test test/bug-393-one-bullet-two-verdicts.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseBugs, classify, openSetFrom } = require('../scripts/build-index.js');
const REPO = path.join(__dirname, '..', '..');
const BUGS_FILE = path.join(REPO, 'BUGS.md');
const README_FILE = path.join(REPO, 'README.md');

// A synthetic register section. Synthetic on purpose: pinning real bug numbers
// would make these fail the day somebody edits an unrelated ticket. The heading
// must match openSetFrom's anchor exactly, and a trailing `## ` terminator is
// included so the section-slicing path is the one under test.
function sectionOf(bullets) {
  return '## OPEN WORK filed 2026-01-01 (fixture)\n\n'
    + bullets.join('\n')
    + '\n\n## SOMETHING ELSE\n\nnot part of the register.\n';
}

const declaredOpen = (bullets) => [...openSetFrom(sectionOf(bullets)).set].sort((a, b) => a - b);

// Build a pointer-shaped entry for classify() from the same bullet text, so both
// routes are fed byte-identical input. A pointer entry in BUGS.md is a bullet
// living under a heading, which is how BUG-352 is written.
function stateOfBullet(n, bullet, openSet) {
  const md = '## BUG-' + n + ' — a fixture\n\n' + bullet + '\n';
  const bugs = parseBugs(md);
  assert.equal(bugs.length, 1, 'fixture must parse as exactly one entry');
  return classify(bugs[0], openSet || new Set());
}

// The real shape, reduced to its load-bearing words. Two lines, because the
// qualifier sitting on the bullet's SECOND line is what defeated the original
// line-by-line scan (BUG-390) and is what makes the two readers disagree here.
const HALF_DONE = '- BUG-393 - catalog truth. **COUNTER FIXED 2026-08-27 (147 -> 179, verified);\n'
  + '  the README catalog table and pie are NOT yet generated.**';

describe('BUG-393 — a half-done bullet must not read closed to one reader and open to the other', () => {
  it('CONTROL — a plainly closed bullet is closed to BOTH readers', () => {
    // Proves the rig can produce agreement, so a passing cross-check below is
    // not passing because nothing matched.
    const b = '- BUG-393 - a thing. FIXED abc1234: it was shipped and verified.';
    assert.deepEqual(declaredOpen([b]), [], 'openSetFrom must skip a plainly closed bullet');
    assert.notEqual(stateOfBullet(393, b), 'open', 'classify must not call it open either');
  });

  it('CONTROL — a plainly open bullet is open to BOTH readers', () => {
    const b = '- BUG-393 - a thing nobody has started. Needs a live pass.';
    assert.deepEqual(declaredOpen([b]), [393]);
    assert.equal(stateOfBullet(393, b, new Set([393])), 'open');
  });

  it('THE BUG — a "FIXED ... NOT yet" bullet stays declared-open', () => {
    // Pre-fix this returned [] : the closure filter saw FIXED and skipped the
    // bullet, so the authoritative open set silently dropped a half-done ticket.
    assert.deepEqual(declaredOpen([HALF_DONE]), [393],
      'a bullet stating one half FIXED and the other NOT yet is still open work');
  });

  it('THE BUG, other route — classify already called that bullet open', () => {
    // Pinned so the fix is proven to move openSetFrom TO classify. If this ever
    // flips, the fix was applied in the dangerous direction.
    assert.equal(stateOfBullet(393, HALF_DONE), 'open');
  });

  it('the two routes now agree on the half-done bullet', () => {
    const set = openSetFrom(sectionOf([HALF_DONE])).set;
    assert.equal(set.has(393), true);
    assert.equal(stateOfBullet(393, HALF_DONE, set), 'open');
  });

  it('the closure vocabulary still closes RESOLVED / CLOSED / SATISFIED', () => {
    // The fix must not blanket-disable the filter. BUG-344's real bullet states
    // "VERIFIED-SATISFIED 2026-08-24" and openSetFrom was taught that word
    // deliberately; losing it would trade one false report for another.
    for (const word of ['RESOLVED', 'CLOSED', 'SATISFIED']) {
      const b = '- BUG-393 - a thing. ' + word + ' 2026-08-24: done.';
      assert.deepEqual(declaredOpen([b]), [], word + ' must still close a bullet');
    }
  });

  it('a half-done bullet stays open for EVERY closure word, not just FIXED', () => {
    // Found by mutation analysis, before the mutation was run: every other case
    // here pairs "NOT yet" with FIXED, so narrowing bulletHalfDone's vocabulary
    // to FIXED alone would have survived — and it holds back a filter that closes
    // on four words, so covering one in four is a guard with a hole in it.
    for (const word of ['FIXED', 'RESOLVED', 'CLOSED', 'SATISFIED']) {
      const b = '- BUG-393 - a thing. **' + word + ' 2026-08-27 for the counter;\n'
        + '  the table is NOT yet generated.**';
      assert.deepEqual(declaredOpen([b]), [393],
        'a bullet stating ' + word + ' on one half and NOT yet on the other is open work');
    }
  });

  it('"NOT yet" without any closure word is open, not accidentally closed', () => {
    const b = '- BUG-393 - a thing. The generator is NOT yet written.';
    assert.deepEqual(declaredOpen([b]), [393]);
  });

  it('a nested "NOT yet" about ANOTHER bug must not reopen the parent', () => {
    // BUG-390's lesson, in the direction this change could break it: large
    // bullets list follow-ups as nested `- BUG-nnn` lines, and reading one of
    // those as the parent's status assigns one ticket's disposition to another.
    // The partial marker must name THIS bullet's own number.
    const b = '- BUG-393 - a thing. FIXED abc1234: shipped.\n'
      + '  Follow-up: BUG-394 is NOT yet started.';
    assert.deepEqual(declaredOpen([b]), [],
      'a NOT-yet naming a different bug number must not reopen this one');
  });

  it('a foreign bug number BEFORE the closure word also blocks the match', () => {
    // FOUND BY MUTATION, and it was a survivor. bulletHalfDone has TWO tight
    // segments — id -> closure word, and closure word -> NOT-yet — and the test
    // above only exercised the second, because its foreign number sits AFTER
    // FIXED. Loosening the FIRST segment therefore changed behaviour with nothing
    // watching. This fixture puts the foreign number before the closure word, so
    // each segment now has a case of its own.
    const b = '- BUG-393 - a thing. See BUG-394, which is FIXED; the rest is NOT yet done.';
    assert.deepEqual(declaredOpen([b]), [],
      'the closure word belongs to BUG-394, so BUG-393 is not half-done');
  });

  it('an unrelated closed bullet in the same section is unaffected', () => {
    const closed = '- BUG-394 - a thing. FIXED def5678: shipped.';
    assert.deepEqual(declaredOpen([HALF_DONE, closed]), [393]);
  });
});

describe('BUG-393 — against the real BUGS.md', () => {
  const text = fs.readFileSync(BUGS_FILE, 'utf8');
  const { set: openSet, section } = openSetFrom(text);
  const bugs = parseBugs(text);

  // Re-slice the section the same way openSetFrom does, so the population this
  // suite asserts over is the same one the reader saw.
  function registerSection() {
    const at = text.search(/^## OPEN WORK filed /m);
    assert.notEqual(at, -1, 'BUGS.md must still have an OPEN WORK register section');
    const after = text.slice(at);
    const endRel = after.slice(3).search(/^## /m);
    return endRel === -1 ? after : after.slice(0, endRel + 3);
  }

  const bulletNumbers = [...registerSection().matchAll(/^[-*] BUG-(\d+)\b/gm)].map((m) => +m[1]);

  it('the register section is present and holds bullets', () => {
    assert.equal(section, true, 'openSetFrom must report the section as found');
    // The assertion that stops this whole suite going vacuous. It is a floor, not
    // an exact count, so closing a ticket does not fail the build.
    assert.ok(bulletNumbers.length >= 5,
      `the OPEN WORK register holds ${bulletNumbers.length} bullets; under 5 means the `
      + 'section was emptied or the bullet pattern stopped matching, and every '
      + 'cross-check below would then pass without asserting anything');
  });

  it('no register bullet produces two verdicts', () => {
    // THE CROSS-CHECK. Two routes, one answer, on live data. Pre-fix this named
    // BUG-352 and nothing else: 12 of 13 bullets agreed, so the signal is
    // specific to the disagreement rather than to the method.
    const contradictions = [];
    for (const n of bulletNumbers) {
      const bug = bugs.find((b) => b.n === n);
      if (!bug) continue;
      const state = classify(bug, openSet);
      const declaredOpenHere = openSet.has(n);
      if (declaredOpenHere !== (state === 'open')) {
        contradictions.push(`BUG-${n}: register says ${declaredOpenHere ? 'open' : 'closed'}, `
          + `classify says ${state}`);
      }
    }
    assert.deepEqual(contradictions, [],
      'a bullet read as closed by openSetFrom and open by classify (or the reverse) is '
      + 'one set of words with two dispositions; state the status unambiguously');
  });

  it('every entry the register declares open still classifies open', () => {
    // bug-389's live check, restated with its population asserted rather than
    // looped over blind. When the declared set is legitimately empty that is
    // recorded here as a fact, and the fixture suite above carries the mechanism.
    if (openSet.size === 0) {
      assert.ok(bulletNumbers.length >= 5,
        'the declared-open set is empty, which is only honest while the section still '
        + 'holds bullets that state a closure');
      return;
    }
    for (const n of openSet) {
      const bug = bugs.find((b) => b.n === n);
      if (!bug) continue;
      assert.equal(classify(bug, openSet), 'open', `BUG-${n} is declared open and must read open`);
    }
  });
});

describe('BUG-393 — the README catalog claim is checked against the README', () => {
  // The narrow half, and deliberately narrow. BUG-352's bullet asserted the
  // catalog was ungenerated for a day after the generator shipped, and the only
  // reason nobody noticed is that no check compares a ticket's factual claim to
  // the artifact. The general version of this is not mechanizable — prose does
  // not name its artifact in any parseable way — so exactly one claim is pinned:
  // the one that went stale.
  it('the register does not claim the catalog is ungenerated while the block exists', () => {
    // Scoped to the OPEN WORK register, NOT the whole file, and that is not
    // convenience. BUG-390's entry quotes BUG-352's old bullet verbatim as the
    // evidence for a different fix, so a whole-file match would stay red forever
    // and the only way to green it would be to destroy that evidence. A ticket's
    // LIVE claim lives in the register; a quote of an old claim is history.
    const bugsText = fs.readFileSync(BUGS_FILE, 'utf8');
    const readme = fs.readFileSync(README_FILE, 'utf8');
    const at = bugsText.search(/^## OPEN WORK filed /m);
    assert.notEqual(at, -1);
    const rest = bugsText.slice(at);
    const endRel = rest.slice(3).search(/^## /m);
    const register = endRel === -1 ? rest : rest.slice(0, endRel + 3);

    const generated = readme.includes('SYNC:EFFECTOR-CATALOG:START');
    const claimsUngenerated = /catalog table and pie are NOT yet generated/i.test(register);
    assert.equal(generated && claimsUngenerated, false,
      generated
        ? 'README.md carries the generated SYNC:EFFECTOR-CATALOG block, so the OPEN WORK '
          + 'register must stop saying the catalog table and pie are not yet generated'
        : 'the register and README.md disagree about the catalog in the other direction');
    // Both halves asserted, so this cannot pass by the README losing its block.
    assert.equal(generated, true, 'README.md must carry the generated catalog block');
  });
});
