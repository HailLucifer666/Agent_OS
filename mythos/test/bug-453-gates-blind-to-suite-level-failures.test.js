'use strict';

// BUG-453 — every gate that asks "did the suite pass" read `# fail N`, and
// `# fail` counts failed LEAF tests only.
//
// Measured 2026-09-23 on Node v26.1.0: a describe() body that throws while
// defining its tests (a require of a deleted module, as in
// test/bug-400-auth-gate-no-401-listener-without-a-token.test.js during the PIN
// removal) prints a top-level `not ok 1 - <suite>` with type 'suite', then
// `# fail 0`, and `# pass` equals `# tests` because the suite's own tests were
// never defined. Only the runner's exit code (1) said anything was wrong. The
// same measurement found three siblings — the same failure one describe deeper,
// a before() hook that throws, and a test that times out — all `# fail 0`.
//
// Who was blind: .githooks/pre-commit (read `# fail` only, so it passed all
// four), .github/workflows/ci.yml (also read `# cancelled`, so it passed the two
// definition-time shapes) and scripts/sync-test-count.js (would --write the
// smaller count as the new baseline).
//
// Every fixture below is trimmed from a real capture of that run. Paths are
// forward-slash and relative on purpose: the path is not what is under test,
// and a backslash in a fixture is the kind of thing that gets eaten silently.
//
// BEFORE THE FIX, run 2026-09-23: this file was 10 pass / 16 fail — every gate
// test red, the tap-verdict tests green. The unfixed `sync-test-count --check`
// fed the describe-throws run printed `tests=1 pass=1 fail=0` and "7 stale
// number(s). Run 'node scripts/sync-test-count.js --write'".
//
// MUTATION PROBES, nine, all run 2026-09-23 against the fixed tree (26/26, then
// 27/27 once the CRLF case was added for probe (i)).
// Each was applied by exact match (refused unless it matched exactly once),
// confirmed by a changed file hash, and restored from a byte copy verified
// identical afterwards:
//   (a) tap-verdict.js: the top-level `not ok` reason deleted -> 6 red: the
//       describe-throws and siblings verdicts, the escaped-TODO case, the hook
//       fed runner_exit 0, and both sync-test-count refusals. The tests that
//       also supply runner_exit 1 stay green — the exit code covers them, which
//       is why both signals are kept.
//   (b) tap-verdict.js: the TODO exclusion deleted -> 2 red: the TODO verdict
//       and "it passes a failing TODO test".
//   (c) pre-commit: `|| [ "$verdict_exit" -ne 0 ]` deleted, i.e. the hook's
//       decision exactly as it was before this fix -> all 4 hook "blocks"
//       tests red; "still passes a clean run" and "passes a failing TODO test"
//       stay green.
//   (d) ci.yml: `exit 1` in the suite gate deleted -> both CI "fails" tests red.
//   (e) sync-test-count.js: the refusal disabled -> the 2 parseCounts refusals
//       and the --check CLI refusal red.
//   (f) tap-verdict.js: summary read from the FIRST match, not the last -> the
//       stdout-injection test red.
//   (g) pre-commit: a `true` inserted between `out=` and `runner_exit=$?` ->
//       the hook source-shape test red.
//   (h) ci.yml: `$runnerExit = $LASTEXITCODE` deleted -> the CI source-shape
//       test red. (The sliced CI gate supplies $runnerExit itself, so only the
//       shape test can see this one; in real CI the empty value would make
//       tap-verdict exit 2, which fails the step closed.)
//   (i) tap-verdict.js: lines split on '\n' instead of /\r?\n/ -> the CRLF
//       test red, because the suite name then carries a trailing \r. The first
//       attempt at this probe, a sed one-liner, silently matched nothing and
//       left the test green; it was caught by diffing, and not counted.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MYTHOS_ROOT = path.join(__dirname, '..');
const HOOK_PATH = path.join(MYTHOS_ROOT, '..', '.githooks', 'pre-commit');
const CI_PATH = path.join(MYTHOS_ROOT, '..', '.github', 'workflows', 'ci.yml');
const { readTapVerdict, readSummary, parseRunnerExit } = require('../scripts/tap-verdict');
const { parseCounts } = require('../scripts/sync-test-count');

const summaryLines = ({ tests, pass, fail = 0, cancelled = 0, todo = 0 }) => [
  `# tests ${tests}`, '# suites 1', `# pass ${pass}`, `# fail ${fail}`,
  `# cancelled ${cancelled}`, '# skipped 0', `# todo ${todo}`, '# duration_ms 107.1',
];
const okFine = (n) => [`# Subtest: fine`, `ok ${n} - fine`, '  ---', "  type: 'test'", '  ...'];

