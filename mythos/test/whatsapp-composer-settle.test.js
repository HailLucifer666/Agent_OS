'use strict';

// whatsapp-composer-settle.test.js — cluster A4 of the 2026-08-14
// "everything fails" session: WhatsApp read the composer before the app had
// drawn it.
//
// MEASURED (vault/Audit/2026-08-14.jsonl):
//   17:29:26 whatsapp_send FAIL — "could not read its message box (No editable
//            element found...)"
//   17:31:11 the same failure again
//   17:31:47 SUCCESS — and only because the operator told it to wait first.
// The operator's diagnosis on the call was "WhatsApp takes a couple of seconds
// to start", and they were right about the first failure: focus_window returning
// proves the WINDOW exists, but WebView2 has not necessarily registered its
// editable surface yet, so ps-automation.ps1 answers honestly that there is no
// editable element.
//
// The fix is a bounded POLL, not a sleep — a fixed delay is a guess that is too
// slow when the app is warm (every send pays it) and too short when it is cold.
//
// THE SAFETY PROPERTY THIS MUST NOT WEAKEN. The retry loop covers "the composer
// is not there yet" and nothing else. BUG-064's recipient-match check is the
// reason whatsapp_send is trustworthy at all — sending to the wrong human is not
// a recoverable error — so a composer that IS found and names the wrong person
// must still be refused immediately, with no polling in the hope of a better
// answer. Both directions are asserted below.
//
// Honest scope: this removes the cold-start class. It does not "fix WhatsApp" —
// the second failure that day came 105s later with the app already focused, so
// something else is also in play (recorded in BUGS.md, not fixed here).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const FROM_PC_PATH = require.resolve('../src/core/effectors/from-pc');
const WHATSAPP_PATH = require.resolve('../src/core/effectors/from-whatsapp');

// Same module-cache swap the sibling whatsapp tests use, so nothing here touches
// a real desktop.
function load(pcOverrides) {
  const calls = [];
  const fakePc = {
    launch_app: async (a) => { calls.push({ fn: 'launch_app', ...a }); return { ok: true, result: { pid: 4242, launched: true } }; },
    focus_window: async (a) => { calls.push({ fn: 'focus_window', ...a }); return { ok: true, result: { pid: a.pid, focused: true } }; },
    ui_type: async (a) => {
      calls.push({ fn: 'ui_type', ...a });
      return { ok: true, result: { typed: true, length: String(a.text).length, typedIntoPid: a.pid, typedIntoTitle: 'WhatsApp' } };
    },
    send_key: async (a) => { calls.push({ fn: 'send_key', ...a }); return { ok: true, result: { key: a.key, sent: true } }; },
    readComposeBox: async (pid) => {
      calls.push({ fn: 'readComposeBox', pid });
      return { ok: true, result: { name: 'Type a message to +15551234567', currentText: '', headerName: null } };
    },
    submitMessage: async (pid) => {
      calls.push({ fn: 'submitMessage', pid });
      return { ok: true, unverified: false, result: { submitted: true, mechanism: 'uia-invoke-send', clearedText: 'x' } };
    },
  };
  Object.assign(fakePc, pcOverrides || {});
  require.cache[FROM_PC_PATH] = { id: FROM_PC_PATH, filename: FROM_PC_PATH, loaded: true, exports: fakePc };
  delete require.cache[WHATSAPP_PATH];
  const wa = require('../src/core/effectors/from-whatsapp');
  return { wa, calls };
}

function withContacts(wa, contacts) {
  wa.registerFromWhatsapp({ register() {} }, {
    memory: { fs: { readJSONStrict: () => contacts } },
    logger: { warn() {}, info() {} },
  });
}

// The real ps-automation.ps1 answer when WebView2 has not registered its
// editable surface yet — verbatim from the 2026-08-14 audit records.
const NOT_YET = { ok: false, result: 'No editable element found in the WhatsApp window.' };

