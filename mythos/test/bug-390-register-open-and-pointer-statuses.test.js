'use strict';

// BUG-390 — two more stated statuses the register could not read, and two ways
// it read the WRONG entry's status.
//
// Found the same way BUG-389's were: by reading what the entries still marked
// `unrecorded` actually say. Three of them open with `**OPEN. Deferred by design
// to …**` or `**OPEN, UNDIAGNOSED …**`, and five are pointer-shape bullets
// carrying `FIXED <sha>` inline. The OPEN ones matter most — an entry wrongly
// left unrecorded there is real work that nothing is tracking.
//
// The two false positives are the more important half:
//   * BUG-273 read `verified` off a bullet NESTED INSIDE IT that was about
//     BUG-345 — one ticket's disposition assigned to another.
//   * BUG-352 reads "COUNTER FIXED … the README catalog table and pie are NOT
//     yet generated", and the qualifier is on the bullet's SECOND line, so a
//     per-line scan closed a half-done ticket on the half that landed.
//
// Run: cd mythos && node --test test/bug-390-register-open-and-pointer-statuses.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseBugs, classify, openSetFrom } = require('../scripts/build-index.js');
const BUGS_FILE = path.join(__dirname, '..', '..', 'BUGS.md');

function stateOf(markdown) {
  const bugs = parseBugs(markdown);
  assert.equal(bugs.length, 1, 'fixture must parse as exactly one entry');
  return classify(bugs[0], new Set());
}

// For fixtures that deliberately contain bullets about OTHER tickets: parseBugs
// reads those as pointer entries of their own, which is correct, so the entry
// under test has to be selected by number rather than by position.
function stateOfN(markdown, n) {
  const bug = parseBugs(markdown).find((b) => b.n === n);
  assert.ok(bug, `fixture must contain BUG-${n}`);
  return classify(bug, new Set());
}

const HEAD = '## BUG-390 — a fixture\n\n';

describe('BUG-390 — a stated OPEN is a status', () => {
  it('reads **OPEN. Deferred by design ...** as open', () => {
    assert.equal(stateOf(HEAD + '**OPEN. Deferred by design to merged-order step 8.** '
      + 'Numbered here so the id is reserved.\n'), 'open');
  });

  it('reads **OPEN, UNDIAGNOSED ...** as open', () => {
    assert.equal(stateOf(HEAD + '**OPEN, UNDIAGNOSED. Operator-reported 2026-08-17 and '
      + 'explicitly deprioritised the same day.**\n'), 'open');
  });

  it('an OPEN marker outranks a later description of a fix', () => {
    // These entries routinely go on to describe the fix that WOULD close them.
    // Reading that as the status is how a deferred ticket disappears.
    const md = HEAD + '**OPEN. Deferred to step 8.**\n\n'
      + '**Fix.** The wiring table in the plan carries the full design.\n';
    assert.equal(stateOf(md), 'open');
  });
});

describe('BUG-390 — pointer-shape entries carry their status inline', () => {
  it('reads a bullet "FIXED <sha>" as fixed', () => {
    assert.equal(stateOf('- BUG-390 - adblock silence caveat. FIXED 639200c: append a '
      + 'spoken caveat to buildLaunchResult.\n'), 'fixed');
  });

  it('a half-done bullet is OPEN even though it says FIXED, and the qualifier wraps', () => {
    // BUG-352's real shape, newline included on purpose: this is the case a
    // line-by-line scan gets wrong.
    const md = '- BUG-390 - catalog truth. **COUNTER FIXED 2026-08-27 (147 -> 179, verified);\n'
      + '  the README catalog table and pie are NOT yet generated — see below.**\n';
    assert.equal(stateOf(md), 'open',
      'work remaining means open; reading the FIXED and stopping closes half a ticket');
  });

  it('a bullet about ANOTHER bug never sets this entry\'s status', () => {
    // BUG-273's real shape: an audit entry that lists other tickets as bullets.
    // Without the id check this read `verified` off BUG-345's disposition.
    const md = HEAD + '**Symptom.** The audit listed several follow-ups.\n\n'
      + '- BUG-345 - adblock silence caveat. FIXED 639200c: append a spoken caveat.\n'
      + '- BUG-346 - wake-word suspended state must feed the re-arm ladder.\n';
    assert.equal(stateOfN(md, 390), 'unrecorded',
      'this entry states nothing about itself; the bullets are about other tickets');
  });

  it('still reads a bullet that names its own number among others', () => {
    // The positive control for the id check — it must not have turned the bullet
    // reader off altogether.
    const md = '- BUG-390 - verifier retry-guidance mapping. FIXED 1adad59. Maps rule '
      + 'names onto OUTPUT_CONTRACT clauses.\n';
    assert.equal(stateOf(md), 'fixed');
  });
});

