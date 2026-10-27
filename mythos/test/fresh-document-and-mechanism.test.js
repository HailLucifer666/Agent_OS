'use strict';

// WAVE 9 — the two lies that survived Waves 0-8, both found by measurement rather
// than argument on 2026-07-31 evening.
//
// BUG-061. ui_type's only injection mechanism was SendInput, and SendInput is
// documented to fail SILENTLY when blocked by UIPI: "neither GetLastError nor the
// return value will indicate the failure". Win11's packaged Notepad is such a
// target. Measured with diagnose_type once its inter-route clear stopped riding
// the mechanism under test:
//     uia-valuepattern-setvalue    LANDED
//     uia-setfocus-then-sendinput  did NOT land (48 events "injected")
//     sendinput-unicode            did NOT land (48 events "injected")
//     wm-char-post                 LANDED
// So ui_type now escalates on the read-back oracle's verdict, and reports which
// mechanism actually delivered the text.
//
// BUG-062. launch_app("notepad") claimed freshDocument:true whenever `send_key
// ctrl+n` returned ok. ctrl+n rides SendInput too, so it opened nothing, and the
// operator asked for a fresh Notepad and got their own .env restored in a tab
// while being told the document was fresh. The oracle is now a rising TAB COUNT
// plus an empty active document, via UIA's Add-New-Tab button.

const { answersResolve } = require('./helpers/launch-resolve'); // B2a: stubs answer resolve_app
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const originalRequire = Module.prototype.require;

// from-pc.js captures its pc-child handle at module load, so restoring the stub
// once require() has returned is safe even for async calls made later.
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

// Records every command, so a test can assert on what was NOT sent as well as
// what was — "it never asked for a new document" is the interesting assertion for
// the opt-out.
function pcChild(handlers) {
  const calls = [];
  return {
    calls,
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => { const resolvedTarget = answersResolve(c); if (resolvedTarget) return resolvedTarget;
      calls.push(c);
      const h = handlers[c.cmd];
      if (typeof h === 'function') return h(c);
      if (h) return h;
      return { ok: true, result: {} };
    },
  };
}

// A FACTORY, not a shared object: launch_app annotates res.result in place
// (freshDocument etc.), so a shared literal would leak one test's mutation into
// the next and make an assertion pass for the wrong reason.
const LAUNCHED = () => ({ ok: true, result: { launched: true, matchedBy: 'process', resolved: true, name: 'notepad', pid: 4242, resolvedVia: 'registry-app-paths' } });

