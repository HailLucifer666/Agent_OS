'use strict';

// Closure campaign A4 — the bug registry lints itself.
//
// BUG numbering has collided twice for real (BUG-280 carries a stale-search
// defect AND a close_window defect; BUG-360 carries an SPA dot-path defect AND
// adb resolution), and both were papered over in prose — "(second half)",
// "(a)/(b)" — rather than caught. Every session is supposed to re-grep the max
// number before assigning one, which is a rule that depends on remembering it.
//
// Two traps this linter must not fall into, both MEASURED on 2026-08-27 rather
// than assumed, and both of which a plausible implementation gets wrong:
//
//   1. The naive maximum is 999, from `## BUG-999` inside a fake BUGS.md string
//      in triage-incidents.test.js. A linter that reports next-free = 1000
//      abandons 632 numbers on a fixture.
//
//   2. The obvious fix for (1) — "ignore numbers that only appear under test/"
//      — is WORSE than the trap. BUG-164 and BUG-364 appear only under test/
//      too, and they are real defects whose only trace is their regression
//      test. That is the healthy case. Discarding them would hide two bugs to
//      hide one fixture.
//
// The resolution is that the linter never guesses: exclusions are adjudicated
// by a human, in the script, with a reason. These tests pin both the
// adjudicated case and the two that must NOT be adjudicated away.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const lint = require('../scripts/lint-bug-registry.js');

