'use strict';

// bug-273-d4-death-leaves-a-trail.test.js — BUG-273 D4.
//
// D4 AS FILED: the first post-BUG-272 live session "died after about two minutes
// with no diagnostic trail" — no Crashpad dump, no child exit line, nothing. It
// was parked as "needs more evidence". Reading the logging path instead of waiting
// for the next death found a mechanism that DESTROYS the evidence, so the next
// session would have been just as blind:
//
//   1. `createWriteStream(childLogPath(), { flags: 'w' })` in startChild().
//      startChild() is not only the boot path — the child's own exit handler
//      re-forks through it after a 1s backoff. So a crashing child's log was
//      erased by its own restart, roughly one second later, EVERY time. In a
//      crash loop only the last and shortest attempt survives, which is exactly
//      the reported symptom: an app that died and left nothing.
//   2. `fs.truncateSync(file, 0)` for the main-log cap. Hitting the cap wipes the
//      whole file rather than the oldest part of it, so the run leading up to a
//      2 MB overflow is gone rather than trimmed.
//
// Both were deliberate and both were reasonable: append-mode grows without bound
// across a crash loop, and rotation is machinery that can go wrong. The fix keeps
// the bound and drops the erasure — ONE previous generation is kept (`*.prev.log`),
// so the ceiling is 2x a known constant instead of unbounded, and a death always
// has its own run plus the one before it on disk.
//
// AND FOUR DEATH MODES THAT LOGGED NOTHING AT ALL. Each is a documented way an
// Electron app disappears, and none of them was handled:
//   - `unhandledRejection` — an async throw. `uncaughtException` does not catch it.
//   - `render-process-gone` — the HUD renderer dies; the window goes blank or
//     vanishes while the main process lives on, looking like a hang.
//   - `child-process-gone` — the GPU or a utility process dies, which is what
//     takes the window with it on a driver fault.
//   - `child.on('error')` on the fork — a spawn that never starts emits 'error',
//     not 'exit', so the existing exit handler never runs and nothing is said.
// Plus `app.on('quit')`: without it a CLEAN quit and a vanish are indistinguishable
// in the log, which is the actual thing that made D4 unanswerable.
//
// Q2 — DOES THIS HIDE EVIDENCE? It is the whole point: this is the item where the
// evidence was being hidden BY the diagnostics. That is why the assertions below
// are about erasure, not about volume.
//
// Q3 — WHO ACTUALLY READS THIS? `<userData>/mythos-server.log` is read by
// scripts/verify-voice-session.js, so its PATH must not change — hence append +
// rotate-on-cap rather than per-run files, which would have split one voice
// session across two names and quietly halved every metric that script reports.
//
// Q5 — IS THIS CONSTANT ACTUALLY CORRECT? The child log has no cap today at all
// (truncate-per-run was the only bound), and a real installed session was measured
// growing 42 KB -> 363 KB in about two hours (see browser-agent-backoff.test.js).
// 8 MB is therefore ~40 hours of ordinary logging before the first rotation, and
// 16 MB is the total ceiling. Named, not sprinkled.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? "A diagnostic that destroys the thing it
// diagnoses." Same class as the wakeword test that renamed the operator's real
// model directory aside to fake a state (see root CLAUDE.md), and as
// verify-voice-session.js counting a bus event that is never logged.
//
// Q8 — PIN THE DISPOSITION: no change to WHEN the child restarts, to the backoff,
// or to the quit path. This slice only changes what survives on disk and what gets
// written down when the app dies.
//
// Source-shape assertions, per root CLAUDE.md: main.js cannot be unit-tested for
// load order (fakes are blind to it) and a green suite cannot tell you the app
// boots, so shape is the only automated guard available.
//
// Run: cd mythos && node --test test/bug-273-d4-death-leaves-a-trail.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, 'electron', 'main.js'), 'utf8');

