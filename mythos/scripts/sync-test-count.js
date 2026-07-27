#!/usr/bin/env node
'use strict';

/**
 * sync-test-count.js — single source of truth for "how many tests pass right now."
 *
 * README.md, ROADMAP.md and CLAUDE.md have each independently drifted to a
 * different stale test count (README alone disagreed with itself: 402 in the
 * prose, 568 in the badge). This script runs the real suite once and keeps a
 * fixed set of "current total" mentions honest — it never touches the
 * historical per-phase tables (those are journal entries, not live counts).
 *
 * Usage:
 *   node scripts/sync-test-count.js --check   # exit 1 if any tracked number is stale
 *   node scripts/sync-test-count.js --write   # rewrite tracked files to match the real run
 *
 * Both modes accept the suite's TAP output on stdin (so a caller that already
 * ran the suite for its own pass/fail gate doesn't have to run it twice —
 * see .githooks/pre-commit and .github/workflows/ci.yml). With no piped
 * input (a TTY, or empty stdin) it runs the suite itself.
 *
 * Zero dependencies — node:child_process, node:fs, node:path only.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MYTHOS_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(MYTHOS_ROOT, '..');
const ROADMAP_FILE = path.join(REPO_ROOT, 'ROADMAP.md');

function runSuite() {
  const testDir = path.join(MYTHOS_ROOT, 'test');
  const files = fs.readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('test', f));

  console.log(`sync-test-count: running ${files.length} test files (this takes ~60-90s)...`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files],
    { cwd: MYTHOS_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function getSuiteOutput() {
  if (!process.stdin.isTTY) {
    const piped = readStdin();
    if (piped.trim()) return piped;
  }
  return runSuite();
}

function parseCounts(out) {
  const field = (name) => {
    const m = out.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    if (!m) {
      throw new Error(
        `sync-test-count: couldn't find "# ${name} N" in suite output — ` +
        `did the reporter change? (expected --test-reporter=tap TAP summary lines)`,
      );
    }
    return parseInt(m[1], 10);
  };
  return {
    tests: field('tests'),
    pass: field('pass'),
    fail: field('fail'),
    skipped: field('skipped'),
  };
}

// Each slot is anchored on stable surrounding text (not a line number) so it
// survives unrelated edits to the same file. Historical per-phase tables
// (README's Build History table, ROADMAP's Commit Log) are deliberately not
// slots here — rewriting them would falsify what a past phase actually shipped.
function readmeSlots(counts) {
  const file = path.join(REPO_ROOT, 'README.md');
  return [
    { file, pattern: /(immune system, and )(\d+)( tests\.)/, value: counts.tests },
    { file, pattern: /(tests-)(\d+)(%20pass-)/, value: counts.pass },
    { file, pattern: /(Linear history on `main`\. )(\d+)( tests green\.)/, value: counts.tests },
    { file, pattern: /(\*\*Tests\*\* \| Built-in `node:test` \| )(\d+)( tests, zero test framework deps \|)/, value: counts.tests },
    { file, pattern: /(package\.json\s+# 4 deps, )(\d+)( tests)/, value: counts.tests },
    { file, pattern: /(test\/\s+# )(\d+)( tests \(node --test\))/, value: counts.tests },
  ];
}

function applySlots(counts, mode, report) {
  let staleCount = 0;
  const byFile = new Map();
  for (const slot of readmeSlots(counts)) {
    const content = byFile.get(slot.file) ?? fs.readFileSync(slot.file, 'utf8');
    const m = content.match(slot.pattern);
    if (!m) {
      report.push(`MISSING PATTERN in ${path.relative(REPO_ROOT, slot.file)}: ${slot.pattern}`);
      staleCount++;
      continue;
    }
    const current = parseInt(m[2], 10);
    if (current === slot.value) {
      byFile.set(slot.file, content);
      continue;
    }
    staleCount++;
    report.push(`${path.relative(REPO_ROOT, slot.file)}: found ${current}, expected ${slot.value}`);
    const next = mode === 'write' ? content.replace(slot.pattern, `$1${slot.value}$3`) : content;
    byFile.set(slot.file, next);
    if (mode === 'write') report.push('  -> written');
  }
  if (mode === 'write') {
    for (const [file, content] of byFile) fs.writeFileSync(file, content, 'utf8');
  }
  return staleCount;
}

const ROADMAP_ANCHOR = '## Keeping this file current';
const ROADMAP_BLOCK_RE = /<!-- SYNC:TEST-COUNT:START -->\n\*\*Current test-suite state\*\* \(auto-synced by `mythos\/scripts\/sync-test-count\.js`, last run \d{4}-\d{2}-\d{2}\): \*\*(\d+) tests, (\d+) passing, (\d+) failing, (\d+) skipped\.\*\*\n<!-- SYNC:TEST-COUNT:END -->/;

function roadmapBlock(counts, date) {
  return `<!-- SYNC:TEST-COUNT:START -->\n**Current test-suite state** (auto-synced by \`mythos/scripts/sync-test-count.js\`, last run ${date}): **${counts.tests} tests, ${counts.pass} passing, ${counts.fail} failing, ${counts.skipped} skipped.**\n<!-- SYNC:TEST-COUNT:END -->`;
}

function syncRoadmap(counts, mode, report) {
  const content = fs.readFileSync(ROADMAP_FILE, 'utf8');
  const m = content.match(ROADMAP_BLOCK_RE);
  const today = new Date().toISOString().slice(0, 10);

  if (!m) {
    report.push('ROADMAP.md: sync block missing');
    if (mode === 'write') {
      const idx = content.indexOf(ROADMAP_ANCHOR);
      if (idx === -1) throw new Error(`sync-test-count: ROADMAP.md anchor "${ROADMAP_ANCHOR}" not found, refusing to guess where to insert`);
      const block = `${roadmapBlock(counts, today)}\n\n---\n\n`;
      fs.writeFileSync(ROADMAP_FILE, content.slice(0, idx) + block + content.slice(idx), 'utf8');
      report.push('  -> inserted');
    }
    return true;
  }

  const [, tests, pass, fail, skipped] = m;
  const matches = +tests === counts.tests && +pass === counts.pass && +fail === counts.fail && +skipped === counts.skipped;
  if (matches) return false;

  report.push(`ROADMAP.md: sync block stale (found ${tests}/${pass}/${fail}/${skipped}, expected ${counts.tests}/${counts.pass}/${counts.fail}/${counts.skipped})`);
  if (mode === 'write') {
    fs.writeFileSync(ROADMAP_FILE, content.replace(ROADMAP_BLOCK_RE, roadmapBlock(counts, today)), 'utf8');
    report.push('  -> written');
  }
  return true;
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null;
  if (!mode) {
    console.error('Usage: node scripts/sync-test-count.js --check | --write');
    process.exit(2);
    return;
  }

  const counts = parseCounts(getSuiteOutput());
  console.log(`sync-test-count: tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}`);
  if (counts.fail > 0) {
    console.warn(
      `sync-test-count: ${counts.fail} test(s) currently failing. This script only keeps ` +
      'documented counts honest — it does not gate on failures (see .githooks/pre-commit / ci.yml for that).',
    );
  }

  const report = [];
  let staleCount = applySlots(counts, mode, report);
  if (syncRoadmap(counts, mode, report)) staleCount++;

  if (report.length) console.log(report.join('\n'));

  if (mode === 'check') {
    if (staleCount > 0) {
      console.error(`sync-test-count --check: ${staleCount} stale number(s). Run 'node scripts/sync-test-count.js --write' and commit the result.`);
      process.exit(1);
    }
    console.log('sync-test-count --check: all tracked numbers match the real suite. OK.');
    return;
  }

  console.log(staleCount > 0 ? `sync-test-count --write: updated ${staleCount} number(s).` : 'sync-test-count --write: already in sync, nothing to do.');
}

main();
