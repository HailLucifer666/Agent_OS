'use strict';

// test/bug-398-aborted-in-flight-is-not-a-failure.test.js — BUG-398 R5a.
//
// THE DEFECT. hub.js's caller-abort (raceSignal, added by a0c82fe for
// GAP-ANALYSIS H1) stops WAITING for an effector; it does not cancel it. Until
// this fix that outcome carried nothing but `ok:false`, so all four narration
// paths in live-tool-adapter.js told the model the action FAILED.
//
// WHY IT IS NOT HYPOTHETICAL. Measured in the 2026-09-02 live voice session:
// whatsapp_send returned `outcome:fail reason:"tool-timeout"` twice while the
// operator watched the message ARRIVE. submitMessage (from-pc.js:353) injects
// the send and only then waits for the composer to clear as its oracle, so the
// abort landed after delivery, during confirmation. MYTHOS then OFFERED TO SEND
// IT AGAIN — a duplicate outward message to a third party, and the only
// irreversible consequence found in that session.
//
// THE CONTRACT PINNED HERE. An aborted-in-flight outcome must be narrated as
// "not confirmed, do not repeat" on EVERY path, and must never render as a
// failure in the record the next turn reads. It is deliberately its own state
// rather than a reuse of `unverified`: the CLAIM is the same ("no proof either
// way") but the permitted next MOVE is not. An unverified launch_app is safe to
// attempt again and MYTHOS currently recovers from it correctly; an aborted
// whatsapp_send is not.
//
// WHY ALL FOUR PATHS IN ONE FILE. This file's shape is copied from
// bug-273-unverified-payload.test.js, and for its reason: BUG-068, BUG-116,
// BUG-273 and BUG-297 were each one narration path being fixed while the others
// kept the defect. Four sites, four tests, one file — the assertion those four
// bugs each wished had existed.
//
// MUTATION PROOF — seven probes, run 2026-09-02, every one of them green
// BEFORE this change. Each was verified APPLIED by re-counting the mutated
// string in the file before re-running (the first attempt at probe (a) was a
// perl one-liner that silently no-op'd and reported all 11 tests passing, which
// is precisely what a broken mutation looks like), and each was restored from a
// full-path copy — `git checkout` would have eaten the uncommitted fix.
//
// Every probe reds EXACTLY the site it disables, which is what proves the six
// sites are independently covered rather than one test carrying the file:
//   (a) hub.js: delete `effectMayHaveLanded: true` from the tool-timeout return
//       — fails ONLY the hub source test. The four path tests inject the hub's
//       shape directly (see ABORTED_WHATSAPP), deliberately, so a narration bug
//       and a hub bug cannot mask each other. The seam between them is held by
//       that fixture being verbatim the hub's output and the hub test asserting
//       it field by field: a rename in hub.js reds the hub test immediately.
//   (b) live-tool-adapter.js, awaited site (`if (ev.abortedInFlight)`, indented
//       8) — fails ONLY path 1.
//   (e) live-tool-adapter.js, late-outcome site (the same condition at indent 4)
//       — fails ONLY path 2. NOTE: an unanchored `sed` matches both (b) and (e)
//       and reds two tests; the anchored probe is the one that isolates.
//   (g) live-tool-adapter.js, late-for-turn site (`if (entry.abortedInFlight)`)
//       — fails ONLY path 3.
//   (f) live-tool-adapter.js, confirm site (`outcome.effectMayHaveLanded`) —
//       fails ONLY path 4, the path the measured incident came through.
//   (c) action-evidence-ledger.js: remove the `entry.abortedInFlight` line —
//       fails ONLY the status test, `expected 'aborted-in-flight', got 'failed'`.
//   (d) action-outcome-summary.js: neutralise the `a.abortedInFlight` branch —
//       fails ONLY the note test, with the note reading "whatsapp_send FAILED".
//
// ADJACENT CASES THAT MUST KEEP PASSING, asserted at the bottom of this file:
// a real `{ok:false}` failure still says FAILED with NO_SUCCESS_CLAIM (BUG-116),
// and an `{ok:true,unverified:true}` outcome keeps its own wording and is NOT
// told never to retry (BUG-273). A guard whose bounds nobody knows is a guard
// nobody can reason about.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { createEffectorHub } = require('../src/core/effectors/hub');
const { actionStatus } = require('../src/core/voice/action-evidence-ledger');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

