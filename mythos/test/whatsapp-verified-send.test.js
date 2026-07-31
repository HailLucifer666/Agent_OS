'use strict';

// WAVE 9 — WhatsApp: prove the right person, then prove it actually left the box.
//
// Two real failures from the 2026-07-31/08-01 live session, both of which every
// pre-existing guard passed:
//
// BUG-064. whatsapp_send verified the WINDOW and never the RECIPIENT. WhatsApp's
// window title is "(194) WhatsApp" whether the open conversation is your mother or
// your employer, so a deep link that failed to switch chats would leave the
// PREVIOUS conversation open and the message would be typed there and submitted.
// The oracle is now the app's own words: its composer is named
// "Type a message to <recipient>".
//
// BUG-067. whatsapp_send reported sent:true while the message sat in the composer.
// `send_key('enter')` rides SendInput, which MSIX-packaged WhatsApp silently
// discards, so Enter was "accepted" and nothing was submitted. Sending is now done
// by invoking WhatsApp's own Send button and is only claimed once the composer has
// emptied.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const WA_PATH = path.resolve(__dirname, '../src/core/effectors/from-whatsapp.js');
const originalRequire = Module.prototype.require;

// Stubs from-pc so no real window is touched. from-whatsapp requires it at module
// load, so the stub must be installed before the require and the module cache
// cleared either side of it.
function withFromPc(stub, fn) {
  Module.prototype.require = function (id) {
    if (id === './from-pc') return stub;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[WA_PATH];
  try {
    const wa = require(WA_PATH);
    wa.registerFromWhatsapp({ register: () => {} }, {
      memory: { fs: { readJSONStrict: () => ({ alex: '+919903382050' }) } },
      logger: { warn() {} },
    });
    return fn(wa);
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[WA_PATH];
  }
}

// A from-pc whose every step succeeds, with the composer addressed to `addressedTo`.
function fromPcStub(overrides) {
  const calls = [];
  const base = {
    calls,
    launch_app: async (a) => { calls.push(['launch_app', a]); return { ok: true, result: { pid: 19716, launched: true, matchedBy: 'process' } }; },
    focus_window: async (a) => { calls.push(['focus_window', a]); return { ok: true, result: { pid: a.pid, focused: true, visible: true } }; },
    readComposeBox: async (pid) => { calls.push(['readComposeBox', pid]); return { ok: true, result: { name: 'Type a message to +91 99033 82050', currentText: '', headerName: '+91 99033 82050 (You) Message yourself' } }; },
    ui_type: async (a) => { calls.push(['ui_type', a]); return { ok: true, unverified: false, result: { typed: true, readBack: 'confirmed', readBackText: a.text, typedIntoPid: a.pid, typedIntoTitle: 'WhatsApp', focusedPid: 20088 } }; },
    submitMessage: async (pid) => { calls.push(['submitMessage', pid]); return { ok: true, unverified: false, result: { submitted: true, mechanism: 'uia-invoke-send', clearedText: 'x' } }; },
    send_key: async (a) => { calls.push(['send_key', a]); return { ok: true, result: { sent: true } }; },
  };
  return Object.assign(base, overrides || {});
}

describe('WAVE 9 (BUG-064) — the composer must name the intended recipient', () => {
  it('REFUSES, without typing, when the open chat is someone else', async () => {
    // The dangerous case: everything about the window checks out and the wrong
    // conversation is on screen. Typing here then submitting sends to the wrong
    // human, which is not recoverable.
    const pc = fromPcStub({
      readComposeBox: async () => ({ ok: true, result: { name: 'Type a message to Priya Sharma', headerName: 'Priya Sharma' } }),
    });
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, false);
      assert.match(res.result, /REFUSED/);
      assert.match(res.result, /Priya Sharma/, 'the operator must be told who was actually on screen');
      assert.equal(pc.calls.some((c) => c[0] === 'ui_type'), false, 'nothing may be typed');
      assert.equal(pc.calls.some((c) => c[0] === 'submitMessage'), false, 'nothing may be sent');
    });
  });

  it('REFUSES when the composer cannot be read at all', async () => {
    const pc = fromPcStub({
      readComposeBox: async () => ({ ok: false, result: 'No editable element found in the foreground window' }),
    });
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, false);
      assert.equal(pc.calls.some((c) => c[0] === 'ui_type'), false,
        'no oracle means no typing — an unreadable composer is not permission to guess');
    });
  });

  it('proceeds when the composer names the number, and records it as evidence', async () => {
    const pc = fromPcStub();
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, true);
      assert.equal(res.result.sent, true);
      assert.match(res.result.addressedTo, /99033 82050/, 'the addressee is evidence, not an assumption');
      assert.equal(res.result.submittedVia, 'uia-invoke-send');
    });
  });

  it('accepts a header that names a saved CONTACT rather than a number', async () => {
    // Once WhatsApp knows a contact it labels the chat by name, so requiring digits
    // would refuse every send to a saved contact.
    const pc = fromPcStub({
      readComposeBox: async () => ({ ok: true, result: { name: 'Type a message', headerName: 'Alex' } }),
    });
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, true, 'a name match is as good as a number match');
    });
  });

  it('reports a draft that was already in the box instead of silently appending to it', async () => {
    const pc = fromPcStub({
      readComposeBox: async () => ({ ok: true, result: { name: 'Type a message to +91 99033 82050', currentText: 'half-written thought' } }),
    });
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, true);
      assert.equal(res.result.priorDraft, 'half-written thought');
    });
  });
});

describe('WAVE 9 (BUG-067) — a send is only claimed once the box has emptied', () => {
  it('a submit that leaves the message in the box is NOT reported as sent', async () => {
    // The 2026-08-01 failure exactly: ok:true from the keystroke, message still
    // sitting there, "sent: true" spoken to the operator.
    const pc = fromPcStub({
      submitMessage: async () => ({
        ok: false,
        result: 'Tried uia-invoke-send, wm-char-return, sendinput-enter and the message is STILL in the box ("hello"), so it was NOT sent.',
      }),
    });
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, false);
      assert.match(res.result, /NOT sent/);
      assert.match(res.result, /sitting in the composer/);
      assert.doesNotMatch(res.result, /\[object Object\]/,
        'the reason must survive into the message — String(obj) threw it away once already');
    });
  });

  it('never falls back to a bare Enter keystroke, which cannot be verified', async () => {
    const pc = fromPcStub();
    await withFromPc(pc, async (wa) => {
      await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(pc.calls.some((c) => c[0] === 'send_key'), false,
        'send_key(enter) is accepted by SendInput and discarded by this app — it must not be the submit path');
      assert.equal(pc.calls.some((c) => c[0] === 'submitMessage'), true);
    });
  });

  it('send:false composes without submitting anything', async () => {
    const pc = fromPcStub();
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      assert.equal(res.ok, true);
      assert.equal(res.result.sent, false);
      assert.equal(res.result.composed, true);
      assert.equal(pc.calls.some((c) => c[0] === 'submitMessage'), false);
    });
  });

  it('a type that could not be verified stops the send', async () => {
    const pc = fromPcStub({
      ui_type: async (a) => ({ ok: false, result: { error: 'the text is not in the window' }, unverified: false }),
    });
    await withFromPc(pc, async (wa) => {
      const res = await wa.whatsapp_send({ to: 'alex', text: 'hello' });
      assert.equal(res.ok, false);
      assert.match(res.result, /not in the window/, 'reasonText must unwrap result.error');
      assert.equal(pc.calls.some((c) => c[0] === 'submitMessage'), false);
    });
  });
});
