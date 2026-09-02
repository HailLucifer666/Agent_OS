'use strict';

// test/see-and-click-focus-before-read.test.js — 2026-08-21 capability audit.
//
// THE INCIDENT, measured. see_and_click is 3 ok / 8 fail. Every failure is the
// grounding step, never the click (click_at is 1 ok / 0 fail all-time). Of the
// 8:
//   5  unscoped, and what OCR read back was MYTHOS's OWN HUD —
//      "What I can read: MYTHOS | File Edit View | Window | Help | Voice: see_an…"
//      i.e. MYTHOS reading its own window, including its rendering of the very
//      request it was being asked to carry out
//   1  scoped (pid 32224) and it DID read the browser, but the long YouTube
//      title still did not match — a separate matching problem, NOT this one
//   1  "PC automation is OFFLINE"
//   1  unscoped, read a mix including google.com/sorry (a CAPTCHA page)
//
// THE MECHANISM, and ps-automation.ps1 already states it in the screen capture
// it uses: PrintWindow "returns black for the DirectComposition/Chromium
// windows this is most needed for", so the capture is CopyFromScreen — a crop
// of the VISIBLE desktop. Therefore "a target sitting behind another window
// reads whatever is on top of it. Scoping is what stops a match in an
// unrelated window; focus_window first is what makes the target the thing
// being read."
//
// see_and_click did the first half and not the second: it threaded `pid` into
// the read (BUG-108) but never focused the window, so a scoped read of an
// occluded window returns the pixels of whatever covers it — usually MYTHOS,
// because the operator is talking to it. The operator had already worked this
// out and written it into the vault twice as a fact beginning "IMPERATIVE:
// When attempting ANY PC automation task ... ALWAYS explicitly focus the target
// application's window FIRST". The system was told, and did not do it.
//
// WHY THE FOCUS IS ADVISORY. focus_window can legitimately fail — Windows
// refuses the foreground lock, the ladder is exhausted and documented as such
// (BUG-272 T3), and adapters/CLAUDE.md records that no fourth rung is coming.
// An unguarded focus call that aborts on failure would be strictly worse than
// no focus at all: this repo has already had "an advisory call killed the
// recovery ladder", where an unguarded SetFocus aborted ui_type before its
// focus-free routes could run. So the focus is attempted, its outcome is
// reported, and the read happens either way.

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
  try { return fn(require(FROM_PC_PATH)); }
  finally { Module.prototype.require = originalRequire; delete require.cache[FROM_PC_PATH]; }
}

// A pc-child that records the exact command order it was given.
function recordingPc({ ocrText, focusOk = true, regions }) {
  const sent = [];
  return {
    sent,
    mock: {
      getStatus: () => ({ state: 'ONLINE' }),
      sendCommand: async (cmd) => {
        const name = cmd && cmd.cmd;
        sent.push({ cmd: name, pid: cmd && cmd.pid });
        if (name === 'focus_window') {
          return focusOk
            ? { ok: true, result: {} }
            : { ok: false, error: 'the foreground lock refused this' };
        }
        if (name === 'screen_read_text') {
          return {
            ok: true,
            result: regions
              ? { text: ocrText, regions: regions }
              : { text: ocrText },
          };
        }
        return { ok: true, result: {} };
      },
    },
  };
}

const MYTHOS_HUD = ['MYTHOS', 'File Edit View', 'Window', 'Help', 'Voice: see_an'].join('\n');

