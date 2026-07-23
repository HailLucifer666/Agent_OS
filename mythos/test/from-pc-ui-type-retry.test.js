'use strict';

// REMEDIATION P0-2 (JS-adapter-level confirmation): now that the PS dispatch
// loop genuinely surfaces a Handle-UiType/Handle-SendKey/Handle-MediaKey
// string failure as {ok:false} (see ps-dispatch-honest-failure.test.js),
// confirm from-pc.js's ui_type actually SEES that ok:false and its
// foregroundThenRetry mechanism (focus the target window, then retry) engages
// on it — previously dead code, since ok was always true.

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

test('ui_type with a pid retries after an ok:false (zero-inject) response, focusing the window first', async () => {
  const calls = [];
  let attempt = 0;
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      calls.push(cmdObj.cmd);
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      attempt++;
      if (attempt === 1) {
        return { ok: false, error: "Type failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app)." };
      }
      return { ok: true, result: { typed: true, length: 5 } };
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: 4242 });
    assert.equal(result.ok, true, `expected an eventual ok:true, got: ${JSON.stringify(result)}`);
    assert.ok(calls.indexOf('focus_window') !== -1, 'ui_type with a pid must foreground the window first');
    assert.equal(attempt, 2, 'the first ok:false response must trigger a retry, not be accepted as final');
  });
});

test('ui_type surfaces a final ok:false when every attempt keeps failing', async () => {
  await withMockedPcChild({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (cmdObj) => {
      if (cmdObj.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      return { ok: false, error: 'Type failed: SendInput injected 0 events (input may be blocked by a higher-integrity foreground app).' };
    },
  }, async (fromPc) => {
    const result = await fromPc.ui_type({ text: 'hello', pid: 4242 });
    assert.equal(result.ok, false, 'a persistently blocked type must surface as ok:false, never a silent success');
  });
});
