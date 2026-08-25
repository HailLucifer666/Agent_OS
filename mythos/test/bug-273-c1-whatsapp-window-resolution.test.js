'use strict';

// bug-273-c1-whatsapp-window-resolution.test.js — BUG-273 C1.
//
// MEASURED, vault/Audit/2026-08-18.jsonl — two sends, zero delivered:
//   whatsapp_send -> fail  "WhatsApp opened the chat with mom (+91…), but I could
//                           not identify its window, so I cannot type into it
//                           safely. The conversation should be open — the message
//                           is NOT sent."
//   whatsapp_send -> fail   same, for `alex`.
// The chat opened both times. Nothing was typed. Honest, and useless.
//
// WHY BOTH pid ATTEMPTS CAME BACK EMPTY. Step 1 launches a URI
// (`whatsapp://send?phone=…`), and since BUG-272 T1 launch_app only reports a pid
// when it can resolve a live windowed process whose NAME matches the request —
// deliberately, because a pid belonging to a different application is worse than
// no pid, and that change is what stopped a launch of "notepad" targeting the
// operator's IDE. A URI matches no process name, so T1 correctly declines. Step 2
// asks by name, but on a machine where WhatsApp is already running that is an
// activation whose new process exits immediately (the MSIX shape BUG-272 slice 4
// documents), so it can decline too. Two correct refusals, and no third option.
//
// THE FIX IS THE ONE launch_app's OWN FAILURE TEXT NAMES: "Call list_windows to see
// what is actually open." list_windows enumerates live top-level windows and
// returns {pid, processName, title, visible} — an observation of the world rather
// than a launch call's say-so, i.e. the same class of evidence T1 demands, obtained
// a different way. No UIA rung is added: this repo has already recorded that
// WinUI3 Invoke no-ops when pc-child is spawned, and the fix plan says so too.
//
// Q1 — matched on processName, NEVER on title. WhatsApp's window title is
// "(194) WhatsApp" whichever conversation is open, so a title match would happily
// select a browser tab or a chat with the wrong person.
//
// Q8 — WHAT DELIBERATELY DOES NOT CHANGE. If list_windows finds nothing either, the
// send still refuses. Typing blind is how a message reaches the wrong human, and
// step 3.5's recipient check exists because even a confirmed window is not a
// confirmed recipient. Both asserted below.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');
const WHATSAPP_PATH = require.resolve('../src/core/effectors/from-whatsapp');

// The 2026-08-18 shape: launch_app can name nothing, whichever way it is asked.
const NO_PID = { ok: true, unverified: true, reason: 'launched, but no windowed process matching the name could be confirmed', result: { launched: true } };

// The overrides receive the SAME calls array, because the first version of this
// file overrode list_windows without pushing to it and the assertion failed on
// correct code — the fake lost the instrumentation the test reads.
function load(makeOverrides) {
  const calls = [];
  const fakePc = {
    launch_app: async (a) => { calls.push({ fn: 'launch_app', name: a.name }); return NO_PID; },
    list_windows: async () => { calls.push({ fn: 'list_windows' }); return { ok: true, result: { windows: [], total: 0 } }; },
    focus_window: async (a) => { calls.push({ fn: 'focus_window', pid: a.pid }); return { ok: true, result: { pid: a.pid, focused: true } }; },
    ui_type: async (a) => {
      calls.push({ fn: 'ui_type', pid: a.pid, text: a.text });
      return { ok: true, result: { typed: true, length: String(a.text).length, typedIntoPid: a.pid, typedIntoTitle: 'WhatsApp' } };
    },
    send_key: async (a) => { calls.push({ fn: 'send_key', key: a.key }); return { ok: true, result: { key: a.key, sent: true } }; },
    readComposeBox: async (pid) => {
      calls.push({ fn: 'readComposeBox', pid });
      return { ok: true, result: { name: 'Type a message to +15551234567', currentText: '', headerName: null } };
    },
    submitMessage: async (pid) => {
      calls.push({ fn: 'submitMessage', pid });
      return { ok: true, unverified: false, result: { submitted: true, mechanism: 'uia-invoke-send', clearedText: 'x' } };
    },
  };
  Object.assign(fakePc, (typeof makeOverrides === 'function' ? makeOverrides(calls) : makeOverrides) || {});
  require.cache[FROM_PC_PATH] = { id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true, exports: fakePc };
  delete require.cache[WHATSAPP_PATH];
  const wa = require('../src/core/effectors/from-whatsapp');
  wa.registerFromWhatsapp({ register() {} }, {
    memory: { fs: { readJSONStrict: () => ({}) } },
    logger: { warn() {}, info() {} },
    // BUG-359 seam: these cases exercise the EXHAUSTED-poll refusal, which now
    // waits WINDOW_SETTLE_MS (6s) per send in production. Zero here keeps the
    // suite fast without changing what is asserted.
    windowSettleMs: 0,
    windowPollMs: 0,
  });
  return { wa, calls };
}

const WIN = (over) => Object.assign({ pid: 7788, processName: 'WhatsApp', title: '(194) WhatsApp', visible: true }, over || {});
const SEND = { to: '+15551234567', text: 'on my way', send: true };

