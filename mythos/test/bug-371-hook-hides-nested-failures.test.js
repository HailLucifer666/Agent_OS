'use strict';

// BUG-371 — the commit gate reports the failing FILE and throws away the
// failing ASSERTION, so a blocked commit teaches nothing.
//
// The gate already learned this lesson once. It used to print `tail -40` of raw
// TAP, which is the last few PASSING tests plus the summary, and cause 3 of
// precommit-hook-environment.test.js fixed that by grepping for `not ok`. The
// grep was anchored `^not ok`.
//
// That anchor is the bug. Node's TAP nests subtests under their describe block
// and INDENTS them, so `^not ok` matches only the top-level roll-up. A real red
// prints:
//
//     not ok 1264 - lint-bug-registry — the numbers it reports
//
// while the line that says what actually broke is four levels down:
//
//         not ok 1 - next-free skips the fixture, and is not 1000
//           error: |-
//             the real maximum in use
//             368 !== 367
//
// Two sessions hit this on 2026-08-27. One had to sed into the raw TAP by line
// number to recover `368 !== 367`; without it the next move is to go hunting
// for a bug in the linter instead of finding a stale constant in its test. The
// other took a single unreproducible red in a 6460-test run and could conclude
// nothing at all from it, because the assertion text was already gone.
//
// The existing cause-3 test asserts only that the hook SOURCE contains the
// string "not ok" — which is true of the broken anchor too, so it passed
// throughout. That is why this one is behavioural: it runs the hook's own
// pipeline against real nested TAP and reads what a human would have seen.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', '..', '.githooks', 'pre-commit');

// Verbatim shape of a real failure, captured 2026-08-27 from the run that
// blocked a commit on lint-bug-registry.test.js. Indentation is the whole
// point of the fixture and must not be tidied.
const NESTED_TAP = [
  '# Subtest: lint-bug-registry — the numbers it reports',
  '    # Subtest: next-free skips the fixture, and is not 1000',
  '    not ok 1 - next-free skips the fixture, and is not 1000',
  '      ---',
  '      duration_ms: 4.6664',
  // Forward slashes deliberately. The real TAP carries a Windows path, but a
  // backslash in a fixture written through a shell heredoc is eaten silently,
  // and the separator is not what this fixture is testing — the indentation is.
  "      location: 'test/lint-bug-registry.test.js:36:3'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        the real maximum in use',
  '        368 !== 367',
  "      code: 'ERR_ASSERTION'",
  '      ...',
  '    1..1',
  'not ok 1264 - lint-bug-registry — the numbers it reports',
  '  ---',
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  '  ...',
  'ok 1265 - something that passed',
  '# tests 6460',
  '# fail 1',
].join('\n');

// The hook's reporting pipeline, SLICED FROM THE HOOK and executed, not
// restated here. A copy of the command in the test is a test of the copy.
//
// The first draft grepped for a single line containing both `grep -E` and
// `not ok`, which worked only while the pipeline was one line. Fixing the
// defect made it three, the extractor silently matched nothing, and every
// assertion below would have passed vacuously had test 1 not been watching for
// exactly that. Hence the sentinels.
const START = 'REPORT-FILTER:START';
const END = 'REPORT-FILTER:END';

function reportFilter() {
  const lines = fs.readFileSync(HOOK_PATH, 'utf8').split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes(START));
  const to = lines.findIndex((l) => l.includes(END));
  if (from === -1 || to === -1 || to <= from) return null;
  return lines.slice(from + 1, to)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

// Runs the hook's line VERBATIM, plumbing included, with `out` supplied through
// the environment exactly as the shell sees it.
//
// An earlier draft stripped the `printf ... |` prefix off the front and fed the
// fixture on stdin instead. The strip silently failed to match, so every
// command ran against an empty `$out`, and three assertions went red for a
// reason that had nothing to do with the defect under test — a test failing
// green-adjacent, which is worse than a test not existing. Running the real
// line cannot drift from the hook and cannot half-work: if the prefix changes,
// the command still runs.
function runFilter() {
  const cmd = reportFilter();
  if (cmd === null) throw new Error('the hook lost its REPORT-FILTER sentinels');
  return execFileSync('sh', ['-c', cmd], {
    env: { ...process.env, out: NESTED_TAP },
    encoding: 'utf8',
  });
}

