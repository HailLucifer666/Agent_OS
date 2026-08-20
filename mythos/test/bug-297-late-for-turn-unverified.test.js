'use strict';

// test/bug-297-late-for-turn-unverified.test.js — BUG-297.
//
// THE FOURTH NARRATION PATH, and BUG-273 B1 never knew it existed.
//
// BUG-273 B1 fixed one invariant — every "this did not certainly happen" outcome
// must carry a prohibition — across the three paths it enumerated: the awaited
// branch, reportLateOutcome, and resolveLiveConfirm. Its own test file says so:
// "it enumerates all three narration paths and requires the prohibition on each,
// so a fourth path (or a tool moved between them) fails here rather than in a
// voice session."
//
// There is a fourth, and it is inside commitAction. When a tool resolves INSIDE
// the ack deadline but its turn has already closed underneath it, the outcome
// cannot go back as a functionResponse — the addressee is gone — so commitAction
// re-narrates it onto the [SYSTEM] channel. That branch recomputed the
// instruction from {tool, ok} alone, and:
//
//   commitAction({ tool, ok: ev.ok, unverified: ev.unverified, summary })
//   ...
//   entry.ok ? 'Report this to the operator accurately.' : NO_SUCCESS_CLAIM
//
// CORRECTION TO BUG-295's OWN CODE COMMENT, which called this a fall-through to
// the neutral default. It is not, and the truth is worse. `evaluateOutcome`
// computes `ok: dispatchOk && !isUnverified`, so `ev.ok` is FALSE for an
// unverified outcome — and the branch above therefore hands it NO_SUCCESS_CLAIM,
// i.e. tells the model the action DID NOT SUCCEED. Measured, not reasoned: the
// red run of this file printed the notice, and it read "ui_type ran but could NOT
// be confirmed … This action did NOT succeed."
//
// That is the exact collapse BUG-273 B2's Q8 forbids in writing: "reporting that
// as a failure would make MYTHOS deny things it actually did — its own kind of
// lying." ui_type's unverified outcome means the text may well be sitting in the
// document. On this path MYTHOS was told to announce that it is not.
//
// Found while fixing BUG-295 and deliberately NOT fixed there: a no-content
// commit is the wrong place to close an unverified hole, and it would have
// shipped without a red test of its own. This is that red test — and it caught
// BUG-295's description of the defect being wrong, which is the argument for
// writing one instead of patching from a code read.
//
// Q6 — WHAT CLASS IS THIS AN INSTANCE OF? The fifth occurrence of "only some
// narration paths carry the honesty sentence" (BUG-068, BUG-116, BUG-273 B1,
// BUG-295). Every previous fix enumerated the paths it knew about; none of them
// could enumerate a path it had not found. So the assertion below is written
// against the PATH COUNT, not against a list of three: see the final test.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