describe('BUG-273 C1 — list_windows resolves the window launch_app could not name', () => {
  beforeEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('the 2026-08-18 failure now finds the window and types into it', async () => {
    const { wa, calls } = load((log) => ({
      list_windows: async () => { log.push({ fn: 'list_windows' }); return { ok: true, result: { windows: [WIN()], total: 1 } }; },
    }));
    const res = await wa.whatsapp_send(SEND);
    assert.notEqual(res.ok, false, 'this is the exact call that delivered nothing twice: ' + JSON.stringify(res.result));
    assert.ok(calls.some((c) => c.fn === 'list_windows'), 'the remedy launch_app names must actually be used');
    const typed = calls.find((c) => c.fn === 'ui_type');
    assert.ok(typed, 'the message must reach ui_type');
    assert.equal(typed.pid, 7788, 'and into the pid list_windows reported, not a guessed one');
  });

  it('Q1 — a title match is NOT enough: only processName counts', async () => {
    // A browser tab or an Explorer window can carry "WhatsApp" in its title. This is
    // the trap that targeted the operator's IDE for a launch of "notepad".
    const { wa } = load({
      list_windows: async () => ({ ok: true, result: {
        windows: [WIN({ processName: 'chrome', title: 'WhatsApp Web - Google Chrome' })], total: 1,
      } }),
    });
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false, 'a Chrome window titled WhatsApp must never be typed into');
    assert.match(String(res.result), /could not identify its window/);
  });

  it('skips a window the OS reports as not visible', async () => {
    const { wa } = load({
      list_windows: async () => ({ ok: true, result: { windows: [WIN({ visible: false })], total: 1 } }),
    });
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false, 'a zero-size window is not a window the operator can see');
  });

  it('Q8 — TWO WhatsApp windows is a refusal that names them, not a coin flip', async () => {
    const { wa } = load({
      list_windows: async () => ({ ok: true, result: {
        windows: [WIN({ pid: 111 }), WIN({ pid: 222 })], total: 2,
      } }),
    });
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false, 'picking one at random is the guess this whole path exists to avoid');
    assert.match(String(res.result), /2 windows report themselves as WhatsApp/);
    assert.match(String(res.result), /111, 222/, 'and it must name them, so the operator can act');
    assert.match(String(res.result), /NOT sent/);
  });

  it('Q8 — with nothing open at all it still refuses, and says both halves failed', async () => {
    const { wa, calls } = load({});   // list_windows returns an empty list
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false);
    assert.match(String(res.result), /launch_app could not name it/);
    assert.match(String(res.result), /no open window reports itself as WhatsApp/);
    assert.match(String(res.result), /NOT sent/, 'the operator must know nothing was delivered');
    assert.ok(!calls.some((c) => c.fn === 'ui_type'), 'and nothing may be typed');
  });

  it('a list_windows that itself fails degrades to the refusal, never to a guess', async () => {
    const { wa } = load({ list_windows: async () => ({ ok: false, result: 'pc-child is offline' }) });
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false);
    assert.match(String(res.result), /could not identify its window/);
  });

  it('the fallback is skipped entirely when launch_app DID name a pid', async () => {
    const { wa, calls } = load({
      launch_app: async () => ({ ok: true, result: { pid: 4242, launched: true } }),
    });
    const res = await wa.whatsapp_send(SEND);
    assert.notEqual(res.ok, false);
    assert.ok(!calls.some((c) => c.fn === 'list_windows'),
      'an extra pc-child round-trip on the happy path is pure cost');
    assert.equal(calls.find((c) => c.fn === 'ui_type').pid, 4242);
  });

  it("Q8 — a confirmed window is still not a confirmed recipient: BUG-064's check survives", async () => {
    // The composer names who it is addressed to. Resolving the WINDOW must not be
    // allowed to look like resolving the PERSON — sending to the wrong human is the
    // one error here that cannot be taken back.
    const { wa, calls } = load({
      list_windows: async () => ({ ok: true, result: { windows: [WIN()], total: 1 } }),
      readComposeBox: async () => ({ ok: true, result: { name: 'Type a message to +19998887777', currentText: '', headerName: null } }),
    });
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false, 'the composer is addressed to a different number and must be refused');
    assert.ok(!calls.some((c) => c.fn === 'ui_type'), 'nothing may be typed into the wrong conversation');
  });
});

describe('BUG-273 C1 — the fallback cannot be worse than the failure it replaces', () => {
  beforeEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('an ABSENT list_windows degrades to the refusal instead of throwing', async () => {
    // Q5: the first version called fromPc.list_windows() unguarded, which threw a
    // TypeError against any from-pc that does not expose it — turning a clean "the
    // message is NOT sent" into an exception. Found by whatsapp-send.test.js's
    // pre-existing no-window case, not by anything written for C1, which is the
    // argument for running the whole suite rather than the new file.
    const { wa, calls } = load((log) => ({ list_windows: undefined }));
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false, 'a missing dependency must not become a crash');
    assert.match(String(res.result), /NOT sent/);
    assert.ok(!calls.some((c) => c.fn === 'ui_type'));
  });

  it('a list_windows that THROWS is caught, and still refuses', async () => {
    const { wa } = load(() => ({ list_windows: async () => { throw new Error('pipe closed'); } }));
    const res = await wa.whatsapp_send(SEND);
    assert.equal(res.ok, false);
    assert.match(String(res.result), /NOT sent/);
  });

  it('a malformed windows payload is treated as no match, not as a match', async () => {
    for (const bad of [{ ok: true, result: {} }, { ok: true, result: { windows: 'nope' } }, { ok: true }, null]) {
      const { wa } = load(() => ({ list_windows: async () => bad }));
      const res = await wa.whatsapp_send(SEND);
      assert.equal(res.ok, false, `payload ${JSON.stringify(bad)} must not resolve a pid`);
    }
  });
});
