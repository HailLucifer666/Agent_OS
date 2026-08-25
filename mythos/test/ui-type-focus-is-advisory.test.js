'use strict';

// ui-type-focus-is-advisory.test.js — an advisory UIA focus call must never be
// able to abort ui_type's escalation ladder.
//
// THE BUG THIS FILE EXISTS FOR (reproduced live, %APPDATA%/MYTHOS/vault/
// Episodic/2026-08-14.jsonl line 136):
//   ui_type({pid: 11604, text: "Mythos capability test. Round 2..."}) returned
//     "Type failed: Exception calling \"SetFocus\" with \"0\" argument(s):
//      \"Target element cannot receive focus.\""
//   after 2 retries. Nothing was typed into Notepad, and the operator's read of
//   it was "it can't even type into Notepad any more".
//
//   Handle-UiType opens with an OPTIONAL pre-focus step: when the caller passes
//   an elementPath, it resolves that element and calls SetFocus() on it. That
//   one call was the only unguarded SetFocus in ps-automation.ps1 — the three
//   others are wrapped precisely because SetFocus is advisory and throws on
//   controls that refuse focus (Win11's WinUI3 Notepad is one). The exception
//   escaped to Handle-UiType's outer catch, which returns 'Type failed: ...'.
//
//   The damage is what never ran: uia-setvalue and wm-char-post, the two routes
//   in the escalation ladder that need no focus at all and are this repo's
//   measured-working mechanisms against MSIX Notepad (see the ladder comment in
//   Handle-UiType, "uia-valuepattern-setvalue LANDED / wm-char-post LANDED").
//   A best-effort optimisation was able to kill the recovery path built for
//   exactly the app that triggered it.
//
// These are source-shape assertions. The real typing path needs Windows, a real
// UIA tree and a real Notepad — covered by scripts/verify-notepad-typing.js —
// so what is pinned here is the INVARIANT that survives refactors: focus is
// advisory everywhere it is attempted.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PS_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const source = fs.readFileSync(PS_PATH, 'utf8');
const lines = source.split(/\r?\n/);

// A SetFocus() call is "guarded" when a `catch {` follows it CLOSELY — i.e. it
// sits in a tight try/catch of its own that swallows the refusal and lets
// execution continue.
//
// The first version of this check looked UPWARD for an enclosing `try {`, and
// was vacuous: Handle-UiType wraps its entire body in one, so the very call
// this file exists for scored as guarded and the test passed against the buggy
// source. An enclosing try is not a guard when its catch abandons the handler —
// what matters is whether the exception is absorbed HERE or unwinds the ladder.
// Verified red against HEAD~ (flags line 2440, and only that line) and green
// after the fix.
const GUARD_WINDOW_LINES = 8;
function isGuarded(lineIndex) {
  return /\bcatch\s*\{/.test(lines.slice(lineIndex, lineIndex + GUARD_WINDOW_LINES).join('\n'));
}

describe('ui_type: UIA focus is advisory, never a precondition', () => {
  it('every SetFocus() call in ps-automation.ps1 absorbs a refusal locally', () => {
    const unguarded = [];
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return;            // prose naming SetFocus, not a call
      if (!/\.SetFocus\(\)/.test(line)) return;
      if (!isGuarded(i)) unguarded.push(`${i + 1}: ${line.trim()}`);
    });

    assert.deepEqual(unguarded, [],
      'SetFocus() throws "Target element cannot receive focus." on controls that refuse focus '
      + '(Win11 WinUI3 Notepad). Unguarded, it escapes to Handle-UiType\'s outer catch and aborts '
      + 'the whole handler — including the uia-setvalue and wm-char-post routes that need no focus '
      + 'and are the ones proven to work on MSIX apps. Wrap it and fall through.');
  });

  it('the pre-focus step records a refusal instead of swallowing it', () => {
    const start = source.indexOf('function Handle-UiType');
    assert.ok(start !== -1, 'Handle-UiType must exist');
    const body = source.slice(start, source.indexOf('\nfunction ', start + 1));

    assert.match(body, /\$preFocusNote/,
      'a refused pre-focus must be captured, so "the ladder was never needed" stays '
      + 'distinguishable from "the ladder is the only reason this worked"');
    assert.match(body, /\$result\.preFocus\s*=\s*\$preFocusNote/,
      'the captured note must reach the returned result — a silently swallowed catch is how '
      + 'this class of bug hides in the first place');
  });

  it('the escalation ladder still runs after the pre-focus step', () => {
    const start = source.indexOf('function Handle-UiType');
    const body = source.slice(start, source.indexOf('\nfunction ', start + 1));

    const focusAt = body.indexOf('$preFocusNote');
    const ladderAt = body.indexOf("'uia-setvalue'");
    const wmCharAt = body.indexOf("'wm-char-post'");

    assert.ok(ladderAt > focusAt && wmCharAt > focusAt,
      'the focus-free routes must remain DOWNSTREAM of the advisory focus step — if a refactor '
      + 'ever makes them conditional on focus succeeding, this bug is back');
  });
});