describe('lint-bug-registry — the numbers it reports', () => {
  const report = lint.buildReport();

  test('next-free skips the fixture, and is not 1000', () => {
    // Pinned to INVARIANTS, not to a snapshot. The first draft asserted
    // `max === 367` and broke the same day, on the very next bug filed — a
    // machine-state assertion wearing a correctness assertion's clothes, which
    // is the failure mode this repo files under "machine-state tests look
    // flaky". The three things that must actually hold:
    assert.ok(report.max < 999,
      `the maximum is ${report.max}; anything at or above 999 means the fake `
      + '`## BUG-999` heading in triage-incidents.test.js has become live and '
      + '632 numbers are about to be abandoned on a fixture');
    // Near-tautological and kept knowingly: the script computes `max + 1`
    // literally, so this line largely restates the implementation. It still
    // catches next-free being rewired to something else, but the floor and the
    // ceiling are the two assertions carrying real weight here.
    assert.strictEqual(report.nextFree, report.max + 1,
      'next-free is the successor of the maximum in use, never of the maximum DECLARED');
    assert.ok(!report.inUse.includes(999),
      'BUG-999 is a fake BUGS.md heading inside a test string, not a bug');
    // A ratchet, so the assertion cannot go vacuous: numbers are only ever
    // allocated, so the maximum can rise but must never fall. A drop means a
    // number in use stopped being seen — the linter going blind, which looks
    // exactly like a clean registry.
    assert.ok(report.max >= 367,
      `the maximum fell to ${report.max}; a number that was in use has stopped being counted`);
  });

  test('a bug whose only trace is its regression test still counts', () => {
    // The exact failure the "ignore test/ mentions" shortcut would cause.
    for (const n of [164, 364]) {
      assert.ok(report.inUse.includes(n),
        `BUG-${n} is a real defect recorded only in its test — excluding it would `
        + 'free a number that is already taken, which is how collisions happen');
    }
  });

  test('it finds both real collisions and pins them at two declarations each', () => {
    assert.deepStrictEqual(report.knownCollisions, [280, 360],
      'two numbers each carry two unrelated defects');
    // Recorded rather than repaired, deliberately: the commits and source citing
    // 280/360 cannot be rewritten, so renumbering in BUGS.md would leave the
    // registry disagreeing with the history that references it. They must stay
    // visible, and a THIRD defect under either number must fail the gate.
    assert.deepStrictEqual(report.duplicates, [],
      'known collisions do not block commits — only a new one does');
    for (const n of [280, 360]) {
      const a = report.adjudicated.find((x) => x.number === n);
      assert.strictEqual(a.kind, 'known-collision', `BUG-${n} must not be filed as benign`);
      assert.match(a.reason, /REAL collision/, 'the record must not soften what it is');
    }
  });

  test('it does not flag BUG-323/324, the known false positive', () => {
    // These share two commits because one commit fixed both. That is co-authorship,
    // not a collision, and a subject-based heuristic reports it as one.
    for (const n of [323, 324]) {
      assert.ok(!report.duplicates.includes(n),
        `BUG-${n} appears in two commits because one commit closed both bugs`);
    }
  });

  test('adjudicated non-collisions stay out of the failure list but stay visible', () => {
    // 214 and 006 are one defect plus a follow-up or historical entry: two real
    // headings, so only a recorded human judgement can clear them.
    for (const n of [214, 6]) {
      assert.ok(!report.duplicates.includes(n), `BUG-${n} was adjudicated as not a collision`);
      assert.ok(report.adjudicated.some((a) => a.number === n && a.reason),
        `BUG-${n} must carry a recorded reason — an unexplained suppression is how a real `
        + 'collision gets silenced later');
    }
  });

  test('a full entry plus a pointer in the open-bug list is one declaration, not two', () => {
    // This file's convention is a `## BUG-NNN` entry AND a one-line pointer to it
    // in the backlog list. Counting both made BUG-353 look like a collision the
    // hour this script landed — main itself would have failed the gate.
    for (const n of [353, 83, 84]) {
      assert.ok(!report.duplicates.includes(n),
        `BUG-${n} has a heading and a list pointer; that is the normal shape, not a collision`);
      assert.ok(!report.adjudicated.some((a) => a.number === n),
        `BUG-${n} must be handled by the declaration rule, not by a hand-written exception — `
        + 'suppressions that structure can retire should be deleted, not kept');
    }
  });

  test('the fixture adjudication is re-checked, not merely trusted', () => {
    // Found by mutation: replacing BUG-999's `stillApplies` with `() => true`
    // broke nothing, which means nothing proved the condition was ever
    // evaluated. Move the fixture to a non-test file and the suppression would
    // have quietly followed it — a real number silently freed.
    const adj = lint.ADJUDICATIONS.find((a) => a.number === 999);
    const ctxWhereFixtureMoved = {
      declaredTimes: () => 0,
      onlyIn: () => false, // 999 now appears somewhere other than that one test file
    };
    assert.strictEqual(adj.stillApplies(ctxWhereFixtureMoved), false,
      'if BUG-999 stops being confined to triage-incidents.test.js, the adjudication must go '
      + 'stale and fail the gate rather than keep suppressing the number');

    const ctxUnchanged = { declaredTimes: () => 0, onlyIn: () => true };
    assert.strictEqual(adj.stillApplies(ctxUnchanged), true);
  });

  test('discussing a number in documentation does not allocate it', () => {
    // Cost two false failures within an hour of the linter landing. Appending a
    // section to the plan document that EXPLAINED the BUG-999 fixture made the
    // fixture's adjudication go stale — 999 became a live number, the maximum
    // jumped to 999, and the ratchet ticked to 137. The gate blocked a commit
    // whose only sin was explaining the gate.
    const inDocs = ['mythos/Plans/MYTHOS-IRIS-Synthesis-Plan.md', 'BUGS.md', 'ROADMAP.md'];
    const report = lint.buildReport({
      declaredTimes: new Map(),
      mentionedInBugs: new Set(),
      inCommits: new Map(),
      inCommitsHead: new Map(),
      inSource: new Map([[999, new Set(inDocs)]]),
    });
    assert.deepStrictEqual(report.undeclared, [],
      'a number that appears only in prose is being discussed, not used');
    assert.strictEqual(report.max, 999,
      'but it still raises the MAXIMUM — over-reporting there can only make the next free '
      + 'number larger, which is the safe direction');
  });

  test('every adjudication names a reason and still applies', () => {
    for (const a of report.adjudicated) {
      assert.ok(a.reason && a.reason.length > 20, `BUG-${a.number} needs a real reason`);
    }
    // This is also the guard that caught the self-reference defect: staging the
    // linter and this file made BUG-999 appear in two files the adjudication did
    // not list, the condition went stale, and the pre-commit hook blocked the
    // commit that introduced it — reporting next-free as 1000, which is exactly
    // the failure the script exists to prevent. It only bites once these files
    // are tracked, which they now permanently are.
    assert.deepStrictEqual(report.staleAdjudications, [],
      'an adjudication whose condition no longer holds must be deleted, not left to suppress '
      + 'a future problem it was never about');
  });
});

