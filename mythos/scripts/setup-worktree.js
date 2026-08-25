#!/usr/bin/env node
'use strict';

// setup-worktree.js — make a git worktree of this repo behave like the main
// checkout, instead of merely looking like one.
//
// WHY THIS EXISTS. Two sessions sharing one checkout share one git index, and on
// 2026-08-22 that cost real work twice in one day: an uncommitted fix was reverted
// wholesale, and a `git add`ed test file was swallowed by another session's
// index-wide commit while this session's pre-commit hook was still running its
// suite. Separate worktrees remove the shared index entirely. Root CLAUDE.md's
// concurrent-session section (BUG-037) is the longer history.
//
// THE PROBLEM THIS SCRIPT SOLVES. `git worktree add` copies TRACKED files only, and
// several things this repo needs to test itself honestly are deliberately
// gitignored. A fresh worktree therefore runs a QUIETER suite than the main
// checkout — and quieter, not redder, is the dangerous part:
//
//   * Missing node_modules fails loudly, so nobody ships past it.
//   * Missing FIXTURES do not fail at all. The licence guards call t.skip() when
//     their fixture is absent, which is the honest design — faking model state on
//     disk is the trap CLAUDE.md's wakeword rename-race entry documents. But a
//     skip is not a pass, and `sync-test-count.js --write` run in such a worktree
//     records `skipped=N` into README/ROADMAP as the repo's baseline. From then on
//     the commit gate treats silent licence guards as normal.
//
// Measured on 2026-08-22 in a fresh worktree: 6031 tests, 0 failures, 2 SKIPS —
// both licence guards, one for the vendored LGPLv3 edge-tts package and one for
// the Silero VAD weights. Both exist to prove the installer does not redistribute
// something it may not, which is live and blocking while MYTHOS is to be sold. The
// worktree looked green. It was testing less.
//
// After linking, the same worktree reported 6031/6031/0/0 — identical to the main
// checkout, which is the only acceptable result.
//
// USAGE
//   node mythos/scripts/setup-worktree.js            # link into the current worktree
//   node mythos/scripts/setup-worktree.js --check    # report what is missing, change nothing
//   node mythos/scripts/setup-worktree.js --path <p> # target a specific worktree
//
// Idempotent: an existing link is left alone, so it is safe to re-run after adding
// a new fixture. It does NOT run the suite — verifying is a separate, slow step and
// this script must stay cheap enough to run without thinking. The verification that
// matters is stated at the end of its own output.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// Gitignored paths a worktree needs in order to test what the main checkout tests.
//
// EVERY ENTRY MUST BE GITIGNORED. A tracked path does not belong here — the
// worktree already has it — and a non-ignored entry means somebody misdiagnosed a
// failure. That rule is asserted by test/worktree-setup-links.test.js rather than
// left to reviewers.
const LINKS = [
  {
    rel: 'node_modules',
    why: 'repo-root dependencies. Missing this fails loudly, but with an error that names a '
      + 'module rather than the worktree, so it is routinely misread as a broken install.',
  },
  {
    rel: 'mythos/node_modules',
    why: 'the SECOND dependency tree, and the one that gets forgotten — mythos/ has its own '
      + 'package.json and the suite runs from inside it.',
  },
  {
    rel: 'mythos/.venv',
    why: 'the Python virtualenv holding the vendored edge-tts package. Without it the LGPLv3 '
      + 'redistribution guard in electron-builder-files-allowlist.test.js SKIPS — silently, '
      + 'and that guard is part of the licensing gate that blocks release.',
  },
  {
    rel: 'mythos/ui/public/models/wakeword',
    why: 'openWakeWord ONNX weights (CC BY-NC-SA 4.0, non-commercial — see THIRD_PARTY_NOTICES). '
      + 'Fetched per machine and never committed.',
  },
  {
    rel: 'mythos/ui/public/models/silero',
    why: 'Silero VAD weights, fetched per machine by scripts/setup-silero.js. Without them the '
      + 'second redistribution guard SKIPS, for the same reason and with the same consequence.',
  },
  {
    rel: 'DeepSeek Harness',
    why: 'the build engine, installed project-local and gitignored. Absent, the engine reports '
      + 'OFFLINE — which is correct behaviour rather than a failure, so its tests pass while '
      + 'proving nothing about the engine.',
  },
  // BUG-360 (2026-08-26). Both added because the list was measured against the
  // wizard's OWN component catalogue for the first time and came up two short.
  // Note what these two have in common and how it differs from everything above:
  // their absence produces no skip and no failure ANYWHERE. The entries above are
  // here because a guard goes quiet without them; these are here because a
  // FEATURE goes quiet without them, and the suite has no opinion either way.
  {
    rel: 'Android Platform Tools',
    why: 'Google\'s platform-tools (adb), fetched per machine by scripts/setup-android.js and '
      + 'gitignored. Absent, android-child settles OFFLINE and buildCapabilitySnapshot withholds '
      + 'all 14 phone_* tools from the model — so they are reported as NOT EXISTING rather than '
      + 'as failing, which is why BUG-360 read as a missing feature for weeks. No test skips.',
  },
  {
    rel: 'mythos/models/piper',
    why: 'Piper ONNX voices, fetched per machine by scripts/setup-piper.js and gitignored. Piper '
      + 'is the LAST link of VOICE_TTS_CHAIN and the only one that speaks with no network and no '
      + 'API key, so without it a provider outage means silence rather than a degraded voice. '
      + 'Nothing fails without it either — the chain simply runs out of rungs.',
  },
];