describe('BUG-371 — a blocked commit must name the assertion, not just the file', () => {
  test('the hook has a reporting pipeline to test at all', () => {
    const cmd = reportFilter();
    assert.ok(cmd !== null && /not ok/.test(cmd),
      'the hook reporting block could not be sliced between its REPORT-FILTER sentinels, or '
      + 'it no longer filters on "not ok" at all. Every assertion below would then pass '
      + 'vacuously, and a test that silently stops testing is worse than no test — this one '
      + 'caught exactly that during its own development.');
  });

  test('the failing ASSERTION survives the filter, not only the roll-up', () => {
    const out = runFilter();
    assert.match(out, /next-free skips the fixture/,
      'the nested subtest is indented, so an `^not ok` anchor drops it and the commit is '
      + 'blocked with only the describe-block name — which names the file and nothing else');
  });

  test('the top-level roll-up still survives too', () => {
    // Not a regression trade. The roll-up carries the file location in the
    // spec reporter's numbering and is what a reader scans first.
    const out = runFilter();
    assert.match(out, /lint-bug-registry — the numbers it reports/);
  });

  test('the numbers that identify the defect survive', () => {
    // `368 !== 367` is the entire diagnosis: a stale constant, not a broken
    // linter. Losing it is what sent a session hunting in the wrong file.
    const out = runFilter();
    assert.match(out, /368 !== 367/,
      'the error body is dropped, so a blocked commit shows a test name with no values — '
      + 'the reader cannot tell a stale expectation from a real regression');
  });

  test('the guard and the filter share one anchor', () => {
    // The `grep -qE` that decides whether to report at all, and the filter that
    // does the reporting, must agree. If the guard keeps a bare `^` while the
    // filter gains the indent-tolerant one, a run whose only failures are
    // nested takes the else-branch and prints "the suite died without a
    // summary" plus `tail -40` — the exact output this whole block replaced.
    // Node always emits a top-level roll-up today, so this is consistency
    // rather than a live defect; it is asserted because the next TAP shape
    // change is where that assumption quietly stops holding.
    const code = fs.readFileSync(HOOK_PATH, 'utf8')
      .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    const anchors = [...code.matchAll(/grep -q?E '(\^[^']*not ok)'/g)].map((m) => m[1]);
    assert.ok(anchors.length >= 1, 'no not-ok grep found in the hook at all');
    for (const a of anchors) {
      assert.match(a, /\[\[:space:\]\]\*/,
        `the anchor ${a} is not indent-tolerant, so it sees only the top-level roll-up`);
    }
  });

  test('the YAML plumbing does not come with it', () => {
    // The error BODY is the diagnosis; duration_ms, location and the `---`
    // fences are noise, and an unbounded dump of them is how this block came
    // to print `tail -40` in the first place. The terminator list in the awk
    // is what keeps the two apart.
    const out = runFilter();
    for (const noise of ['duration_ms', 'ERR_ASSERTION', '1..1']) {
      assert.ok(!out.includes(noise), `YAML noise leaked into the failure list: ${noise}`);
    }
  });

  test('passing lines are still excluded', () => {
    // The filter must stay a filter. `tail -40` of raw TAP was the original
    // defect precisely because it showed passing tests.
    const out = runFilter();
    assert.ok(!/something that passed/.test(out), 'a passing test leaked into the failure list');
    assert.ok(!/^# tests/m.test(out), 'the summary counts leaked into the failure list');
  });

  test('the fixture is honest: the old anchor really does drop the assertion', () => {
    // Guards the test itself. If node's TAP ever stopped indenting subtests
    // this fixture would be fiction and every assertion above would pass for
    // the wrong reason.
    const old = execFileSync('sh', ['-c', "grep -E '^not ok'"], { input: NESTED_TAP, encoding: 'utf8' });
    assert.ok(!/next-free skips the fixture/.test(old),
      'the fixture no longer reproduces the defect — nested TAP is not indented any more, '
      + 'and this whole test file needs rewriting rather than trusting');
    assert.match(old, /lint-bug-registry — the numbers it reports/);
  });
});
