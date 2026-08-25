'use strict';

// test/whatsapp-window-process-family.test.js — 2026-08-21 capability audit.
//
// THE INCIDENT. whatsapp_send's list_windows fallback (BUG-273 C1) matched
// `processName === 'whatsapp'` exactly. The WhatsApp desktop app on this
// machine reports its process as **"WhatsApp.Root"** — measured, 23 occurrences
// of `"processName":"WhatsApp.Root"` across the live vault and
// mythos-server.log, and not one occurrence of a bare "WhatsApp" process.
// Lower-cased that is "whatsapp.root", which never equals "whatsapp", so the
// fallback could not identify the window it was looking at. Three of
// whatsapp_send's 24 recorded failures are "WhatsApp opened the chat with X,
// but I could not identify its window, so I cannot type into it".
//
// WHY 171 PASSING TESTS DID NOT CATCH IT — and the reason this file exists.
// bug-273-c1-whatsapp-window-resolution.test.js builds its rows from
// `processName: 'WhatsApp'`, which lower-cases to exactly the string the
// matcher wanted. The fixture was more generous than the wire: it fed the
// matcher the one spelling that works, so the gate went green over a code path
// that could never fire on the real machine. Every row below is built from the
// string the OS actually reports.
//
// A GUESS THIS FILE DELIBERATELY DOES NOT SHIP. The remediation plan proposed
// /^whatsapp(desktop|beta)?$/ for "MSIX/UWP channel variants". That regex is
// invented — it matches none of the 23 observed samples, and would have left
// the bug exactly where it was while looking like a fix. The pattern here
// admits only what was measured (a bare name, or a dotted MSIX sub-process
// suffix such as ".Root"), and the test data is the observed string.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const WHATSAPP_PATH = require.resolve('../src/core/effectors/from-whatsapp');
const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');

// The exact spelling the live machine reports.
const REAL_PROCESS_NAME = 'WhatsApp.Root';

function loadWithFakePc(fakePc) {
  delete require.cache[WHATSAPP_PATH];
  delete require.cache[FROM_PC_PATH];
  require.cache[FROM_PC_PATH] = { id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true, exports: fakePc };
  const mod = require(WHATSAPP_PATH);
  mod.registerFromWhatsapp({ register() {} }, {
    memory: { fs: { readJSONStrict: (p, fb) => (p === 'Contacts/contacts.json' ? { alex: '+919903382050' } : fb) } },
  });
  return mod;
}

function cleanup() {
  delete require.cache[WHATSAPP_PATH];
  delete require.cache[FROM_PC_PATH];
}

// Minimal from-pc that gets as far as window resolution and then records which
// pid (if any) the resolver settled on. Everything after typing is stubbed to
// fail fast — this file is about window identification only.
function fakePcReporting(windows, seen) {
  // Only the six methods from-whatsapp.js actually calls on from-pc
  // (grepped, not guessed): launch_app, focus_window, list_windows,
  // readComposeBox, ui_type, submitMessage. readComposeBox is the first call
  // AFTER a pid has been chosen, so recording its pid is what proves window
  // identification succeeded.
  const record = (pid) => { seen.push(pid); };
  return {
    launch_app: async () => ({ ok: true, result: {} }),
    focus_window: async () => ({ ok: true, result: {} }),
    list_windows: async () => ({ ok: true, result: { windows, total: windows.length } }),
    readComposeBox: async (pid) => { record(pid); return { ok: false, error: "stop here — window identification is all this file tests" }; },
    ui_type: async (pid) => { record(pid); return { ok: false, error: "stop here" }; },
    submitMessage: async () => ({ ok: false, error: "stop here" }),
  };
}

