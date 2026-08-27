'use strict';

// BUG-389 — the register called 133 entries "unrecorded" while 96 of them stated
// a status the classifier never looked for.
//
// BUGS.md used a BOLD MARKER LINE (`**FIXED.**`, `**Fixed** by <sha>`) before
// `**Status:**` existed. classify() only ever read the heading and a `**Status:**`
// whose marker sat immediately after the colon, so an entire generation of entries
// read as no-status-at-all — and the file's own header asserted they were "a
// heading and prose", which is the claim these tests exist to keep honest.
//
// The dangerous half is NOT the recovery. It is that a body marker must never
// outrank an explicit Status line: three entries that were already classified
// correctly flipped during development because a scoped `**Not fixed in this
// pass:**` subsection was read as the ticket's disposition.
//
// Run: cd mythos && node --test test/bug-389-register-reads-the-older-status-convention.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseBugs, classify, openSetFrom } = require('../scripts/build-index.js');
const BUGS_FILE = path.join(__dirname, '..', '..', 'BUGS.md');

// Classify a single synthetic entry. Synthetic on purpose: pinning real bug
// numbers would make these fail the day somebody edits an unrelated ticket.
function stateOf(markdown, openSet) {
  const bugs = parseBugs(markdown);
  assert.equal(bugs.length, 1, 'fixture must parse as exactly one entry');
  return classify(bugs[0], openSet || new Set());
}

const HEAD = '### BUG-389 — a fixture\n\n';

describe('BUG-389 — the older bold-marker convention is a recorded status', () => {
  it('reads **FIXED.** as fixed', () => {
    assert.equal(stateOf(HEAD + '**FIXED.** New `settings-store.js` — a flat store.\n'), 'fixed');
  });

  it('reads **Fixed** by <sha> as fixed', () => {
    assert.equal(stateOf(HEAD + '**Fixed** by `6b41db1` on the packaging branch: a 429 now backs off.\n'), 'fixed');
  });

  it('promotes a marked fix to verified when it is live-verified or mutation-proven', () => {
    assert.equal(stateOf(HEAD + '**FIXED.** Reworked the gate. Live-verified 2026-08-01.\n'), 'verified');
    assert.equal(stateOf(HEAD + '**FIXED.** Reworked the gate, mutation-proven, 0 survived.\n'), 'verified');
  });

  it('reads **NOT done, and not attempted:** as OPEN, not as fixed', () => {
    // The trap the marker patterns are ordered around: the negative contains the
    // positive, so a naive /FIXED/ scan closes a bug whose own status says it
    // never started. BUG-098 is the real entry that reads this way.
    assert.equal(stateOf(HEAD + '**NOT done, and not attempted:** the wake word was never trained.\n'), 'open');
    assert.equal(stateOf(HEAD + '**NOT fixed.** Nothing was changed here.\n'), 'open');
  });

  it('does not treat **Not unit-testable.** as a status at all', () => {
    // BUG-049's real shape. "Not <verb>" is matched against an explicit verb list
    // precisely so an ordinary bold sentence starting with "Not" stays unrecorded
    // rather than being read as a refusal to fix.
    assert.equal(stateOf(HEAD + '**Not unit-testable.** Whether it feels witty is a human call.\n'), 'unrecorded');
  });

  it('still reports unrecorded for an entry that genuinely states nothing', () => {
    // The whole point of the generator, and the line BUG-389 must not cross.
    assert.equal(stateOf(HEAD + '**Symptom.** Mid-conversation it loses the thread.\n\n'
      + '**Root cause.** Three defects in one block.\n'), 'unrecorded');
  });
});