const CLEAN = ['TAP version 13', ...okFine(1), '1..1', ...summaryLines({ tests: 1, pass: 1 })].join('\n');

const SUITE_THROWS = ['TAP version 13',
  '# Subtest: suite whose body throws',
  'not ok 1 - suite whose body throws',
  '  ---', "  type: 'suite'", "  location: 'test/load-fail.test.js:2:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-', "    Cannot find module './does-not-exist'",
  "  code: 'MODULE_NOT_FOUND'", '  ...',
  ...okFine(2), '1..2', ...summaryLines({ tests: 1, pass: 1 })].join('\n');

const NESTED_SUITE_THROWS = ['TAP version 13', '# Subtest: outer',
  '    ok 1 - ok', '      ---', "      type: 'test'", '      ...',
  '    not ok 2 - inner throws', '      ---', "      type: 'suite'",
  "      failureType: 'testCodeFailure'", "      error: 'inner-define'", '      ...',
  '    1..2',
  'not ok 1 - outer', '  ---', "  type: 'suite'", "  failureType: 'subtestsFailed'", '  ...',
  '1..1', ...summaryLines({ tests: 1, pass: 1 })].join('\n');

const BEFORE_HOOK_THROWS = ['TAP version 13', '# Subtest: hooked',
  '    not ok 1 - a', '      ---', "      failureType: 'cancelledByParent'", '      ...', '    1..1',
  'not ok 1 - hooked', '  ---', "  type: 'suite'", "  failureType: 'hookFailed'",
  "  error: 'before-boom'", '  ...',
  '1..1', ...summaryLines({ tests: 1, pass: 0, cancelled: 1 })].join('\n');

const TIMEOUT = ['TAP version 13', '# Subtest: slow', 'not ok 1 - slow', '  ---', "  type: 'test'",
  "  failureType: 'testTimeoutFailure'", '  ...',
  '1..1', ...summaryLines({ tests: 1, pass: 0, cancelled: 1 })].join('\n');

const LEAF_FAIL = ['TAP version 13', '# Subtest: outer',
  '    not ok 1 - fails', '      ---', "      error: 'boom'", '      ...', '    1..1',
  'not ok 1 - outer', '  ---', "  failureType: 'subtestsFailed'", '  ...',
  '1..1', ...summaryLines({ tests: 1, pass: 0, fail: 1 })].join('\n');

// Runner exits 0 on this one. A failing TODO test is not a failure.
const TODO_FAIL = ['TAP version 13', '# Subtest: todo that fails',
  'not ok 1 - todo that fails # TODO later', '  ---', "  failureType: 'testCodeFailure'", '  ...',
  ...okFine(2), '1..2', ...summaryLines({ tests: 2, pass: 1, todo: 1 })].join('\n');

function runHookGate(tap, runnerExit) {
  const lines = fs.readFileSync(HOOK_PATH, 'utf8').split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes('SUITE-GATE:START'));
  const to = lines.findIndex((l) => l.includes('SUITE-GATE:END'));
  assert.ok(from !== -1 && to > from, 'the hook lost its SUITE-GATE sentinels — nothing below would test it');
  const res = spawnSync('sh', ['-c', lines.slice(from + 1, to).join('\n')], {
    cwd: MYTHOS_ROOT,
    env: { ...process.env, out: tap, runner_exit: String(runnerExit) },
    encoding: 'utf8',
  });
  return { status: res.status, text: `${res.stdout}${res.stderr}` };
}