describe('lint-bug-registry — the two git scopes do different jobs', () => {
  // Both scopes return the same 285 numbers on this checkout, because every
  // branch here is already merged. So a test against the real repo cannot tell
  // whether the code reads the right one — it would pass either way, which is
  // an inert guard wearing a green tick. These supply scopes that diverge.
  const fake = ({ head, all }) => ({
    declaredTimes: new Map(),
    mentionedInBugs: new Set(),
    inCommits: new Map(all.map((n) => [n, new Set(['deadbeef'])])),
    inCommitsHead: new Map(head.map((n) => [n, new Set(['deadbeef'])])),
    inSource: new Map(),
  });

  test('the maximum reads every ref, so a branch-only number is never handed out again', () => {
    // BUG-365/366 existed only on branches before they merged. If the maximum
    // came from HEAD, this session would have been told 401 was free.
    const report = lint.buildReport(fake({ head: [400], all: [400, 500] }));
    assert.strictEqual(report.max, 500, 'a number claimed on an unmerged branch is still claimed');
    assert.strictEqual(report.nextFree, 501);
  });

  test('collectSources actually asks git for the two different scopes', () => {
    // Also found by mutation: with sources injected wholesale, changing
    // `inCommitsHead = scan('HEAD')` to `scan('--all')` broke nothing, because
    // the injected tests never reach collectSources. Field-level proof is not
    // scope-level proof. This observes the git calls themselves.
    const asked = [];
    const runGit = (...args) => {
      if (args[0] === 'log') {
        asked.push(args[1]);
        const n = args[1] === '--all' ? 500 : 400;
        return `abc123\0fix: something (BUG-${n})\0`;
      }
      return '';
    };
    const src = lint.collectSources({ runGit });
    assert.deepStrictEqual(asked, ['--all', 'HEAD'], 'both scopes must be requested, once each');
    assert.ok(src.inCommits.has(500), 'the --all scan must land in inCommits');
    assert.ok(src.inCommitsHead.has(400), 'the HEAD scan must land in inCommitsHead');
    assert.ok(!src.inCommitsHead.has(500),
      'the HEAD map must not be filled from --all — that is the mutation that survived');
  });

  test('the ratchet reads HEAD only, so the gate cannot depend on what a machine fetched', () => {
    // The undeclared count gates commits against a committed baseline. If it
    // counted every ref, the same commit would pass for someone with fewer
    // remote branches and fail for someone with more — the reading of "flaky"
    // that gets a gate switched off.
    const report = lint.buildReport(fake({ head: [400], all: [400, 500] }));
    assert.deepStrictEqual(report.undeclared, [400],
      'the branch-only number must raise the maximum without moving the ratchet');
  });
});

describe('lint-bug-registry — the gate', () => {
  test('the undeclared ratchet holds at or below its baseline', () => {
    const report = lint.buildReport();
    assert.ok(report.undeclared.length <= lint.UNDECLARED_BASELINE,
      `${report.undeclared.length} bug numbers are used in commits or source with no BUGS.md `
      + `entry, above the recorded baseline of ${lint.UNDECLARED_BASELINE}. The backlog is `
      + 'allowed to shrink, never grow.');
  });

  test('the baseline is a ratchet, not a floor — it must track reality', () => {
    const report = lint.buildReport();
    assert.ok(lint.UNDECLARED_BASELINE - report.undeclared.length < 10,
      'the baseline has drifted more than 10 above the real count; lower it so it keeps biting');
  });

  test('a clean registry exits zero, a dirty one does not', () => {
    assert.strictEqual(lint.exitCodeFor({ duplicates: [], undeclared: [], staleAdjudications: [] }), 0);
    assert.strictEqual(lint.exitCodeFor({ duplicates: [280], undeclared: [], staleAdjudications: [] }), 1);
    assert.strictEqual(
      lint.exitCodeFor({ duplicates: [], undeclared: new Array(999).fill(1), staleAdjudications: [] }), 1,
      'an undeclared set above baseline must fail, or the ratchet is decoration',
    );
    assert.strictEqual(
      lint.exitCodeFor({ duplicates: [], undeclared: [], staleAdjudications: [{ number: 1 }] }), 1,
      'a stale adjudication must fail too — it is a suppression nobody is watching',
    );
  });
});