function baseDeps(overrides) {
  return Object.assign({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-297', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: { done: true } }),
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-297',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  }, overrides || {});
}

// ui_type's real unverified payload, from BUG-068's own record.
const UI_TYPE_UNVERIFIED = {
  ok: true,
  unverified: true,
  reason: 'the focused control exposes neither ValuePattern nor TextPattern, so its text cannot be read back',
  result: { typed: true, readBack: 'unavailable' },
};

// Drives the real fourth path: dispatch resolves well inside the 1500ms ack
// deadline (so this is a genuine OUTCOME, not a 'started' ack), but the turn is
// closed underneath it while it is in flight. That is the only way in.
async function runLateForTurn(outcome, toolName) {
  const sentText = [];
  const anomalies = [];
  const adapter = createLiveToolAdapter(baseDeps({
    dispatchAction: async () => { await new Promise((r) => setTimeout(r, 30)); return outcome; },
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    bus: { emit: (type, payload) => { if (type === 'health.anomaly') anomalies.push(payload); } },
  }));
  const inFlight = adapter.handleLiveToolCalls(
    [{ id: 'c1', name: toolName, args: { text: 'Hi Alex' } }],
    { sendToolResponse: () => {} },
  );
  // Close the turn while the dispatch is still running.
  await new Promise((r) => setTimeout(r, 5));
  adapter.onLiveTurnComplete({ userText: 'type hi alex', assistantText: 'doing that now' });
  await inFlight;
  return { sentText, anomalies, adapter };
}

describe('BUG-297 — the late-for-turn re-narration is the fourth path', () => {
  test('the premise: an outcome really does arrive after its turn closed', async () => {
    // Guard the setup. If this stops reaching the late-for-turn branch, every
    // assertion below would pass vacuously against the ordinary awaited path.
    const { anomalies } = await runLateForTurn(UI_TYPE_UNVERIFIED, 'ui_type');
    assert.ok(anomalies.some((a) => a && a.kind === 'live-tool-outcome-late-for-turn'),
      'this test must exercise the late-for-turn branch, not the ordinary awaited one');
  });

  test('an UNVERIFIED outcome carries the no-proof prohibition, not the neutral default', async () => {
    const { sentText } = await runLateForTurn(UI_TYPE_UNVERIFIED, 'ui_type');
    const notice = sentText.at(-1);
    assert.ok(notice, 'the outcome must still reach the model at all');
    assert.match(notice, /ValuePattern/, 'the model must still learn WHAT is unproven');
    assert.match(notice, /NO proof either way/i, 'must state that nothing is proven');
    assert.match(notice, /Do NOT say it worked/i, 'must forbid the success claim');
    assert.match(notice, /Do NOT claim it FAILED/i,
      'unverified is NOT failed — evidence.js is explicit that it may well have landed');
    assert.doesNotMatch(notice, /Report this to the operator accurately/,
      'the neutral default is the weakest instruction in the file, and this is the path with '
      + 'no functionResponse for the model to cross-check against');
  });

  test('a CONFIRMED-STEP outcome gets the partial wording, not the stricter one', async () => {
    // BUG-273 B2: applying the no-proof wording to a confirmed hand-off gags the
    // model about the very fact the operator asked for. `confirmedStep` has to
    // survive the trip to this site or the distinction collapses here.
    const { sentText } = await runLateForTurn({
      ok: true,
      unverified: true,
      reason: 'the page never reported a load event',
      confirmedStep: 'the field was focused',
      result: { handedOff: true },
      // NOT browser_switch, though it is the natural example: browser_switch is a
      // SLOW_TOOL, so it acks 'started' and never reaches commitAction's
      // late-for-turn branch at all. The red run caught that as an undefined
      // notice rather than a wrong one.
    }, 'ui_type');
    const notice = sentText.at(-1);
    assert.match(notice, /State the confirmed part plainly/i);
    assert.doesNotMatch(notice, /NO proof either way/i,
      'a confirmed step must not be described as wholly unproven');
  });

  test('a FAILED outcome still reads as failed', async () => {
    // ui_type again rather than launch_app, for the SLOW_TOOLS reason above.
    const { sentText } = await runLateForTurn(
      { ok: false, result: { error: 'the target window vanished' } }, 'ui_type');
    assert.match(sentText.at(-1), /did NOT succeed/i);
    assert.doesNotMatch(sentText.at(-1), /Do NOT claim it FAILED/i,
      'the unverified wording must not leak onto a genuine failure');
  });

  test('a VERIFIED outcome is still left un-hedged', async () => {
    // The negative control. Hedging a proven outcome is its own dishonesty.
    const { sentText } = await runLateForTurn({
      ok: true,
      unverified: false,
      evidence: { oracle: 'read-back', observed: 'Hi Alex' },
      result: { typed: true },
    }, 'ui_type');
    assert.match(sentText.at(-1), /Report this to the operator accurately/);
    assert.doesNotMatch(sentText.at(-1), /NO proof either way/i);
  });

  test('BUG-295 still holds here: a content-free success keeps its own prohibition', async () => {
    const { sentText } = await runLateForTurn({
      ok: true,
      result: { url: 'https://example.com', title: 'Example', newTab: true, browser: 'chrome' },
    }, 'browser_navigate');
    assert.match(sentText.at(-1), /have NOT read/i);
    assert.doesNotMatch(sentText.at(-1), /NO proof either way/i,
      'no-content and unverified are different claims and must not both fire');
  });

  test('Q2 — the audit summary stays a record, with no prompt text in it', async () => {
    const { adapter } = await runLateForTurn(UI_TYPE_UNVERIFIED, 'ui_type');
    // The entry is routed to health.anomaly rather than liveTurnActions by
    // design, so what must be checked is that the prohibition never travelled in
    // `summary` — the field that feeds the audit and episodic record.
    for (const entry of adapter._internal.liveTurnActions) {
      assert.doesNotMatch(String(entry.summary), /Do NOT/,
        'the prohibition belongs in the instruction; the record must read as a record');
    }
  });

  // Q6, and this is the part BUG-068, BUG-116, BUG-273 B1 and BUG-295 all failed
  // to write down. Each enumerated the paths it knew about, and none could
  // enumerate a path it had NOT found — which is exactly how this one survived
  // four fixes. So the guard is on the POPULATION of narration sites rather than
  // on a remembered list of three: a new one appears, and this fails by name.
  //
  // MEASURED, not assumed: the red run of this test printed the real set, and it
  // was four, not the two this assertion was first written against. BUG-273 B1's
  // "all three narration paths" was already an undercount when it was written.
  test('the population of [SYSTEM]-channel narration sites is pinned', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'voice', 'live-tool-adapter.js'), 'utf8');
    // Every injection tags itself with a `site:` label — BUG-273 D3's injection
    // log — so these labels are load-bearing already, not a shape invented here.
    const sites = [...src.matchAll(/site:\s*'([a-z-]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(sites, [
      'confirm-rejected-by-voice',
      'confirm-resolved',
      'late-for-turn',
      'late-outcome',
    ], 'these are the sendSystemNotice sites; the fifth narration path is the awaited '
      + 'functionResponse, which does not inject. If this list changed, a narration path was '
      + 'added or removed — enumerate it here and in bug-273-unverified-payload.test.js, and '
      + 'check the new one carries a prohibition, BEFORE changing this assertion.');
  });
});
