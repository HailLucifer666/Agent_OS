'use strict';

// WAVE 2 STEP C — Enter is the Send button, and it must not be pressed on faith.
//
// From the recorded session of 2026-07-31:
//   11:23:33  send_key('enter')  -> ok:true   (into a real Slack DM)
//   11:24:15  send_key('enter')  -> ok:true   (again)
//   11:25:17  the FIRST ui_type that could have put text there finally succeeds
//
// So MYTHOS pressed Send on an empty compose box twice, in someone's real DM
// thread, and then told the operator "I have typed the message and sent it."
// send_key had no relationship of any kind to whether text had been typed.
//
// The guard is deliberately narrow: only a bare `enter`, only when the LIVE
// foreground window is a messaging app, and it reads the foreground fresh every
// time rather than trusting anything remembered — focus moves without telling us.
// Typing, clicking and focusing are never gated.

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

// foreground: what get_foreground_window reports. typeReadBack: the verdict a
// ui_type in this scenario comes back with.
// submits: every submit_message the effector routed to (2026-08-02 — Enter in a chat
// app must go through the VERIFIED submit ladder, never a raw keystroke; see below).
function pc(foreground, typeReadBack, sent, submits) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'get_foreground_window') {
        return foreground ? { ok: true, result: foreground } : { ok: false, error: 'No foreground window.' };
      }
      if (c.cmd === 'focus_window') return { ok: true, result: { focused: true, pid: c.pid } };
      if (c.cmd === 'ui_type') {
        return { ok: true, result: Object.assign({
          typed: true, typedIntoPid: c.pid || foreground && foreground.pid, typedIntoTitle: (foreground && foreground.title) || '',
        }, typeReadBack || {}) };
      }
      if (c.cmd === 'send_key') { if (sent) sent.push(c.key); return { ok: true, result: { sent: true, key: c.key } }; }
      if (c.cmd === 'submit_message') {
        if (submits) submits.push(c.pid);
        return { ok: true, result: { submitted: true, mechanism: 'wm-char-return', clearedText: 'on my way' } };
      }
      return { ok: true, result: {} };
    },
  };
}

const SLACK = { pid: 5000, title: 'Alex Rivera (DM) - Slack', process: 'slack' };
const NOTEPAD = { pid: 14556, title: 'Untitled - Notepad', process: 'notepad' };

