'use strict';

// WAVE 7 — app_reply composes into an open chat app and STOPS.
//
// Why this is an effector and not a prompt instruction: on 2026-07-31 MYTHOS
// pressed Enter into a real Slack DM at 11:23:33 and again at 11:24:15, before any
// text had verifiably reached the box, and then reported "I have typed the message
// and sent it." No wording in a system prompt prevents that. A tool with no code
// path to Enter does.
//
// The last test in this file is the one that matters most: it asserts, over the
// real module source, that nothing in this effector can press Enter.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const evidence = require('../src/core/effectors/evidence');

const APP_REPLY_PATH = path.resolve(__dirname, '../src/core/effectors/from-app-reply.js');
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

const originalRequire = Module.prototype.require;

// from-app-reply requires pc-child itself AND requires from-pc (which requires
// pc-child again) — both have to resolve to the same fake.
function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[APP_REPLY_PATH];
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(APP_REPLY_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[APP_REPLY_PATH];
    delete require.cache[FROM_PC_PATH];
  }
}

const SLACK_WIN = { pid: 5000, title: 'Alex Rivera (DM) - Slack', process: 'slack' };

// A fully cooperative desktop; individual tests override one step to break it.
function desktop(over) {
  const o = over || {};
  const calls = [];
  const mock = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      calls.push(c);
      switch (c.cmd) {
        case 'list_windows':
          return { ok: true, result: { windows: o.windows || [SLACK_WIN, { pid: 9, title: 'Untitled - Notepad', process: 'notepad' }] } };
        case 'focus_window':
          return o.focusFails ? { ok: false, error: 'cannot focus' } : { ok: true, result: { focused: true, pid: c.pid } };
        case 'get_foreground_window':
          return { ok: true, result: o.foreground || { pid: SLACK_WIN.pid, title: SLACK_WIN.title, process: 'slack' } };
        case 'screen_read_text':
          return { ok: true, result: { text: o.ocr !== undefined ? o.ocr : 'Alex Rivera\nare you around?\nMessage Alex Rivera', lineCount: 3 } };
        case 'focus_message_box':
          if (o.noMessageBox) return { ok: false, error: 'no editable, keyboard-focusable element in it' };
          return { ok: true, result: Object.assign({ focused: true, via: 'ValuePattern', method: 'uia-setfocus', name: 'Message Alex Rivera', existingText: '', candidateCount: 3 }, o.box || {}) };
        case 'ui_type':
          return { ok: true, result: Object.assign({
            typed: true, typedIntoPid: c.pid, typedIntoTitle: SLACK_WIN.title,
            readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'on my way',
          }, o.type || {}) };
        default:
          return { ok: true, result: {} };
      }
    },
  };
  return { mock, calls };
}

