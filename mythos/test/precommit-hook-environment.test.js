'use strict';

// Phase 0 of the 2026-08-22 audit fix plan (docs/AUDIT-2026-08-22-FIX-PLAN.md,
// item 15). The commit gate reported failures that were not real, and every
// agent who works on this repo pays for it exactly once.
//
// FOUR SEPARATE CAUSES, all environmental, none of them visible in the failure
// text they produce. The plan predicted three; the fourth was found while fixing
// the others and is the worst, because it fails silently instead of loudly.
//
//   0. Line endings. core.autocrlf is on and .githooks carried no attribute, so
//      git rewrites LF to CRLF on checkout and the shebang becomes `#!/bin/sh`
//      followed by a carriage return. The loader then looks for an interpreter
//      whose name ends in one, and the hook does not start at all — on a FRESH
//      CLONE the gate simply never runs, while `git config core.hooksPath` still
//      reports success. Invisible here only because this working copy predates
//      autocrlf being set and has never been re-checked-out.
//   1. The temp directory in Windows 8.3 short form. os.tmpdir() inherits the
//      short spelling, fs.mkdtempSync() hands a spawned server a short-name
//      vault path, and the watcher over it trips a libuv bug — the child aborts
//      on `Assertion failed: !_wcsnicmp(filename, dir, dirlen)` and the test
//      reports only `connect ECONNREFUSED` after its full timeout, because the
//      child's stderr is captured and never printed.
//
//      THE GATE WAS THE VICTIM, WHICH IS WHY THIS SURVIVED. Git does not pass
//      the invoking shell's TEMP to a hook: it sets TEMP=/tmp. That string has
//      no '~' in it, so a check written against the shell's TEMP concludes the
//      environment is fine — but Git Bash's /tmp maps to the profile's local
//      AppData temp folder under its short name, so the suite got the broken
//      path on every gated commit this repo has ever run.
//      `deploy-config-conformance.test.js`'s real-boot test fails at its 30s
//      timeout because of it, and that failure was written off as flakiness.
//      Measured both ways on 2026-08-22: short path -> fail at 30,138ms;
//      expanded path -> the same file passes 9/9.
//   2. A running MYTHOS instance holding the real default ports. boot.test.js
//      binds 4478 and the proactive-speak path needs 5050 — the same two ports
//      the desktop launcher frees on start. With the app open they fail as
//      EADDRINUSE, which reads as broken code.
//   3. On failure the hook printed `tail -40` of raw TAP, which is the last few
//      PASSING tests plus a summary line. It never named the test that failed.
//
// MEASURED 2026-08-22, same unchanged working tree, four consecutive runs:
// 1 failure, then 3, then 2, then 0. That is what an untrustworthy gate looks
// like from the outside, and it is why this is the first item in the plan —
// nothing else can be verified until a red run means something.
//
// WHAT KIND OF TEST EACH ONE IS. Most are source-shape assertions, because
// executing the hook end-to-end would run the whole suite from inside the suite.
// Those are deliberately loose about spacing and strict about the mechanism, so
// ordinary edits do not break them while a DROPPED fix still does, and they read
// the hook's EXECUTABLE lines only — see hookCode() for why that distinction was
// not optional. Cause 1 additionally has a real behavioural test that runs the
// hook's own expression under the environment git actually supplies. Every
// assertion here was mutation-checked: the corresponding fix was removed from
// the hook, this file was confirmed red, and the fix restored.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.join(__dirname, '..', '..', '.githooks', 'pre-commit');

function hookSource() {
  return fs.readFileSync(HOOK_PATH, 'utf8');
}

