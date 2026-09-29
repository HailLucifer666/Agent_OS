'use strict';

// test/file-size-ratchet.test.js — audit item 13, Phase 6 (2026-08-22).
//
// THE HOUSE RULE is under 800 lines per file (root CLAUDE.md via
// ~/.claude/rules/core.md §6). Thirty tracked files break it today. Sweeping all
// thirty is not a change anybody should make in one go, so this guard does the
// next best thing and makes the debt one-directional: it can shrink, it cannot
// grow, and no NEW file may join the list.
//
// WHY A RATCHET AND NOT A FLAT LIMIT. A flat 800-line assertion would fail on
// day one in thirty places, and a guard that is red on arrival gets muted rather
// than obeyed — this repo already has that lesson written down twice (the
// ELECTRON_RUN_AS_NODE guard was deliberately built to accept the inheriting
// form for the same reason). A baseline that only tightens is enforceable today.
//
// HOW IT FAILS. Six checks, each with its own message, because "the size guard
// went red" is useless on its own:
//   1. a tracked .js file that is not on the list goes over 800 -> new debt
//   2. a file on the list grows past its recorded size          -> old debt grew
//   3. a file on the list drops to 800 or under                 -> delete its entry
//   4. a file on the list shrinks well past its number          -> lower the number
//   5. a baseline path is no longer a tracked file              -> stale entry
//   6. a DELIBERATE exception has no real reason written        -> unexplained
//
// Check 4 exists because without it the ratchet only holds against today: a file
// could fall from 4,680 to 900 and climb all the way back unchallenged. It
// carries slack (SHRINK_SLACK) so that deleting a few lines does not force a
// baseline edit in the same commit — which is how a guard becomes an annoyance
// and then an exception.
//
// Check 5 exists because a stale entry is a hole: rename the path and a fresh
// 4,000-line file can appear under the old name with the guard pointing at
// nothing.
//
// THE TWO ENTRIES THAT ARE DELIBERATE EXCEPTIONS, not merely debt, are called
// out by name in DELIBERATE below. Everything else on the list is debt that
// happens not to have been paid yet.
//
// PROVEN BY BREAKING IT, per the plan — a guard that has never gone red is not
// known to work. All six checks were mutated and all six fired with the right
// message: a real 902-line file was created and git-added (check 1), baseline
// numbers were moved down and up (checks 2 and 4), a compliant file was added to
// the list (3), a nonexistent path was added (5), and an exception reason was
// replaced with two words (6). Nothing was left behind; the guard was restored
// byte-identical and verified by hash.
//
// One of those mutations survived on the first attempt — the short-reason one —
// because the replacement text accidentally concatenated onto the original and
// stayed long. That was a broken mutation, not a passing guard, and it is worth
// recording: a SURVIVED result means read your own harness first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LIMIT = 800;
const SHRINK_SLACK = 100;

// Files that are over the limit ON PURPOSE, with the reason. These stay on the
// baseline like everything else — the difference is that nobody should spend
// time trying to remove them.
const DELIBERATE = {
  'electron/main.js':
    'Splitting it is a known way to break the app for everyone. This file has ordering traps where '
    + 'merely PROPERTY-ACCESSING an Electron API before the app is ready throws — root CLAUDE.md '
    + 'records the cursor-overlay crash, where the defensive typeof check WAS the crash, and it '
    + 'shipped past 2598 green tests because a green suite cannot tell you the desktop app starts. '
    + 'Moving code between modules reorders requires. Documented non-fix; see the comment at the '
    + 'top of the file and electron-main-stays-whole.test.js.',
};

// path -> line count at the time it was recorded. Regenerate a number only when
// a file has genuinely shrunk; never raise one to make a red run go green.
const BASELINE = {
  'mythos/server/index.js': 4680,
  'electron/main.js': 2580, // B3b (2026-09-29): the settings channels moved to electron/settings-ipc.js
  // 1627 -> 1610 (BUG-407..411, 2026-09-03): the browser resolver moved to
  // browser-target.js and the launch plan to browser-launch-plan.js, so the fix
  // fitted under the ceiling instead of raising it. Recorded DOWN, per this
  // file's own rule — the ceiling only ever tightens.
  'mythos/src/core/effectors/from-browser.js': 1610,
  'mythos/src/core/effectors/from-pc.js': 1390, // B2a (2026-09-29): launch_app moved to launch-app.js
  'mythos/src/core/voice/live-tool-adapter.js': 1449,
  'mythos/src/core/effectors/from-dashboard.js': 1418,
  'mythos/src/main.js': 1373,
  'mythos/ui/public/js/voice/s2s-bridge.js': 1315,
  'mythos/test/immune.test.js': 1270,
  'mythos/src/core/voice/live-session.js': 1204,
  'mythos/ui/public/js/app.js': 1175,
  'mythos/test/brain.test.js': 1097,
  'mythos/ui/public/js/voice/voice-loop.js': 1075,
  'mythos/ui/public/js/neural-map/hud-canvas.js': 1027,
  'mythos/src/core/effectors/from-computer.js': 867, // B2c: open_file moved to open-file.js
  'mythos/scripts/spike-dsh-build.js': 967,
  'mythos/adapters/dsh-agent/index.js': 929,
  'mythos/src/core/effectors/web-search.js': 862,
  'mythos/scripts/verify-voice-session.js': 918,
  'mythos/src/core/voice/voice-agent.js': 906,
  'mythos/src/core/effectors/from-spotify.js': 900,
  'mythos/src/core/effectors/agent-actions.js': 885,
  'mythos/test/cortex-goals.test.js': 884,
  'mythos/src/core/immune/healer.js': 813,
  'mythos/ui/public/js/neural-map/core-orb.js': 874,
  'mythos/src/core/config/schema.js': 870,
  'mythos/src/core/engagements/executor.js': 864,
  'mythos/test/memory.test.js': 842,
  'mythos/src/core/goals/index.js': 827,
  'mythos/test/bug-272-verify-voice-session.test.js': 801,
};

