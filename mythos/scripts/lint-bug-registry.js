#!/usr/bin/env node
'use strict';

/**
 * lint-bug-registry.js — keep BUG numbering honest.
 *
 * WHY THIS EXISTS
 *
 * Two numbers in this repo carry two unrelated defects each. BUG-280 is both a
 * stale-search answer and a close_window failure; BUG-360 is both an SPA
 * dot-path 404 and adb resolution. Neither was caught — both were absorbed into
 * prose, as "(second half)" and "(a)/(b)" headings, which is what a registry
 * with no gate looks like from the inside. The standing instruction to re-grep
 * the maximum before assigning a number is a rule that depends on a human
 * remembering it, which is the class of rule this repo has already learned to
 * replace with a check.
 *
 * WHAT IT REFUSES TO DO
 *
 * It does not classify. Two attempts at a clever heuristic were measured and
 * both were wrong, so the script reports facts and defers judgement to
 * adjudications recorded here in the file, each with a reason:
 *
 *   (1) "the max is the largest BUG-NNN anywhere" gives 1000 as the next free
 *       number, because `## BUG-999` appears inside a fake BUGS.md string in
 *       triage-incidents.test.js. That abandons 632 numbers to a fixture.
 *
 *   (2) The obvious repair for (1) — "ignore numbers that only appear under
 *       test/" — is WORSE than the bug. BUG-164 and BUG-364 also appear only
 *       under test/, and they are real defects whose sole record is their
 *       regression test. That is the healthy case, not the broken one. The
 *       shortcut would hide two real bugs to hide one fake one, and hand out
 *       numbers that are already taken.
 *
 *   (3) "one number, two different commit subjects" reports BUG-323 and
 *       BUG-324 as collisions. They share two commits because one commit fixed
 *       both. Co-authorship is not collision.
 *
 * So: exclusions are explicit, they carry reasons, and an exclusion whose
 * condition no longer holds is itself an error — a suppression nobody is
 * watching is how a real collision gets silenced later.
 *
 * Usage:
 *   node scripts/lint-bug-registry.js            # report + exit code
 *   node scripts/lint-bug-registry.js --json     # machine-readable
 *   node scripts/lint-bug-registry.js --next     # print the next free number only
 *
 * Remote branches carry numbers too (BUG-365/366 lived only on branches before
 * they merged), so this reads `git log --all`. It does NOT fetch: a linter that
 * reaches the network is a linter that fails on a plane. Run `git fetch` first
 * if you are about to claim a number; --next says so.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUGS_FILE = path.join(REPO_ROOT, 'BUGS.md');

// A bug is DECLARED by a heading or a top-level list entry in BUGS.md. Any
// other appearance of BUG-NNN in that file is a cross-reference.
const DECLARATION_RE = /^(?:#{1,6} |- )BUG-(\d+)\b/gm;
const ANY_REF_RE = /BUG-(\d+)/g;

/**
 * Numbers that look wrong to the checks above and are not. Each entry states
 * the condition that makes it benign; `stillApplies` re-tests that condition on
 * every run, so an adjudication cannot outlive its reason.
 */
