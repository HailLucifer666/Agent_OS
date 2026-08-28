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

  it('BUG-352 is open — half of it is explicitly not done', () => {
    assert.equal(states.get(352), 'open');
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
    const bug = bugs.find((b) => b.n === 273);
    assert.ok(bug, 'BUG-273 must still parse');
    assert.match(bug.body, /\*\*Status:\*\*/, 'and it must still carry its own Status line');
    const withoutStatus = Object.assign({}, bug, {
      body: bug.body.split(/\r?\n/).filter((l) => !/\*\*Status:\*\*/.test(l)).join('\n'),
    });
    assert.notEqual(classify(withoutStatus, openSet), 'verified',
      'BUG-273 read verified off BUG-345\'s bullet before the id check');
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
