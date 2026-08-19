'use strict';

// licence-audit.test.js — the guard for `scripts/audit-licences.js`.
//
// WHY A TEST AT ALL. BUG-274's standing rule: "every new guard, allowlist, threshold or
// cooldown ships with a test that fails when the guard is absent. If a mechanism cannot
// be observed failing, it is not a mechanism." The audit script IS a new allowlist
// (EXCEPTIONS), so it inherits that rule. This repo has already shipped a cooldown that
// was never called, two allowlist entries naming conditions no code emits, and a
// verifier that printed PASS on a number it could not read — an unexercised gate is the
// house failure mode, not a hypothetical one.
//
// WHAT EACH CASE PINS, and how it can be seen failing:
//
//   1. Remove an EXCEPTIONS entry and the audit must report that package. If this
//      passes with an empty map, the map is decoration.
//   2. Every EXCEPTIONS key must be named in THIRD_PARTY_NOTICES.md. Without it the map
//      is a place to silence findings while the notices file drifts — the two-places bug
//      that hit the capture-suspend allowlist three times.
//   3. An EXCEPTIONS key that is no longer in the shipped tree must be reported. A stale
//      exception reads as due diligence while protecting nothing, and leaves the notices
//      file describing an obligation the artifact does not have.
//   4. The dual-licence election rule: "MIT OR GPL-3.0-or-later" needs a recorded
//      election, "MIT OR CC0-1.0" does not. Both were wrong in the first draft — it
//      demanded sign-off on harmless choices, which is how a gate gets ignored.
//   5. The tree as it stands must be clean, so a future dependency bump that drags in
//      copyleft fails here rather than in a lawyer's email.
//
// Case 5 is the one that will fail on somebody else's commit. That is the point.
//
// Run: cd mythos && node --test test/licence-audit.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  audit, failuresOf, classifyExpression, EXCEPTIONS,
} = require('../scripts/audit-licences.js');

const NOTICES = path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md');

test('the EXCEPTIONS map is load-bearing: dropping an entry surfaces that package', () => {
  const names = Object.keys(EXCEPTIONS);
  assert.ok(names.length > 0, 'EXCEPTIONS is empty, so nothing below can be observed failing');

  for (const dropped of names) {
    const reduced = { ...EXCEPTIONS };
    delete reduced[dropped];
    const failures = failuresOf(audit({ exceptions: reduced }));
    assert.ok(
      failures.some((f) => f.name === dropped),
      `removing "${dropped}" from EXCEPTIONS produced no finding for it — the map is not being consulted`,
    );
  }
});

test('every EXCEPTIONS entry is named in THIRD_PARTY_NOTICES.md', () => {
  const notices = fs.readFileSync(NOTICES, 'utf8');
  for (const name of Object.keys(EXCEPTIONS)) {
    assert.ok(
      notices.includes(name),
      `"${name}" is excepted in the audit but never mentioned in THIRD_PARTY_NOTICES.md — the two files have drifted`,
    );
  }
});

test('a stale exception — for a package that no longer ships — is reported', () => {
  const withGhost = { ...EXCEPTIONS, 'a-package-that-does-not-ship': { licence: 'GPL-3.0', why: 'fixture' } };
  const failures = failuresOf(audit({ exceptions: withGhost }));
  assert.ok(
    failures.some((f) => f.name === 'a-package-that-does-not-ship'),
    'an exception for an absent package was accepted silently, which is the phantom-mechanism shape this gate exists to prevent',
  );
});

test('an election is required only when the alternative is not permissive', () => {
  assert.deepEqual(classifyExpression('MIT'), { verdict: 'ok' });
  assert.deepEqual(classifyExpression('(MIT OR CC0-1.0)'), { verdict: 'ok' });
  assert.deepEqual(classifyExpression('(MIT OR GPL-3.0-or-later)'), { verdict: 'elected', elect: 'MIT' });
  assert.deepEqual(classifyExpression('Apache-2.0 AND LGPL-3.0-or-later'), { verdict: 'flagged' });
  assert.deepEqual(classifyExpression('AGPL-3.0 OR SSPL-1.0'), { verdict: 'flagged' });
  assert.deepEqual(classifyExpression('UNDECLARED'), { verdict: 'flagged' });
});

test('the shipped dependency tree currently has no unrecorded licence', () => {
  const result = audit();
  const failures = failuresOf(result);
  assert.equal(
    failures.length,
    0,
    `unrecorded licences in the shipped tree:\n${failures.map((f) => `  ${f.name} (${f.licence}): ${f.reason}`).join('\n')}`,
  );
  assert.ok(result.packages.size > 100, `only ${result.packages.size} packages were examined — the lockfiles were probably not read`);
});
