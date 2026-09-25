#!/usr/bin/env node
'use strict';

/**
 * tap-verdict.js — did a `node --test --test-reporter=tap` run pass? One answer,
 * for every gate that asks (BUG-453).
 *
 * WHY
 *
 * The pre-commit hook, CI and sync-test-count.js each decided "did the suite
 * pass" by reading the `# fail N` summary line. That line counts failed LEAF
 * tests only. Measured 2026-09-23 on Node v26.1.0, four shapes of a broken run
 * print `# fail 0` while the runner itself exits 1:
 *
 *   a describe() body that throws (a require of a deleted module)
 *       not ok 1 - <suite>      type: 'suite'  failureType: 'testCodeFailure'
 *       # tests / # pass drop by however many tests the suite never defined
 *   the same, one describe deeper
 *       not ok 1 - <outer>      failureType: 'subtestsFailed'   # fail 0
 *   a before() hook that throws
 *       not ok 1 - <suite>      failureType: 'hookFailed'       # cancelled 1
 *   a test that times out
 *       not ok 1 - <test>       failureType: 'testTimeoutFailure' # cancelled 1
 *
 * The hook read only `# fail`, so it passed all four. CI also read
 * `# cancelled`, so it caught the last two and passed the first two.
 * sync-test-count --write would have recorded the smaller count as the baseline.
 *
 * THE RULE. A run is clean only when ALL of these hold:
 *   - the `# fail N` summary is present (a run that died before it is not clean)
 *   - `# fail` is 0 and `# cancelled` is 0
 *   - no top-level `not ok` line, other than a TODO test point
 *   - the runner's own exit code is 0, when the caller knows it
 *
 * The exit code is the runner's own verdict and is the strongest signal here,
 * but a TAP file piped in from disk has lost it, so the top-level `not ok` check
 * has to stand on its own too. Every failing leaf rolls up into a failing
 * top-level ancestor, so that check sees every failure the count sees, and the
 * ones it does not.
 *
 * Attacked before shipping; the answers are kept here where they will be read.
 *   What else matches `^not ok`? Only real test points. A test file's own
 *     stdout reaches the TAP stream prefixed `# `, YAML bodies are indented, and
 *     a `#` inside a test name is escaped `\#` — so column 0 is the runner's.
 *   What does it catch by mistake? A failing TODO test prints
 *     `not ok 1 - name # TODO reason` and the runner exits 0. Counting that
 *     would block good commits, so an unescaped `# TODO` directive is excluded.
 *     A name containing an escaped `\# TODO` is still counted.
 *   Which summary line? The LAST one. A child whose stdout carries its own
 *     `fail 0` reaches the stream as `# fail 0`, earlier than the runner's real
 *     summary, which is always printed last.
 *   Not covered: a test file that calls process.exit(0) before its tests
 *     finish. The runner reports that file as `ok` and exits 0; nothing in the
 *     stream says otherwise, so no reader of it can tell.
 *
 * Usage:
 *   node --test --test-reporter=tap | node scripts/tap-verdict.js --runner-exit <code>
 * Exit 0 when clean, 1 when not, 2 on a bad argument.
 *
 * Zero dependencies.
 */

const SUMMARY_FIELDS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const TOP_LEVEL_NOT_OK = /^not ok\b/;
const TODO_DIRECTIVE = /(?<!\\)#\s*TODO\b/i;

function readSummary(tap) {
  const summary = {};
  for (const name of SUMMARY_FIELDS) {
    const all = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
    summary[name] = all.length ? Number(all[all.length - 1][1]) : null;
  }
  return summary;
}

function topLevelFailures(tap) {
  return tap.split(/\r?\n/)
    .filter((line) => TOP_LEVEL_NOT_OK.test(line) && !TODO_DIRECTIVE.test(line))
    .map((line) => line.replace(/^not ok\s*\d*\s*-?\s*/, ''));
}

function readTapVerdict(tap, { runnerExit = null } = {}) {
  const summary = readSummary(String(tap || ''));
  const failures = topLevelFailures(String(tap || ''));
  const reasons = [];
  if (summary.fail === null) reasons.push('no "# fail N" summary line: the suite died before reporting');
  if (summary.fail > 0) reasons.push(`${summary.fail} failing test(s)`);
  if (summary.cancelled > 0) reasons.push(`${summary.cancelled} cancelled test(s): a timeout or a failed before() hook`);
  if (failures.length) reasons.push(`${failures.length} top-level "not ok" line(s)`);
  if (runnerExit !== null && runnerExit !== 0) reasons.push(`node --test exited ${runnerExit}`);
  const isClean = reasons.length === 0;
  // The run failed and the count says it did not. That is the state in which a
  // count derived from this run is wrong, not merely red.
  const isUncounted = !isClean && summary.fail === 0;
  return { summary, failures, runnerExit, isClean, isUncounted, reasons };
}

function parseRunnerExit(argv) {
  const at = argv.indexOf('--runner-exit');
  if (at === -1) return null;
  const raw = argv[at + 1];
  if (!/^\d+$/.test(String(raw))) {
    throw new Error(`tap-verdict: --runner-exit needs a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

const MAX_NAMED = 20;

function main() {
  let runnerExit;
  try {
    runnerExit = parseRunnerExit(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const verdict = readTapVerdict(Buffer.concat(chunks).toString('utf8'), { runnerExit });
    if (verdict.isClean) {
      const s = verdict.summary;
      console.log(`tap-verdict: clean (tests=${s.tests} pass=${s.pass} fail=0 cancelled=${s.cancelled ?? 0})`);
      return;
    }
    console.log(`tap-verdict: NOT CLEAN: ${verdict.reasons.join('; ')}`);
    for (const name of verdict.failures.slice(0, MAX_NAMED)) console.log(`tap-verdict:   not ok - ${name}`);
    if (verdict.failures.length > MAX_NAMED) {
      console.log(`tap-verdict:   ...and ${verdict.failures.length - MAX_NAMED} more`);
    }
    process.exitCode = 1;
  });
  process.stdin.resume();
}

if (require.main === module) main();

module.exports = { readTapVerdict, readSummary, topLevelFailures, parseRunnerExit };