// Both halves, plus the half this state adds. The first four mirror
// bug-273's assertForbidsBothClaims deliberately: if a future edit routes this
// state at the weaker `unverified` wording, the retry assertion is what catches
// it — that is the entire difference between the two states.
function assertAbortedInFlightInstruction(text, label) {
  assert.ok(text, `${label}: there must be instruction text at all`);
  const s = String(text);
  assert.match(s, /NOT cancelled/i, `${label}: must say the action was not cancelled`);
  assert.match(s, /NO proof either way/i, `${label}: must state that nothing is proven`);
  assert.match(s, /do NOT say it worked/i, `${label}: must forbid the success claim`);
  assert.match(s, /do NOT say it\s+FAILED either/i,
    `${label}: must forbid the failure claim too — this is the collapse BUG-273 Q8 forbids`);
  assert.match(s, /later in this conversation/i,
    `${label}: must forbid claiming it later too — BUG-116 was a 49s-late claim`);
  assert.match(s, /Do NOT run it again/i,
    `${label}: must forbid the RETRY — the duplicate outward message is the actual harm`);
  assert.match(s, /do NOT offer/i,
    `${label}: must forbid OFFERING a retry — what MYTHOS actually did on 2026-09-02`);
}

// The verbatim shape hub.js now returns on a caller abort. Built from the wire,
// not from what the adapter wishes it received: a fixture more generous than the
// hub would pass while covering nothing.
const ABORTED_WHATSAPP = {
  ok: false,
  result: 'tool-timeout',
  effectMayHaveLanded: true,
  reason: 'the caller budget expired before whatsapp_send reported back. '
    + 'It was NOT cancelled, so its effect may already have landed',
};

function baseDeps(overrides) {
  return Object.assign({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-398', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: { done: true } }),
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-398', toolResultHoldMaxMs: 0, // BUG-457 R2 (2026-10-06): a SLOW_TOOLS call is now HELD when it fits the hold window; 0 selects the instant-ack late path this test pins
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  }, overrides || {});
}

// ---------------------------------------------------------------------------
// THE SOURCE. Before any narration: prove the hub actually emits the flag, from
// a real abort against a real hub. Mocking the hub here would test the fixture.
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — the hub reports an abort as uncancelled, not merely failed', () => {
  test('(a) a hung effector aborted by the caller signal carries effectMayHaveLanded', async () => {
    const hub = createEffectorHub({ bus: { emit() {} }, config: {} });
    hub.register({ id: 'hung_send', invoke: () => new Promise(function () { /* never settles */ }) });

    const controller = new AbortController();
    // A REF'd timer on purpose: AbortSignal.timeout's is unref'd, and on Node 22
    // the runner then cancels a test awaiting only it (BUG-259 class; BUG-398 R1
    // is the third instance). This is the shape that survives both runtimes.
    const t = setTimeout(() => controller.abort(), 40);
    const res = await hub.invoke('hung_send', {}, { signal: controller.signal });
    clearTimeout(t);

    // The reliability half is unchanged and must stay so: the breaker counts it,
    // the audit records a failure, and dispatch-self-timed-tools' negative
    // control asserts exactly this.
    assert.equal(res.ok, false, 'the dispatch really did blow its budget');
    assert.equal(res.result, 'tool-timeout', 'the machine-readable code every consumer keys on');
    // The world-state half is the new information.
    assert.equal(res.effectMayHaveLanded, true,
      'raceSignal does not cancel the effector, so the effect may already have landed');
    assert.match(String(res.reason), /NOT cancelled/,
      'the prose reason is what the narration paths read');
  });
});

