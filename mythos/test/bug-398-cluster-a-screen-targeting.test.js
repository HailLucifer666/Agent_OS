'use strict';

// test/bug-398-cluster-a-screen-targeting.test.js — BUG-398 rows 9, 10 and 11.
//
// Cluster A of the 2026-09-02 session: "anything that has to find something on a
// screen." Three rows, one file, because all three are the same defect wearing
// different clothes — a tool that could not say what it had actually acted on.
//
// ROW 9 — see_and_click at 8 fails, 0 successes. EVERY call passed pid 6272.
// `Get-Process -Id 6272` was brave, window title "Superfanstudio/OTT-Dashboard-
// APP: Media OTT Dashboard APP - Brave" — a GitHub page, while the target was a
// YouTube video. The tool printed what it HAD read on all eight failures and
// never once compared it to what it was asked for, so the fact that would have
// unstuck the model was in its own output every time and unused. With a pid
// given and the focus succeeding, `remedy` was the EMPTY STRING, so the refusal
// read "I cannot see X on screen.  What I can read: …" and dead-ended.
//   The pid was NOT cached anywhere: the MODEL re-sent 6272 because nothing in
// the refusal told it that pid was the wrong window. So the fix is in the
// message, not in cache invalidation.
//
// ROW 10 — click_at(1336, 1433) returned {"clicked":true}. The URL never
// changed and the <video> still read paused:true, t:0; the element's rect was
// y 1399, height 67 — below the fold. A 1/0 return with no post-condition, and
// `ui_click`'s own failure text RECOMMENDS click_at, so the recovery ladder
// ended in a shrug shaped like a success.
//
// ROW 11 — open_file, 5 unverified / 2 verified, four identical retries on one
// file. THE OPERATOR DIAGNOSED THIS, not the logs: Windows' "How do you want to
// open this file?" picker was up, waiting for a choice, so no app window was
// ever going to appear. MYTHOS ran list_windows in the middle of that very loop,
// which would have shown the picker, and looked past it.
//
// WHAT IS DELIBERATELY NOT DONE, so nobody re-files it:
//   * click_at does NOT scroll a target into view. It is handed raw pixels and
//     has no element to scroll to; there is nothing to scroll.
//   * click_at does NOT bounds-check against the virtual desktop. 1433 was
//     INSIDE the screen — the coordinate was below a PAGE's fold, not off the
//     display — so that check would have passed this exact call and bought
//     nothing.
//   * The verification cost is OPT-IN (`expect`). An unconditional before/after
//     OCR pair would put a slow whole-desktop read in front of every coordinate
//     click in a UI-driving loop. Honest by default, proven on request.
//
// MUTATION PROOF — four probes, run 2026-09-02, each verified applied by
// re-reading the mutated line, and each restored from a full-path copy. What
// they actually reddened:
//   (a) restore `remedy = focusNote` for the scoped branch of see_and_click →
//       2 tests (the window-naming one and the dead-pid one). The refusal goes
//       back to naming no window.
//   (b) return `clickAtRaw({x, y})` from the top of click_at → 3 tests, all the
//       row-10 evidence cases.
//   (c) delete `if (picker) break;` in open_file → 1 test, the early-exit one.
//       THE FIRST VERSION OF THIS FILE HAD NO SUCH TEST and this probe reddened
//       NOTHING — the picker was still detected after the loop, so only wasted
//       time differed. A probe that reds nothing means the behaviour is
//       unguarded, so the early-exit test was written because of it. It asserts
//       the window-listing COUNT (2 for one attempt, 8 for the full poll), not
//       the wall clock, which would flake under load.
//   (d) narrow PICKER_TITLE_RE to /^open with$/ → 2 tests, including the
//       Windows 11 title, which is what pins the title FAMILY rather than one
//       spelling. Note the first attempt at this one was a `sed` whose escaping
//       silently matched nothing; it was caught by checking the occurrence count
//       rather than by trusting the command, and redone in node.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');
const FROM_COMPUTER_PATH = path.resolve(__dirname, '../src/core/effectors/from-computer.js');
const originalRequire = Module.prototype.require;

// Same seam the sibling see-and-click tests use — the pc-child adapter is the
// one boundary these effectors reach the machine through.
// AWAITS fn, unlike the sibling file's version, and that is load-bearing rather
// than tidiness. `try { return fn(...) } finally { restore }` runs the finally
// the moment an async fn returns its PROMISE, so the override is torn down
// before the body has finished. from-computer's open_file requires './from-pc'
// LAZILY, after an await, to break a circular dependency — so with the
// synchronous version it got the REAL pc-child adapter (OFFLINE in a test
// process) and every row-11 assertion failed with "pc-child is not running".
// The sibling tests never hit this because see_and_click's requires all resolve
// before its first await. Found by this file's own first run.
async function withMockedPcChild(mock, targetPath, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[targetPath];
  delete require.cache[FROM_PC_PATH];
  try { return await fn(require(targetPath)); }
  finally {
    Module.prototype.require = originalRequire;
    delete require.cache[targetPath];
    delete require.cache[FROM_PC_PATH];
  }
}

