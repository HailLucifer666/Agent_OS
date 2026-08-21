'use strict';

// test/open-file-verifies-and-focuses.test.js
//
// THREE DEFECTS, all reported by the operator in the 2026-08-21 live session,
// and all of them mine — introduced the day before when open_file was added.
// Their words, verbatim from Episodic/2026-08-21.jsonl:
//
//   MYTHOS: "The request is in, Sir; the OS has accepted the command to open
//            `Parmesan_Garlic_Bread_Recipe.txt`. While that part is confirmed,
//            I can't verify whether the application actually opened and
//            displayed it successfully."
//   USER:   "why can't you confirm? Number two, don't have to give me the
//            details like the Windows has accepted the command. ... Just tell
//            me in short that I have opened it."
//
// The request that produced it was "Can you open that file and focus it on
// front?" — which names the third defect on its own.
//
// 1. IT CAN CONFIRM. open_folder, in the same file, already polls
//    findExplorerWindow four times 400ms apart and returns evidence.verifiedOk
//    with an oracle of 'window-title'. open_file was written as permanently
//    unverified without checking that its own neighbour had an oracle — the
//    exact sibling-parity gap this repo keeps finding elsewhere. The window
//    that appears after shell.openPath belongs to the ASSOCIATED app, not
//    Explorer, so findExplorerWindow cannot be reused as-is: it filters on
//    /explorer/i. Hence a general title finder.
//
// 2. THE VERBOSITY IS A SYMPTOM OF (1), NOT A SEPARATE WORDING PROBLEM.
//    The paragraph the operator objected to is what evidence.unverified()
//    produces: a `reason` explaining what could not be checked plus a
//    `confirmedStep` explaining what could. Once the open is genuinely
//    verified those fields are gone and the honest answer is short. Shortening
//    the text WITHOUT the oracle would have meant claiming an open we had not
//    confirmed, which is the one thing the evidence contract forbids. So this
//    file asserts the oracle, and the brevity follows.
//
// 3. "FOCUS IT ON FRONT" was in the request and open_file did not do it.
//    shell.openPath can leave the window behind others.
//
// Q1 — WHAT ELSE MATCHES A TITLE CONTAINING THE FILENAME? A title match is
// used here as an OBSERVATION oracle, never to choose a window to type into,
// which is the distinction that makes it acceptable — open_folder already
// relies on exactly this. The risk is a stale window that had the file open
// beforehand. That is deliberately treated as success: shell.openPath focuses
// an already-open document rather than opening a second copy, so a
// pre-existing window IS the file being open. MYTHOS's own HUD is not a
// false positive: list_windows reports window TITLES, and MYTHOS's title is
// its own, not the transcript it happens to be displaying.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('node:module');

const FROM_COMPUTER = require.resolve('../src/core/effectors/from-computer');
const FROM_PC = require.resolve('../src/core/effectors/from-pc');

// open_file reaches from-pc lazily (circular dep), the same way open_folder
// does, so the stub is installed in the require cache rather than injected.
// MUST be async and MUST await fn: a synchronous `try { return fn() } finally`
// restores the require cache the instant fn returns its PROMISE, so the real
// from-pc is back in place before open_file ever calls it. The symptom was a
// 1.6s test (four 400ms polls against the real, offline adapter) that looked
// exactly like a working oracle finding nothing.
async function withFakePc(fakePc, fn) {
  const savedPc = require.cache[FROM_PC];
  require.cache[FROM_PC] = { id: FROM_PC, filename: FROM_PC, loaded: true, exports: fakePc };
  delete require.cache[FROM_COMPUTER];
  try { return await fn(require(FROM_COMPUTER)); }
  finally {
    if (savedPc) require.cache[FROM_PC] = savedPc; else delete require.cache[FROM_PC];
    delete require.cache[FROM_COMPUTER];
  }
}

function sandboxWith(fileName) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mythos-openfile2-')));
  fs.writeFileSync(path.join(dir, fileName), 'x', 'utf8');
  return dir;
}

