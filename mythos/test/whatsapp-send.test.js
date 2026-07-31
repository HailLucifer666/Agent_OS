'use strict';

// whatsapp-send.test.js — desktop WhatsApp sending.
//
// "Send a WhatsApp message to dad saying hi" had no implementation at all: the
// only WhatsApp path in the repo drives a PHONE over ADB and is documented as
// never actually sending. This covers the desktop effector.
//
// The design under test: WhatsApp's own whatsapp://send?phone= deep link opens
// the exact conversation (so contact resolution is WhatsApp's job, not fragile
// UI hunting through an Electron accessibility tree), then the message is typed
// with ui_type against the resolved pid — which verifies WHERE the keystrokes
// landed — and only then is Enter pressed.
//
// The tests that matter most here are the refusals. Messaging the wrong human is
// not recoverable, so an ambiguous contact, an unfocusable window, or a
// wrong-window type must all stop before Enter.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');
const WHATSAPP_PATH = require.resolve('../src/core/effectors/from-whatsapp');

// Swap from-pc for a scripted fake so these tests never touch a real desktop.
function load(pcOverrides) {
  const calls = [];
  const fakePc = {
    launch_app: async (a) => { calls.push({ fn: 'launch_app', ...a }); return { ok: true, result: { pid: 4242, launched: true } }; },
    focus_window: async (a) => { calls.push({ fn: 'focus_window', ...a }); return { ok: true, result: { pid: a.pid, focused: true } }; },
    ui_type: async (a) => {
      calls.push({ fn: 'ui_type', ...a });
      return { ok: true, result: { typed: true, length: String(a.text).length, typedIntoPid: a.pid, typedIntoTitle: 'WhatsApp' } };
    },
    send_key: async (a) => { calls.push({ fn: 'send_key', ...a }); return { ok: true, result: { key: a.key, sent: true } }; },
    // WAVE 9 (BUG-064): the composer names its recipient, and whatsapp_send now
    // refuses to type until that names the person it was asked to message.
    // Modelled on the real app: the deep link asked for a number, so the chat that
    // opens is addressed to that number. Deriving it from the launch call rather
    // than hardcoding it keeps every case (contact, raw number, alias) honest.
    readComposeBox: async (pid) => {
      calls.push({ fn: 'readComposeBox', pid });
      const launch = calls.filter((c) => c.fn === 'launch_app' && /phone=/.test(String(c.name || ''))).pop();
      const digits = launch ? String(launch.name).replace(/^.*phone=/, '') : '';
      return { ok: true, result: { name: 'Type a message to +' + digits, currentText: '', headerName: null } };
    },
    // WAVE 9 (BUG-067): Enter is unverifiable and, for MSIX WhatsApp, silently
    // discarded. Submitting invokes the app's Send button and requires the composer
    // to empty before a send is claimed.
    submitMessage: async (pid) => {
      calls.push({ fn: 'submitMessage', pid });
      return { ok: true, unverified: false, result: { submitted: true, mechanism: 'uia-invoke-send', clearedText: 'x' } };
    },
  };
  Object.assign(fakePc, pcOverrides || {});
  require.cache[FROM_PC_PATH] = { id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true, exports: fakePc };
  delete require.cache[WHATSAPP_PATH];
  const wa = require('../src/core/effectors/from-whatsapp');
  return { wa, calls, fakePc };
}

// Minimal vault stub exposing only readJSONStrict, which is what loadContacts uses.
function withContacts(wa, contacts) {
  wa.registerFromWhatsapp({ register() {} }, {
    memory: { fs: { readJSONStrict: () => contacts } },
    logger: { warn() {}, info() {} },
  });
}