describe('BUG-453 — the rule every gate now shares (scripts/tap-verdict.js)', () => {
  test('a describe() that throws is not clean, and is named', () => {
    const v = readTapVerdict(SUITE_THROWS);
    assert.strictEqual(v.summary.fail, 0, 'fixture must reproduce the defect: the count says 0');
    assert.strictEqual(v.isClean, false);
    assert.strictEqual(v.isUncounted, true);
    assert.deepStrictEqual(v.failures, ['suite whose body throws']);
  });

  test('the three siblings measured with it are not clean either', () => {
    for (const [name, tap] of [['nested', NESTED_SUITE_THROWS], ['before()', BEFORE_HOOK_THROWS], ['timeout', TIMEOUT]]) {
      const v = readTapVerdict(tap);
      assert.strictEqual(v.summary.fail, 0, `${name}: fixture must say fail 0`);
      assert.strictEqual(v.isClean, false, `${name} passed as clean`);
      assert.strictEqual(v.isUncounted, true, name);
    }
  });

  test('the runner exit code alone is enough', () => {
    assert.strictEqual(readTapVerdict(CLEAN, { runnerExit: 1 }).isClean, false);
    assert.strictEqual(readTapVerdict(CLEAN, { runnerExit: 0 }).isClean, true);
  });

  test('a counted leaf failure is not clean, and is not "uncounted"', () => {
    const v = readTapVerdict(LEAF_FAIL, { runnerExit: 1 });
    assert.strictEqual(v.isClean, false);
    assert.strictEqual(v.isUncounted, false);
  });

  test('a clean run is clean', () => {
    const v = readTapVerdict(CLEAN, { runnerExit: 0 });
    assert.strictEqual(v.isClean, true, v.reasons.join('; '));
  });

  test('a failing TODO test is still clean — the runner exits 0 on it', () => {
    assert.strictEqual(readTapVerdict(TODO_FAIL, { runnerExit: 0 }).isClean, true);
  });

  test('an ESCAPED "\\# TODO" in a test name does not hide a failure', () => {
    const tap = CLEAN.replace('ok 1 - fine', 'not ok 1 - fix \\# TODO list');
    assert.strictEqual(readTapVerdict(tap).isClean, false);
  });

  test('a test file\'s own stdout cannot fake a failure or a count', () => {
    // A child's stdout reaches the stream prefixed "# ", ahead of the runner's
    // summary, which is always printed last.
    const tap = CLEAN.replace('1..1', '# not ok 9 - printed by a test\n# fail 0\n1..1')
      .replace('# fail 0\n# cancelled', '# fail 2\n# cancelled');
    assert.strictEqual(readSummary(tap).fail, 2, 'the runner\'s summary is the last one');
    assert.deepStrictEqual(readTapVerdict(tap).failures, [], 'a "# not ok" comment is not a test point');
  });

  test('CRLF TAP — what PowerShell hands a native command — reads the same', () => {
    const v = readTapVerdict(SUITE_THROWS.replace(/\n/g, '\r\n'));
    assert.strictEqual(v.summary.fail, 0);
    assert.deepStrictEqual(v.failures, ['suite whose body throws'], 'a trailing \\r must not ride into the name');
    assert.strictEqual(readTapVerdict(CLEAN.replace(/\n/g, '\r\n'), { runnerExit: 0 }).isClean, true);
  });

  test('a run that died before its summary is not clean', () => {
    assert.strictEqual(readTapVerdict('').isClean, false);
    assert.strictEqual(readTapVerdict('TAP version 13\nok 1 - a').isClean, false);
  });

  test('a malformed --runner-exit is refused, not read as "unknown"', () => {
    assert.throws(() => parseRunnerExit(['--runner-exit', '']), /non-negative integer/);
    assert.throws(() => parseRunnerExit(['--runner-exit']), /non-negative integer/);
    assert.strictEqual(parseRunnerExit([]), null);
    const res = spawnSync(process.execPath, ['scripts/tap-verdict.js', '--runner-exit', 'x'],
      { cwd: MYTHOS_ROOT, input: CLEAN, encoding: 'utf8' });
    assert.strictEqual(res.status, 2, res.stderr);
  });
});