// ---------------------------------------------------------------------------
// ROW 9 — the refusal names the window it actually read.
// ---------------------------------------------------------------------------
describe('BUG-398 row 9 — a scoped miss names the window that was really read', () => {
  // The verbatim window from the session: the pid the model kept re-sending.
  const BRAVE_GITHUB = {
    pid: 6272,
    processName: 'brave',
    title: 'Superfanstudio/OTT-Dashboard-APP: Media OTT Dashboard APP - Brave',
  };

  function pcWith(windows, ocrText) {
    return {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        const name = cmd && cmd.cmd;
        if (name === 'focus_window') return { ok: true, result: {} };
        if (name === 'screen_read_text') {
          // Regions, not just text: with an empty region list the refusal takes
          // its 'OCR returned no text regions at all' branch and never reaches
          // the 'What I can read' sample. Found by this file's own first run —
          // a fixture thinner than the wire tests a branch production skips.
          return { ok: true, result: { text: ocrText,
            regions: String(ocrText).split(' | ').map((t, i) => ({ text: t, x: 10 * i, y: 10, width: 40, height: 12 })) } };
        }
        if (name === 'list_windows') return { ok: true, result: { windows, total: windows.length } };
        return { ok: true, result: {} };
      },
    };
  }

  it('(a) names the process, the pid and the title of the window it read', async () => {
    const out = await withMockedPcChild(
      pcWith([BRAVE_GITHUB], 'x | k | Superfanstudio/OTT-Dashboard-APP'), FROM_PC_PATH,
      (mod) => mod.see_and_click({
        text: 'OpenClaw 2.0: This AI Agent Just Got a MASSIVE Upgrade', pid: 6272,
      }));

    assert.equal(out.ok, false);
    const msg = String(out.result);
    assert.match(msg, /pid 6272/, 'the pid it read must be named: ' + msg);
    assert.match(msg, /brave/i, 'the process it read must be named: ' + msg);
    assert.match(msg, /Superfanstudio/,
      'the TITLE is the fact that makes the mismatch obvious to the caller: ' + msg);
    assert.match(msg, /wrong pid/i, 'it must say plainly that this may be the wrong window');
    assert.match(msg, /list_windows/, 'and name the next step');
  });

  it('(a) still reports what it could read, so the old diagnostic is not lost', async () => {
    const out = await withMockedPcChild(
      pcWith([BRAVE_GITHUB], 'x | k | Superfanstudio/OTT-Dashboard-APP'), FROM_PC_PATH,
      (mod) => mod.see_and_click({ text: 'Play', pid: 6272 }));
    assert.match(String(out.result), /What I can read/,
      'naming the window must ADD to the refusal, not replace what it already said');
  });

  it('says so when the pid owns no window at all any more', async () => {
    // A stale pid is a different fact from a wrong one, and "waiting" is wrong
    // for both — this is the shape that had the model retry four times.
    const out = await withMockedPcChild(pcWith([], 'nothing relevant'), FROM_PC_PATH,
      (mod) => mod.see_and_click({ text: 'Play', pid: 9999 }));
    const msg = String(out.result);
    assert.match(msg, /Nothing owned by pid 9999 is on screen/,
      'a dead pid must be reported as such: ' + msg);
  });

  it('BOUNDS: an unscoped miss keeps its own advice and gains no window name', async () => {
    const out = await withMockedPcChild(pcWith([BRAVE_GITHUB], 'MYTHOS | File Edit View'), FROM_PC_PATH,
      (mod) => mod.see_and_click({ text: 'Play' }));
    const msg = String(out.result);
    assert.match(msg, /includes my own window/i, 'the unscoped explanation must survive');
    assert.ok(!/pid 6272/.test(msg),
      'with no pid given there is no window it was asked about — naming one would be a guess: ' + msg);
  });

  it('BOUNDS: a window listing that fails does not break the refusal', async () => {
    // The listing is a nicety. If it throws or errors, the refusal must still be
    // the refusal — never an exception, never a success.
    const angry = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        if (cmd.cmd === 'list_windows') throw new Error('pc-child died');
        if (cmd.cmd === 'screen_read_text') return { ok: true, result: { text: 'nope' } };
        return { ok: true, result: {} };
      },
    };
    const out = await withMockedPcChild(angry, FROM_PC_PATH,
      (mod) => mod.see_and_click({ text: 'Play', pid: 6272 }));
    assert.equal(out.ok, false, 'still an honest refusal');
    assert.match(String(out.result), /I cannot see "Play"/);
  });
});

