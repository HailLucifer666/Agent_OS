'use strict';

// test/bug-394-entry-owns-its-own-text.test.js — BUG-394, 2026-09-02.
//
// ONE RULE: an entry's classification is computed only from text the entry owns.
// Three ways it was not, all of which produced a real misclassification:
//
//   1. THE BODY RAN PAST THE ENTRY. An entry ended at the next `# BUG-` heading
//      and the last one at end-of-file. BUG-273 is the last `## BUG-` heading in
//      BUGS.md, so the whole `## OPEN WORK filed` register and every
//      `## Session (...)` section was read as its body — and appending anything
//      to the end of the file changed its status. It turned a test red on
//      2026-08-28 while BUG-273 itself never changed.
//   2. THE BULLET PATTERNS SPANNED NESTED FOLLOW-UPS. They ran against the whole
//      body with newlines collapsed, so the marker word could come from a
//      `- BUG-nnn` bullet about a DIFFERENT ticket.
//   3. AN ARROW COUNTED AS A BULLET. The id anchor is `[-*]\s*BUG-0*<n>\b`, so
//      writing `brain calls=1  <- BUG-278 measured 1` inside BUG-278's own entry
//      made the `-` of `<-` read as a bullet marker, and BUG-278 classified
//      `open` immediately after being live-verified.
//
// WHY THEY SHIPPED TOGETHER. Measured on 2026-08-28, either fix ALONE flipped
// which of bulletPartial/bulletFixed won for BUG-274 — a live licence ticket —
// and closed it. Re-measured 2026-09-02 in all four cells of
// {bounding on/off} x {tight patterns on/off}: BUG-274, BUG-275 and BUG-394 read
// `open` in every one, because step 1 (an explicit Status line on 274 and 275
// plus a register declaration for both) had since removed the hazard. Shipped
// together anyway — the coupling is real and re-splitting them re-opens it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const gen = require('../scripts/build-index.js');

// Fixture ticket numbers are assembled from a prefix constant rather than
// written out. lint-bug-registry greps tracked SOURCE for BUG-<digits> and
// counts each as an allocated number, so a fixture spelling the literal out is
// indistinguishable from a real ticket and pushes the undeclared ratchet over
// baseline. Same reason as index-register-generated.test.js.
const B = 'BUG-';

const REGISTER = [
  '## OPEN WORK filed 2026-01-01 (fixture)',
  '',
  '- ' + B + '900 - still open, nobody has touched it.',
  '',
].join('\n');

describe('BUG-394 mechanism 1 — an entry ends at the next top-level section', () => {
  test('a following `## ` section is NOT read as the last entry’s body', () => {
    // The measured shape: the final entry states nothing, and a later section
    // carries a closure word. Before the fix the entry wore it.
    const txt = REGISTER
      + '\n## ' + B + '500 — something happened once\n\nProse with no status line at all.\n'
      + '\n## Session (2026-01-02) — unrelated notes\n\n'
      + '**Status:** ✅ FIXED 2026-01-02, mutation-proven. 0 survived.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'unrecorded',
      'the entry states nothing; a later session section must not lend it a status');
  });

  test('the OPEN WORK register itself is not absorbed by the last entry', () => {
    // The exact 2026-08-28 failure: the register sits after the final entry, so
    // its bullets became that entry's body and its status was computed from
    // other tickets' text.
    const txt = '## ' + B + '500 — the last entry, states nothing\n\nSome prose.\n\n'
      + REGISTER + '\n- ' + B + '901 - was open, then FIXED 2026-01-02.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'unrecorded',
      'the register’s bullets are not the last entry’s text');
    assert.deepStrictEqual(r.openDeclared, [900],
      'and the register still parses on its own, unaffected by the bound');
  });

  test('BOUND: an entry KEEPS its own `###` subsections', () => {
    // The bug the first draft of this fix had, and it was worse than the defect
    // it repaired. Stopping at the next heading of ANY depth cut BUG-273 at its
    // own "### Evidence — measured, not inferred" and discarded 89,125
    // characters INCLUDING its mutation proof; 46 entries shrank and 7 changed
    // state, four by losing evidence they had written themselves. Exactly two
    // hashes is the fix, and this is what pins it.
    const txt = REGISTER
      + '\n## ' + B + '500 — a thing (✅ FIXED 2026-01-01)\n\n'
      + '**Status:** ✅ FIXED 2026-01-01.\n\n'
      + '### Evidence — measured, not inferred\n\n'
      + 'Four mutations, all four caught, and the fix is live-verified.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'verified',
      'the proof lives in the entry’s OWN `###` subsection — cutting there '
      + 'throws away the evidence and downgrades a verified fix');
  });

  test('BOUND: a sibling BUG heading written with two hashes is not a section boundary', () => {
    // THIS PROPERTY HOLDS BY CONSTRUCTION AND NO MUTATION CAN RED IT. Said
    // plainly because two drafts of the source each added a guard for it — a
    // `(?!BUG-\d)` lookahead, then a `!bugAt.has(at)` position filter — and
    // mutation probe (c) deleted each in turn and reddened nothing, twice. The
    // real reason is `Math.min(nextBug, nextSection)`: `nextBug` is already the
    // next bug heading's offset, so a bug heading among the section offsets can
    // only tie with it, never win. Both guards were unreachable and both were
    // removed.
    //
    // The test is KEPT anyway, and not as proof of a guard — it is the
    // executable statement of a property a future refactor of that `Math.min`
    // could break. It just cannot be credited to any line of defence.
    const txt = REGISTER
      + '\n## ' + B + '500 — first (✅ FIXED 2026-01-01)\n\n**Status:** ✅ FIXED.\n'
      + '\n## ' + B + '501 — second\n\nProse with no status.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'fixed');
    assert.strictEqual(r.bugs.find((b) => b.n === 501).state, 'unrecorded',
      'the second entry must not inherit the first’s status');
  });
});