describe('WAVE 2 — send_key Enter guard in messaging apps', () => {
  it('THE 11:23 CASE: Enter into Slack with nothing verifiably typed is REFUSED', async () => {
    const sent = [];
    await withMockedPcChild(pc(SLACK, null, sent), async (m) => {
      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, false, 'this Enter sent an empty message into a real DM twice');
      assert.match(String(res.result || res.error), /Enter sends the message/i);
      assert.deepEqual(sent, [], 'and no keystroke may reach the app at all');
    });
  });

  // 2026-08-02 — this test used to assert `sent === ['enter']`, i.e. that an allowed
  // Enter reached the app as a RAW KEYSTROKE. That contract was the bug. WhatsApp
  // Desktop is MSIX-packaged, and MSIX apps silently discard SendInput while reporting
  // the events as injected, so the raw keystroke returned sent:true and WhatsApp
  // received nothing — the operator had to press Enter by hand. The verified ladder
  // (submit_message: uia-invoke-send -> wm-char-return -> sendinput-enter, each gated on
  // the composer actually emptying) already existed and was simply unreachable from
  // send_key. So the assertion inverts: an allowed Enter must NOT produce a keystroke,
  // and must produce a submit_message instead.
  it('Enter is allowed once a ui_type into that same window has been VERIFIED — and goes through the verified submit ladder, not a raw keystroke', async () => {
    const sent = [];
    const submits = [];
    await withMockedPcChild(pc(SLACK, {
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'on my way',
    }, sent, submits), async (m) => {
      const typed = await m.ui_type({ text: 'on my way', pid: SLACK.pid });
      assert.equal(typed.unverified, undefined === typed.unverified ? undefined : false);
      assert.ok(typed.evidence, 'precondition: the type must be verified for this test to mean anything');

      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, true, 'a verified message SHOULD be sendable — the guard is not a wall');
      assert.deepEqual(submits, [SLACK.pid], 'Enter in a chat app must route to submit_message, aimed at that window');
      assert.deepEqual(sent, [], 'and must NOT also fire a raw Enter — that is the keystroke MSIX apps swallow, and a double-fire sends twice');
      assert.ok(res.evidence, 'the ladder proves the composer emptied, so this send carries evidence');
    });
  });

  it('an UNVERIFIED type does not earn an Enter — that is when it is most dangerous', async () => {
    const sent = [];
    await withMockedPcChild(pc(SLACK, {
      readBack: 'unavailable', readBackReason: 'no readable text pattern',
    }, sent), async (m) => {
      const typed = await m.ui_type({ text: 'on my way', pid: SLACK.pid });
      assert.equal(typed.unverified, true, 'precondition');

      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, false, 'nobody knows what is in the box, so nobody may press Send');
      assert.deepEqual(sent, []);
    });
  });

  it('a verified type into a DIFFERENT window does not unlock Enter here', async () => {
    const sent = [];
    // Verify text into Notepad, then move focus to Slack and try to send.
    let foreground = NOTEPAD;
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (c) => {
        if (c.cmd === 'get_foreground_window') return { ok: true, result: foreground };
        if (c.cmd === 'focus_window') return { ok: true, result: { focused: true, pid: c.pid } };
        if (c.cmd === 'ui_type') {
          return { ok: true, result: { typed: true, typedIntoPid: NOTEPAD.pid, typedIntoTitle: NOTEPAD.title, readBack: 'confirmed', readBackText: 'a private note' } };
        }
        if (c.cmd === 'send_key') { sent.push(c.key); return { ok: true, result: { sent: true } }; }
        return { ok: true, result: {} };
      },
    };
    await withMockedPcChild(mock, async (m) => {
      await m.ui_type({ text: 'a private note', pid: NOTEPAD.pid });
      foreground = SLACK;
      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, false, 'this would send whatever was already sitting in the Slack box');
      assert.match(String(res.result || res.error), /different window/i);
      assert.deepEqual(sent, []);
    });
  });

  it('Enter outside a messaging app is never gated', async () => {
    const sent = [];
    await withMockedPcChild(pc(NOTEPAD, null, sent), async (m) => {
      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, true, 'a newline in Notepad is not a Send button');
      assert.deepEqual(sent, ['enter']);
    });
  });

  it('non-Enter keys are never gated, even in a messaging app', async () => {
    const sent = [];
    await withMockedPcChild(pc(SLACK, null, sent), async (m) => {
      assert.equal((await m.send_key({ key: 'escape' })).ok, true);
      assert.equal((await m.send_key({ key: 'tab' })).ok, true);
      assert.equal((await m.send_key({ key: 'ctrl+a' })).ok, true);
      assert.deepEqual(sent, ['escape', 'tab', 'ctrl+a']);
    });
  });

  it('no foreground oracle means no basis to refuse (degrade honestly, do not block work)', async () => {
    const sent = [];
    await withMockedPcChild(pc(null, null, sent), async (m) => {
      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, true, 'refusing on missing evidence would break Enter everywhere');
      assert.deepEqual(sent, ['enter']);
    });
  });

  it('the guard matches on process name even when the title does not say the app', async () => {
    const sent = [];
    await withMockedPcChild(pc({ pid: 7000, title: 'Alex Rivera', process: 'Discord' }, null, sent), async (m) => {
      const res = await m.send_key({ key: 'enter' });
      assert.equal(res.ok, false, 'a DM window titled only with a person\'s name is still a DM');
      assert.deepEqual(sent, []);
    });
  });
});
