'use strict';

// test/close-window-honesty.test.js — BUG-103. From the 2026-08-05 incident:
//   close_window({pid:24304})  ->  "Chrome failed to close, process couldn't be found"
//   close_window({pid:22164})  ->  Brave "failed a graceful close attempt within the timeout"
//
// The PowerShell handler returned `@{closed=$false; note='...'}` — a HASHTABLE,
// which the dispatcher treats as success. So a window that was demonstrably
// still open came back `ok:true`, and only the free-text `note` said otherwise.
// That is the evidence-contract violation the repo's dispatch rules exist to
// prevent (src/core/CLAUDE.md: never flatten "did not verify" into ok).
//
// The PowerShell side is not reachable from `node --test`; this pins the Node
// half — close_window must never report success for a window still open, and a
// pid that no longer exists must name the recovery step instead of dead-ending.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalRequire = Module.prototype.require;
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

test('a window that did not close is a FAILURE, not ok:true with a note', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    // The exact legacy shape from the Brave incident.
    sendCommand: async () => ({ ok: true, result: { pid: 22164, closed: false, note: 'Window did not close gracefully in 3s' } }),
  }, async (fromPc) => {
    const res = await fromPc.close_window({ pid: 22164 });

    assert.equal(res.ok, false, 'a still-open window must never be reported as a successful close');
    assert.match(String(res.result), /did not close|still open/i);
  });
});

test('a genuine close stays a success', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async () => ({ ok: true, result: { pid: 22164, closed: true, graceful: true } }),
  }, async (fromPc) => {
    const res = await fromPc.close_window({ pid: 22164 });

    assert.equal(res.ok, true);
    assert.equal(res.result.closed, true);
  });
});

test('a vanished pid reports honestly and names the recovery step', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async () => ({ ok: false, error: "Cannot close PID 24304: Cannot find a process with the process identifier 24304." }),
  }, async (fromPc) => {
    const res = await fromPc.close_window({ pid: 24304 });

    assert.equal(res.ok, false);
    assert.match(String(res.result), /24304/);
    assert.match(String(res.result), /list_windows/i, 'the model needs the next step, not just the error');
  });
});

test('a failed close does not clear the launched-pid default (the window is still there)', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmd) => {
      if (cmd.cmd === 'launch_app') return { ok: true, result: { pid: 4242, name: 'brave' } };
      return { ok: true, result: { pid: 4242, closed: false, note: 'Window did not close gracefully in 3s' } };
    },
  }, async (fromPc) => {
    await fromPc.launch_app({ name: 'brave' });
    const res = await fromPc.close_window({ pid: 4242 });

    assert.equal(res.ok, false);
    // lastLaunchedPid is only cleared on a real close — the pid is still valid,
    // so a follow-up ui_type must still be able to default to it.
    const typed = await fromPc.ui_type({ text: 'x' }).catch(() => null);
    assert.ok(typed, 'the launched pid default must survive a failed close');
  });
});