// Assertions below run against the EXECUTABLE lines, not the whole file.
// Found the moment this test was first run green: the hook's own comment
// explains that `MYTHOS_PORT=0` is invalid here, and the check for that literal
// matched the explanation instead of a real assignment. A shape guard that
// passes on prose is not a guard — it would equally accept a hook whose only
// mention of a port is a sentence about ports. Stripping comments makes every
// assertion below about what the hook DOES.
function hookCode() {
  return hookSource()
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

test('the commit gate exists where core.hooksPath points', () => {
  assert.ok(fs.existsSync(HOOK_PATH),
    'activate with `git config core.hooksPath .githooks`; this test guards the file, not the config');
});

test('cause 0 — the gate survives checkout: line endings are pinned to LF', () => {
  // Found while fixing the three causes above, and the worst of the four,
  // because it makes the gate fail SILENTLY rather than loudly. core.autocrlf
  // is true on this machine and .githooks had no attribute, so git rewrites LF
  // to CRLF on checkout. A shell script whose shebang ends in a carriage return
  // does not start — the loader looks for an interpreter named "sh\r". The hook
  // then never runs, while `git config core.hooksPath .githooks` still reports
  // success and nothing anywhere says the gate is off.
  //
  // The working copy here predates autocrlf being set, so it is still LF and the
  // fault was invisible locally. A fresh clone would have got the broken form.
  const attrs = fs.readFileSync(path.join(__dirname, '..', '..', '.gitattributes'), 'utf8');
  assert.match(attrs, /\.githooks\/\*\*\s+text\s+eol=lf/,
    '.gitattributes must pin .githooks to LF, or a fresh clone on Windows gets a hook that cannot start');

  // And the file on disk must actually be LF right now, not merely declared so.
  const raw = fs.readFileSync(HOOK_PATH, 'utf8');
  assert.ok(!raw.includes('\r'),
    'the hook contains a carriage return — it will not execute; re-checkout after fixing .gitattributes');
});

test('cause 1 — the gate asks node what temp dir it will use, not the shell', () => {
  const src = hookCode();
  // The mechanism, and specifically WHERE it reads from. Measured 2026-08-22:
  // git does not pass the invoking shell's TEMP to a hook, it sets TEMP=/tmp.
  // A check written against $TEMP therefore sees a string with no '~' in it and
  // concludes all is well — while Git Bash's /tmp maps to
  // the profile's local AppData temp folder under its 8.3 short name, so the
  // suite got the short form on
  // every gated commit this repo has ever run. The first version of this fix
  // made exactly that mistake and was inert.
  assert.match(src, /os\.tmpdir\(\)/,
    "the hook must resolve node's own os.tmpdir(), not $TEMP — under git the shell's TEMP is /tmp "
    + 'and carries no evidence of the short path underneath it');
  assert.match(src, /realpathSync\.native/,
    'realpathSync.native is the expander; without it the short form survives');
  assert.match(src, /export TEMP TMP|export TMP TEMP/,
    'both must be exported — os.tmpdir() reads TEMP then TMP, so setting one leaves the bug reachable');
  assert.doesNotMatch(src, /case\s+"\$TEMP\$TMP"/,
    'do not gate on the shell\'s own TEMP: that is the check that was inert');
});

test('cause 1, behaviourally — the expansion the hook relies on removes a short segment', () => {
  // Not a shape assertion. Runs the exact expression the hook runs, in a child
  // whose TEMP is the value git actually supplies, and asserts the result is
  // usable. On Windows this expands the 8.3 short profile name to the full one; on
  // other platforms /tmp is already canonical and this asserts the no-op.
  // It must go through `sh`, not straight to node. Git Bash rewrites POSIX
  // paths in the environment into Windows form on the way to a native program,
  // so `TEMP=/tmp sh -c node` is what git actually produces, while spawning node
  // directly hands it the literal string '/tmp' — a different value with a
  // different failure. The first version of this test made that mistake and
  // failed against a working fix.
  const { execFileSync } = require('node:child_process');
  const expr = 'const fs=require("fs"),os=require("os");'
    + 'try{process.stdout.write(fs.realpathSync.native(os.tmpdir()))}catch(e){process.stdout.write("")}';
  const out = execFileSync('sh', ['-c', 'TEMP=/tmp TMP=/tmp exec "$0" -e "$1"', process.execPath, expr], {
    encoding: 'utf8',
  }).trim();

  assert.ok(out, 'the expansion produced nothing — the hook would silently leave TEMP alone');
  assert.ok(!/~\d/.test(out),
    'the expanded temp path still carries an 8.3 short segment (' + out + '). '
    + "deploy-config-conformance's real-boot test dies at its 30s timeout on such a path, "
    + 'and reports only ECONNREFUSED.');
});

test('cause 2 — the gate picks ports a running MYTHOS cannot be holding', () => {
  const src = hookCode();
  for (const name of ['MYTHOS_PORT', 'EDGE_TTS_PORT', 'EDGE_TTS_URL']) {
    assert.ok(src.includes(name),
      `the hook must set ${name}, or a commit made while the app is open fails on ports 4478/5050 `
      + 'and reads as a regression');
  }
  // The two must agree. A port override with a URL still pointing at the old
  // port is worse than neither: the server moves and the client does not.
  assert.match(src, /EDGE_TTS_URL[^\n]*EDGE_TTS_PORT/,
    'EDGE_TTS_URL must be derived from EDGE_TTS_PORT, not hardcoded beside it');
  // Defaults, not overrides: an operator who deliberately set a port keeps it.
  assert.match(src, /:=/,
    'use ${VAR:=default} so the hook supplies a default without overriding a deliberate choice');
  assert.doesNotMatch(src, /MYTHOS_PORT=0\b/,
    'MYTHOS_PORT=0 is not an ephemeral port here — the config schema enforces a minimum of 1024 '
    + 'and rejects it as a config error');
});

test('cause 3 — a blocked commit names the tests that failed', () => {
  const src = hookCode();
  assert.match(src, /not ok/,
    'the hook must surface the TAP "not ok" lines. tail -40 shows the last few PASSING tests '
    + 'and a summary count, which is why a blocked commit used to say nothing useful');
  assert.match(src, /BLOCKED/, 'the refusal itself must stay loud');
});

test('the normalisation the hook relies on is idempotent, so a good TEMP is left alone', () => {
  // Runs on every platform: resolving an already-canonical path must return the
  // same path. If this ever stopped holding, the hook would rewrite a correct
  // TEMP into something else on every commit. The short-to-long expansion
  // itself is Windows-only and cannot be constructed portably, which is stated
  // here rather than hidden behind a skip — this repo has been bitten by guards
  // that only ever skip.
  const canonical = fs.realpathSync.native(os.tmpdir());
  assert.equal(fs.realpathSync.native(canonical), canonical,
    'realpathSync.native must be a no-op on an already-resolved path');
  assert.ok(!/~\d/.test(canonical),
    'the resolved temp path must not still carry an 8.3 short segment: ' + canonical);
});