describe('WAVE 7 — app_reply composes but never sends', () => {
  it('types into the open Slack window and reports the read-back, with sendPending', async () => {
    const { mock, calls } = desktop();
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });

      assert.equal(res.ok, true);
      assert.equal(res.result.sendPending, true, 'the human closes the loop');
      assert.equal(res.result.sent, false);
      assert.equal(res.result.pid, SLACK_WIN.pid);
      assert.equal(evidence.isVerified(res), true, 'a composed reply must be quotable back');
      assert.equal(res.evidence.oracle, 'read-back');
      assert.equal(res.evidence.observed, 'on my way');

      const keys = calls.filter((c) => c.cmd === 'send_key');
      assert.deepEqual(keys, [], 'app_reply must never press a key');
    });
  });

  it('never launches anything — an app that is not open is an honest stop', async () => {
    const { mock, calls } = desktop({ windows: [{ pid: 9, title: 'Untitled - Notepad', process: 'notepad' }] });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /not open/i);
      assert.deepEqual(calls.filter((c) => c.cmd === 'launch_app'), [],
        '"reply" means the conversation is already on screen; launching would open a different view');
    });
  });

  it('two windows of the same app means ASK, listing both, never guess', async () => {
    const second = { pid: 5001, title: 'engineering (channel) - Slack', process: 'slack' };
    const { mock } = desktop({ windows: [SLACK_WIN, second] });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.ok, false, 'guessing puts a private reply in the wrong conversation');
      assert.match(String(res.result), /Alex Rivera/);
      assert.match(String(res.result), /engineering/);
      assert.match(String(res.result), /which one/i);
    });
  });

  it('refuses when the foreground oracle disagrees with the focus call', async () => {
    // focus_window said ok, but something else still has the keyboard.
    const { mock, calls } = desktop({ foreground: { pid: 777, title: 'Antigravity IDE', process: 'code' } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /still has the keyboard/i);
      assert.match(String(res.result), /nothing was typed/i);
      assert.deepEqual(calls.filter((c) => c.cmd === 'ui_type'), [], 'and it must not type anyway');
    });
  });

  it('stops honestly when no message box can be found', async () => {
    const { mock, calls } = desktop({ noMessageBox: true });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /could not find its message box/i);
      assert.match(String(res.result), /will not guess/i);
      assert.deepEqual(calls.filter((c) => c.cmd === 'ui_type'), []);
    });
  });

  it('a type that cannot be read back is unverified, not quoted as fact', async () => {
    const { mock } = desktop({ type: { readBack: 'unavailable', readBackReason: 'no readable text pattern' } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.ok, true, 'the text may well be there');
      assert.equal(res.unverified, true);
      assert.equal(evidence.isVerified(res), false);
      assert.match(res.reason, /cannot quote it back|check before sending/i);
    });
  });

  it('a read-back mismatch fails the whole reply rather than reporting a composed message', async () => {
    const { mock } = desktop({ type: { readBack: 'mismatch', readBackText: '' } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.ok, false);
      assert.match(String(res.result), /nothing was sent/i);
    });
  });

  it('surfaces text already sitting in the box, so a stranger\'s draft is never appended to silently', async () => {
    const { mock } = desktop({ box: { existingText: 'half-written thought' } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'slack', text: 'on my way' });
      assert.equal(res.result.existingTextBefore, 'half-written thought');
    });
  });

  it('an unknown app is refused with the list of apps it can actually reach', async () => {
    const { mock } = desktop();
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'mybank', text: 'hello' });
      assert.equal(res.ok, false, 'a fuzzy match on an arbitrary name could type into anything');
      assert.match(String(res.result), /do not know how to reply/i);
      assert.match(String(res.result), /slack/);
    });
  });

  it('requires text, and requires an app', async () => {
    const { mock } = desktop();
    await withMockedPcChild(mock, async (m) => {
      assert.equal((await m.app_reply({ app: 'slack', text: '   ' })).ok, false);
      assert.equal((await m.app_reply({ text: 'hi' })).ok, false);
    });
  });

  it('STRUCTURAL: the module contains no way to press Enter or send', () => {
    // The guarantee is meant to be by construction, so it is asserted over the
    // source rather than over one code path a future edit could bypass.
    const src = fs.readFileSync(APP_REPLY_PATH, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    assert.doesNotMatch(code, /send_key/, 'app_reply must not reference send_key at all');
    assert.doesNotMatch(code, /['"]enter['"]/i, 'no Enter keystroke may appear in this module');
    assert.doesNotMatch(code, /whatsapp_send|gmail_send/, 'no sending effector may be reachable from here');
    assert.match(code, /sendPending/, 'and it must state that a send is still outstanding');
  });
});

describe('WAVE 7 — app_reply is tiered and registered', () => {
  it('has a TIER_TABLE entry at T2 (composing, not sending)', () => {
    const { TIER_TABLE } = require('../src/core/leash/tiers');
    assert.equal(TIER_TABLE['app_reply'], 2);
  });

  it('registers into a hub, so tier-table conformance can see it', () => {
    const { registerFromAppReply } = require('../src/core/effectors/from-app-reply');
    const registered = [];
    const count = registerFromAppReply({ register: (e) => registered.push(e.name || (e.tool && e.tool.name)) });
    assert.equal(count, 1);
  });

  it('the catalog entry documents the compose-then-stop contract to the model', () => {
    const { TOOLS } = require('../src/core/effectors/from-app-reply');
    const d = TOOLS[0].description;
    assert.match(d, /ALREADY OPEN/i, 'the model must know it does not launch');
    assert.match(d, /NEVER presses Enter/i, 'the contract has to be in the text the model reads');
    assert.match(d, /reads the text back/i);
  });
});
