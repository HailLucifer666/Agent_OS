'use strict';

// BUG-396 — see_and_click clicked the right pixel and then reported that nothing
// happened, because it asked the screen "did you change?" before the screen had
// any chance to answer.
//
// MEASURED, from the operator's live session on 2026-08-28
// (vault/Episodic/2026-08-28.jsonl, lines 40-45):
//
//   21:10:24.216  screen_look   -> "YouTube homepage", the target video found
//   21:10:25.690  see_and_click -> clicked "INDIA'S GOT LATENT S2 EP5 ft." at
//                                  605,715, unverified: "the screen reads
//                                  exactly the same afterwards"
//
// 1,474 ms for the WHOLE call: one full-desktop OCR read, the match, the click,
// and a second full-desktop OCR read. So the second read began roughly 700 ms
// after the click — and a browser navigating to a watch page does not repaint in
// 700 ms. The verification sampled the pre-navigation screen and concluded the
// click had hit nothing.
//
// WHY THIS IS THE WORST FAILURE MODE AVAILABLE. The operator asked for a video to
// play. It very likely did. MYTHOS then said "I clicked on the video, Sir, but
// I'm afraid I can't visually confirm that it started playing. Would you mind
// trying to play it manually?" — an honest sentence about a dishonest
// measurement, which from the operator's chair is indistinguishable from the tool
// being broken. from-pc.js's own comment records the opposite history: "click_at
// is 1 ok / 0 fail all-time" and "every failure is grounding, never the click".
// This is neither. It is the ORACLE failing, which no previous entry covers.
//
// THE CLASS: time-of-check to time-of-use. `before` is sampled, the world is
// changed, and `after` is sampled at a moment of the code's choosing rather than
// the world's. The fix does not assume the click worked — it gives the screen a
// bounded chance to show that it did, and a click that genuinely changes nothing
// still ends UNVERIFIED, which is the whole point of the oracle.
//
// Run: cd mythos && node --test test/bug-396-see-and-click-verifies-too-early.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const PC_CHILD_PATH = require.resolve('../adapters/pc-child');
const FROM_PC = require.resolve('../src/core/effectors/from-pc');

// Same stub shape as test/see-and-click.test.js — from-pc.js requires the adapter
// directly rather than taking it by injection, so the module cache is the seam.
function withStubbedChild(script, run) {
  const calls = [];
  const original = Module._load;
  Module._load = function (request, parent) {
    const resolved = (() => {
      try { return require.resolve(request, { paths: [parent.path] }); } catch { return null; }
    })();
    if (resolved === PC_CHILD_PATH) {
      return {
        getStatus: () => ({ state: 'ONLINE' }),
        sendCommand: async (cmd) => {
          calls.push(cmd);
          const reply = script(cmd, calls.length);
          return reply === undefined ? { ok: true, result: {} } : reply;
        },
      };
    }
    return original.apply(this, arguments);
  };
  try {
    delete require.cache[FROM_PC];
    return run(require(FROM_PC), calls);
  } finally {
    Module._load = original;
    delete require.cache[FROM_PC];
  }
}

// A believable YouTube home row, and the watch page it becomes. Both carry the
// clicked title, because a real navigation keeps the video's name on screen —
// asserting on "the text changed" rather than "the title vanished" is what the
// production oracle actually does.
const HOME = [
  { text: 'YouTube', x: 100, y: 40, width: 90, height: 20 },
  { text: "INDIA'S GOT LATENT S2 EP5 ft.", x: 480, y: 700, width: 250, height: 30 },
  { text: 'Starboy', x: 800, y: 700, width: 90, height: 30 },
];
const WATCH = [
  { text: 'YouTube', x: 100, y: 40, width: 90, height: 20 },
  { text: "INDIA'S GOT LATENT S2 EP5 ft. Orry", x: 300, y: 120, width: 400, height: 30 },
  { text: '1:02 / 58:14', x: 300, y: 640, width: 120, height: 20 },
  { text: 'Subscribe', x: 900, y: 120, width: 100, height: 24 },
];
const asOcr = (regions) => ({
  ok: true,
  result: { text: regions.map((r) => r.text).join('\n'), lineCount: regions.length, regions },
});

// Drives the no-pid path the operator's real call took:
// see_and_click({ occurrence: 1, text: "INDIA'S GOT LATENT" }) — no pid, so no
// focus_window, and the reads are whole-desktop.
// `readsBeforeChange` = how many POST-CLICK reads still show the OLD screen.
function runWithRepaintDelay(readsBeforeChange, opts) {
  let reads = 0;
  return withStubbedChild((cmd) => {
    if (cmd.cmd === 'screen_read_text') {
      reads += 1;
      if (reads === 1) return asOcr(HOME);                 // the `before` sample
      return asOcr(reads - 1 <= readsBeforeChange ? HOME : WATCH);
    }
    if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
    return { ok: true, result: {} };
  }, async (fromPc, calls) => {
    const res = await fromPc.see_and_click(Object.assign(
      { text: "INDIA'S GOT LATENT", occurrence: 1 }, opts || {}));
    return { res, calls, reads: calls.filter((c) => c.cmd === 'screen_read_text').length };
  });
}

