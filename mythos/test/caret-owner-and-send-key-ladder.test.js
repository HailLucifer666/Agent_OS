'use strict';

// 2026-08-02 — the two P0s from the WhatsApp session, both of which reported success
// while doing nothing (or doing it to the wrong app).
//
// ONE. THE BRAVE INCIDENT. from-pc.js compared only the FOREGROUND window's pid, and
// keystrokes do not follow the foreground window — they follow the CARET. Recorded:
//
//   {"typedIntoPid":2132,"focusedPid":7972,"readBack":"confirmed",
//    "typedIntoTitle":"WhatsApp","readBackText":"huggingface.co/moonshotai/Kimi-K3mom"}
//
// WhatsApp (2132) was the target AND the foreground, so landedPid === targetPid and
// every guard passed. Brave (7972) held the caret, so "mom" was typed into Brave's
// address bar — and the read-back oracle then read BRAVE's address bar, found the text,
// and graded the type 'confirmed'. focusedPid was captured and stored, never compared.
//
// TWO. THE ENTER THAT COULD NOT WORK. WhatsApp Desktop is MSIX-packaged, and MSIX apps
// silently discard SendInput while reporting the events as injected. Handle-SendKey's
// only failure signal was "SendInput returned 0 events", which never fires there, so
// send_key('enter') returned {key:'enter',sent:true} and WhatsApp received nothing. The
// operator pressed Enter by hand. A verified ladder (submit_message) already existed and
// was simply unreachable from send_key.

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
  try {
    return fn(require(FROM_PC_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[FROM_PC_PATH];
  }
}

const WHATSAPP = { pid: 2132, title: 'WhatsApp', process: 'WhatsApp' };

// typeResult is merged into what ui_type reports back, so a test can reproduce the exact
// recorded payload. calls records every command for order/absence assertions.
function pc(foreground, typeResult, calls) {
  return {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      if (calls) calls.push(c);
      if (c.cmd === 'get_foreground_window') {
        return foreground ? { ok: true, result: foreground } : { ok: false, error: 'No foreground window.' };
      }
      if (c.cmd === 'focus_window') return { ok: true, result: { focused: true, pid: c.pid } };
      if (c.cmd === 'ui_type') {
        return {
          ok: true,
          result: Object.assign({
            typed: true,
            typedIntoPid: c.pid || (foreground && foreground.pid),
            typedIntoTitle: (foreground && foreground.title) || '',
          }, typeResult || {}),
        };
      }
      if (c.cmd === 'send_key') return { ok: true, result: { sent: true, key: c.key } };
      if (c.cmd === 'submit_message') {
        return { ok: true, result: { submitted: true, mechanism: 'wm-char-return', clearedText: 'hi' } };
      }
      if (c.cmd === 'ui_click') return { ok: false, error: 'Element path index 2 out of range (parent has 0 children)' };
      return { ok: true, result: {} };
    },
  };
}

describe('P0 — the caret owner decides where keystrokes go, not the foreground window', () => {
  it('THE RECORDED CASE: a read-back taken from another app is NOT success', async () => {
    await withMockedPcChild(pc(WHATSAPP, {
      typedIntoPid: 2132,
      focusedPid: 7972,
      focusedProcess: 'brave',
      caretSameApp: false,
      readBack: 'confirmed',
      readBackVia: 'ValuePattern',
      readBackText: 'huggingface.co/moonshotai/Kimi-K3mom',
    }), async (m) => {
      const res = await m.ui_type({ text: 'mom', pid: WHATSAPP.pid });
      assert.equal(res.ok, false, 'this exact payload was reported to the operator as a delivered message');
      const msg = String(res.result || res.error);
      // "names both windows" — the operator has to be able to act on this sentence.
      assert.match(msg, /brave/i, 'must name the app that actually got the keystrokes');
      assert.match(msg, /7972/, 'and its pid');
      assert.match(msg, /2132/, 'and the target pid it was supposed to go to');
      assert.match(msg, /read-back/i, 'and must void the read-back rather than lean on it');
    });
  });

  it('a caret in a same-app child (WebView2 shell vs renderer) is still allowed', async () => {
    // BUG-066: WhatsApp's shell owns the window while msedgewebview2 owns the text box.
    // Strict pid equality here would refuse every legitimate WhatsApp type, which is why
    // the same-app verdict is computed by Test-SameApp on the PS side and reported.
    await withMockedPcChild(pc(WHATSAPP, {
      typedIntoPid: 2132, focusedPid: 8899, focusedProcess: 'msedgewebview2',
      caretSameApp: true,
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'hi',
    }), async (m) => {
      const res = await m.ui_type({ text: 'hi', pid: WHATSAPP.pid });
      assert.equal(res.ok, true, 'a renderer child of the target app is the target app');
      assert.ok(res.evidence);
    });
  });

  it('an absent caret verdict is an honest unknown, not a failure', async () => {
    // UIA declining to answer must never be converted into a refusal — that would break
    // every surface where FocusedElement is unavailable.
    await withMockedPcChild(pc(WHATSAPP, {
      typedIntoPid: 2132,
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'hi',
    }), async (m) => {
      const res = await m.ui_type({ text: 'hi', pid: WHATSAPP.pid });
      assert.equal(res.ok, true, 'no caretSameApp field means UIA could not say — do not invent a failure');
    });
  });
});