const ADJUDICATIONS = [
  // The two REAL collisions. They are adjudicated rather than gated on, and the
  // reason is not convenience: the commits and source files that cite BUG-280
  // and BUG-360 cannot be rewritten, so renumbering the second defect in
  // BUGS.md would leave the registry disagreeing with the history that
  // references it. That is a worse state than a recorded collision, and it is
  // the same rule as "applied migrations are immutable — fix forward".
  //
  // They stay loud in the report, and `stillApplies` pins the count at exactly
  // two: a THIRD defect filed under either number fails the gate.
  {
    number: 280,
    kind: 'known-collision',
    reason: 'REAL collision, recorded not repaired. Carries a stale-search-answer defect AND a '
      + 'close_window defect, papered over as a "(second half)" heading. Both resolved '
      + '2026-08-20/21. Renumbering would desync BUGS.md from commit 5d6ff99 and the source '
      + 'that cite 280.',
    stillApplies: (ctx) => ctx.declaredTimes(280) === 2,
  },
  {
    number: 360,
    kind: 'known-collision',
    reason: 'REAL collision, recorded not repaired. Carries an SPA dot-path 404 AND adb '
      + 'resolution, papered over as "(a)" and "(b)" headings. Renumbering would desync '
      + 'BUGS.md from branch fix/bug-360-adb-resolution and the commits citing 360.',
    stillApplies: (ctx) => ctx.declaredTimes(360) === 2,
  },
  {
    number: 999,
    kind: 'not-a-bug',
    reason: 'fake `## BUG-999` heading inside a fixture string in test/triage-incidents.test.js, '
      + 'used to exercise the triage parser. Never allocated to a defect. The other two files '
      + 'are this script and its test, which cite the number to explain the exclusion.',
    // The file list is narrow ON PURPOSE, and it caught its own author: staging
    // this script and its test made 999 appear in two new files, the condition
    // went stale, and the gate blocked the commit that introduced it — next-free
    // jumped to 1000, which is precisely the failure being prevented. A NEW file
    // mentioning BUG-999 should break this, because outside these three the most
    // likely explanation is that somebody has started using the number for real.
    stillApplies: (ctx) => ctx.onlyIn(999, [
      'mythos/test/triage-incidents.test.js',
      'mythos/scripts/lint-bug-registry.js',
      'mythos/test/lint-bug-registry.test.js',
    ]),
  },
  {
    number: 214,
    kind: 'not-a-collision',
    reason: 'two entries for ONE defect: the reminder/timer parsing bug, plus a later '
      + '"deferred fixture — closed as genuinely absent" note about the same ticket.',
    stillApplies: (ctx) => ctx.declaredTimes(214) === 2,
  },
  {
    number: 6,
    kind: 'not-a-collision',
    reason: 'two entries for ONE defect: the YouTube embed failure, plus a historical '
      + 'pre-2026-07-22 investigation entry explicitly kept for context.',
    stillApplies: (ctx) => ctx.declaredTimes(6) === 2,
  },
  {
    number: 83,
    kind: 'not-a-collision',
    reason: 'one heading plus one later prose bullet that REFERS to the fix ("BUG-083 routed '
      + "MYTHOS's own edge-tts speech through sendText()\"). A reference in a narrative "
      + 'section, not a second declaration.',
    stillApplies: (ctx) => ctx.declaredTimes(83) === 2,
  },
  {
    number: 84,
    kind: 'not-a-collision',
    reason: 'one heading plus one later prose bullet referring to the fix (pcm-player.js '
      + 'TAIL_GUARD_SEC). Same shape as BUG-083.',
    stillApplies: (ctx) => ctx.declaredTimes(84) === 2,
  },
];

/**
 * Numbers used in a commit message or in tracked source with no BUGS.md entry.
 * There are a lot of these and they are a real backlog, not a build break — so
 * this is a RATCHET rather than a gate at zero: the set may shrink, never grow.
 * Lower it whenever you write entries; the test fails if it drifts far above
 * reality, because a baseline that no longer bites is decoration.
 */
const UNDECLARED_BASELINE = 136;

function git(...args) {
  // The pre-commit hook exports GIT_DIR/GIT_INDEX_FILE, which would silently
  // point these reads at the wrong repository state. Strip the git environment
  // and address the worktree explicitly.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
}

