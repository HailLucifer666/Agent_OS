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

// WHAT COUNTS AS DECLARING A BUG.
//
// A heading declares. A top-level list entry declares ONLY if that number has no
// heading — because this file's normal convention is a full `## BUG-NNN` entry
// PLUS a one-line pointer to it in the open-bug list, and counting both made a
// perfectly ordinary bug look like a collision.
//
// Caught the hour this script landed, by merging main: BUG-353 arrived with a
// heading and a list line reading "FIXED 2026-08-27 (full entry above)", and the
// gate called it a collision. Main itself would have failed the check. Treating
// the second mention as a pointer rather than a declaration fixes the class, and
// it also retired two adjudications (BUG-083, BUG-084) that existed only to
// suppress this same shape — structure doing the work a hand-written exception
// list was doing before.
const HEADING_DECLARATION_RE = /^#{1,6} BUG-(\d+)\b/gm;
const LIST_DECLARATION_RE = /^- BUG-(\d+)\b/gm;
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
      + 'used to exercise the triage parser. Never allocated to a defect. The other files in the '
      + 'list are this script and two of its tests, which cite the number to explain the '
      + 'exclusion rather than to claim it.',
    // The file list is narrow ON PURPOSE, and it caught its own author: staging
    // this script and its test made 999 appear in two new files, the condition
    // went stale, and the gate blocked the commit that introduced it — next-free
    // jumped to 1000, which is precisely the failure being prevented. A NEW file
    // mentioning BUG-999 should break this, because outside these three the most
    // likely explanation is that somebody has started using the number for real.
    // Grew to four on 2026-08-27, and the mechanism worked exactly as the
    // comment above promises. BUG-373's test cites BUG-999 to explain that
    // markdown was the FIRST instance of the prose-is-not-allocation class;
    // that file is a .js, so it counts as code by design (BUG-164 and BUG-364
    // are real defects whose only trace is a test file, which is why test/ is
    // not excluded). The gate fired, a human read it, and the adjudication is
    // widened deliberately rather than the mention being reworded to slip past
    // a scanner that is correctly designed to see it.
    stillApplies: (ctx) => ctx.onlyIn(999, [
      'mythos/test/triage-incidents.test.js',
      'mythos/scripts/lint-bug-registry.js',
      'mythos/test/lint-bug-registry.test.js',
      'mythos/test/bug-373-commit-prose-is-not-allocation.test.js',
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
  // BUG-083 and BUG-084 were adjudicated here until 2026-08-27 and have been
  // REMOVED rather than kept. Both were "one heading plus one list line
  // referring to the fix", which the declaration rule above now handles
  // structurally. An adjudication whose condition the code no longer produces is
  // dead suppression, and this script's own gate treats it as an error — so
  // deleting them is the behaviour it demands of everyone else.
];

/**
 * Numbers used in a commit message or in tracked source with no BUGS.md entry.
 * There are a lot of these and they are a real backlog, not a build break — so
 * this is a RATCHET rather than a gate at zero: the set may shrink, never grow.
 * Lower it whenever you write entries; the test fails if it drifts far above
 * reality, because a baseline that no longer bites is decoration.
 */
const UNDECLARED_BASELINE = 130;

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

  const headings = new Map();
  for (const m of bugsText.matchAll(HEADING_DECLARATION_RE)) {
    const n = Number(m[1]);
    headings.set(n, (headings.get(n) || 0) + 1);
  }
  const declaredTimes = new Map(headings);
  for (const m of bugsText.matchAll(LIST_DECLARATION_RE)) {
    const n = Number(m[1]);
    if (headings.has(n)) continue; // a pointer to the full entry, not a second declaration
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

  // DOCUMENTATION IS NOT ALLOCATION. A markdown file that discusses BUG-999 —
  // a plan, a roadmap, a design note — is talking ABOUT the number, not
  // claiming it. Conflating the two cost two false failures within an hour:
  // appending a closure-campaign section that explained the BUG-999 fixture
  // made the fixture's own adjudication go stale, so 999 became a live number,
  // the maximum jumped to 999 and the undeclared ratchet ticked to 137. The
  // gate blocked a commit whose only sin was explaining the gate.
  //
  // Code, config and commit messages are where a number gets USED. Markdown is
  // where it gets discussed. Note the asymmetry, which is deliberate: markdown
  // still counts toward the MAXIMUM, because over-reporting the maximum can
  // only make the next free number larger, and that is the safe direction.
  const isDoc = (file) => /\.mdx?$/i.test(file);
  const codeFilesFor = (n) => [...(src.inSource.get(n) || [])]
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !isDoc(f));

  const ctx = {
    declaredTimes: (n) => src.declaredTimes.get(n) || 0,
    onlyIn: (n, files) => {
      const where = codeFilesFor(n);
      if (where.length === 0) return false;
      return where.every((f) => files.includes(f));
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
  // Code and commits only, for the same reason as the adjudication check above:
  // writing a paragraph that mentions an unfiled bug does not add to the
  // backlog, and a gate that blocks a documentation commit for doing so trains
  // people to stop writing documentation.
  // BUG-373: CODE ONLY. A commit message is prose, and prose is not allocation
  // — the same rule `isDoc` already applies to markdown, which this failed to
  // apply to the other kind of documentation the scan reads.
  //
  // It bit on 2026-08-27. Two sessions were handed BUG-371 by --next inside one
  // minute; the second renumbered to 372 by amending, its body still read
  // "(BUG-371)", and 371 became in-use-and-undeclared in that tree. The ratchet
  // went 136 -> 137 and blocked EVERY commit from that checkout, not only ones
  // citing a number. Worse, `git commit --amend` runs the hook while HEAD is
  // still the OLD commit, so the amend removing the citation was blocked by the
  // citation it was removing: a gate that reads HEAD cannot be satisfied by
  // rewriting HEAD.
  //
  // Measured cost before the change, not estimated: 130 undeclared numbers
  // appear in code and exactly 6 appear only in commit messages. The objection
  // — "~20 legacy bugs live only in commit messages and this is the only thing
  // pointing at them" — was false; of the BUG-323..342 block that argument
  // named, zero are commit-only. Those six are reported by name below, which is
  // more actionable than the aggregate that hid them.
  const undeclared = [...src.inSource.keys()]
    .filter((n) => codeFilesFor(n).length > 0)
    .filter((n) => !notABug.has(n))
    .filter((n) => ctx.declaredTimes(n) === 0)
    .sort((a, b) => a - b);

  // Reported, never gated. HEAD-scoped like the ratchet so two people at the
  // same commit see the same list regardless of what they have fetched.
  const undeclaredInCommits = [...src.inCommitsHead.keys()]
    .filter((n) => !notABug.has(n))
    .filter((n) => ctx.declaredTimes(n) === 0)
    .filter((n) => !undeclared.includes(n))
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
    undeclaredInCommits,
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

  // BUG-373. The numbers the ratchet deliberately stopped counting, NAMED
  // rather than tallied. The objection to removing them from the gate was that
  // the ratchet was the only thing pointing at them — it pointed at them as an
  // aggregate nobody could act on, which is why they are all still undeclared.
  // A list you can work through is a better instrument than a count that blocks
  // an unrelated commit.
  if (process.argv.includes('--undeclared-in-commits')) {
    const list = report.undeclaredInCommits;
    if (!list.length) {
      console.log('lint-bug-registry: no bug number appears only in a commit message. '
        + 'Every number cited on HEAD is either declared in BUGS.md or used in code.');
      process.exit(0);
    }
    console.log(`lint-bug-registry: ${list.length} number(s) appear ONLY in commit messages on `
      + 'HEAD — no BUGS.md entry, and nothing in the source cites them. Not gated: prose is not '
      + 'allocation. Listed so they can be written up or retired deliberately.');
    for (const n of list) console.log(`  BUG-${n}`);
    process.exit(0);
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

  if (report.undeclaredInCommits.length) {
    // One line in the normal report, so the set cannot grow unnoticed the way
    // it did while it was buried inside an aggregate. Never an exit code.
    console.log(`\n${report.undeclaredInCommits.length} number(s) cited only in commit messages, `
      + 'never gated (prose is not allocation — BUG-373). '
      + 'List them: --undeclared-in-commits');
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
