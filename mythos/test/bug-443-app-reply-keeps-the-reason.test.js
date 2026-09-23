'use strict';

// test/bug-443-app-reply-keeps-the-reason.test.js — the failure reason
// app_reply threw away.
//
// OBSERVED 2026-09-16 10:41:31Z, live, in vault/Audit: app_reply failed and the
// row read
//
//   "Could not type the reply into whatsapp: [object Object] Nothing was sent."
//
// The operator was told a tool failed and given nothing to act on. Worse, that
// sentence is what MYTHOS SPEAKS — so the spoken explanation was the literal
// words "object Object".
//
// WHY — AND IT WAS TWO DEFECTS, NOT ONE. The ticket named the second; the first
// was found only by driving this test and reading where the string was really
// born.
//
//   1. from-pc.js `delegate()` read `resp.error` raw. pc-child can answer with a
//      STRUCTURED error, and two lines later window-recovery.js does
//      `String(text || '')` — so the object became "[object Object]" at that
//      boundary, and every caller downstream faithfully carried the literal on.
//      That is where the 2026-09-16 row was actually made. It had a quieter
//      second cost: isStaleWindowTarget() matches a regex, and a regex never
//      matches an object, so BUG-405's dead-pid recovery could not fire on a
//      structured failure at all.
//   2. from-app-reply.js rendered its OWN failures with `String(...)`. Its
//      local pc() helper calls pc-child directly, bypassing from-pc entirely,
//      so three of its four sites (list_windows, focus_window,
//      focus_message_box) see raw adapter values and needed the fix
//      independently of (1). Neither fix subsumes the other, which the two
//      mutations below demonstrate separately.
//
// JavaScript's default object toString is "[object Object]", so in both cases
// the more information the producer supplied, the less the operator got.
//
// THIS IS THE THIRD INSTANCE OF THE CLASS IN THIS REPOSITORY, which is why the
// helper already exists and why this fix is four call sites rather than a
// fourth private normalizer: dispatch-action.js hit it on 2026-07-29 (its own
// Audit file has the same literal), BUG-101 before that, and
// scripts/google-auth.js after. util/reason-text.js was extracted for exactly
// this and was simply never reached from here.
//
// BRANCH TRAVERSED (protocol STAGE 4.11): all four failure-rendering returns in
// from-app-reply.js — list_windows, focus_window, focus_message_box and
// ui_type — each driven through the real module with a stubbed pc-child, using
// app-reply-flow.test.js's established harness.
//
// MUTATION PROBES, run 2026-09-18, each diffed to confirm it applied:
//   (p1) revert from-pc.js's `reasonText(resp.error || …)` to the raw value
//        => fails 'the typing failure names its cause' and 'an empty object
//           says what it was', reproducing the Audit row.
//   (p2) revert from-app-reply.js's focus_window site to String(…)
//        => fails 'a focus refusal names its cause', which p1 does not touch.
// Two mutations because there are two defects; one probe would have let the
// other fix look load-bearing when it is not the whole story.
//
// A third probe was attempted first and SILENTLY DID NOT APPLY — a sed whose
// delimiter collided with a `||` in the pattern. The suite came back green,
// which is exactly what a working guard looks like. It was caught only by
// diffing the file before trusting the result, and that is why the diff is not
// optional.
//
// ADJACENT CASES THAT MUST KEEP PASSING, asserted below: a plain-string reason
// is passed through unchanged (the helper must not "improve" it), a successful
// compose still reports its read-back, and the "Nothing was sent." promise is
// still on every one of these sentences — the reason text changing must not
// quietly drop the part that tells the operator no message left the machine.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const APP_REPLY_PATH = path.resolve(__dirname, '../src/core/effectors/from-app-reply.js');
const FROM_PC_PATH = path.resolve(__dirname, '../src/core/effectors/from-pc.js');

const originalRequire = Module.prototype.require;

function withMockedPcChild(mock, fn) {
  Module.prototype.require = function (id) {
    if (id === '../../../adapters/pc-child') return mock;
    return originalRequire.apply(this, arguments);
  };
  delete require.cache[APP_REPLY_PATH];
  delete require.cache[FROM_PC_PATH];
  try {
    return fn(require(APP_REPLY_PATH));
  } finally {
    Module.prototype.require = originalRequire;
    delete require.cache[APP_REPLY_PATH];
    delete require.cache[FROM_PC_PATH];
  }
}

const WA_WIN = { pid: 7100, title: 'Alex Rivera - WhatsApp', process: 'WhatsApp' };

