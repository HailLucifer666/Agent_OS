'use strict';

// BUG-077 — Stage 6 of 7. "close Spotify" needs alt+F4, and the whole
// function-key row (f1-f12) was simply absent from send_key's map. The
// operator's log shows the model trying 'alt' and 'f4' as two SEPARATE
// send_key calls, both rejected ("Invalid key: alt", "Invalid key: f4"):
// alt was already a valid MODIFIER (KEY_MODIFIERS), but f4 was not a valid
// base key at all, so "alt+f4" itself could never have worked either.
//
// This is the same class of thing as WAVE 2's guard, not a new mechanism —
// send_key still reports its effect as unverified (no oracle for what a
// keystroke DID), which existing tests already cover; this file only
// proves f-keys are now accepted where they used to be rejected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

const originalRequire = Module.prototype.require;
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

function pc(sent) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'get_foreground_window') return { ok: false, error: 'no window' };
      if (c.cmd === 'send_key') { if (sent) sent.push(c.key); return { ok: true, result: { sent: true, key: c.key, combo: c.key.includes('+') } }; }
      return { ok: true, result: {} };
    },
  };
}

describe('BUG-077 — send_key accepts f1-f12, so alt+f4 ("close Spotify") is expressible', () => {
  it('THE RECORDED CASE: send_key("f4") is no longer "Invalid key: f4"', async () => {
    await withMockedPcChild(pc([]), async (m) => {
      const res = await m.send_key({ key: 'f4' });
      assert.equal(res.ok, true, 'f4 must be a valid bare key now');
    });
  });

  it('THE RECORDED CASE: send_key("alt+f4") actually sends the combo', async () => {
    const sent = [];
    await withMockedPcChild(pc(sent), async (m) => {
      const res = await m.send_key({ key: 'alt+f4' });
      assert.equal(res.ok, true);
      assert.deepEqual(sent, ['alt+f4']);
    });
  });

  it('all twelve function keys are accepted', async () => {
    await withMockedPcChild(pc([]), async (m) => {
      for (let i = 1; i <= 12; i++) {
        const res = await m.send_key({ key: `f${i}` });
        assert.equal(res.ok, true, `f${i} must be valid`);
      }
    });
  });

  it('a genuinely bogus key is still rejected honestly (the whitelist did not silently open up)', async () => {
    await withMockedPcChild(pc([]), async (m) => {
      const res = await m.send_key({ key: 'f13' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /Invalid key/);
    });
  });
});