// ---------------------------------------------------------------------------
// Path 1 of 4 — the awaited (fast) branch.
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — path 1: the awaited branch', () => {
  test('(a)(b) an aborted tool is status:unverified with the no-retry prohibition, never status:failed', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({ dispatchAction: async () => ABORTED_WHATSAPP }));
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'whatsapp_send', args: { to: 'Alex', message: 'hi' } }],
      { sendToolResponse: (r) => responses.push(...r) },
    );

    const response = responses[0].response;
    assert.notEqual(response.status, 'failed',
      'an uncancelled action that may have sent a message must not be reported as failed');
    assert.equal(response.status, 'unverified',
      'reuses the status the model already understands rather than inventing a fourth');
    assertAbortedInFlightInstruction(response.message, 'awaited branch');
    assert.match(response.message, /whatsapp_send/, 'the instruction must name the tool');
  });

  test('(a) the identical call is suppressed afterwards, so a retry cannot even be dispatched', async () => {
    // The instruction tells the model not to retry. This asserts the MECHANISM
    // that holds even if it ignores the instruction — noteToolOutcome marks the
    // signature bad on `dispatchOk === false`, which an abort still is. Asserting
    // the side effect, not the sentence.
    const dispatched = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async (decision) => { dispatched.push(decision.tool); return ABORTED_WHATSAPP; },
    }));
    const args = { to: 'Alex', message: 'hi' };
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'whatsapp_send', args }],
      { sendToolResponse: () => {} });
    await adapter.handleLiveToolCalls([{ id: 'c2', name: 'whatsapp_send', args }],
      { sendToolResponse: () => {} });

    assert.equal(dispatched.length, 1,
      'the second identical whatsapp_send must not reach dispatch — one send, one message');
  });
});

// ---------------------------------------------------------------------------
// Path 2 of 4 — reportLateOutcome (SLOW_TOOLS). Reaches the model only as prose
// on the [SYSTEM] channel, so the prose is the whole fix.
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — path 2: the late/SLOW_TOOLS outcome', () => {
  test('(a) an aborted SLOW_TOOL is narrated as not-confirmed with the no-retry prohibition', async () => {
    const sentText = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => Object.assign({}, ABORTED_WHATSAPP, {
        reason: 'the caller budget expired before dsh_task reported back. '
          + 'It was NOT cancelled, so its effect may already have landed',
      }),
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));
    // dsh_task is in SLOW_TOOLS. Guard the premise: if it ever leaves that set
    // this test stops covering the path it was written for.
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'dsh_task', args: { task: 'build' } }],
      { sendToolResponse: () => {} });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sentText.length, 1,
      'dsh_task must still be a SLOW_TOOL reporting via the [SYSTEM] channel — see SLOW_TOOLS');
    // Scoped to the VERDICT, not the whole notice: the instruction legitimately
    // contains the word FAILED ("do NOT say it FAILED either"), so a bare
    // /FAILED/ here matches the prohibition and fails on a correct fix. Found by
    // this test's own first red run.
    assert.doesNotMatch(sentText[0], /dsh_task FAILED/,
      'the late notice must not call an uncancelled action a failure');
    assert.match(sentText[0], /NOT CONFIRMED/, 'it must say what is actually true');
    assertAbortedInFlightInstruction(sentText[0], 'reportLateOutcome');
  });
});

// ---------------------------------------------------------------------------
// Path 3 of 4 — late-for-turn re-narration. Recomputes the instruction from the
// ENTRY after the turn has closed, which is why the flag has to ride on it
// (exactly the hole BUG-297 found here for `unverified`).
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — path 3: the late-for-turn re-narration', () => {
  test('(a) an abort arriving after its turn closed is re-narrated from the entry, not as a failure', async () => {
    const sentText = [];
    let resolveDispatch;
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: () => new Promise((r) => { resolveDispatch = r; }),
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));

    // A non-SLOW tool so the call is awaited, then the turn closes underneath it.
    const pending = adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'gmail_send', args: { to: 'a@b.c' } }],
      { sendToolResponse: () => {} },
    );
    adapter.onLiveTurnComplete({ userText: 'send it', assistantText: 'Sending now.' });
    resolveDispatch(Object.assign({}, ABORTED_WHATSAPP, {
      reason: 'the caller budget expired before gmail_send reported back. '
        + 'It was NOT cancelled, so its effect may already have landed',
    }));
    await pending;
    await new Promise((r) => setTimeout(r, 10));

    // Deliberately NOT searched by tool name. This site re-narrates from the
    // ENTRY, and the entry's summary is written by the awaited branch — keying
    // on the tool name made this test fail when the awaited branch was mutated,
    // i.e. it was measuring path 1 as well. Found while running probe (b).
    assert.equal(sentText.length, 1, 'the outcome must still reach the model after its turn closed (G3)');
    assertAbortedInFlightInstruction(sentText[0], 'late-for-turn');
  });
});