// Cooperative up to the step a test breaks. Mirrors app-reply-flow.test.js's
// desktop() rather than inventing a second shape.
function desktop(over) {
  const o = over || {};
  const mock = {
    getStatus: () => ({ state: 'ONLINE' }),
    sendCommand: async (c) => {
      switch (c.cmd) {
        case 'list_windows':
          if (o.listFails) return o.listFails;
          return { ok: true, result: { windows: [WA_WIN] } };
        case 'focus_window':
          if (o.focusFails) return o.focusFails;
          return { ok: true, result: { focused: true, pid: c.pid } };
        case 'get_foreground_window':
          return { ok: true, result: { pid: WA_WIN.pid, title: WA_WIN.title, process: 'WhatsApp' } };
        case 'screen_read_text':
          return { ok: true, result: { text: 'Alex Rivera\nare you around?\nType a message', lineCount: 3 } };
        case 'focus_message_box':
          if (o.boxFails) return o.boxFails;
          return { ok: true, result: { focused: true, via: 'ValuePattern', method: 'uia-setfocus', name: 'Type a message', existingText: '', candidateCount: 2 } };
        case 'ui_type':
          if (o.typeFails) return o.typeFails;
          return { ok: true, result: { typed: true, typedIntoPid: c.pid, typedIntoTitle: WA_WIN.title, readBack: 'confirmed', readBackVia: 'ValuePattern', readBackText: 'on my way' } };
        default:
          return { ok: true, result: {} };
      }
    },
  };
  return { mock };
}

function messageOf(res) {
  return String(res && res.result);
}

describe('BUG-443 — app_reply keeps the reason it was given', () => {
  it('the typing failure names its cause instead of [object Object]', async () => {
    // THE WIRE SHAPE, and getting this wrong is itself part of the finding.
    // The first draft of this test used `{ok:false, result:{...}}`, which
    // from-pc.js's delegate() ignores — it reads `resp.error` — so the message
    // came back as the generic "PC automation command failed." and the test
    // failed for a reason that had nothing to do with the bug. pc-child answers
    // a failed command with `{ok:false, error: <string|object>}`, and it is the
    // OBJECT case that produced the 2026-09-16 Audit row. A fixture more
    // generous than the wire proves nothing about the wire.
    const { mock } = desktop({
      typeFails: { ok: false, error: { error: 'SendInput was discarded by the packaged app', code: 'MSIX_BLOCKED' } },
    });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.equal(res.ok, false);
      const msg = messageOf(res);
      assert.doesNotMatch(msg, /\[object Object\]/,
        'THE FILED DEFECT: this sentence is spoken aloud and written to the Audit trail, so the operator '
        + 'heard the literal words "object Object" instead of a reason');
      assert.match(msg, /SendInput was discarded by the packaged app/,
        'the producer supplied a real cause and it must survive to the operator');
      assert.match(msg, /Nothing was sent\./, 'and the promise that nothing left the machine still holds');
    });
  });

  it('a window-listing failure names its cause', async () => {
    const { mock } = desktop({ listFails: { ok: false, error: { error: 'pc-child stopped responding', lastCommandId: 41 } } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.equal(res.ok, false);
      assert.doesNotMatch(messageOf(res), /\[object Object\]/);
      assert.match(messageOf(res), /pc-child stopped responding/);
    });
  });

  it('a focus refusal names its cause', async () => {
    const { mock } = desktop({ focusFails: { ok: false, error: { error: 'foreground lock held by another process', pid: 17996 } } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.equal(res.ok, false);
      assert.doesNotMatch(messageOf(res), /\[object Object\]/);
      assert.match(messageOf(res), /foreground lock held by another process/);
      assert.match(messageOf(res), /Nothing was typed\./);
    });
  });

  it('a missing message box names its cause, from either channel', async () => {
    const viaError = desktop({ boxFails: { ok: false, error: { error: 'UIA returned no editable element' } } });
    await withMockedPcChild(viaError.mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.doesNotMatch(messageOf(res), /\[object Object\]/);
      assert.match(messageOf(res), /UIA returned no editable element/);
    });

    // The second channel this site reads: ok:true-shaped result carrying the
    // reason. Both were String()'d before, so both could produce the literal.
    const viaResult = desktop({ boxFails: { ok: true, result: { focused: false, error: { error: 'the candidate was read-only' } } } });
    await withMockedPcChild(viaResult.mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.doesNotMatch(messageOf(res), /\[object Object\]/);
      assert.match(messageOf(res), /the candidate was read-only/);
    });
  });

  it('an empty object says what it was rather than trailing off after the colon', async () => {
    const { mock } = desktop({ typeFails: { ok: false, error: {} } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      const msg = messageOf(res);
      assert.doesNotMatch(msg, /\[object Object\]/);
      assert.doesNotMatch(msg, /:\s+Nothing was sent/,
        'a sentence that stops after the colon is strictly worse than a bad reason — there is nothing to '
        + 'search for. reason-text.js was extended for exactly this on 2026-08-14');
      assert.match(msg, /empty object/);
    });
  });

  // ---- the adjacent cases ------------------------------------------------------

  it('a plain-string reason is passed through unchanged', async () => {
    const { mock } = desktop({ typeFails: { ok: false, error: 'the window closed mid-type' } });
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.match(messageOf(res), /the window closed mid-type/,
        'the helper normalizes structure; it must not paraphrase a reason that was already a sentence');
    });
  });

  it('a successful compose is untouched and still stops before sending', async () => {
    const { mock } = desktop();
    await withMockedPcChild(mock, async (m) => {
      const res = await m.app_reply({ app: 'whatsapp', text: 'on my way' });
      assert.equal(res.ok, true);
      assert.equal(res.result.sendPending, true, 'the human still closes the loop');
      assert.equal(res.result.sent, false);
    });
  });
});