describe('whatsapp_send', () => {
  beforeEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('resolves a contact name, opens the right chat by deep link, types and sends', async () => {
    const { wa, calls } = load();
    withContacts(wa, { dad: '+15551234567', mom: '+15559876543' });

    const res = await wa.whatsapp_send({ to: 'dad', text: 'Hi, how are you doing?' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(res.result.sent, true);
    assert.equal(res.result.number, '+15551234567');

    const launch = calls.find((c) => c.fn === 'launch_app');
    assert.equal(launch.name, 'whatsapp://send?phone=15551234567',
      'the deep link is what makes WhatsApp resolve the contact instead of us guessing');

    // Order matters, and WAVE 9 inserted two steps into it: the composer is read
    // BEFORE typing (so the wrong conversation is caught before a character is
    // typed), and submitting replaced Enter (which this app silently discards).
    const order = calls.map((c) => c.fn);
    assert.deepEqual(order, ['launch_app', 'focus_window', 'readComposeBox', 'ui_type', 'submitMessage']);
    assert.equal(calls.find((c) => c.fn === 'ui_type').text, 'Hi, how are you doing?');
    assert.equal(calls.some((c) => c.fn === 'send_key'), false,
      'Enter is not the submit path — it cannot be verified and does not work for MSIX WhatsApp');
  });

  it('does not claim delivery it cannot verify', async () => {
    const { wa } = load();
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.match(res.result.note, /cannot confirm/i,
      'pressing Enter is evidence of submission, not a delivery receipt');
  });

  it('accepts a raw phone number without any contacts file', async () => {
    const { wa, calls } = load();
    withContacts(wa, {});
    const res = await wa.whatsapp_send({ to: '+1 (555) 123-4567', text: 'hi' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(calls.find((c) => c.fn === 'launch_app').name, 'whatsapp://send?phone=15551234567');
  });

  it('is case- and phrasing-tolerant about the contact name', async () => {
    const { wa } = load();
    withContacts(wa, { dad: '+15551234567' });
    assert.equal((await wa.whatsapp_send({ to: 'Dad', text: 'hi' })).ok, true);
    assert.equal((await wa.whatsapp_send({ to: 'my dad', text: 'hi' })).ok, true);
  });

  it('refuses an ambiguous contact rather than guessing which human to message', async () => {
    const { wa, calls } = load();
    withContacts(wa, { 'dad mobile': '+15551112222', 'dad work': '+15553334444' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /more than one contact/);
    assert.equal(calls.length, 0, 'nothing may be opened or typed while the recipient is ambiguous');
  });

  it('asks for the number when the contact is unknown, and names what it does know', async () => {
    const { wa, calls } = load();
    withContacts(wa, { mom: '+15559876543' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /do not have a number for "dad"/);
    assert.match(res.result, /mom/, 'the honest error should say which contacts exist');
    assert.match(res.result, /Contacts\/contacts\.json/, 'and where to add one');
    assert.equal(calls.length, 0);
  });

  it('does not press Enter when the window cannot be focused', async () => {
    const { wa, calls } = load({
      focus_window: async () => ({ ok: false, result: 'blocked by the OS foreground-lock' }),
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /NOT sent/);
    assert.equal(calls.filter((c) => c.fn === 'send_key').length, 0);
    assert.equal(calls.filter((c) => c.fn === 'ui_type').length, 0);
  });

  it('does not press Enter when the text landed in the wrong window', async () => {
    // ui_type's own cross-check produces this; whatsapp_send must respect it
    // rather than sending blind.
    const { wa, calls } = load({
      ui_type: async () => ({ ok: false, result: 'Typed into the wrong window: the text went to "MYTHOS"' }),
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /Nothing was sent/);
    assert.equal(calls.filter((c) => c.fn === 'send_key').length, 0);
  });

  it('reports the message as composed-but-unsent when the submit cannot be proven', async () => {
    // WAVE 9 (BUG-067): the failure that matters is no longer "the keystroke was
    // rejected" but "the message is still in the box". On 2026-08-01 Enter was
    // ACCEPTED and the message never left, and this function reported sent:true.
    const { wa } = load({
      submitMessage: async () => ({
        ok: false,
        result: 'Tried uia-invoke-send, wm-char-return, sendinput-enter and the message is STILL in the box ("hi"), so it was NOT sent.',
      }),
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /NOT sent/);
    assert.match(res.result, /composer/, 'the operator needs to know the text is sitting there');
  });

  it('send:false composes without pressing Enter', async () => {
    const { wa, calls } = load();
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi', send: false });
    assert.equal(res.ok, true);
    assert.equal(res.result.sent, false);
    assert.equal(res.result.composed, true);
    assert.equal(calls.filter((c) => c.fn === 'send_key').length, 0);
  });

  it('refuses an empty message and a missing recipient', async () => {
    const { wa } = load();
    withContacts(wa, { dad: '+15551234567' });
    assert.equal((await wa.whatsapp_send({ to: 'dad', text: '   ' })).ok, false);
    assert.equal((await wa.whatsapp_send({ to: '', text: 'hi' })).ok, false);
  });

  it('fails honestly when WhatsApp is not installed', async () => {
    const { wa } = load({
      launch_app: async () => ({ ok: false, result: 'Failed to launch "whatsapp://send?phone=15551234567".' }),
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /WhatsApp Desktop installed/);
  });

  it('resolves the window by name when the URI launch reports no pid', async () => {
    let nth = 0;
    const { wa, calls } = load({
      launch_app: async (a) => {
        calls.push({ fn: 'launch_app', ...a });
        nth += 1;
        // A scheme launch often reports the handler, not the app.
        if (nth === 1) return { ok: true, result: { launched: true, note: 'no pid' } };
        return { ok: true, result: { pid: 777, launched: true } };
      },
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, true, String(res.result));
    const launches = calls.filter((c) => c.fn === 'launch_app').map((c) => c.name);
    assert.deepEqual(launches, ['whatsapp://send?phone=15551234567', 'whatsapp']);
    assert.equal(calls.find((c) => c.fn === 'ui_type').pid, 777);
  });

  it('refuses to type when no window can be identified at all', async () => {
    const { wa, calls } = load({
      launch_app: async (a) => { calls.push({ fn: 'launch_app', ...a }); return { ok: true, result: { launched: true } }; },
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(res.result, /NOT sent/);
    assert.equal(calls.filter((c) => c.fn === 'ui_type').length, 0,
      'typing into an unidentified window is how text ends up in the wrong app');
  });

  it('strips newlines so a multi-line message cannot submit itself early', async () => {
    const { wa, calls } = load();
    withContacts(wa, { dad: '+15551234567' });
    await wa.whatsapp_send({ to: 'dad', text: 'line one\nline two' });
    const typed = calls.find((c) => c.fn === 'ui_type').text;
    assert.equal(typed, 'line one line two');
    assert.doesNotMatch(typed, /\n/);
  });

  it('preserves punctuation and emoji in the message', async () => {
    // Guard against the control-character-range mistake: [ -] looks like "space
    // or hyphen" but is 0x20-0x2D, which silently eats spaces and punctuation.
    const { wa, calls } = load();
    withContacts(wa, { dad: '+15551234567' });
    const original = "Don't forget: 50% off (today) + free! 👋";
    await wa.whatsapp_send({ to: 'dad', text: original });
    assert.equal(calls.find((c) => c.fn === 'ui_type').text, original);
  });
});

describe('whatsapp_contacts', () => {
  beforeEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('lists names only — never phone numbers', async () => {
    const { wa } = load();
    withContacts(wa, { dad: '+15551234567', mom: '+15559876543' });
    const res = await wa.whatsapp_contacts();
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.contacts, ['dad', 'mom']);
    // A tool result is spoken aloud and written to episodic memory; a full phone
    // number has no reason to travel through either.
    assert.doesNotMatch(JSON.stringify(res.result), /\+?1555/);
  });

  it('explains how to add contacts when there are none', async () => {
    const { wa } = load();
    withContacts(wa, {});
    const res = await wa.whatsapp_contacts();
    assert.equal(res.ok, true);
    assert.deepEqual(res.result.contacts, []);
    assert.match(res.result.note, /Contacts\/contacts\.json/);
  });
});

describe('whatsapp tool tiers', () => {
  it('whatsapp_send is T3 and whatsapp_contacts is a plain read', () => {
    const { tierOf } = require('../src/core/leash/tiers');
    // Strictly more consequential than phone_whatsapp_send (which only pre-fills
    // and waits for a human tap) — this one presses Enter.
    assert.equal(tierOf('whatsapp_send'), 3);
    assert.equal(tierOf('whatsapp_contacts'), 0);
  });
});