describe('A4 the composer is given time to appear, then read', () => {
  beforeEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('a cold start that answers on the second read now succeeds', async () => {
    let reads = 0;
    const { wa, calls } = load({
      readComposeBox: async (pid) => {
        reads += 1;
        calls.push({ fn: 'readComposeBox', pid });
        if (reads === 1) return NOT_YET;
        return { ok: true, result: { name: 'Type a message to +15551234567', currentText: '', headerName: null } };
      },
    });
    withContacts(wa, { dad: '+15551234567' });

    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(reads, 2, 'exactly one extra read — this is the failure the operator had to talk it through');
    assert.deepEqual(calls.map((c) => c.fn),
      ['launch_app', 'focus_window', 'readComposeBox', 'readComposeBox', 'ui_type', 'submitMessage'],
      'and the rest of the sequence is unchanged');
  });

  it('a warm app pays nothing — one read, no wait', async () => {
    let reads = 0;
    const { wa } = load({
      readComposeBox: async () => {
        reads += 1;
        return { ok: true, result: { name: 'Type a message to +15551234567', currentText: '', headerName: null } };
      },
    });
    withContacts(wa, { dad: '+15551234567' });

    const startedAt = Date.now();
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(reads, 1, 'a fixed sleep would have made every warm send slower; a poll returns immediately');
    assert.ok(Date.now() - startedAt < 200, 'no settle delay is paid when the composer is already there');
  });

  it('several slow reads are tolerated inside the deadline', async () => {
    let reads = 0;
    const { wa } = load({
      readComposeBox: async () => {
        reads += 1;
        if (reads < 4) return NOT_YET;
        return { ok: true, result: { name: 'Type a message to +15551234567', currentText: '', headerName: null } };
      },
    });
    withContacts(wa, { dad: '+15551234567' });
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, true, String(res.result));
    assert.equal(reads, 4);
  });

  it('a composer that never appears still fails honestly, and says it waited', async () => {
    let reads = 0;
    const { wa, calls } = load({ readComposeBox: async () => { reads += 1; return NOT_YET; } });
    withContacts(wa, { dad: '+15551234567' });

    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false, 'a window with no composer is still a refusal — nothing may be typed blind');
    assert.match(String(res.result), /could not read its message box/,
      'the original reason must survive; the poll adds patience, not a new excuse');
    assert.match(String(res.result), /No editable element found/,
      'and the app\'s own words must still be carried through, not replaced by ours');
    assert.match(String(res.result), /after waiting/i,
      'the message must say the wait happened, or the next operator re-diagnoses a timing bug that was already ruled out');
    assert.match(String(res.result), /NOT sent|nothing was sent/i);
    assert.ok(reads > 1, 'it must actually have retried');
    assert.equal(calls.some((c) => c.fn === 'ui_type'), false, 'and nothing may be typed');
    assert.equal(calls.some((c) => c.fn === 'submitMessage'), false);
  });

  it('the poll is bounded — it cannot hang the turn', async () => {
    const { COMPOSER_SETTLE_MS, COMPOSER_POLL_MS } = require('../src/core/effectors/from-whatsapp')._internal;
    assert.ok(COMPOSER_SETTLE_MS > 0 && COMPOSER_SETTLE_MS <= 5000,
      'long enough for the measured cold start, short enough that a dead window is not a long stall; got ' + COMPOSER_SETTLE_MS);
    assert.ok(COMPOSER_POLL_MS >= 100 && COMPOSER_POLL_MS < COMPOSER_SETTLE_MS,
      'the interval must fit inside the deadline several times over; got ' + COMPOSER_POLL_MS);
  });
});

describe('A4 the recipient guard is untouched — the composer is read once, then obeyed', () => {
  beforeEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });
  afterEach(() => { delete require.cache[FROM_PC_PATH]; delete require.cache[WHATSAPP_PATH]; });

  it('a composer naming the WRONG human is refused, and the settle loop never runs', async () => {
    let reads = 0;
    const { wa, calls } = load({
      readComposeBox: async () => {
        reads += 1;
        return { ok: true, result: { name: 'Type a message to +19998887777', currentText: '', headerName: 'Someone Else' } };
      },
    });
    withContacts(wa, { dad: '+15551234567' });

    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.match(String(res.result), /REFUSED/,
      'BUG-064: sending to the wrong human is not a recoverable error. The settle poll covers '
      + '"not there yet" ONLY — a composer that IS found and names the wrong person must never be '
      + 're-read in the hope of a better answer.');
    assert.equal(calls.some((c) => c.fn === 'ui_type'), false);
    // The pre-existing deep-link retry (Wave 4) legitimately re-reads once. What
    // must NOT happen is the settle loop's repeated polling on top of it.
    assert.ok(reads <= 2, 'the wrong-recipient path must not enter the settle poll; reads=' + reads);
  });

  it('a wrong-recipient refusal is fast — no settle deadline is paid', async () => {
    const { wa } = load({
      readComposeBox: async () => ({ ok: true, result: { name: 'Type a message to +19998887777', currentText: '', headerName: null } }),
    });
    withContacts(wa, { dad: '+15551234567' });
    const startedAt = Date.now();
    const res = await wa.whatsapp_send({ to: 'dad', text: 'hi' });
    assert.equal(res.ok, false);
    assert.ok(Date.now() - startedAt < 1500,
      'a refusal that takes the full settle deadline means the loop is gating the wrong condition');
  });
});