// `runGit` is injectable for ONE reason, found by mutation: with the sources
// injected wholesale, `inCommitsHead = scan('--all')` broke no test. The
// injected test proved buildReport reads the right FIELD; nothing proved this
// function fills that field from the right SCOPE. A single complete function is
// safe to swap here — unlike a half-populated object of sources, which would
// silently fall back to real collection field by field.
function collectSources({ runGit = git } = {}) {
  const bugsText = fs.readFileSync(BUGS_FILE, 'utf8');

  const declaredTimes = new Map();
  for (const m of bugsText.matchAll(DECLARATION_RE)) {
    const n = Number(m[1]);
    declaredTimes.set(n, (declaredTimes.get(n) || 0) + 1);
  }

  const mentionedInBugs = new Set();
  for (const m of bugsText.matchAll(ANY_REF_RE)) mentionedInBugs.add(Number(m[1]));

  // TWO SCOPES, DELIBERATELY, because the two questions want opposite properties.
  //
  // The MAXIMUM must never under-report: handing out a number another branch
  // already took is the failure this script exists to prevent, and BUG-365/366
  // lived only on branches before they merged. So it reads every ref. Reading
  // too many refs can only make the next-free number larger, which is safe.
  //
  // The RATCHET must be reproducible: it gates commits, and a gate whose answer
  // depends on which remote branches this particular machine happens to have
  // fetched is a gate that fails for one person and passes for another, gets
  // called flaky, and gets switched off. So it reads HEAD's history only —
  // the same answer on every machine at the same commit.
  //
  // On this checkout today both scopes return 285, because every branch here is
  // already merged. That is a coincidence of the moment, not a reason to
  // collapse them.
  const scan = (scope) => {
    const found = new Map();
    const log = runGit('log', scope, '--format=%H%x00%s%x00%b%x01');
    for (const rec of log.split('\x01')) {
      const [sha, subject, body] = rec.split('\x00');
      if (!sha || !sha.trim()) continue;
      for (const m of `${subject}\n${body || ''}`.matchAll(ANY_REF_RE)) {
        const n = Number(m[1]);
        if (!found.has(n)) found.set(n, new Set());
        found.get(n).add(sha.trim().slice(0, 8));
      }
    }
    return found;
  };
  const inCommits = scan('--all');
  const inCommitsHead = scan('HEAD');

  const inSource = new Map();
  for (const file of runGit('ls-files').split(/\r?\n/).filter(Boolean)) {
    if (file === 'BUGS.md') continue;
    let text;
    try { text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(ANY_REF_RE)) {
      const n = Number(m[1]);
      if (!inSource.has(n)) inSource.set(n, new Set());
      inSource.get(n).add(file);
    }
  }

  return { declaredTimes, mentionedInBugs, inCommits, inCommitsHead, inSource };
}

// `sources` is injectable so the two-scope invariant can actually be tested. On
// this checkout every branch is merged, so --all and HEAD return identical sets
// and a test against the real repo would pass whichever scope the code used —
// the shape of an inert guard. The injected case supplies scopes that DIVERGE,
// which is the only way to prove max reads the union and the ratchet reads HEAD.
// Passed wholesale, never merged with the real thing: a half-populated fake that
// falls back per-field silently turns real collection back on mid-test.
function buildReport(sources) {
  const src = sources || collectSources();

  const ctx = {
    declaredTimes: (n) => src.declaredTimes.get(n) || 0,
    onlyIn: (n, files) => {
      const where = src.inSource.get(n);
      if (!where || where.size === 0) return false;
      const normalized = [...where].map((f) => f.replace(/\\/g, '/'));
      return normalized.every((f) => files.includes(f));
    },
  };

  const suppressed = new Map();
  const staleAdjudications = [];
  for (const a of ADJUDICATIONS) {
    if (a.stillApplies(ctx)) suppressed.set(a.number, a);
    else staleAdjudications.push(a);
  }

  const notABug = new Set(
    [...suppressed.values()].filter((a) => a.kind === 'not-a-bug').map((a) => a.number),
  );

  const all = new Set([
    ...src.declaredTimes.keys(),
    ...src.inCommits.keys(),
    ...src.inSource.keys(),
  ]);
  const inUse = [...all].filter((n) => !notABug.has(n)).sort((a, b) => a - b);
  const max = inUse.length ? inUse[inUse.length - 1] : 0;

  const duplicates = [...src.declaredTimes.entries()]
    .filter(([n, count]) => count > 1 && !suppressed.has(n))
    .map(([n]) => n)
    .sort((a, b) => a - b);

  // "Undeclared" means: used somewhere real, but BUGS.md has no entry for it —
  // not even a cross-reference. A number mentioned only in passing still has no
  // ticket, so mentions do not count as declarations here.
  //
  // HEAD-scoped on purpose (see the two-scope note in collectSources): this is
  // the number the gate compares against a committed baseline, so it has to be
  // the same on every machine at the same commit.
  const undeclared = [...new Set([...src.inCommitsHead.keys(), ...src.inSource.keys()])]
    .filter((n) => !notABug.has(n))
    .filter((n) => ctx.declaredTimes(n) === 0)
    .sort((a, b) => a - b);

  const gaps = [];
  for (let i = 1; i < max; i++) if (!all.has(i)) gaps.push(i);

  const knownCollisions = [...suppressed.values()]
    .filter((a) => a.kind === 'known-collision')
    .map((a) => a.number)
    .sort((a, b) => a - b);

  return {
    max,
    nextFree: max + 1,
    inUse,
    duplicates,
    knownCollisions,
    undeclared,
    gaps,
    adjudicated: [...suppressed.values()].map((a) => ({
      number: a.number, kind: a.kind, reason: a.reason,
    })),
    staleAdjudications: staleAdjudications.map((a) => ({ number: a.number, reason: a.reason })),
    declaredCount: src.declaredTimes.size,
  };
}

