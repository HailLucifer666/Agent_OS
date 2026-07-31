'use strict';

// WAVE 2 — ui_type must prove the text is in the window, or say it cannot.
//
// The failure this pins is the one that made the operator stop believing MYTHOS.
// 2026-07-31, 11:28:09:
//   * target pid 14556, resolved properly
//   * foreground confirmed as "Untitled - Notepad"
//   * SendInput returned its full event count
//   * ui_type returned {typed:true, length:23}
//   * the screenshot MYTHOS took 28 seconds later shows an EMPTY document
//   * MYTHOS said "I'm pleased to report I have successfully typed..."
//
// Every guard that existed passed, because all of them verify the CALL: the pid
// was right, the foreground was right, the events were accepted. None of them
// looked at the window afterwards. typed:true only ever meant "SendInput accepted
// the events".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const evidence = require('../src/core/effectors/evidence');
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

// A pc-child whose ui_type replies with a given read-back verdict.
function pcWithReadBack(typeResult, extra) {
  return Object.assign({
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'focus_window') return { ok: true, result: { focused: true, pid: c.pid } };
      if (c.cmd === 'ui_type') {
        return { ok: true, result: Object.assign({
          typed: true, typedIntoPid: c.pid || 14556, typedIntoTitle: 'Untitled - Notepad',
        }, typeResult) };
      }
      return { ok: true, result: {} };
    },
  }, extra || {});
}

describe('WAVE 2 — ui_type read-back', () => {
  it('a confirmed read-back is verified and quotes what the window actually holds', async () => {
    await withMockedPcChild(pcWithReadBack({
      length: 7, readBack: 'confirmed', readBackVia: 'TextPattern', readBackText: 'Hi Alex',
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 14556 });
      assert.equal(res.ok, true);
      assert.equal(evidence.isVerified(res), true);
      assert.equal(res.evidence.oracle, 'read-back');
      assert.equal(res.evidence.observed, 'Hi Alex');
      assert.equal(res.evidence.expected, 'Hi Alex');
    });
  });

  it('THE 11:28 CASE: full event count into an empty window is a FAILURE, not typed:true', async () => {
    await withMockedPcChild(pcWithReadBack({
      length: 23, readBack: 'mismatch', readBackVia: 'TextPattern', readBackText: '',
      readBackReason: 'the control does not contain the text after injection',
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex, this is Mythos', pid: 14556 });

      assert.equal(res.ok, false,
        'SendInput accepting the events is not the text being in the window — this must not be ok:true');
      assert.equal(evidence.isVerified(res), false);
      assert.match(res.error, /not in the window|empty/i);
      assert.match(res.error, /Nothing was actually typed/i,
        'the operator has to hear that it did not happen, in words');
    });
  });

  it('a mismatch with different text reports what the window really says', async () => {
    await withMockedPcChild(pcWithReadBack({
      readBack: 'mismatch', readBackVia: 'ValuePattern', readBackText: 'yesterdays note',
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 14556 });
      assert.equal(res.ok, false);
      assert.match(res.error, /yesterdays note/, 'both strings, so the failure is diagnosable');
    });
  });

  it('no readable pattern is UNVERIFIED, not success and not failure', async () => {
    // Games, canvas-drawn Electron surfaces. The keystrokes may well have landed;
    // we simply cannot prove it, and must not pretend either way.
    await withMockedPcChild(pcWithReadBack({
      readBack: 'unavailable',
      readBackReason: 'the focused control exposes neither ValuePattern nor TextPattern, so its text cannot be read back',
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 14556 });
      assert.equal(res.ok, true, 'refusing to claim failure for something that probably worked');
      assert.equal(res.unverified, true);
      assert.equal(evidence.isVerified(res), false);
      assert.match(res.reason, /ValuePattern|read back/i);
    });
  });

  it('text that was already there and did not change is unverified, not confirmed', async () => {
    // Otherwise a re-run over an unchanged document reads as a fresh success.
    await withMockedPcChild(pcWithReadBack({
      readBack: 'unchanged', readBackVia: 'TextPattern',
      readBackReason: 'the control already contained this text and its contents did not change, so the keystrokes cannot be confirmed to have landed',
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 14556 });
      assert.equal(res.ok, true);
      assert.equal(res.unverified, true);
      assert.match(res.reason, /did not change/i);
    });
  });

  it('an old-style reply with no read-back field at all degrades to unverified', async () => {
    // Forward-compat: a pc-child that predates Wave 2 must never read as proven.
    await withMockedPcChild(pcWithReadBack({ length: 7 }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 14556 });
      assert.equal(res.ok, true);
      assert.equal(res.unverified, true);
      assert.equal(evidence.isVerified(res), false);
    });
  });

  it('the wrong-window guard still fires before read-back is even consulted', async () => {
    await withMockedPcChild({
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (c) => {
        if (c.cmd === 'focus_window') return { ok: true, result: { focused: true } };
        return { ok: true, result: { typed: true, typedIntoPid: 16800, typedIntoTitle: 'Antigravity IDE', readBack: 'confirmed', readBackText: 'Hi Alex' } };
      },
    }, async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 14556 });
      assert.equal(res.ok, false, 'landing verifiably in the WRONG window is still a failure');
      assert.match(res.result || res.error || '', /wrong window/i);
    });
  });
});