describe('BUG-394 mechanism 2 — a marker is read from the bullet that names this entry', () => {
  test('a nested bullet about ANOTHER ticket cannot supply this entry’s marker', () => {
    // The measured defect: the patterns ran across a flattened whole body, so a
    // follow-up bullet about a different number closed this entry.
    //
    // THE FIXTURE HAD TO BE STRENGTHENED, and probe (d) is what showed it. The
    // first version listed ONLY the other ticket's bullet — and it passed with
    // the scoping reverted, because with no bullet naming this entry at all the
    // id anchor never matched in the first place. It was asserting nothing about
    // the mechanism it was written for. The own bullet below is what makes the
    // flattened body reach across from this entry's id to the other's marker,
    // which is the real shape from BUGS.md.
    const txt = REGISTER
      + '\n## ' + B + '500 — an entry with no status line of its own\n\n'
      + '- ' + B + '500 - the counter work, still in progress.\n'
      + '- ' + B + '901 - the adjacent ticket. FIXED 2026-01-02.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'unrecorded',
      'BUG-' + '901’s closure is not BUG-' + '500’s status');
  });

  test('a bullet that DOES name this entry is still read, including a wrapped qualifier', () => {
    // The negative control for the scoping, and it guards something the file
    // already relies on: a wrapped bullet states the qualifier two lines down,
    // and reading line by line closes a ticket on the half that landed.
    const txt = REGISTER
      + '\n## ' + B + '500 — an entry with no status line\n\n'
      + '- ' + B + '500 - counter FIXED;\n'
      + '  the catalog table and pie are NOT yet generated.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'open',
      'its own half-done bullet must still be read, across the line wrap');
  });

  test('one bullet mentioning TWO ids: the other id’s marker is not borrowed', () => {
    // Why the `(?!BUG-\d)` gap is NOT made redundant by the block scoping.
    // Scoping excludes a separate bullet; it does nothing about a single bullet
    // that names two tickets. Only the gap stops this.
    const txt = REGISTER
      + '\n## ' + B + '500 — an entry with no status line\n\n'
      + '- ' + B + '500 - see ' + B + '901, which is FIXED 2026-01-02.\n';
    const r = gen.buildRegister({ bugsText: txt });
    assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'unrecorded',
      'the closure word belongs to the other id named in the same bullet');
  });
});

