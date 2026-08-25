'use strict';

// BUG-283 — "folder read/write access fails in a way it can save to desktop, but
// its tools tell it that it cannot save. And once it saves, cannot open that
// file if I close it."
//
// The report has two halves and only one of them is real. Both were settled
// against the audit vault of the 2026-08-20 session, in order, before any code
// was touched.
//
// HALF ONE — "its tools tell it that it cannot save" — DOES NOT REPRODUCE.
// The audit and episodic records show the save path working exactly as designed:
//   write_file  decision:"confirm"   reason:"tier-3-requires-confirm"
//   MYTHOS says "Saving to the desktop now, Sir. I have the file queued ...
//                Just awaiting your final confirmation to proceed."
//   write_file  decision:"completed" outcome:"ok"  actor:"confirm-accept"
//   MYTHOS says "Recipe saved to your desktop, Sir."
// No Save-menu call preceded it, no ui_click, nothing failed. The deferred
// -confirm design (live-tool-adapter.js) answered awaiting_human_confirmation,
// the model narrated the wait, the operator clicked, and resolveLiveConfirm
// narrated the success. The scoping handoff for this work proposed a fix built
// on Notepad's known-broken WinUI3 Save menu (BUG-274 T5) being tried first.
// It was not tried. That hypothesis is retracted and no code was changed for it.
//
// HALF TWO — "cannot open that file if I close it" — IS REAL, and this file is
// about the one seam in it that is ours to fix.
//   MYTHOS: "Launching blank Notepad, Sir. Cannot open that specific file.
//            System limitation."
// It is not a system limitation. open_artifact is in live-tools.js's
// DEFAULT_ALLOWLIST and was declared for the whole session. It was never called
// once. Instead: launch_app notepad, send_key ctrl+o (which reported only "the
// keystroke was accepted, but I did not verify what it did"), a close_window
// that failed, and finally open_folder on the Desktop.
//
// Earlier in that same session open_folder had been handed a FILE path and
// returned "That is a file, not a folder: ...capabilities.txt. Use open_artifact
// for files." The remedy was named, in the failure string, and the model still
// did not take it — then later called the whole capability a system limitation.
//
// That is the third time this tool has lost a tool-selection race for this
// intent; the previous round is recorded in from-computer.js's own comments,
// where the model reached for launch_app('explorer.exe "D:\\..."') three times
// and the remedy was a longer description. Prose has now lost twice. So the
// dead end goes instead of being re-worded a third time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const FROM_COMPUTER_PATH = path.resolve(__dirname, '../src/core/effectors/from-computer.js');
const originalRequire = Module.prototype.require;

// Same harness shape as open-folder-and-suggestions.test.js: stub pc-child so
// the window oracle is deterministic, and spy on spawn so no Explorer window
// opens on the machine running the suite. The spawn ARGS are the mechanism under
// test here — asserting only res.ok would pass on a tool that opened the wrong
// thing.
async function withPc(mock, fn) {
  const spawned = [];
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    if (id === 'child_process') {
      return Object.assign({}, originalRequire.call(this, 'child_process'), {
        spawn: (cmd, args) => { spawned.push({ cmd, args }); return { unref() {} }; },
      });
    }
    return originalRequire.apply(this, arguments);
  };
  withPc.lastSpawned = spawned;
  delete require.cache[FROM_PC_PATH];
  delete require.cache[FROM_COMPUTER_PATH];
  try {
    return await fn(require(FROM_COMPUTER_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
    delete require.cache[FROM_COMPUTER_PATH];
  }
}

function pcWithWindows(windows) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (c.cmd === 'list_windows') return { ok: true, result: { windows: windows || [] } };
      return { ok: true, result: {} };
    },
  };
}

const REAL_DIR = path.resolve(__dirname, '..', 'vault');

function withTempFile(name, fn) {
  const p = path.join(REAL_DIR, name);
  let made = false;
  try { fs.writeFileSync(p, 'x'); made = true; } catch (_) { /* read-only env */ }
  if (!made) return Promise.resolve('skipped-unwritable');
  return Promise.resolve(fn(p)).finally(() => {
    try { fs.unlinkSync(p); } catch (_) {}
  });
}