// ---------------------------------------------------------------------------
// ROW 10 — click_at reports its own effect, or says it cannot.
// ---------------------------------------------------------------------------
describe('BUG-398 row 10 — click_at no longer returns a bare success', () => {
  function pcClick(afterText, beforeText) {
    let reads = 0;
    return {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true, x: cmd.x, y: cmd.y } };
        if (cmd.cmd === 'screen_read_text') {
          reads += 1;
          return { ok: true, result: { text: reads === 1 ? (beforeText || 'before') : afterText } };
        }
        return { ok: true, result: {} };
      },
    };
  }

  it('(b) with no expect, the click is UNVERIFIED and says why', async () => {
    const out = await withMockedPcChild(pcClick('anything'), FROM_PC_PATH,
      (mod) => mod.click_at({ x: 1336, y: 1433 }));

    assert.equal(out.ok, true, 'the click really was delivered — this is not a failure');
    assert.equal(out.unverified, true, 'but nothing confirms what it hit');
    const why = String(out.reason);
    assert.match(why, /no oracle/i, 'the reason must name the missing oracle: ' + why);
    assert.match(why, /expect/, 'and name the way to get proof');
    assert.match(why, /see_and_click/, 'and the tool that finds the label first');
  });

  it('(b) with expect satisfied, it is PROVEN and cites the ocr oracle', async () => {
    const out = await withMockedPcChild(pcClick('now playing the video'), FROM_PC_PATH,
      (mod) => mod.click_at({ x: 10, y: 20, expect: 'now playing' }));

    assert.equal(out.ok, true);
    assert.notEqual(out.unverified, true, 'a satisfied expectation is proof');
    assert.equal(out.evidence.oracle, 'ocr');
    assert.match(String(out.evidence.observed), /now playing/);
  });

  it('with expect unmet and nothing changing, it says the pixels may be behind or below', async () => {
    // The measured shape: the click landed on whatever was at those coordinates
    // because the element was below the fold.
    const out = await withMockedPcChild(pcClick('before', 'before'), FROM_PC_PATH,
      (mod) => mod.click_at({ x: 1336, y: 1433, expect: 'now playing' }));

    assert.equal(out.unverified, true);
    assert.match(String(out.reason), /below the visible part of a scrolling page/,
      'the below-the-fold case is the one that produced this bug');
  });

  it('a genuinely failed click is still a failure, not an unverified one', async () => {
    const broken = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => (cmd.cmd === 'click_at'
        ? { ok: false, result: 'Click failed: access denied' }
        : { ok: true, result: {} }),
    };
    const out = await withMockedPcChild(broken, FROM_PC_PATH,
      (mod) => mod.click_at({ x: 1, y: 1 }));
    assert.equal(out.ok, false, 'a refused click must not be dressed up as unverified');
  });

  it('BOUNDS: see_and_click still returns its OWN verdict, not click_at\'s hedge', async () => {
    // see_and_click runs its own bounded settle on the scope it read, so it uses
    // the raw click path. If it started going through the wrapper it would pay
    // for a second whole-screen read and report a weaker verdict than it earned.
    const regions = [{ text: 'Video call', x: 100, y: 200, width: 80, height: 20 }];
    let reads = 0;
    const pc = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
        if (cmd.cmd === 'screen_read_text') {
          reads += 1;
          return { ok: true, result: { text: reads === 1 ? 'Video call' : 'In call', regions } };
        }
        return { ok: true, result: {} };
      },
    };
    const out = await withMockedPcChild(pc, FROM_PC_PATH,
      (mod) => mod.see_and_click({ text: 'Video call' }));
    assert.equal(out.ok, true);
    assert.equal(out.result.evidence, 'ocr', 'its own ocr verdict, from its own scoped settle');
    assert.ok(!/no oracle/i.test(String(out.reason || '')),
      'see_and_click must not inherit the raw-coordinate hedge: ' + out.reason);
  });
});