describe('BUG-394 third sighting — an arrow is not a bullet', () => {
  test('`<- ' + B + 'nnn` inside an entry does not read as a bullet marker', () => {
    // Verbatim shape from the 2026-08-28 incident: writing an ASCII arrow next
    // to a bug number inside that same entry classified it `open` immediately
    // after it had been live-verified. Nothing in the entry was a bullet.
    const txt = REGISTER
      + '\n## ' + B + '500 — a live-verified entry with no status line\n\n'
      + '**FIXED.** Live-verified 2026-01-02.\n\n'
      + 'brain calls=1  <- ' + B + '500 measured 1, and FIXED is NOT yet the whole story.\n';
    const r = gen.buildRegister({ bugsText: txt });
    const state = r.bugs.find((b) => b.n === 500).state;
    assert.ok(state === 'fixed' || state === 'verified',
      'an arrow satisfied the old id anchor and flipped this to open; got ' + state);
  });

  test('a real bullet at line start IS still a bullet, indented or not', () => {
    // The bound on the line-start anchor: indentation is normal in this file, so
    // requiring column 0 would silently stop reading nested-but-own bullets.
    for (const indent of ['', '  ', '    ']) {
      const txt = REGISTER
        + '\n## ' + B + '500 — no status line\n\n'
        + indent + '- ' + B + '500 - FIXED 2026-01-02.\n';
      const r = gen.buildRegister({ bugsText: txt });
      assert.strictEqual(r.bugs.find((b) => b.n === 500).state, 'fixed',
        'an own bullet indented by ' + indent.length + ' spaces must still be read');
    }
  });
});

describe('BUG-394 — the real file, and the safety property the ticket is built on', () => {
  test('the live licence ticket and the fabrication ticket stay OPEN', () => {
    // THE reason mechanisms 1 and 2 are one ticket. Either fix alone once
    // flipped BUG-274 — a live licence ticket that gates shipping — to closed.
    // This is the assertion that must never go quiet.
    //
    // BUG-394 itself is deliberately NOT in this list: it was closed by this
    // change and its register bullet now states so, which is the register
    // working rather than an omission. Only tickets that are genuinely still
    // open belong here, or the test rots into a snapshot.
    const r = gen.buildRegister();
    for (const n of [274, 275]) {
      assert.strictEqual(r.bugs.find((b) => b.n === n).state, 'open',
        'BUG-' + n + ' must read open — it is declared in the OPEN WORK register');
    }
    assert.deepStrictEqual(r.openDeclared, [274, 275],
      'the open set is read from the register, and these two are what is left');
  });

  test('the three state changes on the real file are the expected three', () => {
    // Inspected by hand before shipping, which is what the ticket instructs and
    // is how the first draft's over-cutting was caught. All three are honest:
    //
    //   BUG-38  fixed -> verified   its OWN text carries "live-verified"; the
    //                               51,992 characters it was absorbing were the
    //                               "## Phase 1 — Engagement Execution Engine"
    //                               section, which is not its text.
    //   BUG-98  fixed -> CODED      its `fixed` was BORROWED — its own text has no
    //                               closure marker at all, so bounding first made
    //                               it `unrecorded`. That tripped BUG-391's
    //                               "nothing is unrecorded" guard, whose own
    //                               message says a new one "means an entry was
    //                               filed with no status, which is the thing to
    //                               fix at the source". Fixed at the source: it
    //                               was given a Status line read from its own
    //                               words ("NEEDS-LIVE-CHECK explicitly, not
    //                               claimed further"), so it now reads `coded`.
    //                               The guard was NOT relaxed — relaxing it would
    //                               have been altering the measurement.
    //   BUG-273 verified -> fixed   it loses borrowed PROOF text: `mutation-proven`
    //                               sits in the swallowed register section, not in
    //                               its own body. Still fixed, no longer verified.
    const r = gen.buildRegister();
    assert.strictEqual(r.bugs.find((b) => b.n === 38).state, 'verified');
    assert.strictEqual(r.bugs.find((b) => b.n === 98).state, 'coded',
      'BUG-098 states 🔧 and explicitly declines to claim more; `coded` is its own word');
    assert.strictEqual(r.bugs.find((b) => b.n === 273).state, 'fixed');
    assert.strictEqual(r.counts.unrecorded, 0,
      'the bounding raised unrecorded 0->1 and the source was fixed rather than the guard');
  });

  test('no entry’s body reaches past a top-level section heading', () => {
    // The invariant, asserted over EVERY entry rather than the ones that
    // happened to change state — a check that only looks at today's three is the
    // same omission scheduled for the next entry someone appends a section after.
    const fs = require('node:fs');
    const path = require('node:path');
    const text = fs.readFileSync(path.join(__dirname, '..', '..', 'BUGS.md'), 'utf8');
    const bugs = gen.parseBugs(text).filter((b) => b.shape === 'entry');
    assert.ok(bugs.length > 200, 'sanity: the real file parsed');
    const offenders = [];
    for (const b of bugs) {
      // Its own heading is line 1 of the body; any LATER `## ` that is not a bug
      // heading means the body crossed a section boundary.
      const rest = b.body.slice(b.body.indexOf('\n') + 1);
      const m = /^## (?!BUG-\d)/m.exec(rest);
      if (m) offenders.push('BUG-' + b.n + ' crosses: ' + rest.slice(m.index, m.index + 60).trim());
    }
    assert.deepStrictEqual(offenders, [],
      'these entries still absorb a section that is not theirs');
  });
});