const FILE = 'Parmesan_Garlic_Bread_Recipe.txt';

// A from-pc whose list_windows reports the associated app's window, and which
// records every focus_window call so the test can assert the mechanism.
function fakePc({ windows, online = true }) {
  const focused = [];
  return {
    focused,
    mod: {
      focus_window: async ({ pid }) => { focused.push(pid); return { ok: true, result: {} }; },
      list_windows: async () => (online
        ? { ok: true, result: { windows, total: windows.length } }
        : { ok: false, result: 'PC automation is OFFLINE' }),
      // open_file calls findWindowByTitle, so the stub must provide it. The
      // REAL matcher is exercised separately below against a mocked pc-child —
      // a stub that reimplemented the matching would let the two drift, and
      // this file would end up testing its own fake.
      findWindowByTitle: async (leaf) => {
        if (!online) return { online: false, window: null, matchedBy: null };
        const want = String(leaf || '').toLowerCase();
        const hit = windows.find((w) => String(w.title || '').toLowerCase().includes(want)) || null;
        return { online: true, window: hit, matchedBy: hit ? 'contains' : null };
      },
    },
  };
}

async function runOpen({ pc, fileName = FILE, opened = true, reason = null }) {
  const dir = sandboxWith(fileName);
  const saved = process.env.VOICE_ALLOWED_DIRS;
  process.env.VOICE_ALLOWED_DIRS = dir;
  try {
    return await withFakePc(pc.mod, async (mod) => {
      mod.registerFromComputer({ register() {} }, { config: { MYTHOS_VAULT_ROOT: dir } });
      mod.setOpenPathProvider(async () => ({ opened, reason }));
      const out = await mod.open_file({ path: path.join(dir, fileName) });
      return { out, dir };
    });
  } finally {
    process.env.VOICE_ALLOWED_DIRS = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('open_file confirms the open with a window oracle', () => {
  it('returns VERIFIED — not unverified — when the app window appears', async () => {
    const pc = fakePc({
      windows: [{ pid: 4242, processName: 'notepad', title: FILE + ' - Notepad', visible: true }],
    });
    const { out } = await runOpen({ pc });

    assert.equal(out.ok, true, JSON.stringify(out));
    assert.notEqual(out.unverified, true,
      'the window is the oracle — with it present this must not still be reported as unverified: ' +
      JSON.stringify(out));
    assert.ok(out.verified || out.evidence || out.oracle || out.observed,
      'a verified result must carry its oracle: ' + JSON.stringify(out));
  });

  it('brings that window to the front — "focus it on front" was in the request', async () => {
    const pc = fakePc({
      windows: [{ pid: 4242, processName: 'notepad', title: FILE + ' - Notepad', visible: true }],
    });
    await runOpen({ pc });
    // Assert the mechanism, not the wording: the window was actually focused.
    assert.deepEqual(pc.focused, [4242],
      'the located window must be focused, once, by its real pid');
  });

  it('does NOT claim verified, and focuses nothing, when no window shows up', async () => {
    const pc = fakePc({ windows: [{ pid: 1, processName: 'chrome', title: 'unrelated', visible: true }] });
    const { out } = await runOpen({ pc });

    assert.equal(out.ok, true, 'the OS still accepted the open — this is not a failure');
    assert.equal(out.unverified, true,
      'with no window to see, the honest answer is still unverified: ' + JSON.stringify(out));
    assert.deepEqual(pc.focused, [], 'nothing may be focused when nothing matched');
  });

  it('stays honest and does not crash when pc-child is offline', async () => {
    const pc = fakePc({ windows: [], online: false });
    const { out } = await runOpen({ pc });
    assert.equal(out.ok, true);
    assert.equal(out.unverified, true);
    assert.deepEqual(pc.focused, []);
  });

  it('a failed shell open is still a failure — the oracle cannot rescue it', async () => {
    // Negative control on the whole feature: a window that happens to match
    // must not turn a refused open into a success.
    const pc = fakePc({
      windows: [{ pid: 4242, processName: 'notepad', title: FILE + ' - Notepad', visible: true }],
    });
    const { out } = await runOpen({ pc, opened: false, reason: 'no application is associated' });
    assert.equal(out.ok, false);
    assert.match(String(out.result), /no application is associated/);
    assert.deepEqual(pc.focused, [], 'a refused open must not focus anything');
  });

  it('matches the file, not just any window (negative control on the oracle)', async () => {
    // If the finder matched anything at all, every test above would pass for
    // the wrong reason.
    const pc = fakePc({
      windows: [
        { pid: 7, processName: 'chrome', title: 'Some Other Document - Chrome', visible: true },
        { pid: 8, processName: 'explorer', title: 'Downloads', visible: true },
      ],
    });
    const { out } = await runOpen({ pc });
    assert.equal(out.unverified, true, 'unrelated windows must not count as confirmation');
    assert.deepEqual(pc.focused, []);
  });
});

// The block above stubs from-pc, so it proves open_file CONSULTS the oracle and
// focuses what it finds — but it cannot prove the oracle itself matches
// correctly. This exercises the real findWindowByTitle against a mocked
// pc-child, so the stub and the implementation cannot quietly disagree.
describe('findWindowByTitle — the real matcher', () => {
  const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
  const originalRequire = Module.prototype.require;

  function withMockedPcChild(windows, fn) {
    const mock = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => (cmd && cmd.cmd === 'list_windows'
        ? { ok: true, result: { windows, total: windows.length } }
        : { ok: true, result: {} }),
    };
    Module.prototype.require = function (id) {
      if (id === '../../../adapters/pc-child') return mock;
      return originalRequire.apply(this, arguments);
    };
    delete require.cache[FROM_PC_PATH];
    try { return fn(require(FROM_PC_PATH)); }
    finally { Module.prototype.require = originalRequire; delete require.cache[FROM_PC_PATH]; }
  }

  it('prefers an exact title over a containing one', async () => {
    // "notes.txt" must not lose to "notes.txt.bak - Notepad".
    const res = await withMockedPcChild([
      { pid: 2, processName: 'notepad', title: 'notes.txt.bak - Notepad', visible: true },
      { pid: 1, processName: 'notepad', title: 'notes.txt', visible: true },
    ], (mod) => mod.findWindowByTitle('notes.txt'));
    assert.equal(res.matchedBy, 'exact');
    assert.equal(res.window.pid, 1);
  });

  it('falls back to a containing title, which is the normal app case', async () => {
    const res = await withMockedPcChild([
      { pid: 9, processName: 'notepad', title: 'Parmesan_Garlic_Bread_Recipe.txt - Notepad', visible: true },
    ], (mod) => mod.findWindowByTitle('Parmesan_Garlic_Bread_Recipe.txt'));
    assert.equal(res.matchedBy, 'contains');
    assert.equal(res.window.pid, 9);
  });

  it('is not fooled by an unrelated window, and reports no match', async () => {
    const res = await withMockedPcChild([
      { pid: 3, processName: 'chrome', title: 'Recipes - Google Search', visible: true },
    ], (mod) => mod.findWindowByTitle('Parmesan_Garlic_Bread_Recipe.txt'));
    assert.equal(res.online, true, 'the adapter answered — this is a genuine no-match, not an outage');
    assert.equal(res.window, null);
  });

  it('ignores invisible windows — an unseen window is not confirmation', async () => {
    const res = await withMockedPcChild([
      { pid: 4, processName: 'notepad', title: 'notes.txt - Notepad', visible: false },
    ], (mod) => mod.findWindowByTitle('notes.txt'));
    assert.equal(res.window, null);
  });

  it('an empty leaf never matches anything', async () => {
    const res = await withMockedPcChild([
      { pid: 5, processName: 'notepad', title: 'anything', visible: true },
    ], (mod) => mod.findWindowByTitle(''));
    assert.equal(res.window, null);
  });
});