describe('see_and_click focuses the target window before reading it', () => {
  it('with a pid, focus_window runs BEFORE screen_read_text', async () => {
    const rec = recordingPc({ ocrText: MYTHOS_HUD });
    await withMockedPcChild(rec.mock, (mod) =>
      mod.see_and_click({ text: 'Video call', pid: 4321 }));

    const order = rec.sent.map((s) => s.cmd);
    const iFocus = order.indexOf('focus_window');
    const iRead = order.indexOf('screen_read_text');
    assert.ok(iFocus >= 0,
      'a scoped read of an occluded window returns whatever covers it — the window must be ' +
      'focused first. Commands seen: ' + JSON.stringify(order));
    assert.ok(iRead >= 0, 'the OCR read must still happen');
    assert.ok(iFocus < iRead, 'focus must come BEFORE the read, not after: ' + JSON.stringify(order));
    assert.equal(rec.sent[iFocus].pid, 4321, 'it must focus the pid the caller named');
  });

  it('a FAILED focus does not abort the read — the focus is advisory', async () => {
    // The pinned lesson: focus_window's foreground-lock refusal is real and
    // documented, and an unguarded advisory call that aborts is how this repo
    // previously killed a recovery ladder. Assert the mechanism: the read still
    // reached the adapter.
    const rec = recordingPc({ ocrText: MYTHOS_HUD, focusOk: false });
    const out = await withMockedPcChild(rec.mock, (mod) =>
      mod.see_and_click({ text: 'Video call', pid: 4321 }));

    const order = rec.sent.map((s) => s.cmd);
    assert.ok(order.includes('screen_read_text'),
      'the read must still be attempted after a failed focus: ' + JSON.stringify(order));
    assert.equal(out.ok, false, 'the text is genuinely not on screen in this fixture');
    assert.match(String(out.result), /cannot see/i);
  });

  it('without a pid nothing is focused — there is nothing to focus', async () => {
    const rec = recordingPc({ ocrText: MYTHOS_HUD });
    await withMockedPcChild(rec.mock, (mod) => mod.see_and_click({ text: 'Video call' }));
    const order = rec.sent.map((s) => s.cmd);
    assert.ok(!order.includes('focus_window'),
      'an unscoped call has no window to focus and must not guess one: ' + JSON.stringify(order));
    assert.ok(order.includes('screen_read_text'), 'it must still read (negative control)');
  });

  it('the unscoped miss names the remedy instead of dead-ending', async () => {
    // BUG-099 class: a refusal that names no reachable next step is where the
    // model improvises. All five HUD-reading failures ended here with nothing
    // to do next.
    const rec = recordingPc({ ocrText: MYTHOS_HUD });
    const out = await withMockedPcChild(rec.mock, (mod) =>
      mod.see_and_click({ text: 'Video call' }));

    const msg = String(out.result);
    assert.equal(out.ok, false);
    assert.match(msg, /list_windows/,
      'the refusal must name how to get a pid: ' + msg);
    assert.match(msg, /\bpid\b/i,
      'it must say that passing the pid is what narrows the read: ' + msg);
  });

  it('a scoped miss names the window it actually read, and does not repeat the unscoped advice', async () => {
    // DELIBERATELY REWRITTEN by BUG-398 row 9 (2026-09-02). The original
    // assertion was `!/call list_windows/i` with the reasoning "the remedy is
    // only a remedy when it has not already been taken. Telling a caller that
    // already passed a pid to go and get a pid ... trains the model to ignore
    // refusals." The intent is right and is preserved below. The PREMISE was
    // wrong, and the session disproved it eight times: passing a pid does not
    // mean the read was scoped CORRECTLY.
    //
    // MEASURED: 8 fails, 0 successes, every call carrying pid 6272 — a Brave
    // window showing a GitHub page, while the target was a YouTube video. The
    // refusal printed what it had read and never compared it to what it was
    // asked for, so the one fact that would have unstuck the model was on screen
    // and unused. With the window named, "list_windows will show you the right
    // one" stops being advice-already-taken and becomes the next real step.
    //
    // So the invariant is now: name the window that was read, and do NOT hand
    // back the UNSCOPED advice ("pass its pid so I read that window instead"),
    // which is the form that really would be redundant here.
    const rec = recordingPc({ ocrText: MYTHOS_HUD });
    const out = await withMockedPcChild(rec.mock, (mod) =>
      mod.see_and_click({ text: 'Video call', pid: 4321 }));
    const msg = String(out.result);
    assert.equal(out.ok, false);
    assert.match(msg, /pid 4321/,
      'the refusal must name the pid it actually read, so a wrong pid is visible: ' + msg);
    assert.ok(!/pass its pid so I read/i.test(msg),
      'the UNSCOPED remedy must not be repeated to a caller that already passed a pid: ' + msg);
    assert.ok(!/includes my own window/i.test(msg),
      'the whole-screen explanation belongs only to an unscoped read: ' + msg);
  });

  it('a successful match still clicks, and the focus did not break the happy path', async () => {
    // Negative control for the whole file: without this, every assertion above
    // could hold while see_and_click no longer works at all.
    const regions = [{ text: 'Video call', x: 100, y: 200, width: 80, height: 20 }];
    const rec = recordingPc({ ocrText: 'Video call', regions });
    const out = await withMockedPcChild(rec.mock, (mod) =>
      mod.see_and_click({ text: 'Video call', pid: 4321 }));
    const order = rec.sent.map((s) => s.cmd);
    assert.ok(
      order.some((c) => /click/i.test(String(c || ''))),
      'a located target must still be clicked: ' + JSON.stringify(order)
    );
    assert.ok(out, 'a result must be returned');
  });

  it('BUG-349: focus refused but target FOUND -> refuse the click, never fire occluded coordinates', async () => {
    // The read is advisory; the click is not. Occluded pixels belong to
    // whatever covered the target - the exact wrong-target class.
    const regions = [{ text: 'Video call', x: 100, y: 200, width: 80, height: 20 }];
    const rec = recordingPc({ ocrText: 'Video call', focusOk: false, regions });
    const out = await withMockedPcChild(rec.mock, (mod) =>
      mod.see_and_click({ text: 'Video call', pid: 4321 }));
    assert.equal(out.ok, false, 'an occluded hit must not be clicked');
    assert.match(String(out.result), /covering it/i);
    assert.ok(
      !rec.sent.some((s) => String(s.cmd) === 'click_at'),
      'click_at fired on occluded coordinates: ' + JSON.stringify(rec.sent.map((s) => s.cmd))
    );
    assert.ok(rec.sent.some((s) => s.cmd === 'screen_read_text'), 'the grounding read still happens');
  });
});
