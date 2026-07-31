'use strict';

// ui-type-target-honesty.test.js — ui_type must never report success for
// keystrokes that landed somewhere other than the target window.
//
// THE BUG THIS FILE EXISTS FOR (reproduced live, vault/Episodic/2026-07-31.jsonl
// lines 100-107 and 172-177):
//   launch_app("notepad") returned ok:true with NO pid — Windows 11's Notepad is
//   MSIX-packaged, so the activation stub exits and Start-Process's pid is dead.
//   from-pc.js's lastLaunchedPid therefore stayed null. ui_type is tier-3, so the
//   human clicked Approve in the dashboard, which moved OS keyboard focus onto
//   MYTHOS's own window. With no pid, ui_type took its "type into whatever is
//   focused" branch, and SendInput genuinely typed all 24 characters — into
//   MYTHOS itself. It returned ok:true with typedIntoTitle:"MYTHOS".
//
//   ps-automation.ps1 was honest: it reported typedIntoPid/typedIntoTitle. But
//   nothing in JS ever compared them to the intended target, and both honesty
//   guards in voice-agent.js only fire on ok:false. So MYTHOS said "Message
//   delivered, Sir. Notepad is now displaying..." — a fabrication that no layer
//   could catch, because the TOOL was the thing lying, by omission.
//
// These tests drive from-pc.js against a fake pc-child, so they assert the
// cross-check itself rather than Windows behaviour. The real desktop path is
// covered by scripts/verify-notepad-typing.js.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const PC_CHILD_PATH = require.resolve('../adapters/pc-child');
const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');

// Replaces the pc-child module in the require cache with a scripted fake, so
// from-pc.js's module-level singleton talks to us.
function withFakeChild(handler) {
  const fake = {
    calls: [],
    startPcChild: async () => {},
    shutdownPcChild: async () => {},
    getStatus: () => ({ state: 'ONLINE', hint: '', queueDepth: 0 }),
    sendCommand: async (cmd) => {
      fake.calls.push(cmd);
      return handler(cmd, fake.calls);
    },
  };
  require.cache[PC_CHILD_PATH] = { id: PC_CHILD_PATH, filename: PC_CHILD_PATH, loaded: true, exports: fake };
  delete require.cache[FROM_PC_PATH];
  return { fake, fromPc: require('../src/core/effectors/from-pc') };
}

describe('ui_type target cross-check', () => {
  beforeEach(() => {
    delete require.cache[PC_CHILD_PATH];
    delete require.cache[FROM_PC_PATH];
  });
  afterEach(() => {
    delete require.cache[PC_CHILD_PATH];
    delete require.cache[FROM_PC_PATH];
  });

  it('fails honestly when the keystrokes land in a different window than the target', async () => {
    const { fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'focus_window') return { ok: true, result: { pid: cmd.pid, focused: true } };
      if (cmd.cmd === 'ui_type') {
        // The exact shape ps-automation.ps1 returned during the live incident.
        return { ok: true, result: { typed: true, length: 24, typedIntoPid: 13752, typedIntoTitle: 'MYTHOS' } };
      }
      return { ok: true, result: {} };
    });

    const res = await fromPc.ui_type({ text: 'Hi Alex, this is Mythos.', pid: 4242 });
    assert.equal(res.ok, false, 'typing into the wrong window must not be reported as success');
    assert.match(res.result, /wrong window/i);
    assert.match(res.result, /MYTHOS/, 'the honest error must name where the text actually went');
    assert.match(res.result, /4242/, 'and which target was intended');
  });

  it('refuses to claim success when, with no target, the text lands in the MYTHOS dashboard', async () => {
    const { fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'ui_type') {
        return { ok: true, result: { typed: true, length: 10, typedIntoPid: 13752, typedIntoTitle: 'MYTHOS' } };
      }
      return { ok: true, result: {} };
    });

    // No pid, and no prior launch_app, so this is the "type into whatever is
    // focused" branch — which after an Approve click is MYTHOS itself.
    const res = await fromPc.ui_type({ text: 'some text' });
    assert.equal(res.ok, false);
    assert.match(res.result, /dashboard/i);
  });

  it('passes through a genuine success where the target received the text', async () => {
    const { fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'focus_window') return { ok: true, result: { pid: cmd.pid, focused: true, method: 'attach-thread-input' } };
      if (cmd.cmd === 'ui_type') {
        return { ok: true, result: { typed: true, length: 9, typedIntoPid: cmd.pid, typedIntoTitle: 'Untitled - Notepad' } };
      }
      return { ok: true, result: {} };
    });

    const res = await fromPc.ui_type({ text: 'some text', pid: 5150 });
    assert.equal(res.ok, true);
    assert.equal(res.result.typedIntoPid, 5150);
  });

  it('does not fabricate a mismatch when the child reports no landing pid at all', async () => {
    // Older/other handlers may not include typedIntoPid. Absence is not evidence
    // of a wrong window, so the result must pass through unchanged.
    const { fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'focus_window') return { ok: true, result: { focused: true } };
      if (cmd.cmd === 'ui_type') return { ok: true, result: { typed: true, length: 4 } };
      return { ok: true, result: {} };
    });
    const res = await fromPc.ui_type({ text: 'text', pid: 99 });
    assert.equal(res.ok, true);
  });

  it('aborts when the target window cannot be focused, rather than typing blind', async () => {
    const { fake, fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'focus_window') {
        return { ok: false, error: 'Failed to bring PID 77 to the foreground (blocked by the OS foreground-lock).' };
      }
      return { ok: true, result: { typed: true, length: 4, typedIntoPid: 1, typedIntoTitle: 'Something Else' } };
    });
    const res = await fromPc.ui_type({ text: 'text', pid: 77 });
    assert.equal(res.ok, false);
    assert.match(res.result, /foreground-lock/);
    assert.equal(fake.calls.filter((c) => c.cmd === 'ui_type').length, 0,
      'no keystrokes may be sent once focus is known to have failed');
  });
});

