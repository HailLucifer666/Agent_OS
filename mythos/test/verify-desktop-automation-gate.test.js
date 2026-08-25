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

const { refusalFor, existingTextOf, gateVerdict, VERDICT } = require('../scripts/verify-desktop-automation.js');

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

// --- the gate's own verdict (2026-08-21) -----------------------------------
//
// A live run that day came back 7 PASS and 1 UNTESTED — charmap's `type`, refused
// by the blank-document gate because the window was still titled "(untitled)" and
// its text could not be read — and the script printed "every verb is
// oracle-confirmed on both a Win32 and an MSIX app" and exited 0. So the Win32
// typing route had no live proof and the run reported success anyway.
//
// An immediate re-run came back 8/8: charmap typed via wm-char-post, read back
// through TextPattern. The UNTESTED was a launch-time sampling race in the probe,
// not a capability gap — which makes the old behaviour worse, not better: the run
// it called green was the flaky one.
//
// The doctrine was already written at the top of that file: "a skipped column
// that prints like a passing one is how a gate lies". It just was not implemented.

const step = (name, verdict) => ({ name, verdict, detail: '' });

test('an UNTESTED verb does not satisfy the gate', () => {
  const v = gateVerdict([step('launch', VERDICT.PASS), step('type', VERDICT.UNTESTED)]);
  assert.equal(v.met, false);
  assert.equal(v.blocking.length, 0, 'UNTESTED is not a failure...');
  assert.deepEqual(v.unproven.map((s) => s.name), ['type'], '...it is an absence of proof, and must be named as one');
});

test('the exact shape of the 2026-08-21 run does not report success', () => {
  // 7 PASS + charmap type UNTESTED. This is the regression, verbatim.
  const steps = [
    step('launch', VERDICT.PASS), step('focus', VERDICT.PASS),
    step('type', VERDICT.UNTESTED), step('click', VERDICT.PASS),
    step('launch', VERDICT.PASS), step('focus', VERDICT.PASS),
    step('type', VERDICT.PASS), step('click', VERDICT.PASS),
  ];
  assert.equal(gateVerdict(steps).met, false);
});

test('a documented EXPECTED-FAIL still satisfies the gate', () => {
  // focus_window's foreground lock is reproduced, understood and recorded in
  // adapters/CLAUDE.md. A known refusal is knowledge, not an unknown — treating it
  // as blocking would make the gate permanently red for a closed question.
  const v = gateVerdict([step('focus', VERDICT.EXPECTED), step('type', VERDICT.PASS)]);
  assert.equal(v.met, true);
});

test('FAIL and UNVERIFIED both block, and are reported separately from UNTESTED', () => {
  const v = gateVerdict([step('type', VERDICT.UNVERIFIED), step('click', VERDICT.FAIL), step('focus', VERDICT.UNTESTED)]);
  assert.equal(v.met, false);
  assert.deepEqual(v.blocking.map((s) => s.name).sort(), ['click', 'type']);
  assert.deepEqual(v.unproven.map((s) => s.name), ['focus']);
});

test('an all-pass run is the only thing that satisfies the gate', () => {
  assert.equal(gateVerdict([step('a', VERDICT.PASS), step('b', VERDICT.PASS)]).met, true);
});

test('no steps at all is not a pass', () => {
  // A run that collected nothing — adapter never loaded, both targets absent —
  // must not read as a clean sweep. Zero failures out of zero checks is the
  // purest form of the substitution this whole function exists to stop.
  assert.equal(gateVerdict([]).met, false);
});

test('the exit code follows the verdict, not just the failures', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'scripts', 'verify-desktop-automation.js'), 'utf8');
  assert.match(src, /process\.exit\(met \? 0 : 1\)/,
    'exit must key on the gate verdict — keying it on blocking.length alone is what let UNTESTED exit 0');
});
