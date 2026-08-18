'use strict';

// bug-273-d4-log-rotate.test.js — BUG-273 D4, the behavioural half.
//
// electron/log-rotate.js exists as its own module precisely so this file can exist.
// The claim being made is "a crash's log survives", and root CLAUDE.md is explicit
// that main.js can only be shape-asserted — a regex over source text is not evidence
// that bytes stay on disk, and this repo has a documented case of a diagnostic that
// destroyed the very data it was there to protect (the wakeword test that renamed the
// operator's real model directory aside).
//
// Real files in a real temp directory, no fs fakes: the failure modes that matter here
// are the ones fs actually has (rename onto an existing target throws on win32; a
// missing file must be a no-op, not a throw), and a fake is exactly where those would
// be assumed away.
//
// Long-form TEMP note: these tests create a temp dir but spawn no server, so the 8.3
// `TEMP` libuv fault recorded in root CLAUDE.md cannot bite here — that one needs a
// watcher over a short-name path in a spawned child.
//
// Run: cd mythos && node --test test/bug-273-d4-log-rotate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rotateLogIfOver, previousGenerationPath } = require('../../electron/log-rotate');

function tmpDir() {
  // AD-7: derived from os.tmpdir(), never a literal path — a tracked test file with a
  // machine-specific path in it fails the portability gate.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-logrotate-'));
}
const write = (p, bytes) => fs.writeFileSync(p, 'x'.repeat(bytes));
const size = (p) => fs.statSync(p).size;

test('under the cap: nothing moves', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'main.log');
  write(file, 100);
  assert.equal(rotateLogIfOver(file, 1000), false);
  assert.equal(size(file), 100, 'the live file is untouched');
  assert.equal(fs.existsSync(previousGenerationPath(file)), false, 'and no generation is created');
});

test('over the cap: the bytes MOVE to .prev and are still readable', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'main.log');
  write(file, 2000);
  assert.equal(rotateLogIfOver(file, 1000), true);

  // This is the whole point of the change. truncateSync(file, 0) satisfied "the file
  // is now small" too — and lost the 2000 bytes doing it.
  const prev = path.join(dir, 'main.prev.log');
  assert.ok(fs.existsSync(prev), 'the previous run must still exist on disk');
  assert.equal(size(prev), 2000, 'in full, not trimmed');
  assert.equal(fs.existsSync(file), false, 'and the live name is free for the next write');
});

test('exactly one generation is kept — the bound is 2x the cap, not unbounded', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'mythos-server.log');
  const prev = path.join(dir, 'mythos-server.prev.log');

  write(file, 2000);
  rotateLogIfOver(file, 1000);
  write(file, 3000);
  rotateLogIfOver(file, 1000);

  assert.equal(size(prev), 3000, 'the newest rotated run wins');
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['mythos-server.prev.log'],
    'no .prev.prev, no numbered generations, no growth in file COUNT either — an '
    + 'unbounded number of bounded files is still unbounded'
  );
});

test('a rotation is not a wipe: rotate, then append, and BOTH runs are readable', () => {
  // The D4 sequence, played out: run one crashes, run two starts, and the question is
  // whether run one's evidence is still there a second later.
  const dir = tmpDir();
  const file = path.join(dir, 'mythos-server.log');
  fs.writeFileSync(file, 'x'.repeat(2000) + '\nCRASH: the line that matters\n');

  rotateLogIfOver(file, 1000);
  fs.appendFileSync(file, '--- boot: run two ---\n');

  assert.match(fs.readFileSync(path.join(dir, 'mythos-server.prev.log'), 'utf8'), /CRASH: the line that matters/);
  assert.match(fs.readFileSync(file, 'utf8'), /boot: run two/);
});

test('a missing file is a no-op, never a throw', () => {
  const dir = tmpDir();
  // Called on every log() write and on every startChild, including the very first,
  // when nothing exists yet. A throw here would be inside the app's logging path.
  assert.equal(rotateLogIfOver(path.join(dir, 'nope.log'), 10), false);
});

test('an unwritable directory degrades to false, and never loses the live file', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'main.log');
  write(file, 2000);

  // Simulate the win32 case the unlink-first ordering exists for: the previous
  // generation is a DIRECTORY, so both unlink and rename onto it fail.
  fs.mkdirSync(path.join(dir, 'main.prev.log'));
  assert.equal(rotateLogIfOver(file, 1000), false, 'reported honestly as "did not rotate"');
  assert.equal(size(file), 2000,
    'and the live log is intact — a failed rotation must degrade the BOUND, never the '
    + 'evidence and never the app');
});

test('Q5 — the cap is the caller\'s, and a nonsense cap rotates nothing', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'main.log');
  write(file, 2000);
  for (const bad of [undefined, null, NaN, Infinity, -1, '1000']) {
    assert.equal(rotateLogIfOver(file, bad), false, 'cap ' + String(bad) + ' must not rotate');
  }
  assert.equal(size(file), 2000);
  // Deliberately NOT defaulted: a cap that silently substitutes a number of its own is
  // how a bound nobody chose gets applied to an operator's disk.
});

test('the .prev name is derived, and a dotted DIRECTORY cannot fool it', () => {
  assert.equal(previousGenerationPath('main.log'), 'main.prev.log');
  assert.equal(previousGenerationPath('mythos-server.log'), 'mythos-server.prev.log');
  assert.equal(previousGenerationPath('serverlog'), 'serverlog.prev', 'no extension: just append');
  // AD-7: derived from os.tmpdir(), never spelled out. A user-shaped absolute path in a
  // TRACKED file fails the portability gate — and that gate scans tracked files only,
  // so it goes red at `git add`, not when the test is first run.
  const dotted = path.join(os.tmpdir(), '.mythos', 'logs', 'main');
  // The only dot in that string belongs to a DIRECTORY; treating it as the file's
  // extension would name a sibling of the directory instead of the file.
  assert.equal(previousGenerationPath(dotted), dotted + '.prev');
});