describe('launch_app opens a fresh document for session-restoring apps', () => {
  beforeEach(() => {
    delete require.cache[PC_CHILD_PATH];
    delete require.cache[FROM_PC_PATH];
  });
  afterEach(() => {
    delete require.cache[PC_CHILD_PATH];
    delete require.cache[FROM_PC_PATH];
  });

  it('focuses and opens a verified new document after launching notepad', async () => {
    // WAVE 9 (BUG-062). This test used to assert `ctrl+n` was sent, and passed
    // while the real behaviour was broken: ctrl+n rides SendInput, which Win11's
    // packaged Notepad silently discards (BUG-061), so no tab ever opened and the
    // operator got their restored .env with freshDocument:true on top. Asserting
    // the keystroke was sent could never have caught that — only asserting the
    // OUTCOME can, which is what new_document reports.
    const { fake, fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'launch_app') return { ok: true, result: { pid: 321, name: cmd.name, launched: true } };
      if (cmd.cmd === 'focus_window') return { ok: true, result: { pid: cmd.pid, focused: true, visible: true } };
      if (cmd.cmd === 'new_document') return { ok: true, result: { fresh: true, created: true, via: 'uia-invoke-addbutton', tabsBefore: 1, tabsAfter: 2 } };
      return { ok: true, result: {} };
    });

    const res = await fromPc.launch_app({ name: 'notepad' });
    assert.equal(res.ok, true);
    assert.equal(res.result.freshDocument, true);
    assert.equal(res.result.freshDocumentVia, 'uia-invoke-addbutton');
    assert.deepEqual(fake.calls.filter((c) => c.cmd === 'new_document').map((c) => c.pid), [321]);
    assert.equal(fake.calls.some((c) => c.cmd === 'send_key'), false,
      'Windows 11 Notepad restores previous tabs, and a keystroke cannot prove a new one opened');
  });

  it('reports the launch as successful but flags an unconfirmed fresh document', async () => {
    // A convenience step failing must not turn into a false launch failure — nor
    // into a silent claim that the document is blank.
    const { fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'launch_app') return { ok: true, result: { pid: 321, launched: true } };
      if (cmd.cmd === 'focus_window') return { ok: false, error: 'blocked by the OS foreground-lock' };
      return { ok: true, result: {} };
    });
    const res = await fromPc.launch_app({ name: 'notepad' });
    assert.equal(res.ok, true, 'the app did launch');
    assert.equal(res.result.freshDocument, false);
    assert.match(res.result.freshDocumentError, /foreground-lock/);
  });

  it('leaves other apps alone', async () => {
    const { fake, fromPc } = withFakeChild((cmd) => {
      if (cmd.cmd === 'launch_app') return { ok: true, result: { pid: 555, launched: true } };
      return { ok: true, result: {} };
    });
    await fromPc.launch_app({ name: 'spotify' });
    assert.equal(fake.calls.filter((c) => c.cmd === 'send_key').length, 0);
    assert.equal(fake.calls.filter((c) => c.cmd === 'new_document').length, 0);
  });
});

describe('send_key accepts modifier combos', () => {
  beforeEach(() => {
    delete require.cache[PC_CHILD_PATH];
    delete require.cache[FROM_PC_PATH];
  });
  afterEach(() => {
    delete require.cache[PC_CHILD_PATH];
    delete require.cache[FROM_PC_PATH];
  });

  it('forwards a valid combo and normalises case', async () => {
    const { fake, fromPc } = withFakeChild(() => ({ ok: true, result: { sent: true } }));
    const res = await fromPc.send_key({ key: 'Ctrl+N' });
    assert.equal(res.ok, true);
    assert.equal(fake.calls[0].key, 'ctrl+n');
  });

  it('still accepts the original named keys', async () => {
    const { fake, fromPc } = withFakeChild(() => ({ ok: true, result: { sent: true } }));
    assert.equal((await fromPc.send_key({ key: 'enter' })).ok, true);
    // WAVE 2: a bare `enter` now probes get_foreground_window first, to refuse
    // pressing Send in a messaging app with nothing verifiably typed. So the
    // keystroke is no longer necessarily calls[0] — assert on the send_key call
    // itself rather than on its position, which is what this test cares about.
    const keyCall = fake.calls.find((c) => c.cmd === 'send_key');
    assert.ok(keyCall, 'the keystroke must still be forwarded');
    assert.equal(keyCall.key, 'enter');
  });

  it('rejects an unknown modifier and an unknown base key', async () => {
    const { fromPc } = withFakeChild(() => ({ ok: true, result: {} }));
    assert.equal((await fromPc.send_key({ key: 'hyper+n' })).ok, false);
    assert.equal((await fromPc.send_key({ key: 'ctrl+nope' })).ok, false);
    assert.equal((await fromPc.send_key({ key: 'banana' })).ok, false);
  });
});