describe('whatsapp window resolution matches the process family the OS reports', () => {
  it('the observed process name is not what the old matcher required (negative control)', () => {
    // Guards the premise of the whole file. If WhatsApp ever does report a bare
    // "whatsapp", this assertion fails and tells the next reader that the
    // motivating condition is gone.
    assert.notEqual(
      REAL_PROCESS_NAME.toLowerCase(), 'whatsapp',
      'this fix exists because the real process name is NOT the bare string the old matcher compared against'
    );
    assert.match(REAL_PROCESS_NAME.toLowerCase(), /^whatsapp\./);
  });

  it('identifies the window when the process is reported as "WhatsApp.Root"', async () => {
    const seen = [];
    const rows = [{ pid: 7788, processName: REAL_PROCESS_NAME, title: '(194) WhatsApp', visible: true }];
    const mod = loadWithFakePc(fakePcReporting(rows, seen));
    try {
      const out = await mod.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      // The send is stubbed to fail downstream; what matters is that it got PAST
      // window identification. Assert the mechanism (a pid was adopted and used),
      // not the return value — returning a failure while never having identified
      // the window is exactly the bug wearing a fix's clothes.
      assert.ok(
        seen.includes(7788),
        'the resolver must have adopted pid 7788 from the WhatsApp.Root row; instead it never typed. Result: ' +
          JSON.stringify(out && out.result || out)
      );
      const text = JSON.stringify(out);
      assert.ok(!/could not identify its window/.test(text),
        'must not report the window as unidentifiable: ' + text);
    } finally { cleanup(); }
  });

  it('still refuses when no WhatsApp-family window is present at all', async () => {
    const seen = [];
    const rows = [{ pid: 10, processName: 'chrome', title: 'WhatsApp Web - Google Chrome', visible: true }];
    const mod = loadWithFakePc(fakePcReporting(rows, seen));
    try {
      const out = await mod.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      assert.equal(out.ok, false);
      assert.ok(!seen.includes(10), 'a Chrome window must never be typed into');
    } finally { cleanup(); }
  });

  it('a browser tab TITLED WhatsApp is still never matched — title is not evidence', async () => {
    // The original Q1 rule, re-asserted against the widened matcher. Widening
    // the process family must not have widened it into title territory.
    const seen = [];
    const rows = [
      { pid: 11, processName: 'msedge', title: 'WhatsApp', visible: true },
      { pid: 12, processName: 'explorer', title: 'WhatsApp Files', visible: true },
    ];
    const mod = loadWithFakePc(fakePcReporting(rows, seen));
    try {
      await mod.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      assert.deepEqual(seen, [], 'no non-WhatsApp process may be adopted, whatever its title');
    } finally { cleanup(); }
  });

  it('two visible WhatsApp-family windows still refuse rather than guessing', async () => {
    // BUG-273 C1's pinned disposition, preserved through the widening: picking
    // one of two at random is the guess the whole path exists to avoid.
    const seen = [];
    const rows = [
      { pid: 21, processName: REAL_PROCESS_NAME, title: '(1) WhatsApp', visible: true },
      { pid: 22, processName: 'WhatsApp', title: '(2) WhatsApp', visible: true },
    ];
    const mod = loadWithFakePc(fakePcReporting(rows, seen));
    try {
      const out = await mod.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      assert.equal(out.ok, false, 'two candidates must refuse');
      assert.deepEqual(seen, [], 'neither pid may be typed into when two are visible');
    } finally { cleanup(); }
  });

  it('an invisible WhatsApp window is not adopted', async () => {
    const seen = [];
    const rows = [{ pid: 31, processName: REAL_PROCESS_NAME, title: 'WhatsApp', visible: false }];
    const mod = loadWithFakePc(fakePcReporting(rows, seen));
    try {
      await mod.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      assert.deepEqual(seen, [], 'a hidden window is not somewhere a message can be typed');
    } finally { cleanup(); }
  });

  it('a lookalike process name is NOT adopted', async () => {
    // Q1: what else matches this? The pattern must not accept a process merely
    // starting with the letters "whatsapp" — that is how an unrelated helper or
    // a deliberately-named binary would inherit the send.
    const seen = [];
    const rows = [{ pid: 41, processName: 'WhatsAppSpoofer', title: 'WhatsApp', visible: true }];
    const mod = loadWithFakePc(fakePcReporting(rows, seen));
    try {
      await mod.whatsapp_send({ to: 'alex', text: 'hello', send: false });
      assert.deepEqual(seen, [], 'only the exact name or a dotted sub-process of it may match');
    } finally { cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// The "a fuzzy resolution is never silent" claim is the safety argument for the
// fuzzy recipient rung, so it must be asserted where the operator actually
// hears it — in whatsapp_send's own message — not merely on resolveRecipient's
// return value. Mutating the note out of the label left the fuzzy test file
// green, which means that file alone did not cover this. It does now.
describe('a fuzzy recipient substitution reaches the spoken result', () => {
  it('names the substituted contact in the message text, even when the send then fails', () => {
    const seen = [];
    const rows = [{ pid: 5150, processName: REAL_PROCESS_NAME, title: 'WhatsApp', visible: true }];
    delete require.cache[WHATSAPP_PATH];
    delete require.cache[FROM_PC_PATH];
    require.cache[FROM_PC_PATH] = {
      id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true,
      exports: fakePcReporting(rows, seen),
    };
    const mod = require(WHATSAPP_PATH);
    mod.registerFromWhatsapp({ register() {} }, {
      memory: {
        fs: {
          readJSONStrict: (p, fb) => (p === 'Contacts/contacts.json'
            ? { 'Mausumi Paul': '+6361119795' } : fb),
        },
      },
    });
    try {
      // "Mousumi Paul" is 1 edit from the saved "Mausumi Paul".
      return mod.whatsapp_send({ to: 'Mousumi Paul', text: 'hi', send: false }).then((out) => {
        const text = JSON.stringify(out);
        assert.match(text, /Mausumi Paul/, 'must name the contact it actually chose');
        assert.match(
          text, /closest match/i,
          'the substitution must be stated out loud, not just returned internally: ' + text
        );
      });
    } finally { cleanup(); }
  });
});
