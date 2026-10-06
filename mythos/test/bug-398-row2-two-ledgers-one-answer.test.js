'use strict';

// test/bug-398-row2-two-ledgers-one-answer.test.js — BUG-398 row 2.
//
// THE REPORTED DEFECT: for one action the Audit "action record" says
// `ok:true, unverified:true` while the turn record says `ok:false,
// status:"unverified"`. Confirmed in the session on launch_app({name:"code"})
// and open_web, and filed as an ok-polarity bug likely responsible for the
// duplicate-WhatsApp retry.
//
// WHAT IT ACTUALLY IS, after reading both writers and every consumer:
//
//   1. IT DID NOT CAUSE THE RETRY. The model is handed a string `status` field
//      in its functionResponse and never sees either boolean. That retry came
//      from hub.js returning a genuine `failed` for an aborted-but-uncancelled
//      send, which is row 1 (fixed in 60c98ed).
//
//   2. BOTH VALUES ARE CORRECT. The Audit row's `outcome` is DISPATCH-level:
//      the effector returned without failing. The turn record's `ok` is
//      EVIDENCE-level: this is not a proven success. For an unverified action
//      both are true at once. They are two different predicates wearing one
//      name.
//
//   3. THE FOLD IS LOAD-BEARING AND MUST STAY. claim-check.js decides which
//      spoken claims are backed using `a.ok === true`; that is what stops an
//      unverified action from backing a completion claim, and
//      live-tool-adapter.test.js pins it deliberately. Unfolding `ok` would
//      quietly weaken the honesty detector — the opposite of the intent.
//
// SO THE GUARD THIS TICKET ORIGINALLY ASKED FOR WOULD HAVE BEEN WRONG. A
// reviewed plan said: "assert the two ledgers agree on `ok` for the same
// traceId". Asserting agreement would assert a falsehood. What was actually
// missing is smaller and duller: the two records could not be JOINED at all —
// neither carried the other's key — so the only way to notice the disagreement
// was to read the vault by eye, which is exactly how it was found.
//
// THE FIX. The turn record now carries `dispatchOk` under its own name beside
// the evidence-level `ok`, and a `traceId` to join on. Then the check that IS
// correct becomes possible and is asserted below: for one traceId, the turn
// record's DISPATCH-level field must equal the Audit row's dispatch-level
// outcome. Same fact, two routes, compared — rather than two different facts
// forced to match.
//
// MUTATION PROOF — two probes, 2026-09-02, each verified applied by re-counting
// the mutated text. What each actually reddened:
//   (a) drop `dispatchOk: ev.dispatchOk` from the awaited commitAction → 4
//       tests. Every case that compares the two scopes loses the dispatch-level
//       field, leaving only the evidence-level boolean, which disagrees with the
//       Audit row by design.
//   (b) drop `traceId: call.id` → 2 tests: the join test, and the scope
//       comparison whose premise is that both rows describe the same action.
//       Without a shared key the two records cannot be matched at all, which is
//       the whole reason this disagreement could only be found by eye.
//
// A third property is covered but has no probe here: every OTHER commitAction
// site (the pending ack, confirm-pending, denied, error) and the late-outcome
// row also carry the id. The slow-path case at the bottom is what pins the one
// that matters — launch_app and open_web are the ticket's own examples and both
// are slow, so the ack is the row a vault reader actually sees for them.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// The verbatim outcome shape from the session: launch_app('code') came back ok
// with nothing confirming a window.
//
// NOTE ON THE TOOL NAME BELOW. The cases that compare the two records use
// `ui_type`, not launch_app, and that is not arbitrary: launch_app and open_web
// — the ticket's own two examples — are BOTH in SLOW_TOOLS, so their turn record
// holds the pending ACK and their real outcome arrives after the turn has
// closed. There is no dispatch outcome to compare at that moment, by design.
// The slow path is covered by its own case at the bottom of this file. Found by
// this file's first run, which failed on exactly that.
const LAUNCH_CODE_UNVERIFIED = {
  ok: true,
  unverified: true,
  reason: 'launched but no windowed process matching the name could be confirmed',
  result: { pid: 4242, name: 'code' },
};

function harness(outcome) {
  const episodic = [];
  const audit = [];
  const history = [];
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'c', reject: () => {} },
    },
    toolResultHoldMaxMs: 0, // BUG-457 R2 (2026-10-06): a SLOW_TOOLS call is now HELD when it fits the hold window; 0 selects the instant-ack late path this test pins
    // Stands in for dispatch-action, and records what the AUDIT writer would
    // have been given for this call: `outcome` is dispatch-level, exactly as
    // dispatch-action.js computes it (`actionOk ? 'ok' : 'fail'`).
    dispatchAction: async (decision, ctx) => {
      audit.push({
        tool: decision.tool,
        traceId: ctx && ctx.traceId,
        outcome: outcome.ok ? 'ok' : 'fail',
        unverified: !!(outcome.ok && outcome.unverified) || undefined,
      });
      return outcome;
    },
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-398-r2',
    memory: { working: { tick: 9 }, episodic: { write: async (r) => { episodic.push(r); } } },
    historyAppend: (role, text) => history.push({ role, text }),
    reflection: { noteTurn() {} },
    summarizeActionsForResult: require('../src/core/voice/action-outcome-summary').summarizeActionsForResult,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  });
  return { adapter, episodic, audit, history };
}