describe('BUG-396 — the click oracle must give the screen time to repaint', () => {
  test('THE BUG: a repaint that lands after the first re-read is still a change', async () => {
    // One post-click read shows the stale screen; the next shows the watch page.
    // This is the operator's exact case and it is what fails on the old code:
    // the single immediate re-read saw HOME and returned unverified.
    const { res } = await runWithRepaintDelay(1);
    assert.equal(res.ok, true, 'the click landed and the screen did change — this is not unverified');
    assert.ok(!res.unverified,
      'reporting "I cannot tell that anything happened" about a screen that DID change is the defect');
    assert.equal(res.result.clicked, "INDIA'S GOT LATENT S2 EP5 ft.");
  });

  test('THE BUG, with expect: a late-arriving expectation still confirms', async () => {
    // `expect` was checked exactly once too, so the strongest form of evidence
    // the tool offers was the one most likely to be missed.
    const { res } = await runWithRepaintDelay(1, { expect: '1:02 / 58:14' });
    assert.equal(res.ok, true);
    assert.equal(res.result.confirmed, '1:02 / 58:14',
      'a matched expectation is the strong oracle and must survive a slow repaint');
  });

  test('ADJACENT, must not regress: a click that changes nothing stays UNVERIFIED', async () => {
    // The oracle's entire value. If this ever returns a clean ok, the fix has
    // replaced a false negative with a false positive, which is strictly worse.
    const { res } = await runWithRepaintDelay(Infinity);
    assert.equal(res.unverified, true, 'nothing changed, so nothing may be claimed');
    assert.match(res.reason, /reads exactly the same afterwards/,
      'the honest wording is load-bearing — the model is told not to claim success');
    // How hard the oracle tried is part of the finding, not decoration: "looked
    // three times" and "looked once" support the same sentence very differently.
    assert.equal(res.result.attempts, 3,
      'the unverified result must report how many looks it spent');
  });

  test('ADJACENT, must not regress: an instant repaint costs no extra reads', async () => {
    // A UI that repaints immediately must be exactly as fast as before the fix:
    // one `before` read, the click, one `after` read. Three commands, no waiting.
    const { res, calls, reads } = await runWithRepaintDelay(0);
    assert.equal(res.ok, true);
    assert.equal(reads, 2, 'a screen that already changed must not be polled again');
    assert.deepEqual(calls.map((c) => c.cmd), ['screen_read_text', 'click_at', 'screen_read_text']);
  });

  test('the retry budget is BOUNDED — a dead click cannot poll forever', async () => {
    // Without an upper bound this fix would hang the turn on every miss. The
    // number is asserted so raising it is a deliberate, reviewed edit.
    const { reads } = await runWithRepaintDelay(Infinity);
    assert.ok(reads >= 2, 'it must re-read at least once');
    assert.ok(reads <= 4, 'and at most 3 post-click attempts (got ' + (reads - 1) + ')');
  });

  test('a failed click still fails, and is never polled', async () => {
    // The oracle only runs on a click that reported success. A refused click must
    // short-circuit — polling a click that never landed would be pure latency.
    const out = await withStubbedChild((cmd) => {
      if (cmd.cmd === 'screen_read_text') return asOcr(HOME);
      if (cmd.cmd === 'click_at') return { ok: false, error: 'SendInput was discarded' };
      return { ok: true, result: {} };
    }, async (fromPc, calls) => {
      const res = await fromPc.see_and_click({ text: "INDIA'S GOT LATENT", occurrence: 1 });
      return { res, reads: calls.filter((c) => c.cmd === 'screen_read_text').length };
    });
    assert.equal(out.res.ok, false, 'a click that did not land is a failure, not an unverified success');
    assert.equal(out.reads, 1, 'no verification reads may follow a failed click');
  });

  test('an unreadable screen after the click is its own distinct outcome', async () => {
    // "I could not look" and "I looked and nothing changed" are different facts
    // and must not collapse into one message.
    const out = await withStubbedChild((cmd, n) => {
      if (cmd.cmd === 'screen_read_text') {
        return n === 1 ? asOcr(HOME) : { ok: false, error: 'OCR engine unavailable' };
      }
      if (cmd.cmd === 'click_at') return { ok: true, result: { clicked: true } };
      return { ok: true, result: {} };
    }, async (fromPc) => fromPc.see_and_click({ text: "INDIA'S GOT LATENT", occurrence: 1 }));
    assert.equal(out.unverified, true);
    assert.match(out.reason, /could not be re-read/,
      'an unreadable screen must say so, not claim the screen was identical');
  });
});

// ---------------------------------------------------------------------------
// The settle loop on its own. The effector tests above pay the real timer, so
// these inject a counting `wait` instead — the arithmetic is checked here and
// the wiring is checked there, rather than both by fiat.
// ---------------------------------------------------------------------------