// FIX-PLAN 3.2 (2026-08-17) — the fields-ABSENT half. The 2026-08-10 fix gave
// typedIntoSameApp:false a same-app-aware verdict, but undefined (older adapter,
// failed Test-SameApp lookup) still fell back to strict pid equality — and for a
// WebView2 app the pid NEVER matches the shell target, so legitimate WhatsApp
// sends were refused as "the text went elsewhere" with no evidence for the
// claim. That branch is now an honest unverified outcome, and it must return
// BEFORE the read-back oracle: the read-back reads whichever control holds the
// caret — exactly the window it could not rule out — so its "confirmed" would
// be the Brave incident's every-layer-agreed-on-a-lie again.
describe('P0 — an absent typedIntoSameApp is an honest unknown, not a wrong-app accusation', () => {
  it('THE RECORDED SHAPE: keys landed in the WebView2 child pid, field absent → unverified, not refused', async () => {
    // 2026-08-09 audit: refused with 'the text went to "Chrome Legacy Window"
    // (pid 15956), not the target (pid 15928)' — 15956 was WhatsApp.Root's own
    // msedgewebview2 child. Right window, message actually typed, refused.
    await withMockedPcChild(pc(WHATSAPP, {
      typedIntoPid: 15956,
      typedIntoTitle: 'Chrome Legacy Window',
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'hi',
    }), async (m) => {
      const res = await m.ui_type({ text: 'hi', pid: WHATSAPP.pid });
      assert.equal(res.ok, true, 'a pid mismatch without a same-app verdict is not evidence the text went elsewhere');
      assert.equal(res.unverified, true, 'it must be spoken as attempted, not confirmed');
      assert.match(String(res.reason), /could not verify/i);
      assert.ok(!/wrong window/i.test(String(res.reason)),
        'and it must not accuse a window it could not check');
      assert.ok(!res.evidence, 'a read-back from the unverifiable window is not evidence — the BUG-066 lie shape');
    });
  });

  it('GUARD: typedIntoSameApp:false is still the hard failure it was on 2026-08-10', async () => {
    await withMockedPcChild(pc(WHATSAPP, {
      typedIntoPid: 4242, typedIntoTitle: 'Notepad',
      typedIntoSameApp: false,
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'hi',
    }), async (m) => {
      const res = await m.ui_type({ text: 'hi', pid: WHATSAPP.pid });
      assert.equal(res.ok, false, 'a POSITIVE wrong-app finding stays a failure — the honesty fix loosens nothing');
      assert.match(String(res.result || res.error), /wrong window/i);
    });
  });
});

describe('P0 — Enter reaches the app through the verified ladder', () => {
  it('THE RECORDED CASE: Enter in WhatsApp does not go out as a raw keystroke', async () => {
    const calls = [];
    await withMockedPcChild(pc(WHATSAPP, {
      typedIntoPid: 2132, focusedPid: 2132, caretSameApp: true,
      readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'hi',
    }, calls), async (m) => {
      await m.ui_type({ text: 'hi', pid: WHATSAPP.pid });
      const res = await m.send_key({ key: 'enter' });

      assert.equal(res.ok, true);
      const kinds = calls.map((c) => c.cmd);
      assert.ok(kinds.includes('submit_message'), 'must route to the ladder that proves the composer emptied');
      assert.equal(kinds.includes('send_key'), false,
        'a raw Enter is exactly what MSIX silently swallows, and firing both risks sending twice');
      assert.ok(res.evidence, 'the send carries evidence because the composer was observed to empty');
    });
  });

  it('Enter outside a chat app is still a plain keystroke', async () => {
    const calls = [];
    await withMockedPcChild(pc({ pid: 14556, title: 'Untitled - Notepad', process: 'notepad' }, null, calls),
      async (m) => {
        const res = await m.send_key({ key: 'enter' });
        assert.equal(res.ok, true);
        const kinds = calls.map((c) => c.cmd);
        assert.ok(kinds.includes('send_key'), 'Notepad has no compose box to submit');
        assert.equal(kinds.includes('submit_message'), false);
      });
  });

  it('an optional pid is forwarded so the caret guard can engage, and is never invented', async () => {
    const calls = [];
    await withMockedPcChild(pc({ pid: 14556, title: 'Untitled - Notepad', process: 'notepad' }, null, calls),
      async (m) => {
        await m.send_key({ key: 'tab', pid: 14556 });
        const withPid = calls.find((c) => c.cmd === 'send_key');
        assert.equal(withPid.pid, 14556, 'a caller-supplied pid must reach pc-child, or the guard cannot run');

        calls.length = 0;
        await m.send_key({ key: 'tab' });
        const noPid = calls.find((c) => c.cmd === 'send_key');
        assert.equal('pid' in noPid, false,
          'pid must NOT be defaulted to the last-launched app: "press escape" aims at whatever the ' +
          'operator is looking at, and a borrowed pid would abort on a caret mismatch nobody asked about');
      });
  });
});

describe('P1 — a failed ui_click names the recovery that actually works', () => {
  it('an empty-tree failure points at see_and_click', async () => {
    await withMockedPcChild(pc(WHATSAPP, null), async (m) => {
      const res = await m.ui_click({ pid: WHATSAPP.pid, elementPath: ['0', '2'] });
      assert.equal(res.ok, false);
      const msg = String(res.result || res.error);
      assert.match(msg, /see_and_click/, 'the failure message is the one prompt the model always reads');
      assert.match(msg, /out of range/, 'and it must still say what actually went wrong');
    });
  });
});