async function runOne(outcome, toolName) {
  const h = harness(outcome);
  await h.adapter.handleLiveToolCalls(
    [{ id: 'fc_16510075431666483365', name: toolName || 'ui_type', args: { text: 'code' } }],
    { sendToolResponse: () => {} });
  h.adapter.onLiveTurnComplete({ userText: 'open vs code', assistantText: 'Opening it now.' });
  const turn = h.episodic.find((r) => r.kind === 'conversation');
  return { turn, action: turn && turn.detail.actions[0], audit: h.audit[0], history: h.history };
}

describe('BUG-398 row 2 — the two ledgers record two scopes, and can now be joined', () => {
  it('the same unverified outcome reaches history without becoming a failed action', async () => {
    const { action, history } = await runOne(LAUNCH_CODE_UNVERIFIED);
    assert.equal(action.ok, false);
    assert.equal(action.dispatchOk, true);
    assert.equal(action.status, 'unverified');
    const note = history.find(row => row.role === 'system' && row.text.startsWith('Action outcomes:'));
    assert.ok(note);
    assert.match(note.text, /ui_type NOT CONFIRMED/);
    assert.doesNotMatch(note.text, /ui_type FAILED|ui_type succeeded/);
  });
  it('(b) the turn record carries the Audit row\'s traceId', async () => {
    const { action, audit } = await runOne(LAUNCH_CODE_UNVERIFIED);
    assert.equal(audit.traceId, 'fc_16510075431666483365', 'premise: the audit side has it');
    assert.equal(action.traceId, audit.traceId,
      'without a shared key the two records cannot be matched up at all, which is '
      + 'why this disagreement could only be found by reading the vault by eye');
  });

  it('(a) TWO ROUTES, ONE ANSWER: the dispatch-level fields agree for one traceId', async () => {
    const { action, audit } = await runOne(LAUNCH_CODE_UNVERIFIED);
    assert.equal(action.traceId, audit.traceId, 'premise: same action');
    // The check that is actually correct. Same fact, derived twice by different
    // means, compared — rather than two different facts forced to match.
    assert.equal(action.dispatchOk, audit.outcome === 'ok',
      'the turn record and the Audit row must agree about whether the DISPATCH '
      + 'succeeded: turn dispatchOk=' + action.dispatchOk + ', audit outcome=' + audit.outcome);
  });

  it('the evidence-level field still says NOT PROVEN, and that is not a contradiction', async () => {
    const { action, audit } = await runOne(LAUNCH_CODE_UNVERIFIED);
    // This is the pair the dossier read as a polarity bug. Both are correct:
    // the dispatch returned, and nothing proved the world changed.
    assert.equal(audit.outcome, 'ok', 'dispatch-level: the effector returned without failing');
    assert.equal(action.dispatchOk, true, 'the same fact, in the turn record');
    assert.equal(action.ok, false, 'evidence-level: AD-4 — an unproven action is not an ok one');
    assert.equal(action.status, 'unverified', 'and the word for it is unverified, not failed');
  });

  it('the same three fields on a PROVEN success are all positive', async () => {
    const { action, audit } = await runOne({
      ok: true, unverified: false, evidence: { oracle: 'process-window', observed: 'code (pid 1)' },
      result: { pid: 1 },
    });
    assert.equal(audit.outcome, 'ok');
    assert.equal(action.dispatchOk, true);
    assert.equal(action.ok, true, 'proven means proven at both levels');
    assert.equal(action.status, 'ok');
  });

  it('and all negative on a real failure — the scopes only diverge on unverified', async () => {
    const { action, audit } = await runOne({ ok: false, result: { error: 'no such app' } });
    assert.equal(audit.outcome, 'fail');
    assert.equal(action.dispatchOk, false);
    assert.equal(action.ok, false);
    assert.equal(action.status, 'failed');
  });

  it('a SLOW tool pending ack is joinable too, even before its outcome exists', async () => {
    // launch_app and open_web are the ticket's measured cases and both are slow,
    // so this is the row a reader of the vault actually sees for them. It has no
    // dispatch verdict yet — that is honest, not a gap — but it must still carry
    // the key, or the late outcome can never be tied back to it.
    const { action, audit } = await runOne(LAUNCH_CODE_UNVERIFIED, 'launch_app');
    assert.equal(action.status, 'pending', 'a slow tool has not reported at turn close');
    assert.equal(action.traceId, audit.traceId,
      'the ack must carry the join key even though the verdict is still unknown');
    assert.equal(action.dispatchOk, undefined,
      'and must NOT invent a dispatch verdict it does not have');
  });

  it('BOUNDS: the fold stays — an unverified action must not back a completion claim', () => {
    // The reason `ok` is NOT unfolded. claim-check.js reads exactly this
    // predicate to decide which spoken claims are backed; loosening it would
    // let "I opened it" stand on an outcome nothing confirmed.
    const { detectUnbackedClaims } = require('../src/core/voice/claim-check');
    const claims = detectUnbackedClaims('I opened VS Code for you.',
      [{ tool: 'launch_app', ok: false, unverified: true, dispatchOk: true }], []);
    assert.equal(claims.length, 1,
      'dispatchOk:true must NOT back a completion claim — only evidence does');
  });
});