// Comments in this area now discuss `flags: 'w'` and truncation by name, so every
// assertion below has to run against code with the prose stripped — the repo has
// the "detector matched my own comment" failure on record.
function codeOnly(text) {
  return text.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = codeOnly(SRC);

function block(startNeedle, endNeedle) {
  const a = CODE.indexOf(startNeedle);
  assert.notEqual(a, -1, 'could not find ' + startNeedle);
  const b = CODE.indexOf(endNeedle, a + startNeedle.length);
  assert.notEqual(b, -1, 'could not find ' + endNeedle + ' after ' + startNeedle);
  return CODE.slice(a, b);
}

test('the child log is APPENDED to, so a crash-restart cannot erase the crash', () => {
  const startChild = block('function startChild(', 'function stopChild(');

  assert.doesNotMatch(startChild, /flags:\s*'w'/,
    'startChild() is the restart path as well as the boot path, so truncate-on-open '
    + 'deleted the evidence of the crash that caused the restart about a second later');
  assert.match(startChild, /flags:\s*'a'/,
    'append, with the bound moved to a size cap + one kept generation');
});

test('both logs rotate instead of being wiped, through ONE shared implementation', () => {
  // The rules and their behaviour live in electron/log-rotate.js and are tested for
  // real in bug-273-d4-log-rotate.test.js. What this file can add is that main.js
  // actually reaches for it — in BOTH places, from one module, so the two logs cannot
  // drift into disagreeing about what "bounded" means.
  assert.match(CODE, /require\('\.\/log-rotate'\)/,
    'main.js must use the tested module, not a second inline copy of the logic');
  assert.match(CODE, /rotateLogIfOver/, 'and must call it');

  const logFn = block('function log(', 'function safeStringify(');
  assert.doesNotMatch(logFn, /truncateSync\(/,
    'truncate-to-zero at the cap threw away the whole run leading up to the overflow');
  assert.match(logFn, /rotateLogIfOver\(/, 'the main log caps by rotating');

  const startChild = block('function startChild(', 'function stopChild(');
  assert.match(startChild, /rotateLogIfOver\(/,
    'the child log had NO cap before this — truncate-per-run was its only bound, and '
    + 'append without a cap would grow forever');
});

test('the bound is a named constant per log, not a sprinkled number', () => {
  assert.match(CODE, /MAIN_LOG_MAX_BYTES\s*=/);
  assert.match(CODE, /CHILD_LOG_MAX_BYTES\s*=/,
    'the child log is far chattier than the main one and needs its own ceiling');
});

test('the rotation module ships in the packaged build', () => {
  // A require that resolves in dev and not in the installed app is the exact shape of
  // this repo's asar failures, and it would take the whole main process with it — this
  // one sits in the logging path, above everything. electron/** is packed INSIDE
  // app.asar, which is fine for an in-process require (Electron's fs patches make it
  // transparent) and would not be for a spawn or a dynamic import; this is neither.
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'electron', 'log-rotate.js')));
  const files = require(path.join(REPO_ROOT, 'package.json')).build.files;
  assert.ok(files.some((f) => f === 'electron/**/*'),
    'build.files must still carry electron/**/* or the module is absent from the install');
});

test('a boot marker makes it possible to tell where a run began', () => {
  assert.match(CODE, /boot:/,
    'appending across runs is only readable if each run announces itself; without this, '
    + '"the log ends here" and "the log was overwritten here" look identical');
});

test('unhandledRejection is logged — uncaughtException does not catch it', () => {
  assert.match(CODE, /process\.on\('unhandledRejection'/,
    'an async throw in the main process left no line at all, and most of this file is async');
});

test('a dead renderer is logged instead of looking like a hang', () => {
  assert.match(CODE, /app\.on\('render-process-gone'/,
    'the HUD renderer dying while the main process lives on is the exact shape of the '
    + '"it just stopped responding" report');
});

test('a dead GPU or utility process is logged', () => {
  assert.match(CODE, /app\.on\('child-process-gone'/,
    'a driver fault takes the window with it, and the main process survives to write it down');
});

test("a fork that never starts is logged — 'error' fires instead of 'exit'", () => {
  const startChild = block('function startChild(', 'function stopChild(');
  assert.match(startChild, /child\.on\('error'/,
    "the existing exit handler carries the only crash line, and a failed spawn never "
    + 'reaches it');
});

test('a clean quit is distinguishable from a vanish', () => {
  assert.match(CODE, /app\.on\('quit'/,
    'this is what made D4 unanswerable: with no line for an orderly exit, a log that '
    + 'simply stops proves nothing either way');
});

test('Q8 — the restart policy itself is untouched', () => {
  const startChild = block('function startChild(', 'function stopChild(');
  assert.match(CODE, /BACKOFF_STEPS_MS\s*=\s*\[1000,\s*2000,\s*5000\]/,
    'same backoff steps as before this slice');
  assert.match(startChild, /if \(isQuitting\)/,
    "BUG-225's never-re-fork-while-quitting guard must still be the first thing "
    + 'startChild does');
});

test('the boot marker names MYTHOS, not Electron', () => {
  // LIVE-CAUGHT, 2026-08-18: the very first marker this code wrote said
  // "--- boot: MYTHOS 43.3.0 ---". 43.3.0 is Electron's version. app.getVersion()
  // is correct in a packaged build (it reads the asar's own package.json) and
  // returns Electron's version in dev, where there is no asar.
  //
  // Not cosmetic in this repo: the operator spent 2026-08-12 with four builds and no
  // way to tell them apart from inside the app, and a HUD badge on a 0.1.7 install
  // read "v0.1.0" for the same class of reason. A marker exists to say which run a
  // log belongs to; one naming the wrong product is worse than none, because it gets
  // believed.
  assert.match(CODE, /function appVersionForLog\(/);
  const fn = block('function appVersionForLog(', '\nfunction ');
  assert.match(fn, /app\.isPackaged/,
    'packaged is the case app.getVersion() answers correctly, and it must keep it');
  assert.match(fn, /require\('\.\.\/package\.json'\)/,
    "and dev must read the repo's own version instead of Electron's");

  const startChild = block('function startChild(', 'function stopChild(');
  assert.match(startChild, /appVersionForLog\(\)/, 'the marker uses it');
  assert.doesNotMatch(startChild, /boot: MYTHOS ' \+ app\.getVersion\(\)/);
});

test('the other app.getVersion() callers are left alone', () => {
  // They are all on the auto-update path, which runs only when packaged — where
  // app.getVersion() is the RIGHT answer and the one the installer, the updater and
  // the release asset all agree on. Q3/surgical: fix the caller that was wrong, not
  // the function that was right everywhere else.
  assert.ok((CODE.match(/app\.getVersion\(\)/g) || []).length >= 5,
    'the update path still asks Electron directly');
});