describe('BUG-453 — the pre-commit hook blocks what the count cannot see', () => {
  test('it blocks a describe() that throws, and names the suite', () => {
    const r = runHookGate(SUITE_THROWS, 1);
    assert.strictEqual(r.status, 1, r.text);
    assert.match(r.text, /suite whose body throws/);
    assert.match(r.text, /Cannot find module/, 'the error body must survive the report filter');
    assert.match(r.text, /BLOCKED/);
  });

  test('it blocks on the top-level "not ok" even with no exit code to go on', () => {
    assert.strictEqual(runHookGate(SUITE_THROWS, 0).status, 1);
    assert.strictEqual(runHookGate(NESTED_SUITE_THROWS, 0).status, 1);
  });

  test('it blocks a timeout and a failed before() hook (# cancelled, never read before)', () => {
    assert.strictEqual(runHookGate(TIMEOUT, 1).status, 1);
    assert.strictEqual(runHookGate(BEFORE_HOOK_THROWS, 1).status, 1);
  });

  test('it blocks on the runner exit code alone', () => {
    assert.strictEqual(runHookGate(CLEAN, 1).status, 1);
  });

  test('it still passes a clean run', () => {
    const r = runHookGate(CLEAN, 0);
    assert.strictEqual(r.status, 0, r.text);
    assert.doesNotMatch(r.text, /BLOCKED/);
  });

  test('it passes a failing TODO test', () => {
    const r = runHookGate(TODO_FAIL, 0);
    assert.strictEqual(r.status, 0, r.text);
  });

  test('the exit code is read on the line straight after the suite runs', () => {
    // Any command between the two replaces $?, and the gate would then read the
    // exit code of that command instead. Comments are not commands.
    const src = fs.readFileSync(HOOK_PATH, 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /\nout=\$\(node --test --test-reporter=tap 2>&1\)\n(?:[ \t]*#[^\n]*\n)*runner_exit=\$\?\n/);
    assert.ok(src.indexOf('runner_exit=$?') < src.indexOf('SUITE-GATE:START'),
      'the sliced gate must start after runner_exit is captured, or the test supplies what the hook does not');
  });
});

function findPowerShell() {
  for (const exe of ['pwsh', 'powershell.exe']) {
    const probe = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

function runCiGate(t, tap, runnerExit) {
  const shell = findPowerShell();
  if (!shell) { t.skip('no PowerShell on this machine — the CI step runs under pwsh'); return null; }
  const lines = fs.readFileSync(CI_PATH, 'utf8').split(/\r?\n/);
  const from = lines.findIndex((l) => l.includes('SUITE-GATE:START'));
  const to = lines.findIndex((l) => l.includes('SUITE-GATE:END'));
  assert.ok(from !== -1 && to > from, 'ci.yml lost its SUITE-GATE sentinels');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-453-ci-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'run.tap'), tap);
  const script = ['$out = Get-Content -LiteralPath $env:TAP_FIXTURE', '$runnerExit = [int]$env:RUNNER_EXIT',
    ...lines.slice(from + 1, to), 'exit 0'].join('\n');
  fs.writeFileSync(path.join(dir, 'gate.ps1'), script);
  const res = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'gate.ps1')], {
    cwd: MYTHOS_ROOT,
    env: { ...process.env, TAP_FIXTURE: path.join(dir, 'run.tap'), RUNNER_EXIT: String(runnerExit) },
    encoding: 'utf8',
  });
  return { status: res.status, text: `${res.stdout}${res.stderr}` };
}

describe('BUG-453 — CI fails what the count cannot see', () => {
  test('it fails a describe() that throws, and annotates the suite name', (t) => {
    const r = runCiGate(t, SUITE_THROWS, 1);
    if (!r) return;
    assert.strictEqual(r.status, 1, r.text);
    assert.match(r.text, /::error::.*suite whose body throws/);
  });

  test('it fails on the runner exit code alone', (t) => {
    const r = runCiGate(t, CLEAN, 1);
    if (r) assert.strictEqual(r.status, 1, r.text);
  });

  test('it still passes a clean run', (t) => {
    const r = runCiGate(t, CLEAN, 0);
    if (r) assert.strictEqual(r.status, 0, r.text);
  });

  test('the exit code is captured first, and the gate runs before the count check', () => {
    const src = fs.readFileSync(CI_PATH, 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /node --test --test-reporter=tap 2>&1 \| Tee-Object -Variable out\n(?:[ \t]*#[^\n]*\n)*[ \t]*\$runnerExit = \$LASTEXITCODE\n/);
    const gate = src.indexOf('SUITE-GATE:START');
    assert.ok(gate !== -1 && gate < src.indexOf('scripts/sync-test-count.js --check'),
      'the count check exits 0 on a load-failed run whose docs match, and its exit code is the step\'s');
  });
});

describe('BUG-453 — sync-test-count refuses counts from a run whose count is wrong', () => {
  test('a describe() that throws is refused, and named', () => {
    assert.throws(() => parseCounts(SUITE_THROWS), /Refusing[\s\S]*suite whose body throws/);
  });

  test('a clean-looking run the runner failed is refused', () => {
    assert.throws(() => parseCounts(CLEAN, { runnerExit: 1 }), /Refusing/);
  });

  test('a clean run still counts', () => {
    assert.deepStrictEqual(parseCounts(CLEAN, { runnerExit: 0 }), { tests: 1, pass: 1, fail: 0, skipped: 0 });
  });

  test('a COUNTED failure still counts — this script does not gate on failures, by design', () => {
    // Pinned so the refusal cannot widen into a second commit gate: a red run
    // with an honest count is reported, as it was before, and the hook and CI
    // are what block it.
    assert.strictEqual(parseCounts(LEAF_FAIL, { runnerExit: 1 }).fail, 1);
  });

  test('--check refuses piped TAP from such a run before comparing anything', () => {
    const res = spawnSync(process.execPath, ['scripts/sync-test-count.js', '--check'],
      { cwd: MYTHOS_ROOT, input: SUITE_THROWS, encoding: 'utf8' });
    assert.notStrictEqual(res.status, 0);
    assert.match(`${res.stdout}${res.stderr}`, /Refusing[\s\S]*suite whose body throws/);
  });
});