describe('BUG-283: a file path opens its folder with the file selected', () => {
  it('does not dead-end on a file path', async () => {
    const out = await withTempFile('bug-283-reveal-probe.tmp', async (file) => {
      return withPc(pcWithWindows([]), async (m) => m.open_folder({ path: file }));
    });
    if (out === 'skipped-unwritable') return;
    // The sandbox root can differ per environment; a sandbox refusal is a
    // different (correct) rejection and is covered separately below.
    if (!out.ok && /outside|sandbox|not allowed/i.test(String(out.result))) return;
    assert.equal(out.ok, true,
      'refusing here is what sent the model improvising and then calling it a system limitation');
  });

  it('asks Explorer to select the file, not just to open something', async () => {
    const out = await withTempFile('bug-283-reveal-args.tmp', async (file) => {
      const res = await withPc(pcWithWindows([]), async (m) => m.open_folder({ path: file }));
      return { res, spawned: withPc.lastSpawned.slice(), file };
    });
    if (out === 'skipped-unwritable') return;
    if (!out.res.ok && /outside|sandbox|not allowed/i.test(String(out.res.result))) return;

    const explorer = out.spawned.find((s) => String(s.cmd).toLowerCase().includes('explorer'));
    assert.ok(explorer, 'explorer.exe must actually have been spawned');
    // Assert the MECHANISM. `/select,<path>` as a SINGLE argument is what makes
    // Explorer highlight the file; split across two arguments it silently opens
    // the wrong thing, and `res.ok` would not notice.
    assert.equal(explorer.args.length, 1, 'the reveal must be one argument, not two');
    assert.ok(explorer.args[0].startsWith('/select,'),
      'expected a /select, reveal argument, got: ' + explorer.args[0]);
    assert.ok(explorer.args[0].endsWith(path.basename(out.file)),
      'the reveal must name the file itself, not its folder');
  });

  it('still names open_artifact, so the pointer to the right tool survives', async () => {
    // Removing the dead end must not remove the signpost: opening the folder is
    // not the same as opening the file, and the model needs to know which tool
    // does the other thing.
    const out = await withTempFile('bug-283-reveal-hint.tmp', async (file) => {
      return withPc(pcWithWindows([]), async (m) => m.open_folder({ path: file }));
    });
    if (out === 'skipped-unwritable') return;
    if (!out.ok && /outside|sandbox|not allowed/i.test(String(out.result))) return;
    assert.match(JSON.stringify(out.result), /open_artifact/,
      'the result must still name the tool that opens the file itself');
  });

  it('reports the folder it opened and the file it revealed as separate facts', async () => {
    const out = await withTempFile('bug-283-reveal-fields.tmp', async (file) => {
      const res = await withPc(pcWithWindows([]), async (m) => m.open_folder({ path: file }));
      return { res, file };
    });
    if (out === 'skipped-unwritable') return;
    if (!out.res.ok && /outside|sandbox|not allowed/i.test(String(out.res.result))) return;
    assert.equal(out.res.result.revealed, path.resolve(out.file),
      'the revealed file must be its own field, not folded into the folder path');
    assert.equal(out.res.result.opened, path.dirname(path.resolve(out.file)),
      'what was OPENED is the folder — saying the file was opened would be the old dishonesty');
  });
});

describe('BUG-283: the folder path is unchanged (negative control)', () => {
  // The guard against fixing the file case by breaking the case that worked.
  it('a directory still spawns a plain open, with no /select', async () => {
    const res = await withPc(pcWithWindows([]), async (m) => m.open_folder({ path: REAL_DIR }));
    if (!res.ok && /outside|sandbox|not allowed/i.test(String(res.result))) return;
    const explorer = withPc.lastSpawned.find((s) => String(s.cmd).toLowerCase().includes('explorer'));
    assert.ok(explorer, 'explorer.exe must be spawned for a directory too');
    assert.equal(explorer.args.length, 1);
    assert.equal(explorer.args[0], path.resolve(REAL_DIR),
      'a directory must be passed straight through — no reveal syntax');
  });

  it('a nonexistent path still fails', async () => {
    const res = await withPc(pcWithWindows([]), async (m) =>
      m.open_folder({ path: path.join(REAL_DIR, 'bug-283-definitely-not-here') }));
    assert.equal(res.ok, false, 'a missing path is still an honest failure');
  });

  it('a missing path argument still fails', async () => {
    const res = await withPc(pcWithWindows([]), async (m) => m.open_folder({}));
    assert.equal(res.ok, false);
  });
});