// ---------------------------------------------------------------------------
// ROW 11 — the app-picker is named instead of waited out.
// ---------------------------------------------------------------------------
describe('BUG-398 row 11 — open_file detects the "how do you want to open this" picker', () => {
  // A real file on disk, created here. Two constraints found on the first run:
  // open_file stats the path (so it must exist) and REFUSES executables —
  // .js included, because Windows would run it through WScript rather than
  // show it — so the obvious 'use this test file' fixture never reaches the
  // oracle under test. A .txt in its own temp dir needs no repo file and no
  // assumption about where the allowlist points.
  const fs = require('node:fs');
  const os = require('node:os');
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bug398-openfile-'));
  const REAL_FILE = path.join(SANDBOX, 'notes.txt');
  fs.writeFileSync(REAL_FILE, 'hello');

  function computerWith(windows, opts) {
    const o = opts || {};
    let listCalls = 0;
    const pc = {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        if (cmd.cmd === 'list_windows') {
          listCalls += 1;
          return { ok: true, result: { windows, total: windows.length } };
        }
        return { ok: true, result: { windows: [], total: 0 } };
      },
    };
    return { pc, listCalls: () => listCalls, o };
  }

  async function runOpenFile(windows) {
    const { pc, listCalls } = computerWith(windows);
    const out = await withMockedPcChild(pc, FROM_COMPUTER_PATH, async (mod) => {
      // The shell provider is injected; without it open_file refuses before it
      // ever reaches the oracle, which would test nothing.
      mod.setOpenPathProvider(async () => ({ opened: true }));
      process.env.VOICE_ALLOWED_DIRS = SANDBOX;
      return mod.open_file({ path: REAL_FILE });
    });
    return { out, listCalls: listCalls() };
  }

  it('(c)(d) names the Windows 11 picker and says waiting will not help', async () => {
    const { out } = await runOpenFile([
      { pid: 4242, processName: 'ApplicationFrameHost', title: 'How do you want to open this file?' },
    ]);
    assert.equal(out.ok, true, 'the file WAS handed to the shell — that part is true');
    assert.equal(out.unverified, true);
    const why = String(out.reason);
    assert.match(why, /asking which app/i, 'the real cause must be named: ' + why);
    assert.match(why, /pid 4242/, 'and the dialog located');
    assert.match(why, /waiting longer will not help/i,
      'the old message said "the app may still be starting", which is the opposite of true here');
    assert.match(why, /ui_click|see_and_click/, 'and a way to act on it');
  });

  it('(c) it STOPS as soon as the picker is seen, instead of waiting out the poll', async () => {
    // The dossier's point, and the reason this is not just a wording change:
    // "waiting longer never helps in that state". The poll is four attempts
    // 400ms apart; with a picker up, attempts 2-4 are dead time in front of an
    // answer that cannot change. Asserted on the CALL COUNT, not the wall clock,
    // because a timing assertion on a loaded machine is a flake generator.
    //
    // This is the assertion the first version of this file was missing: deleting
    // the `if (picker) break;` line left all fourteen tests green, because the
    // picker was still detected after the loop and only the wasted time
    // differed. A probe that reds nothing means the behaviour is unguarded.
    const { out, listCalls } = await runOpenFile([
      { pid: 4242, processName: 'ApplicationFrameHost', title: 'How do you want to open this file?' },
    ]);
    assert.match(String(out.reason), /asking which app/i, 'premise: the picker was detected');
    // TWO listings per attempt, measured rather than assumed: findWindowByTitle
    // lists windows to look for the app's title, and the picker check lists them
    // again. So one attempt costs 2 and the full four-attempt poll costs 8.
    // Asserting 2 is asserting "exactly one attempt ran".
    assert.equal(listCalls, 2,
      'the picker is visible on the first check, so attempts 2-4 must not run — one attempt is '
      + '2 listings (the title lookup plus the picker check), the whole poll would be 8. Saw '
      + listCalls);
  });

  it('(d) the legacy "Open with" title is recognised too', async () => {
    const { out } = await runOpenFile([{ pid: 77, processName: 'rundll32', title: 'Open with' }]);
    assert.equal(out.unverified, true);
    assert.match(String(out.reason), /asking which app/i);
  });

  it('BOUNDS: an ordinary slow launch keeps the original "may still be starting" wording', async () => {
    const { out } = await runOpenFile([
      { pid: 10, processName: 'explorer', title: 'Downloads' },
    ]);
    assert.equal(out.unverified, true);
    assert.match(String(out.reason), /may still\s+be starting/i,
      'with no picker up, the honest answer is still that it might be slow');
    assert.ok(!/asking which app/i.test(String(out.reason)),
      'the picker message must not fire when there is no picker');
  });

  it('BOUNDS: a window whose title merely mentions opening is not the picker', async () => {
    const { out } = await runOpenFile([
      { pid: 11, processName: 'chrome', title: 'How to open a PDF - Google Search' },
    ]);
    assert.ok(!/asking which app/i.test(String(out.reason)),
      'a browser tab about opening files is not the shell picker: ' + out.reason);
  });
});
