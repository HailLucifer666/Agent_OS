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
    //
    // TWICE MORE ON 2026-09-02, THIS GUARD CAUGHT WHAT NOTHING ELSE WOULD HAVE,
    // and both are recorded here because both are about the guard rather than
    // about any one site.
    //
    // 1. A REFACTOR MADE IT BLIND TO FOUR SITES. The four turn-auditing
    //    detectors were collapsed into one shared reporter (the size ratchet
    //    demanded it), and the first draft passed each site as a bare positional
    //    string. The labels stopped being written in the form this matcher
    //    greps, so four narration paths vanished from this list at once — while
    //    still firing in production. The reporter now takes an OPTIONS OBJECT so
    //    every site stays a quoted literal. That label is load-bearing beyond
    //    this test: BUG-273 D3's injection log keys on it.
    // 2. THE COMMENT EXPLAINING THAT FIX BECAME A THIRTEENTH SITE. It quoted the
    //    pattern verbatim, so the grep counted the prose as a narration path.
    //    Exactly the trap build-index.js's `bulletMarks` comment already warns
    //    about — a pattern that matches ids must not look like one, and neither
    //    must the sentence explaining it. Reworded to describe the shape without
    //    spelling it.
    //
    // THE CHARACTER CLASS IS THE WHOLE TEST. The first version of this matcher was
    // /site:\s*'([a-z-]+)'/ and reported FOUR sites. There are six: 'ad4-correction-
    // premature' and 'ad4-correction-retract' contain a digit, so the class failed
    // mid-label and skipped them silently. A guard against "a narration path nobody
    // enumerated" that itself under-counted narration paths is the exact class it
    // exists to catch, and it was caught by reading the real output rather than by
    // the guard going red. Keep 0-9 in the class.
    const sites = [...src.matchAll(/site:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(sites, [
      'ad4-correction-premature',
      'ad4-correction-retract',
      // Added by BUG-299, and this assertion is how it got enumerated: the new
      // site made this test fail on the same commit that introduced it, which is
      // precisely the job. Its prohibition is checked in
      // bug-299-fragment-cannot-license-a-fact.test.js.
      'ad4-correction-unheard',
      // Added by BUG-275 H3/H4 (2026-09-02) — a ranked position handed to a name
      // that occurs in none of the fact-finding results in evidence. This guard
      // did its job a third time: the new site reddened this test on the commit
      // that introduced it, and the enumeration below was written only after
      // checking what the message instructs.
      //
      // ITS PROHIBITION: "Do NOT restate that ranking as established." Wording
      // pinned in bug-275-unsourced-ranked-entity.test.js (logic) and
      // bug-275-evidence-digest-reaches-the-ledger.test.js (the notice actually
      // reaching the model), and the prose itself now lives in
      // src/core/voice/turn-audit-notices.js.
      //
      // IT IS THE ONLY SITE IN THIS LIST THAT IS NOT A "CORRECTION". Its message
      // opens "CHECK of your own prior statement", deliberately: the detector
      // knows the name is absent from the results and does NOT know why, and
      // H3's measured cause was an earlier lookup ageing out of the 120s window
      // rather than invention. Asserting a cause here is what BUG-398 row 5 was.
      //
      // NOT in bug-273-unverified-payload.test.js's matrix, for the same reason
      // as the D1 site below: that file enumerates paths narrating a TOOL
      // OUTCOME, and this one narrates a property of a reply.
      // Added by BUG-275 H2 (2026-09-02) — the operator disputes a claim and the
      // reply EXPLAINS it instead of re-checking. The DIG-IN twin of
      // bug398-row7-false-retraction below: that site stops the model taking
      // back something proven, this one stops it defending something unproven.
      // BUG-398 row 7 recorded that "there is NO POLICY for 'the operator
      // contradicts my evidence'"; these two sites are that policy, from both
      // sides.
      //
      // ITS PROHIBITION: "Do NOT explain what a name or a figure 'refers to'
      // from memory while it is being disputed." Wording pinned in
      // bug-275-h2-defended-under-challenge.test.js, which also asserts the
      // notice does NOT claim the operator was right — that is unmeasured, and
      // asserting it would be BUG-398 row 5 pointed at an opinion.
      //
      // Like the two BUG-398 sites, NOT in bug-273-unverified-payload.test.js's
      // matrix: that file enumerates paths narrating a TOOL OUTCOME.
      'bug275-h2-defended-challenge',
      'bug275-h3-unsourced-ranking',
      // Added by BUG-398 D1 (2026-09-02) — a promised RECURRING commitment with
      // nothing scheduled. This guard did its job again: the new site made this
      // test fail on the commit that introduced it. Enumerated here after
      // checking, as the message below instructs, that it carries a prohibition
      // ("Do NOT repeat the promise") and that its wording is pinned — in
      // bug-398-d1-promised-schedule-not-created.test.js, whose wiring tests
      // assert the notice names `remember` as the trap and `reminder_add` as the
      // remedy. It is NOT in bug-273-unverified-payload.test.js's matrix on
      // purpose: that file enumerates the paths that narrate a TOOL OUTCOME, and
      // this site narrates the absence of one.
      'bug398-d1-unscheduled-commitment',
      // Added by BUG-398 row 7 (2026-09-02) — the model retracting a PROVEN
      // action under operator pressure. The only site in this list whose
      // prohibition runs the OTHER way: it forbids taking a true claim back
      // rather than making a false one. Its wording ("Do NOT retract it",
      // RECONCILE, and the concrete next step) is pinned in
      // bug-398-cluster-b-narration.test.js.
      'bug398-row7-false-retraction',
      'confirm-rejected-by-voice',
      'confirm-resolved',
      // Added by BUG-457 (2026-09-24), and this guard reddened on the commit that
      // introduced it, as intended. A held reply's call was CANCELLED by Google
      // (the operator spoke during the hold), and live the model once invented the
      // missing result. This notice narrates the ABSENCE of an outcome: its whole
      // text is the prohibition — "NOT known yet: do not state, guess or invent it"
      // — pinned in bug-457-held-reply.test.js (f) and (i). NOT in
      // bug-273-unverified-payload.test.js's matrix, for the reason given above:
      // that file enumerates paths narrating a TOOL OUTCOME, and there is none here.
      'held-call-cancelled',
      'late-for-turn',
      'late-outcome',
      // Added by BUG-357 — the affirmative twin of confirm-rejected-by-voice: a
      // spoken go-ahead over still-pending confirms is told its words dispatched
      // nothing. Its wording is pinned in bug-357-reply-grounding.test.js.
      'spoken-go-ahead-no-dispatch',
    ], 'these are the sendSystemNotice sites; the remaining narration path is the awaited '
      + 'functionResponse, which does not inject. If this list changed, a narration path was '
      + 'added or removed — enumerate it here and in bug-273-unverified-payload.test.js, and '
      + 'check the new one carries a prohibition, BEFORE changing this assertion.');
  });
});