// Secrets, which are copied rather than linked: a worktree may legitimately want
// different keys, and linking would make an edit in one place change the other
// silently. Absent files are skipped without complaint — BYO keys is the documented
// posture and features degrade honestly without them.
const COPIES = ['mythos/.env', '.env.local', 'mythos/.env.local'];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// The main checkout is where the real .git lives. --git-common-dir points at it
// from inside any worktree, and at .git itself from the main checkout, so this is
// the same question in both places rather than two code paths.
function mainCheckoutOf(worktree) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree);
  return path.dirname(common);
}

function isIgnored(repo, rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;   // exit 1 means "not ignored"; check-ignore has no other failure mode here
  }
}

// A directory link. Windows needs a junction (mklink /J) because a plain symlink
// there requires elevation or developer mode, and this script must work for someone
// who has neither. Everything else gets an ordinary symlink.
function linkDir(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (os.platform() === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore' });
  } else {
    fs.symlinkSync(target, linkPath, 'dir');
  }
}

function main(argv) {
  const check = argv.includes('--check');
  const pathIdx = argv.indexOf('--path');
  // The worktree ROOT, never the current directory. Every path in LINKS is written
  // relative to the repository root, so resolving them against cwd silently
  // produces nonsense the moment this is run from a subdirectory — and the natural
  // place to run it from is mythos/, where the suite lives. Caught by running it:
  // from mythos/ it proposed linking `mythos/node_modules` INTO mythos/, i.e.
  // mythos/mythos/node_modules, while reporting `already present: node_modules`
  // because mythos/node_modules happened to satisfy the relative check. It would
  // have created six wrong links and declared success.
  let worktree = pathIdx !== -1 && argv[pathIdx + 1] ? path.resolve(argv[pathIdx + 1]) : null;
  if (!worktree) {
    try {
      worktree = git(['rev-parse', '--path-format=absolute', '--show-toplevel'], process.cwd());
    } catch {
      console.error('setup-worktree: not inside a git repository — cd into the worktree, '
        + 'or pass --path <worktree>.');
      return 1;
    }
  }

  let mainRepo;
  try {
    mainRepo = mainCheckoutOf(worktree);
  } catch {
    console.error('setup-worktree: not inside a git repository — run this from within the worktree, '
      + 'or pass --path <worktree>.');
    return 1;
  }

  if (path.resolve(mainRepo) === path.resolve(worktree)) {
    console.error('setup-worktree: ' + worktree + ' IS the main checkout, not a worktree. '
      + 'Nothing to link — it already owns all of these. Create a worktree first:\n'
      + '  git worktree add .claude/worktrees/<name> -b <branch> HEAD\n'
      + 'and note that branching from HEAD is deliberate: the default base is origin/<default>, '
      + 'which would leave your current work behind.');
    return 1;
  }

  const made = [];
  const already = [];
  const absent = [];
  const notIgnored = [];

  for (const entry of LINKS) {
    const target = path.join(mainRepo, entry.rel);
    const linkPath = path.join(worktree, entry.rel);

    if (!isIgnored(mainRepo, entry.rel)) notIgnored.push(entry.rel);

    if (fs.existsSync(linkPath)) { already.push(entry.rel); continue; }
    if (!fs.existsSync(target)) {
      // The main checkout has not got it either, so there is nothing to share. Say
      // so plainly instead of creating a dangling link that would read as success.
      absent.push(entry.rel);
      continue;
    }
    if (check) { made.push(entry.rel); continue; }
    linkDir(target, linkPath);
    made.push(entry.rel);
  }

  const copied = [];
  for (const rel of COPIES) {
    const from = path.join(mainRepo, rel);
    const to = path.join(worktree, rel);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    if (!check) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    copied.push(rel);
  }

  console.log('setup-worktree: ' + worktree);
  console.log('  main checkout: ' + mainRepo);
  if (already.length) console.log('  already present (' + already.length + '): ' + already.join(', '));
  if (made.length) console.log('  ' + (check ? 'WOULD link' : 'linked') + ' (' + made.length + '): ' + made.join(', '));
  if (copied.length) console.log('  ' + (check ? 'WOULD copy' : 'copied') + ' (' + copied.length + '): ' + copied.join(', '));

  for (const rel of absent) {
    const entry = LINKS.find((l) => l.rel === rel);
    console.log('  NOT AVAILABLE: ' + rel + ' — the main checkout has not got it either.');
    console.log('      ' + entry.why);
  }
  for (const rel of notIgnored) {
    console.log('  WARNING: ' + rel + ' is NOT gitignored, so a worktree already has it and this '
      + 'entry is wrong. Remove it from LINKS.');
  }

  if (check && (made.length || copied.length)) {
    console.log('\nsetup-worktree --check: incomplete. Re-run without --check.');
    return 1;
  }

  console.log('\nNow VERIFY, because the failure this guards against is silent. From the worktree:');
  console.log('  cd mythos && node --test --test-reporter=tap | grep -E "^# (tests|pass|fail|skipped)"');
  console.log('It must report the SAME numbers as the main checkout, and in particular');
  console.log('skipped=0. A skip here is a licence guard standing down, not a passing test —');
  console.log('and syncing the test-count docs from such a run commits that as the baseline.');
  return absent.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { LINKS, COPIES, mainCheckoutOf };