const { settleForChange, SETTLE_ATTEMPTS, SETTLE_BACKOFF_MS } =
  require('../src/core/effectors/see-and-click-settle.js');

// Returns a reader that yields each script entry in turn, and records the waits.
function reader(script) {
  const waits = [];
  let n = 0;
  return {
    waits,
    read: async () => script[Math.min(n++, script.length - 1)],
    wait: async (ms) => { waits.push(ms); },
    get reads() { return n; },
  };
}
const screen = (text) => ({ ok: true, text: text, regions: [] });

describe('BUG-396 — settleForChange', () => {
  test('a screen that already changed costs one read and zero waits', async () => {
    const r = reader([screen('AFTER')]);
    const out = await settleForChange({ read: r.read, beforeText: 'BEFORE', wait: r.wait });
    assert.equal(out.kind, 'changed');
    assert.equal(out.attempts, 1);
    assert.deepEqual(r.waits, [], 'nothing to wait for once the answer has arrived');
  });

  test('a change on the last attempt is still a change', async () => {
    const r = reader([screen('BEFORE'), screen('BEFORE'), screen('AFTER')]);
    const out = await settleForChange({ read: r.read, beforeText: 'BEFORE', wait: r.wait });
    assert.equal(out.kind, 'changed');
    assert.equal(out.attempts, 3);
    assert.deepEqual(r.waits, [SETTLE_BACKOFF_MS, SETTLE_BACKOFF_MS]);
  });

  test('an unchanging screen spends the whole budget and no more', async () => {
    const r = reader([screen('BEFORE')]);
    const out = await settleForChange({ read: r.read, beforeText: 'BEFORE', wait: r.wait });
    assert.equal(out.kind, 'unchanged');
    assert.equal(out.attempts, SETTLE_ATTEMPTS);
    assert.equal(r.reads, SETTLE_ATTEMPTS, 'exactly the budgeted number of looks');
  });

  test('there is no wait after the FINAL look — it is latency nobody reads', async () => {
    const r = reader([screen('BEFORE')]);
    await settleForChange({ read: r.read, beforeText: 'BEFORE', wait: r.wait });
    assert.equal(r.waits.length, SETTLE_ATTEMPTS - 1,
      'N looks need N-1 gaps; an Nth wait delays the answer for nothing');
  });

  test('an unreadable screen stops immediately and is its own kind', async () => {
    const r = reader([screen('BEFORE'), { ok: false, error: 'OCR down' }]);
    const out = await settleForChange({ read: r.read, beforeText: 'BEFORE', wait: r.wait });
    assert.equal(out.kind, 'unreadable');
    assert.equal(out.attempts, 2, 'it reports WHICH look failed');
  });

  test('expect is the strong oracle: matched case-insensitively and trimmed', async () => {
    const r = reader([screen('now playing 1:02 / 58:14')]);
    const out = await settleForChange({
      read: r.read, beforeText: 'BEFORE', expect: '  1:02 / 58:14  ', wait: r.wait,
    });
    assert.equal(out.kind, 'expected');
  });

  test('expect wins over a bare change, because it is better evidence', async () => {
    // Both conditions are true on this read. Returning 'changed' would downgrade
    // a confirmed success to "something moved".
    const r = reader([screen('Subscribe')]);
    const out = await settleForChange({
      read: r.read, beforeText: 'BEFORE', expect: 'subscribe', wait: r.wait,
    });
    assert.equal(out.kind, 'expected');
  });

  test('expect that never appears falls back to the change verdict, not a claim', async () => {
    const r = reader([screen('AFTER')]);
    const out = await settleForChange({
      read: r.read, beforeText: 'BEFORE', expect: 'never on this screen', wait: r.wait,
    });
    assert.equal(out.kind, 'changed', 'a missing expectation must not be reported as confirmed');
  });

  test('the budget is overridable, and a nonsense budget falls back to the default', async () => {
    const one = reader([screen('BEFORE')]);
    assert.equal((await settleForChange({
      read: one.read, beforeText: 'BEFORE', attempts: 1, wait: one.wait,
    })).attempts, 1);
    assert.deepEqual(one.waits, [], 'a single-attempt budget has no gaps');

    const bad = reader([screen('BEFORE')]);
    assert.equal((await settleForChange({
      read: bad.read, beforeText: 'BEFORE', attempts: 0, wait: bad.wait,
    })).attempts, SETTLE_ATTEMPTS, 'zero attempts would disable the oracle entirely');
  });

  test('the default budget is 3 looks 500ms apart — change this deliberately', async () => {
    // Pinned so that widening the window (and with it the chance an unrelated
    // repaint is mistaken for the click landing) is a reviewed edit, not a drift.
    assert.equal(SETTLE_ATTEMPTS, 3);
    assert.equal(SETTLE_BACKOFF_MS, 500);
  });
});