// MUTATION PROOF — 8 probes, run 2026-09-02 and then RE-RUN against the final
// code after it changed mid-pass, because a probe result that describes an
// earlier draft is not evidence about what ships. Each applied-verified by
// re-counting the mutated string; each restored by full-path file copy verified
// `sha256sum -c`.
//
// RESULTS AS OBSERVED, NOT AS PREDICTED. Three probes behaved differently from
// the note first written here, and each discrepancy is kept because each says
// something true about what these tests do and do not depend on.
//
//   (a) restore the old body bound (`const end = nextBug`)
//       -> RED: "a following `## ` section is NOT read", "the three state
//          changes on the real file", and the whole-file invariant. As predicted.
//       -> PREDICTED AND DID NOT HAPPEN: "the OPEN WORK register itself is not
//          absorbed" going red. It does not, because that fixture's entry has no
//          bullet naming itself, so the register's bullets could not reach it
//          even unbounded. The test still documents the shape; it is the
//          whole-file invariant that actually catches this mutation.
//   (b) widen the section boundary to `#{1,6}`
//       -> RED: "BOUND: an entry KEEPS its own `###` subsections" and the
//          three-state-changes test. This is the defect this fix's own first
//          draft shipped, and it is why that bound exists.
//   (c) DELETED, TWICE, AND RECORDED RATHER THAN REPLACED. It removed the
//       boundary pattern's `(?!BUG-\d)` lookahead, and reddened NOTHING. Rewritten
//       to remove the `!bugAt.has(at)` position filter instead — and that reddened
//       nothing either. Both guards were unreachable, because `Math.min(nextBug,
//       nextSection)` already guarantees the property; both were removed from the
//       source. There is now no probe (c), and the property's test says openly
//       that it holds by construction and cannot be reddened.
//   (d) revert firstMarkerLine to the flattened whole body
//       -> RED: the arrow test only.
//       -> PREDICTED AND DID NOT HAPPEN: "a nested bullet about ANOTHER ticket"
//          going red. The `gap` guard covers that case on its own. The block
//          scoping's unique contribution is the line-start anchor, i.e. the arrow.
//   (e) drop the line-start anchor from BULLET_LINE_RE -> RED: the arrow test.
//   (f) loosen `gap` back to `[^\n]*` -> RED: "one bullet mentioning TWO ids"
//       only. The scoping covers the nested-bullet case on its own.
//   (g) ADJACENT CASE — over-tighten the anchor to column 0
//       -> RED: "a real bullet at line start IS still a bullet, indented or not".
//          The anchor is not over-tightened, and indented own bullets still read.
//   (h) (d) AND (f) TOGETHER -> RED: all three bullet tests including the
//       nested-bullet one. Written because neither alone reds it: the scoping and
//       the gap each cover that case independently, so it is genuinely defended
//       twice — and each guard covers a case the other does not (arrow -> scoping
//       only; two ids in ONE bullet -> gap only). Without this probe the
//       nested-bullet test would look vacuous, and it is not.
//
// Results also recorded in the BUG-394 entry in BUGS.md.
