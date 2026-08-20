'use strict';

// The typing gate in scripts/verify-desktop-automation.js, pinned.
//
// WHY THIS EXISTS. That script types a probe string into real applications on the
// operator's desktop, and the only thing standing between it and a real document is
// this gate. It shipped inert: `existingTextOf` looked for 'text' / 'readBackText' /
// 'value', while Handle-ReadComposeBox answers with `currentText`, so the gate read
// null on every run — and null took the "go ahead and type" branch. A guard nothing
// exercises is indistinguishable from no guard, so both halves are asserted here:
// the field name it must understand, and the fail-closed decision it must make.

const test = require('node:test');
const assert = require('node:assert');

const { refusalFor, existingTextOf } = require('../scripts/verify-desktop-automation.js');

const OK = { ok: true, result: { fresh: true } };

test('existingTextOf reads currentText, the key read_compose_box actually emits', () => {
  // The exact shape observed live from Handle-ReadComposeBox on 2026-08-20.
  const envelope = {
    ok: true,
    result: {
      controlType: 'ControlType.Document',
      name: 'Text editor',
      currentText: 'MYTHOS W2 probe 12345',
      readFromPid: null,
      candidateCount: 9,
      headerName: null,
    },
  };
  assert.strictEqual(existingTextOf(envelope), 'MYTHOS W2 probe 12345');
});

test('existingTextOf reports unreadable as null, not as empty', () => {
  // A refusal from the handler (wrong foreground app, no editable element) must not
  // read as "the document is empty".
  assert.strictEqual(existingTextOf({ ok: false, error: 'The foreground window belongs to PID 1' }), null);
  assert.strictEqual(existingTextOf({ ok: true, result: { candidateCount: 0 } }), null);
});

test('the gate proceeds only for a confirmed blank, readable document', () => {
  assert.strictEqual(refusalFor(OK, ''), null);
  assert.strictEqual(refusalFor(OK, '   \r\n  '), null);
});

test('the gate refuses when the target holds content', () => {
  const why = refusalFor(OK, 'Caesar salad: romaine, parmesan');
  assert.match(String(why), /already holds 31 characters/);
});

test('the gate refuses when the content could not be read at all', () => {
  // FAIL-CLOSED. "We could not check" is not evidence that typing is safe, and this
  // is the exact branch the inert version fell through to.
  for (const unreadable of [null, undefined, {}, 0]) {
    assert.match(String(refusalFor(OK, unreadable)), /cannot be shown to be empty/);
  }
});

test('the gate refuses when new_document could not produce a blank document', () => {
  const why = refusalFor({ ok: false, error: 'the active document still contains text' }, '');
  assert.match(String(why), /could not produce a blank document/);
  // The reason travels with the refusal — a probe that refuses without saying why
  // costs the next session a live run to rediscover it.
  assert.match(String(why), /still contains text/);
  assert.match(String(refusalFor(null, '')), /no response/);
});

test('requiring the script does not launch anything', () => {
  // The module is a CLI; its main() is behind require.main === module. If that guard
  // is ever removed, this file would start typing into the operator's applications
  // as a side effect of `node --test`.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'verify-desktop-automation.js'), 'utf8');
  assert.match(src, /if \(require\.main === module\)/);
});
