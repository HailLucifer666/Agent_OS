'use strict';

// bug-359-whatsapp-window-settle.test.js — BUG-359.
//
// THE MEASURED SESSION (2026-08-24 20:23–20:29 UTC): three operator-approved
// whatsapp_send dispatches, three failures —
//   ×2  "WhatsApp opened the chat … but I could not identify its window"
//   ×1  "Process 17056 has no main window."   (focus_window on the resolved pid)
//
// MEASURED LIVE ON THIS MACHINE, 2026-08-25: the desktop client is an MSIX app
// whose process OUTLIVES its window. With the chat closed:
//     pid=17056  processName=WhatsApp.Root  MainWindowHandle=0  title=<empty>
// and after activation the SAME pid owns a visible "WhatsApp" window. The
// operator's "the app is open" is true of the PROCESS; the window is a separate,
// asynchronous event. A deep link to this cold state takes seconds to produce an
// enumerable top-level window.
//
// from-whatsapp.js probed list_windows EXACTLY ONCE after the launch calls. On a
// cold start that single probe lands in the gap before the window exists, finds
// nothing, and refuses — honest, and useless, for the second time (BUG-273 C1's
// own Q8 note declined a settle-poll "until there is evidence of a timing case".
// This session is that evidence; the note asked for exactly this measurement).
//
// THE FIX follows this file's OWN precedent one stage earlier in the same flow:
// COMPOSER_SETTLE_MS/COMPOSER_POLL_MS already poll for the composer AFTER focus
// (A4). The window now gets the same bounded poll BEFORE focus. The refusal to
// type blind does not change: when the poll exhausts, the failure text is
// byte-identical to today's, and ambiguity (two matching windows) still refuses
// immediately — waiting cannot cure not-knowing-which.
//
// Run: cd mythos && node --test test/bug-359-whatsapp-window-settle.test.js

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');
const WHATSAPP_PATH = require.resolve('../src/core/effectors/from-whatsapp');

const NO_PID = { ok: true, unverified: true, reason: 'launched, but no windowed process matching the name could be confirmed', result: { launched: true } };
let clock;

function load(listWindowsResponses, ctxExtra) {
  const calls = [];
  const queue = Array.isArray(listWindowsResponses) ? listWindowsResponses : null;
  let probe = 0;
  const fakePc = {
    launch_app: async () => { calls.push({ fn: 'launch_app' }); return NO_PID; },
    list_windows: async () => {
      clock.tick(5);
      calls.push({ fn: 'list_windows' });
      const i = probe++;
      if (!queue) return { ok: true, result: { windows: [], total: 0 } };
      return queue[Math.min(i, queue.length - 1)];
    },
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
  require.cache[FROM_PC_PATH] = { id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true, exports: fakePc };
  delete require.cache[WHATSAPP_PATH];
  const wa = require('../src/core/effectors/from-whatsapp');
  wa.registerFromWhatsapp({ register() {} }, Object.assign({
    memory: { fs: { readJSONStrict: () => ({ mom: '+15551234567' }) } },
    logger: { warn() {}, info() {} },
    // Test seam — production gets the real settle via defaults; see BUG-359.
    windowSettleMs: 40,
    windowPollMs: 5,
  }, ctxExtra || {}));
  return { wa, calls };
}

const WA_WINDOW = (pid) => ({
  ok: true,
  result: { windows: [{ pid, processName: 'WhatsApp.Root', title: 'WhatsApp', visible: true }], total: 1 },
});

describe('BUG-359 — the window gets a bounded settle after a cold deep-link launch', () => {
  beforeEach((t) => {
    // Advance the deadline with probe time, not unrelated full-suite load.
    // Real sleep still runs; a 40ms CPU scheduling pause cannot erase probe 3.
    clock = t.mock.timers;
    clock.enable({ apis: ['Date'], now: 1000 });
  });
  it('a window that appears on a later probe completes the send instead of refusing', async () => {
    // Cold-start shape measured live: two probes too early, then the window.
    const h = load([
      { ok: true, result: { windows: [], total: 0 } },
      { ok: true, result: { windows: [], total: 0 } },
      WA_WINDOW(99),
    ]);
    const res = await h.wa.whatsapp_send({ to: 'mom', text: 'hi', send: true });
    assert.equal(res.ok, true,
      'the exact cold-start sequence from 2026-08-24 must reach typing once the window exists');
    assert.ok(h.calls.some((c) => c.fn === 'ui_type'));
    const probes = h.calls.filter((c) => c.fn === 'list_windows').length;
    assert.ok(probes >= 2, 'it polled rather than trusting the first empty answer');
  });

  it('a warm window answers on the FIRST probe — no added latency on the happy path', async () => {
    const h = load([WA_WINDOW(99)]);
    await h.wa.whatsapp_send({ to: 'mom', text: 'hi', send: true });
    const probes = h.calls.filter((c) => c.fn === 'list_windows').length;
    assert.equal(probes, 1, 'A4 precedent: a warm app must never wait out the settle');
  });

  it('an exhausted poll keeps the byte-for-byte honest refusal — never types blind', async () => {
    const h = load(null); // every probe comes back empty, forever
    const res = await h.wa.whatsapp_send({ to: 'mom', text: 'hi', send: true });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /could not identify its window/,
      'the C1 refusal text is the contract; settling changes WHEN we give up, not THAT we give up');
    assert.match(String(res.result), /no open window reports itself as WhatsApp/);
    const probes = h.calls.filter((c) => c.fn === 'list_windows').length;
    assert.ok(probes >= 2, 'it waited out more than one probe before refusing');
    assert.ok(!h.calls.some((c) => c.fn === 'ui_type'), 'nothing was typed into an unidentified window');
  });

  it('two matching windows refuse IMMEDIATELY — ambiguity is not cured by waiting', async () => {
    const both = {
      ok: true,
      result: { windows: [
        { pid: 11, processName: 'WhatsApp.Root', title: 'WhatsApp', visible: true },
        { pid: 22, processName: 'whatsapp', title: 'WhatsApp', visible: true },
      ], total: 2 },
    };
    const h = load([both]);
    const res = await h.wa.whatsapp_send({ to: 'mom', text: 'hi', send: true });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /will not guess which one to type into/);
    const probes = h.calls.filter((c) => c.fn === 'list_windows').length;
    assert.equal(probes, 1, 'polling past an ambiguous world would only burn seconds');
  });
});