describe('BUG-389 — an explicit Status line outranks any marker in the body', () => {
  // Each of these reproduces an entry that regressed while this was being written.
  it('a **Status:** FIXED entry stays fixed despite a later "Not fixed in this pass"', () => {
    const md = HEAD + '**Status:** ✅ FIXED (2026-07-17) — the hang was never a hang.\n\n'
      + '**Not fixed in this pass:** the thumbnail path is still unproven.\n';
    assert.equal(stateOf(md), 'fixed',
      'BUG-038 shape: a scoped subsection about PART of the work is not the disposition');
  });

  it('a **Status:** MITIGATED entry is not reopened by a "Not fixed" subsection', () => {
    const md = HEAD + '**Status:** ⚠️ MITIGATED (2026-07-17) — CLAUDE.md now carries binding rules.\n\n'
      + '**Not fixed in this pass:** no systemic guard exists yet.\n';
    assert.equal(stateOf(md), 'fixed', 'BUG-037 shape');
  });

  it('reads a Status line whose marker is not adjacent to the colon', () => {
    // BUG-011 shape. The old regex required ✅ immediately after `**Status:**`, so
    // three separately verified fixes read as no status.
    const md = HEAD + '**Status:** Fix 2 (param aliasing) ✅ VERIFIED · Fix 1 ✅ LIVE-VERIFIED (2026-07-27)\n';
    assert.equal(stateOf(md), 'verified');
  });

  it('reads 🔧 CODED from a Status line, not only from the heading', () => {
    // BUG-020 shape: the coded/diagnosed checks read the heading while the fixed
    // check read both, and nobody noticed the asymmetry.
    assert.equal(stateOf(HEAD + '**Status:** 🔧 CODED — mic tuning still needs a live pass\n'), 'coded');
  });

  it('reads the WORD CODED on a Status line, with no emoji to lean on', () => {
    // Found by mutation: the case above passes on the 🔧 alone, so deleting the
    // word-CODED branch survived. Not every entry carries the emoji.
    assert.equal(stateOf(HEAD + '**Status:** CODED 2026-08-02 — awaiting a live pass\n'), 'coded');
  });

  it('reads a bold **LIVE-VERIFIED** marker line on its own', () => {
    // Also found by mutation: every other marker fixture goes through the FIXED
    // branch, so the verified branch was never the thing under test.
    assert.equal(stateOf(HEAD + '**LIVE-VERIFIED 2026-08-01.** The orb answers every click.\n'), 'verified');
  });

  it('does not call a CLOSED-via-another-bug entry a duplicate', () => {
    // BUG-001 shape. Widening the duplicate window from 40 to 300 characters made
    // this read as a duplicate because the word appears far later in the line.
    const md = HEAD + '**Status:** ✅ CLOSED via BUG-026\'s 5th-attempt fix (2026-07-17) — playback '
      + 'live-verified working; see BUG-026, which also lists the duplicate reports.\n';
    assert.equal(stateOf(md), 'verified');
  });

  it('the OPEN WORK register still outranks a FIXED marker', () => {
    const md = HEAD + '**FIXED.** Shipped last week.\n';
    assert.equal(stateOf(md, new Set([389])), 'open',
      'the authoritative open list must not be overridden by an entry\'s own prose');
  });
});

describe('BUG-389 — against the real BUGS.md', () => {
  const text = fs.readFileSync(BUGS_FILE, 'utf8');
  const bugs = parseBugs(text);
  const openSet = openSetFrom(text).set;
  const states = bugs.map((b) => ({ n: b.n, s: classify(b, openSet) }));

  it('reads a status for the large majority of entries', () => {
    const unrec = states.filter((x) => x.s === 'unrecorded').length;
    // Deliberately a bound, not the exact number: this must not fail every time
    // somebody files or closes a ticket. It was 133 of 237 before BUG-389.
    assert.ok(unrec <= 60,
      `${unrec} entries still unrecorded out of ${states.length}; BUG-389 brought 133 down to 36, `
      + 'so a jump back over 60 means the older-convention reader stopped working');
  });

  it('every entry the OPEN WORK register names still reads as open', () => {
    for (const n of openSet) {
      const got = states.find((x) => x.n === n);
      if (!got) continue;
      assert.equal(got.s, 'open', `BUG-${n} is in the OPEN WORK register and must read open`);
    }
  });

  it('no state outside the declared set', () => {
    const { STATES } = require('../scripts/build-index.js');
    for (const x of states) {
      assert.ok(STATES.includes(x.s), `BUG-${x.n} produced an undeclared state "${x.s}"`);
    }
  });
});