// ---------------------------------------------------------------------------
// Path 4 of 4 — resolveLiveConfirm. THE PATH THE MEASURED INCIDENT CAME
// THROUGH: whatsapp_send is tier 3 and NEVER_TRUSTABLE, so it is always
// confirmed and its outcome always arrives here.
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — path 4: the confirm path (the measured incident)', () => {
  function makeConfirmAdapter() {
    const sentText = [];
    let confirmId = null;
    const adapter = createLiveToolAdapter(baseDeps({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: () => { confirmId = 'confirm-398-t3'; return confirmId; }, reject: () => {} },
      },
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));
    return { adapter, sentText, id: () => confirmId };
  }

  test('(a) an APPROVED whatsapp_send whose budget expired is not reported as FAILED', async () => {
    const { adapter, sentText, id } = makeConfirmAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'whatsapp_send', args: { to: 'Alex', message: 'briefing' } }],
      { sendToolResponse: () => {} },
    );
    await adapter.resolveLiveConfirm(id(), ABORTED_WHATSAPP, true);

    assert.equal(sentText.length, 1, 'the operator-approved outcome must reach the model');
    // Verbatim from the 2026-09-02 session, the sentence that produced the retry.
    assert.doesNotMatch(sentText[0], /but it FAILED/,
      'the exact wording the operator heard over a message that had already arrived');
    assert.match(sentText[0], /RAN, but the outcome could NOT be confirmed/,
      'an approved action that ran must be described as having run');
    assertAbortedInFlightInstruction(sentText[0], 'resolveLiveConfirm (approved, aborted)');
  });
});

// ---------------------------------------------------------------------------
// THE RECORD. The next turn reads these, not the functionResponse — so an
// instruction that stops a retry this turn and a record that says FAILED would
// simply move the bug one turn later.
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — the record the next turn reads', () => {
  test('(c) actionStatus reports aborted-in-flight, not failed', () => {
    assert.equal(actionStatus({ tool: 'whatsapp_send', ok: false, abortedInFlight: true }),
      'aborted-in-flight', 'ok:false with an uncancelled effector is not a failure');
    // The states either side of it are untouched.
    assert.equal(actionStatus({ tool: 'x', ok: false }), 'failed');
    assert.equal(actionStatus({ tool: 'x', ok: false, unverified: true }), 'unverified');
    assert.equal(actionStatus({ tool: 'x', ok: true }), 'ok');
  });

  test('(d) the action-outcomes note says NOT CONFIRMED and warns against repeating it', () => {
    const note = summarizeActionsForResult([
      { tool: 'whatsapp_send', ok: false, abortedInFlight: true, summary: 'budget expired' },
    ]);
    assert.doesNotMatch(String(note), /FAILED/,
      'this note is what the NEXT turn reads — "FAILED" is how the retry offer came back');
    assert.match(String(note), /NOT CONFIRMED/);
    assert.match(String(note), /may have completed/);
    assert.match(String(note), /do not repeat it/i);
  });
});