describe('WAVE 9 (BUG-062) — "open notepad" means a BLANK document', () => {
  it('a new_document that cannot prove a blank document does NOT set freshDocument', async () => {
    // The exact tonight-shape: the command succeeds at the protocol level while
    // reporting that it could not confirm anything. Trusting ok alone is what
    // produced freshDocument:true over a restored .env tab.
    const pc = pcChild({
      launch_app: () => LAUNCHED(),
      focus_window: (c) => ({ ok: true, result: { focused: true, visible: true, pid: c.pid } }),
      new_document: () => ({ ok: true, result: { fresh: false, error: 'the active document still contains text' } }),
    });
    await withMockedPcChild(pc, async (m) => {
      const res = await m.launch_app({ name: 'notepad' });
      assert.equal(res.result.freshDocument, false, 'ok:true is not proof of a blank document');
      assert.match(res.result.freshDocumentError, /still contains text/);
    });
  });

  it('a verified new tab reports freshDocument with the mechanism that opened it', async () => {
    const pc = pcChild({
      launch_app: () => LAUNCHED(),
      focus_window: (c) => ({ ok: true, result: { focused: true, visible: true, pid: c.pid } }),
      new_document: () => ({ ok: true, result: { fresh: true, created: true, via: 'uia-invoke-addbutton', tabsBefore: 1, tabsAfter: 2 } }),
    });
    await withMockedPcChild(pc, async (m) => {
      const res = await m.launch_app({ name: 'notepad' });
      assert.equal(res.result.freshDocument, true);
      assert.equal(res.result.freshDocumentVia, 'uia-invoke-addbutton');
    });
  });

  it('existing:true reuses the open document and never asks for a new one', async () => {
    // The operator's opt-out. Recorded in vault/Semantic/user-facts.md as "always
    // open a new Notepad unless the user specifies a filename" and, until now,
    // enforced by nothing.
    const pc = pcChild({ launch_app: () => LAUNCHED() });
    await withMockedPcChild(pc, async (m) => {
      const res = await m.launch_app({ name: 'notepad', existing: true });
      assert.equal(res.ok, true);
      assert.equal(res.result.freshDocument, undefined, 'the fresh-document step must be skipped entirely');
      assert.equal(pc.calls.some((c) => c.cmd === 'new_document'), false);
    });
  });

  it('apps that do not restore a session are left alone', async () => {
    const pc = pcChild({ launch_app: () => ({ ok: true, result: { launched: true, matchedBy: 'process', name: 'calc', pid: 99 } }) });
    await withMockedPcChild(pc, async (m) => {
      await m.launch_app({ name: 'calc' });
      assert.equal(pc.calls.some((c) => c.cmd === 'new_document'), false);
    });
  });

  it('a launch that resolved only by window TITLE never opens a document in it', async () => {
    // Wave 1's rule still holds: an unresolved launch carries no pid, so nothing
    // downstream may act on it. A new_document into a title-matched window would
    // be the BUG-052 mistake with a new tool.
    const pc = pcChild({
      launch_app: () => ({ ok: true, result: { launched: true, matchedBy: 'title', candidatePid: 777, candidateTitle: 'notes about notepad' } }),
    });
    await withMockedPcChild(pc, async (m) => {
      const res = await m.launch_app({ name: 'notepad' });
      assert.equal(res.unverified, true);
      assert.equal(pc.calls.some((c) => c.cmd === 'new_document'), false);
      assert.equal(pc.calls.some((c) => c.cmd === 'focus_window'), false);
    });
  });
});

describe('WAVE 9 (BUG-061) — ui_type reports the mechanism that actually delivered', () => {
  function pcTyping(typeResult) {
    return pcChild({
      focus_window: (c) => ({ ok: true, result: { focused: true, visible: true, pid: c.pid } }),
      get_foreground_window: () => ({ ok: true, result: { pid: 4242, title: 'Untitled - Notepad', process: 'Notepad' } }),
      ui_type: (c) => ({ ok: true, result: Object.assign({ typed: true, typedIntoPid: c.pid, typedIntoTitle: 'Untitled - Notepad' }, typeResult) }),
    });
  }

  it('an escalated type is VERIFIED and names the mechanism that worked', async () => {
    await withMockedPcChild(pcTyping({
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'Hi Alex',
      mechanism: 'uia-setvalue', mechanismsTried: ['sendinput-unicode', 'uia-setvalue'],
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 4242 });
      assert.equal(res.ok, true);
      assert.equal(res.unverified, false, 'a read-back that quotes the text back is proof');
      assert.equal(res.result.mechanism, 'uia-setvalue');
      assert.deepEqual(res.result.mechanismsTried, ['sendinput-unicode', 'uia-setvalue']);
    });
  });

  it('a mismatch after every mechanism is a FAILURE, not an unverified success', async () => {
    // If SendInput, SetValue and WM_CHAR have all been tried and the window still
    // does not contain the text, there is nothing left to be optimistic about.
    await withMockedPcChild(pcTyping({
      readBack: 'mismatch', readBackVia: 'ValuePattern', readBackText: '',
      readBackReason: 'the control does not contain the text after injection',
      mechanism: 'sendinput-unicode',
      mechanismsTried: ['sendinput-unicode', 'uia-setvalue', 'wm-char-post'],
    }), async (m) => {
      const res = await m.ui_type({ text: 'Hi Alex', pid: 4242 });
      assert.equal(res.ok, false, 'the oracle contradicted the claim — that is a failure');
    });
  });
});