function exitCodeFor(report) {
  if (report.duplicates.length) return 1;
  if (report.staleAdjudications.length) return 1;
  if (report.undeclared.length > UNDECLARED_BASELINE) return 1;
  return 0;
}

function main() {
  const report = buildReport();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(exitCodeFor(report));
  }

  if (process.argv.includes('--next')) {
    console.log(String(report.nextFree));
    console.error('(from local refs only — run `git fetch` first if another machine may have '
      + 'claimed a number)');
    process.exit(0);
  }

  console.log(`lint-bug-registry: ${report.inUse.length} numbers in use, `
    + `${report.declaredCount} declared in BUGS.md.`);
  console.log(`lint-bug-registry: max=${report.max}  NEXT FREE=${report.nextFree}  `
    + '(local refs only — `git fetch` before claiming one)');

  for (const a of report.adjudicated) {
    console.log(`  adjudicated BUG-${a.number} (${a.kind}): ${a.reason}`);
  }

  if (report.knownCollisions.length) {
    console.log(`\nknown collisions, recorded and pinned at two declarations each: `
      + report.knownCollisions.map((n) => `BUG-${n}`).join(', '));
  }

  if (report.staleAdjudications.length) {
    console.error('\nSTALE ADJUDICATION — the condition that made these benign no longer holds. '
      + 'Delete the entry rather than leaving it to suppress something it was never about:');
    for (const a of report.staleAdjudications) console.error(`  BUG-${a.number}: ${a.reason}`);
  }

  if (report.duplicates.length) {
    console.error('\nCOLLISION — one number, two declarations in BUGS.md:');
    for (const n of report.duplicates) console.error(`  BUG-${n}`);
    console.error('Give one of them a fresh number, or adjudicate it in ADJUDICATIONS with a reason.');
  }

  console.log(`\nundeclared (used, but no BUGS.md entry): ${report.undeclared.length} `
    + `/ baseline ${UNDECLARED_BASELINE}`);
  if (report.undeclared.length > UNDECLARED_BASELINE) {
    console.error('  ABOVE BASELINE — write entries, or the backlog grows silently.');
    console.error('  ' + report.undeclared.join(', '));
  }

  process.exit(exitCodeFor(report));
}

if (require.main === module) main();

module.exports = { buildReport, collectSources, exitCodeFor, ADJUDICATIONS, UNDECLARED_BASELINE };