// ---------------------------------------------------------------------------
// THE BOUNDS. A guard is only correct if it also fails to fire where it should
// not. These are the two states that sit either side of the new one.
// ---------------------------------------------------------------------------
describe('BUG-398 R5a — adjacent cases that must keep passing', () => {
  test('a real failure still says it FAILED and still forbids the success claim (BUG-116)', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => ({ ok: false, result: { error: 'no element matched "Subscribe"' } }),
    }));
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'see_and_click', args: { text: 'Subscribe' } }],
      { sendToolResponse: (r) => responses.push(...r) });

    const response = responses[0].response;
    assert.equal(response.status, 'failed', 'a genuine failure is still a failure');
    assert.match(response.message, /did NOT succeed/i);
    assert.doesNotMatch(response.message, /Do NOT run it again/i,
      'a failed click SHOULD be retryable — widening the no-retry rule to failures '
      + 'would break the recovery ladders this repo relies on');
  });

  test('an unverified outcome keeps its own wording and is NOT told never to retry (BUG-273)', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => ({
        ok: true, unverified: true,
        reason: 'the focused control exposes neither ValuePattern nor TextPattern',
        result: { typed: true },
      }),
    }));
    // ui_type, not launch_app: launch_app is a SLOW_TOOL, so it returns
    // 'started' and never reaches the awaited branch this case is bounding.
    // BUG-068's own tool, and the outcome quoted in its record.
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'ui_type', args: { text: 'x' } }],
      { sendToolResponse: (r) => responses.push(...r) });

    const response = responses[0].response;
    assert.equal(response.status, 'unverified');
    assert.match(response.message, /NO proof either way/i, 'BUG-273 B1 wording is unchanged');
    assert.doesNotMatch(response.message, /Do NOT run it again/i,
      'launch_app is safe to attempt again; only an uncancelled side effect is not');
  });

  // Eleven hostile shapes were fed to this guard on 2026-09-02, after it was
  // written and green. Eight behaved correctly with no change needed: a
  // stringified `'true'` flag still counts (fail-safe direction); a missing
  // `reason` falls back to the tool-timeout code rather than narrating "null";
  // an OBJECT `reason` is rejected by the typeof check instead of reaching the
  // model as "[object Object]" (the reasonText class this repo has been bitten
  // by before); `effectMayHaveLanded:false` still narrates a plain failure; a
  // `started` ACK carrying the flag stays "outcome pending", because an ACK is
  // not an outcome and its real one arrives via reportLateOutcome; and an entry
  // with an explicit `status` keeps it, which is actionStatus's pre-existing
  // contract. The three below changed nothing either but are PINNED, because
  // each is a precedence decision that would be silent and wrong if it drifted.
  //
  // NOT a finding, recorded so nobody re-files it: a `reason` string reaches the
  // model verbatim, so hostile text inside one is echoed. That is true of every
  // reason on every branch in this file and is deliberate — BUG-116 exists
  // because the real reason was NOT reaching the model. These reasons originate
  // in hub.js and the effectors, not from operator input.
  test('the flag cannot hijack a PROVEN success (attack: effector sets it on ok:true)', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => ({
        ok: true, evidence: { oracle: 'read-back' }, result: { sent: true },
        effectMayHaveLanded: true,
      }),
    }));
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'whatsapp_send', args: { to: 'Alex' } }],
      { sendToolResponse: (r) => responses.push(...r) });

    assert.equal(responses[0].response.status, 'ok',
      'abortedInFlight is gated on dispatchOk being FALSE, so a buggy effector cannot '
      + 'turn a proven send into an unretryable maybe');
  });

  test('an unverified outcome carrying the flag keeps the unverified claim (no producer, pinned anyway)', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => ({
        ok: true, unverified: true, reason: 'no read-back', effectMayHaveLanded: true,
      }),
    }));
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'ui_type', args: { text: 'x' } }],
      { sendToolResponse: (r) => responses.push(...r) });

    // hub.js only sets the flag alongside ok:false, so this shape cannot occur
    // today. Pinned because the resolution is the WEAKER of the two claims: if
    // some future effector starts emitting it, this test is the thing that says
    // the precedence was chosen rather than inherited.
    assert.equal(responses[0].response.status, 'unverified');
    assert.doesNotMatch(responses[0].response.message, /Do NOT run it again/i);
  });

  test('in the RECORD, aborted-in-flight outranks unverified (strictest next move wins)', () => {
    assert.equal(actionStatus({ tool: 't', ok: false, unverified: true, abortedInFlight: true }),
      'aborted-in-flight',
      'when both are set the record must carry the state that forbids the retry');
  });

  test('a verified success is not touched by any of this', async () => {
    const responses = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => ({ ok: true, evidence: { oracle: 'read-back' }, result: { sent: true } }),
    }));
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'whatsapp_send', args: { to: 'Alex' } }],
      { sendToolResponse: (r) => responses.push(...r) });

    assert.equal(responses[0].response.status, 'ok');
    assert.equal(responses[0].response.message, undefined,
      'a proven success needs no honesty instruction');
  });
});
