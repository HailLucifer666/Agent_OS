'use strict';

// test/bug-443-no-unclassified-reason-stringify.test.js — the guard that stops
// "[object Object]" coming back a fifth time.
//
// THE CLASS, with dates, because it is the point. A failure value that may be a
// STRUCTURED object is rendered with `String(...)`, JavaScript's default object
// toString produces the literal "[object Object]", and the operator is told a
// tool failed with no reason at all:
//
//   BUG-101                     the first
//   dispatch-action.js          2026-07-29, in its own Audit file
//   scripts/google-auth.js      2026-08
//   from-pc.js delegate()       2026-09-16 — BUG-443, the row the operator heard
//   from-app-reply.js x4        2026-09-16 — BUG-443
//   from-pc.js reasonOf()       2026-09-18 — found by this sweep
//   from-cua.js describeError() 2026-09-18 — found by this sweep
//
// Four of those seven were fixed one call site at a time. The shared normalizer
// util/reason-text.js was extracted for this in 2026-07 and the class kept
// recurring anyway, because nothing made a NEW instance visible. This is that.
//
// WHY THIS SHAPE AND NOT A COUNT. A fixed "there are N matches" assertion goes
// green the moment one defect replaces another, which is a guard that cannot
// tell you anything. This one derives the candidate set from the source and
// requires every member to be CLASSIFIED by identity. Add a new
// `String(x.error)` and the test names it and fails; classify it deliberately
// and it passes. The waiver map is deliberately non-empty and each entry says
// why — an exception that is invisible is an exception nobody re-examines.
//
// WHAT COUNTS AS A CANDIDATE: stringifying a whole failure value —
// `String(x.error)`, `String(x.reason)`, `String(x.result)`. Reading a named
// scalar FIELD off one — `String(x.result.title)`, `String(x.result.output)` —
// is not this defect and is not matched: those fields are strings by contract,
// and flagging them would train people to mute the guard.
//
// Run: cd mythos && node --test test/bug-443-no-unclassified-reason-stringify.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EFFECTORS = path.join(__dirname, '..', 'src', 'core', 'effectors');

// `String(<expr>.error)` / `.reason` / `.result` with NOTHING after it — a
// trailing `.field` or `[` means a scalar read, not a whole-reason render.
const CANDIDATE = /String\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(error|reason|result)\s*(?![.[\w])/g;

// Every known candidate, by file and by the expression it stringifies, with the
// reason it is allowed. Identity, not count.
const CLASSIFIED = {
  'close-window-guard.js': {
    'res.result': 'res comes from from-pc delegate(), which since BUG-443 normalizes its reason to a '
      + 'string before returning. Stringifying a string is a no-op, and the /cannot find/i test beside '
      + 'it needs a string to match against at all.',
  },
  'from-android.js': {
    'res.result': 'adb command failures carry a string reason from runAdb(); the object shape pc-child '
      + 'can produce does not exist on this path.',
  },
  'from-browser.js': {
    'refProblem.result': 'refProblem is built locally in this file with a string message; it never '
      + 'crosses an adapter boundary.',
  },
  'from-cua.js': {
    'stateRes.result': 'stateRes comes from this file s own call wrapper, whose failure result is the '
      + 'output of describeError() — already normalized through reasonText() since BUG-443.',
  },
  'from-dashboard.js': {
    'ack.reason': 'the dashboard ack protocol defines reason as a string on the wire (from-dashboard s '
      + 'own header); a structured value here would be a protocol violation, not a rendering bug.',
    'res.reason': 'same protocol, same field.',
  },
  'from-pc.js': {
    'focused.result': 'focused comes from delegate(), normalized since BUG-443.',
  },
  'from-app-reply.js': {
    // Intentionally empty: every site in this file was converted to
    // reasonText() by BUG-443. An entry appearing here again means a
    // regression, and the test will say so by name.
  },
};

function sourceFiles() {
  return fs.readdirSync(EFFECTORS)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(EFFECTORS, f), 'utf8') }));
}

// Comments describe the defect in several of these files ("a plain
// String(result.result) produced the useless literal"), and a scanner that
// reads prose reports the explanation as an instance of the thing explained.
function codeOnly(text) {
  return text.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function candidatesIn(text) {
  const found = new Set();
  const code = codeOnly(text);
  let m;
  CANDIDATE.lastIndex = 0;
  while ((m = CANDIDATE.exec(code)) !== null) found.add(m[1] + '.' + m[2]);
  return found;
}

test('BUG-443 / every whole-reason String() in an effector is classified', () => {
  const unclassified = [];
  for (const { file, text } of sourceFiles()) {
    const allowed = CLASSIFIED[file] || {};
    for (const expr of candidatesIn(text)) {
      if (!Object.prototype.hasOwnProperty.call(allowed, expr)) unclassified.push(file + ': String(' + expr + ')');
    }
  }
  assert.deepEqual(unclassified, [],
    'A new whole-failure-value String() appeared in an effector. This is the shape that has produced '
    + '"[object Object]" seven times in this repository. Either render it with reasonText() from '
    + 'util/reason-text.js, or add it to CLASSIFIED above WITH the reason it is safe — which means '
    + 'having read the producer and confirmed the value is a string by contract.');
});

test('BUG-443 / the waiver list has no stale entries', () => {
  // A waiver for a site that no longer exists is a claim nobody re-checks, and
  // it silently re-permits the pattern if the same expression comes back for a
  // different reason.
  const live = new Map();
  for (const { file, text } of sourceFiles()) live.set(file, candidatesIn(text));
  const stale = [];
  for (const [file, exprs] of Object.entries(CLASSIFIED)) {
    const present = live.get(file);
    for (const expr of Object.keys(exprs)) {
      if (!present || !present.has(expr)) stale.push(file + ': String(' + expr + ')');
    }
  }
  assert.deepEqual(stale, [],
    'a waiver naming a site that is gone must be deleted with the site, or it quietly re-permits the '
    + 'pattern when the same expression returns for a different reason');
});

test('BUG-443 / the guard can actually see the defect it is written for', () => {
  // The step almost everyone skips: prove the detector fires. A guard that
  // matches nothing passes forever and reads as safety — this repository has
  // that failure on record more than once.
  const probe = 'return fail("could not type: " + String(typed.result) + " Nothing was sent.");';
  assert.deepEqual([...candidatesIn(probe)], ['typed.result'],
    'the detector must match the exact pre-fix line from from-app-reply.js');

  const scalar = 'const t = String(res.result.title || "");';
  assert.deepEqual([...candidatesIn(scalar)], [],
    'and must NOT match a named scalar field, or it trains people to mute it');

  const inComment = '// a plain String(result.result) produced the useless literal';
  assert.deepEqual([...candidatesIn(inComment)], [],
    'nor the prose explaining the defect — several of these files document it');
});
