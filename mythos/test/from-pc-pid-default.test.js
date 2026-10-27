'use strict';

// FIX 1 (pid-defaulting): launch_app now remembers the pid of the last app it
// launched (module-level lastLaunchedPid). ui_type/ui_click default their pid
// param to it when the caller omits pid, so foregroundThenRetry actually
// engages instead of typing/clicking into whatever window happens to be
// focused. This file covers the defaulting behavior itself — the retry
// mechanics are already covered by from-pc-ui-type-retry.test.js.

const { answersResolve } = require('./helpers/launch-resolve'); // B2a: stubs answer resolve_app
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

test('ui_type with no pid defaults to the pid of the immediately preceding launch_app and foregrounds it', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'launch_app') return { ok: true, result: { pid: 5555, launched: true } };
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') return { ok: true, result: { typed: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const launched = await fromPc.launch_app({ name: 'notepad' });
    assert.equal(launched.ok, true);

    const result = await fromPc.ui_type({ text: 'hello' }); // pid omitted on purpose

    assert.equal(result.ok, true);
    const focusCall = calls.find((c) => c.cmd === 'focus_window');
    const typeCall = calls.find((c) => c.cmd === 'ui_type');
    assert.ok(focusCall, 'omitting pid must still foreground a window — proves foregroundThenRetry engaged, not the pid-less plain-delegate branch');
    assert.equal(focusCall.pid, 5555, 'the window focused must be the one launch_app just opened');
    assert.equal(typeCall.pid, 5555, 'ui_type must send the defaulted pid down to pc-child');
  });
});

test('ui_click with no pid defaults to the pid of the immediately preceding launch_app', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'launch_app') return { ok: true, result: { pid: 7777, launched: true } };
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_click') return { ok: true, result: { clicked: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    await fromPc.launch_app({ name: 'calc' });

    const result = await fromPc.ui_click({ elementPath: ['0', '1'] }); // pid omitted

    assert.equal(result.ok, true);
    const focusCall = calls.find((c) => c.cmd === 'focus_window');
    const clickCall = calls.find((c) => c.cmd === 'ui_click');
    assert.ok(focusCall, 'ui_click with no pid must still foreground the last-launched window');
    assert.equal(focusCall.pid, 7777);
    assert.equal(clickCall.pid, 7777);
  });
});

test('an explicit pid always wins over lastLaunchedPid (backward compatibility)', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'launch_app') return { ok: true, result: { pid: 1111, launched: true } };
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') return { ok: true, result: { typed: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' }); // sets lastLaunchedPid = 1111

    const result = await fromPc.ui_type({ text: 'hi', pid: 9999 }); // explicit pid differs from lastLaunchedPid

    assert.equal(result.ok, true);
    const typeCall = calls.find((c) => c.cmd === 'ui_type');
    assert.equal(typeCall.pid, 9999, 'an explicitly supplied pid must never be overridden by lastLaunchedPid');
  });
});

test('ui_type with no pid and no prior launch_app in this module instance still uses the pid-less plain-delegate path (no focus_window call)', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'ui_type') return { ok: true, result: { typed: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hi' }); // no pid, no prior launch_app call

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, 'with no pid available at all, only the bare ui_type delegate call should fire — no focus_window');
    assert.equal(calls[0].cmd, 'ui_type');
    assert.equal('pid' in calls[0], false, 'no pid field should be sent when none is available');
  });
});

test('ui_click with no pid and no prior launch_app in this module instance still fails honestly', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async () => { throw new Error('sendCommand should not be called — ui_click must fail before delegating'); },
  }, async (fromPc) => {
    const result = await fromPc.ui_click({ elementPath: ['0'] }); // no pid, no prior launch_app
    assert.equal(result.ok, false);
    assert.match(String(result.result), /PID is required/);
  });
});

// coercePid: the planning LLM sometimes emits a non-numeric placeholder pid
// (e.g. "Notepad PID") instead of a real number. That string is truthy, so
// `pid || lastLaunchedPid` used to pick it over the real fallback and forward
// it toward PS's Int32-typed Get-Process -Id, which throws.

test('ui_type with a garbage non-numeric pid and a prior launch_app falls back to lastLaunchedPid', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'launch_app') return { ok: true, result: { pid: 5555, launched: true } };
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') return { ok: true, result: { typed: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    await fromPc.launch_app({ name: 'notepad' }); // sets lastLaunchedPid = 5555

    const result = await fromPc.ui_type({ text: 'hello', pid: 'Notepad PID' }); // garbage placeholder pid

    assert.equal(result.ok, true);
    const focusCall = calls.find((c) => c.cmd === 'focus_window');
    const typeCall = calls.find((c) => c.cmd === 'ui_type');
    assert.ok(focusCall, 'garbage pid must be rejected by coercePid, falling back to lastLaunchedPid, which still engages foregroundThenRetry');
    assert.equal(focusCall.pid, 5555);
    assert.equal(typeCall.pid, 5555, 'the garbage placeholder pid must never be forwarded to pc-child');
  });
});

test('ui_type with a numeric-string pid and no prior launch_app coerces it to a number', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmdObj.cmd === 'ui_type') return { ok: true, result: { typed: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: '1234' }); // numeric string, no prior launch_app

    assert.equal(result.ok, true);
    const typeCall = calls.find((c) => c.cmd === 'ui_type');
    assert.equal(typeCall.pid, 1234, 'a numeric-string pid must be coerced to a real number');
    assert.equal(typeof typeCall.pid, 'number');
  });
});

test('ui_type with a garbage non-numeric pid and no prior launch_app falls back to the plain-delegate path (no focus_window call)', async () => {
  const calls = [];
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => { const resolvedTarget = answersResolve(cmdObj); if (resolvedTarget) return resolvedTarget;
      calls.push(cmdObj);
      if (cmdObj.cmd === 'ui_type') return { ok: true, result: { typed: true } };
      throw new Error('unexpected cmd: ' + cmdObj.cmd);
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hi', pid: 'Notepad PID' }); // garbage pid, no prior launch_app

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, 'with no real pid available at all (garbage rejected, no fallback), only the bare ui_type delegate call should fire — no focus_window');
    assert.equal(calls[0].cmd, 'ui_type');
    assert.equal('pid' in calls[0], false, 'no pid field should be sent when none is available');
  });
});
