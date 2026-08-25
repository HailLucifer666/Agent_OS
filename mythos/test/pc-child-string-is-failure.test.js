'use strict';

// pc-child-string-is-failure.test.js — ps-automation.ps1's stated convention is
// "string = failure, hashtable = success". This pins it at the DISPATCHER, once,
// instead of per command arm.
//
// THE BUG THIS FILE EXISTS FOR (BUG-223, live 2026-08-14):
//   close_window({pid:11604}) was audited as
//     outcome:"ok", ok:true,
//     result:"Window for PID 11604 (Notepad, ...) did not close within 3s and is
//             still open. Nothing was closed."
//   A failure, recorded as a success, in the same record that spells out the
//   failure in prose.
//
//   Handle-CloseWindow was made honest in BUG-103 and returns a STRING when the
//   window survives — its own comment says "Returning a STRING is how this file
//   reports an honest failure". But the conversion of a string result into
//   ok:false lived in each `switch` arm, and close_window's arm never got one.
//   ~24 of 42 arms carried a copy, every one added reactively after an incident
//   proved that arm was missing it (launch_app FIX 4, media_key P0-2, ui_click,
//   ui_type, click_at ...). from-pc.js's Node backstop missed it too: it still
//   tests for the pre-BUG-103 hashtable shape (`result.closed === false`).
//
// The fix hoists the conversion to a single gate before Write-Response, so an
// unguarded arm cannot exist. These tests are what stops it being un-hoisted.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PS_PATH = path.join(__dirname, '..', 'adapters', 'pc-child', 'ps-automation.ps1');
const source = fs.readFileSync(PS_PATH, 'utf8');

describe('pc-child dispatcher: a string result is always a failure', () => {
  it('the conversion is hoisted to a single gate, not left per-arm', () => {
    const gate = source.indexOf('if ($null -eq $err -and $result -is [string])');
    assert.ok(gate !== -1,
      'the hoisted convention gate is missing — without it, every new `switch` arm has to '
      + 'remember its own copy, which is exactly how close_window shipped ok:true for a '
      + 'window that was still open');

    const writeErr = source.indexOf('Write-Response $false $err');
    assert.ok(gate < writeErr,
      'the gate must run BEFORE the response is written, or it cannot affect the verdict');
  });

  // The real dispatcher, driven end to end. `close_window` with no pid makes
  // Handle-CloseWindow return its 'PID is required.' string without touching a
  // window, so this is hermetic: no desktop state, no real process.
  //
  // Verified red against HEAD~ (BUG-223's parent), which answered
  //   {"ok":true,"result":"PID is required.","id":"t1"}
  it('answers ok:false when a handler returns a failure string', { skip: process.platform !== 'win32' ? 'windows-only' : false }, () => {
    const res = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_PATH],
      { input: '{"cmd":"close_window","id":"t1"}\n', encoding: 'utf8', timeout: 90000 });

    const line = String(res.stdout || '').split(/\r?\n/).find((l) => l.trim().startsWith('{'));
    assert.ok(line, 'the child wrote no JSON response; stderr: ' + String(res.stderr || '').slice(0, 400));

    const parsed = JSON.parse(line);
    assert.equal(parsed.ok, false,
      'a handler that returned a failure string must reach the caller as ok:false — got '
      + JSON.stringify(parsed));
    assert.equal(parsed.error, 'PID is required.',
      'the failure text belongs in `error`, not in `result` where a success would carry it');
    assert.equal(parsed.id, 't1', 'the command id must still be echoed (node drops mismatched ids as stale)');
  });
});