function countLines(content) {
  const parts = content.split(/\r?\n/);
  // A file ending in a newline splits to a trailing empty string, which is not a
  // line. Without this the guard reports every file as one line longer than
  // `wc -l` does, and the baseline drifts from what a human measures.
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function trackedJsFiles() {
  const out = execFileSync('git', ['ls-files', '*.js'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((p) => !/(^|\/)node_modules\//.test(p));
}

function measure() {
  const sizes = new Map();
  for (const rel of trackedJsFiles()) {
    let content;
    try {
      content = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // staged-but-deleted, submodule entry — not this guard's business
    }
    sizes.set(rel, countLines(content));
  }
  return sizes;
}

test('no NEW file joins the over-800 list', () => {
  const sizes = measure();
  const fresh = [];
  for (const [rel, n] of sizes) {
    if (n > LIMIT && !(rel in BASELINE)) fresh.push(rel + ' (' + n + ' lines)');
  }
  assert.deepEqual(fresh, [],
    'these files are over the ' + LIMIT + '-line house limit and are not on the baseline. Split them, '
    + 'or — if there is a real reason they must stay whole — add them to BASELINE and to DELIBERATE '
    + 'with that reason written out: ' + fresh.join(', '));
});

test('no file on the list grows past the size it was recorded at', () => {
  const sizes = measure();
  const grown = [];
  for (const rel of Object.keys(BASELINE)) {
    const n = sizes.get(rel);
    if (n === undefined) continue; // covered by the stale-entry test below
    if (n > BASELINE[rel]) grown.push(rel + ': ' + BASELINE[rel] + ' -> ' + n);
  }
  assert.deepEqual(grown, [],
    'an already-oversized file got bigger. The baseline number is a ceiling, not a suggestion — '
    + 'do not raise it to make this pass. Move the new code somewhere else: ' + grown.join(', '));
});

test('a file that has come under the limit is removed from the list', () => {
  const sizes = measure();
  const compliant = [];
  for (const rel of Object.keys(BASELINE)) {
    const n = sizes.get(rel);
    if (n !== undefined && n <= LIMIT) compliant.push(rel + ' is now ' + n + ' lines');
  }
  assert.deepEqual(compliant, [],
    'this file now obeys the house limit — delete its BASELINE entry so it can never quietly grow '
    + 'back over 800: ' + compliant.join(', '));
});

test('a file that has shrunk a long way has its number lowered', () => {
  // Without this the ratchet only holds against today's size forever: a file
  // could fall from 4,680 to 900 and then climb all the way back with nothing
  // complaining. The slack exists so ordinary edits do not force a baseline
  // update in the same commit.
  const sizes = measure();
  const loose = [];
  for (const rel of Object.keys(BASELINE)) {
    const n = sizes.get(rel);
    if (n === undefined) continue;
    if (n <= LIMIT) continue; // the previous test owns this case
    if (BASELINE[rel] - n > SHRINK_SLACK) loose.push(rel + ': recorded ' + BASELINE[rel] + ', now ' + n);
  }
  assert.deepEqual(loose, [],
    'lower the BASELINE number to the current size, otherwise the file is free to grow back to the '
    + 'old one: ' + loose.join(', '));
});

test('every baseline entry still names a real tracked file', () => {
  // A stale entry is a hole: the path could be renamed and a fresh 4,000-line
  // file could appear under the old name with the guard still pointing at
  // nothing.
  const sizes = measure();
  const missing = Object.keys(BASELINE).filter((rel) => !sizes.has(rel));
  assert.deepEqual(missing, [],
    'these BASELINE paths are not tracked .js files any more — a rename or a deletion left the '
    + 'entry behind: ' + missing.join(', '));
});

test('the deliberate exceptions are on the baseline and carry a reason', () => {
  for (const rel of Object.keys(DELIBERATE)) {
    assert.ok(rel in BASELINE, rel + ' is called a deliberate exception but is not on the baseline');
    assert.ok(DELIBERATE[rel].length > 80,
      rel + ' has an exception entry with no real reason in it. A one-word excuse is how a '
      + 'deliberate decision decays into an unexplained exemption.');
  }
});