describe('BUG-390 — against the real BUGS.md', () => {
  const text = fs.readFileSync(BUGS_FILE, 'utf8');
  const bugs = parseBugs(text);
  const openSet = openSetFrom(text).set;
  const states = new Map(bugs.map((b) => [b.n, classify(b, openSet)]));

  it('the deferred and undiagnosed tickets read as open, not as nothing', () => {
    for (const n of [266, 267, 268]) {
      assert.equal(states.get(n), 'open',
        `BUG-${n} states **OPEN** and must be tracked as open work`);
    }
  });

  it('a half-done bullet reads open — the mechanism, on a fixture', () => {
    // RE-SCOPED 2026-08-28 by BUG-393. This asserted `states.get(352) === 'open'`
    // against the live file, which was an OUTCOME standing in for a MECHANISM: it
    // passed only while BUG-352 happened to be half-done. Both halves of BUG-352
    // then shipped, its bullet was corrected, and this guard went red against a
    // CORRECT register — the same erosion the neighbouring BUG-273 case records,
    // and the second instance of it in this one file.
    //
    // What it is for is the partial marker: FIXED on one half plus NOT-yet on the
    // other is open work. Drive that, on text this test owns.
    const md = '- BUG-390 - catalog truth. **COUNTER FIXED 2026-08-27 (147 -> 179, verified);\n'
      + '  the README catalog table and pie are NOT yet generated.**\n';
    assert.equal(stateOf(md), 'open',
      'a bullet stating one half FIXED and the other NOT yet is still open work');
    // And the adjacent case that must keep passing, or the guard has no bounds:
    // the same bullet with no qualifier is closed, not open.
    const done = '- BUG-390 - catalog truth. **COUNTER FIXED 2026-08-27 (147 -> 179, verified).**\n';
    assert.notEqual(stateOf(done), 'open');
  });

  it('BUG-273 does not inherit a status from the bullets nested inside it', () => {
    // RE-SCOPED 2026-08-28. This asserted `states.get(273) !== 'verified'`, which
    // was an OUTCOME standing in for a MECHANISM: it read as a pass only while
    // BUG-273 happened to be open. An audit read then fixed BUG-273 and gave it a
    // real `**Status:**` line, and this guard went red against a CORRECT register
    // — the same erosion this repo has recorded before, where fixing the thing a
    // guard was scoped to shrinks it below its own floor.
    //
    // What it is actually for is the id check: a bullet about BUG-345 nested
    // inside BUG-273's body must not classify BUG-273. So drive THAT — strip
    // BUG-273's own Status line and confirm the nested bullets alone do not make
    // it verified.
    // RE-SCOPED AGAIN 2026-08-28 by BUG-393, and this time for a sharper reason
    // than erosion: the previous version was MEASURING THE WRONG ARTIFACT.
    //
    // It stripped BUG-273's Status line and classified the remainder — but
    // BUG-273 is the LAST `## BUG-` heading in BUGS.md, and parseBugs ends the
    // final entry at `text.length` (build-index.js :79). So its "body" swallows
    // the whole OPEN WORK register that follows it, and the markers this
    // assertion read belonged to BUG-352's bullet, not to BUG-273. It passed only
    // because that bullet said "FIXED ... NOT yet"; correcting BUG-352's text
    // turned it red while BUG-273 itself never changed. The swallowing is real and
    // filed as BUG-394 with the measurement (18 entries, 4 state changes).
    //
    // Driven on owned text instead, so it tests the id check and nothing else.
    assert.ok(bugs.find((b) => b.n === 273), 'BUG-273 must still parse');
    const nested = HEAD + '**Symptom.** The audit listed its follow-ups as bullets.\n\n'
      + '- BUG-345 - adblock silence caveat. FIXED 639200c: append a spoken caveat.\n'
      + '- BUG-346 - wake-word re-arm ladder. FIXED 2026-08-28, mutation-proven.\n';
    assert.notEqual(stateOfN(nested, 390), 'verified',
      'a parent must not read verified off bullets that name other tickets');
    // Positive control, or the assertion above passes for any input at all.
    const own = HEAD + '**Symptom.** It broke.\n\n'
      + '- BUG-390 - this very ticket. FIXED 639200c, mutation-proven.\n';
    assert.equal(stateOfN(own, 390), 'verified',
      'a bullet naming its OWN number must still be read');
  });

  it('the unrecorded count keeps falling and does not regress', () => {
    const unrec = [...states.values()].filter((s) => s === 'unrecorded').length;
    // 133 before BUG-389, 36 after it, 28 after BUG-390. A bound, not the number,
    // so filing a ticket does not fail the suite.
    assert.ok(unrec <= 45,
      `${unrec} unrecorded; BUG-389 and BUG-390 brought 133 down to 28, so a jump `
      + 'past 45 means one of the convention readers stopped working');
  });
});
