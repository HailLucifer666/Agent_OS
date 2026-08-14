'use strict';

// live-pending-is-not-failure.test.js — cluster A3 of the 2026-08-14
// "everything fails" session: MYTHOS spoke before the outcome existed, and the
// ledger then recorded the wrong thing about it in both directions.
//
// MEASURED (vault/Audit + vault/Episodic, 2026-08-14):
//   17:29:26 — reply "Message sent to Alex, sir." in the same turn as
//              whatsapp_send=FAIL.
//   17:38:56 — "Playing 'Tera Mera Rishta' on YouTube for you now" against an
//              open_web that could NOT be confirmed.
//   claimed-action-not-taken x5, live-tool-outcome-late-for-turn x14.
//   17:37:02 — browser_navigate=FAIL(started — outcome pending), followed at
//              17:37:10 by ok FOR THE SAME CALL. Nothing broke. The ledger lied.
//
// The turn boundary belongs to the model and awaiting harder cannot fix it —
// BUG-128's started/ack-deadline split is the right design and is untouched here
// (see bug-128-live-tool-ack-deadline.test.js). What this file pins is the two
// remaining gaps:
//
//   1. `commitAction({ok:false, started:true})` recorded a pending ack as a
//      FAILURE. That manufactures failures, and it makes a genuine failure and a
//      pending ack indistinguishable to anything reading the vault days later.
//      `ok: null` keeps every "did this succeed?" consumer (`ok === true`,
//      `ok !== true`) behaving exactly as before, while nothing can read it as a
//      definite failure.
//   2. STARTED_MESSAGE is an instruction, and instructions are advisory — the
//      model received it and still said "Message sent." So the pending case gets
//      a code-side correction of its own, distinct from the failure correction:
//      telling the model a pending tool "did NOT happen" is itself a false
//      statement, because reportLateOutcome may contradict it seconds later.
//
// NOT attempted here: re-ordering say-after-act globally. That is the standing
// mythos-say-before-act architecture issue and is deliberately out of scope; the
// target is the false "it worked", not the ordering.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
const { detectUnbackedClaims } = require('../src/core/voice/claim-check');

function harness(opts) {
  const o = opts || {};
  const injected = [];
  const anomalies = [];
  const episodic = [];
  const history = [];
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-a3' },
    },
    dispatchAction: async () => {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      return o.outcome || { ok: true, result: { evidence: 'done' } };
    },
    bus: { emit: (type, payload) => { if (type === 'health.anomaly') anomalies.push(payload); } },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-a3',
    memory: { working: { tick: 1 }, episodic: { write: (rec) => episodic.push(rec) } },
    historyAppend: (role, text) => history.push({ role, text }),
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => ({ isOpen: () => true, sendText: (t) => injected.push(t) }),
    toolAckDeadlineMs: o.deadlineMs === undefined ? 20 : o.deadlineMs,
  });
  return { adapter, injected, anomalies, episodic, history };
}

function call(adapter, id, name, args) {
  const responses = [];
  return adapter
    .handleLiveToolCalls([{ id, name, args: args || {} }], { sendToolResponse: (r) => responses.push(...r) })
    .then(() => responses);
}

describe('A3 a pending ack is recorded as pending, not as a failure', () => {
  test('the turn action for an ack-deadline call is status:"pending", never ok:false', async () => {
    const { adapter } = harness({ delayMs: 400, deadlineMs: 20 });
    await call(adapter, 'c1', 'browser_navigate', { url: 'https://openai.com' });

    const actions = adapter._internal.liveTurnActions;
    assert.equal(actions.length, 1);
    const entry = actions[0];
    assert.equal(entry.tool, 'browser_navigate');
    assert.equal(entry.status, 'pending',
      'a call that is still running is pending — 17:37:02 recorded it as FAIL and 17:37:10 '
      + 'recorded the same call as ok');
    assert.notEqual(entry.ok, false,
      'ok:false is a claim that the action FAILED. It had not; it had not finished. This is what '
      + 'put a manufactured failure in the vault for a call that worked.');
    assert.equal(entry.started, true,
      'started must stay — action-outcome-summary.js and commitAction\'s late-arrival branch both key on it');
  });

  test('a SLOW_TOOLS call records the same pending shape', async () => {
    // hermes_task is on the SLOW_TOOLS list, so it never awaits at all.
    const { adapter } = harness({ deadlineMs: 5000 });
    await call(adapter, 'c2', 'hermes_task', { prompt: 'x' });
    const actions = adapter._internal.liveTurnActions;
    const entry = actions.find((a) => a.tool === 'hermes_task');
    assert.ok(entry, 'the slow path must still record something for the turn');
    assert.equal(entry.status, 'pending');
    assert.notEqual(entry.ok, false);
  });

  test('a REAL failure is still an unambiguous failure — the fix must not blur that', async () => {
    const { adapter } = harness({ outcome: { ok: false, result: 'invalid_grant' }, deadlineMs: 500 });
    await call(adapter, 'c3', 'gmail_send', { to: 'a@b.c' });
    const entry = adapter._internal.liveTurnActions[0];
    assert.equal(entry.ok, false, 'failures keep ok:false semantics untouched');
    assert.notEqual(entry.status, 'pending',
      'the point of the change is that pending and failed become DISTINGUISHABLE — if a failure '
      + 'now reads as pending, the fix has moved the lie rather than removed it');
  });

  test('a pending tool still cannot back a completion claim', () => {
    // The property that must survive: detectUnbackedClaims requires ok === true,
    // so ok:null is not backing. This is asserted directly because it is the
    // safety property the ok:false -> ok:null change could plausibly have broken.
    const pending = [{ tool: 'whatsapp_send', ok: null, started: true, status: 'pending', summary: 'x' }];
    const claims = detectUnbackedClaims("Message sent to Alex, sir.", pending);
    assert.equal(claims.length, 1, 'a pending send must not vouch for "I sent it"');
    assert.equal(claims[0].category, 'sending');
  });

  test('the spoken history line still says "started (outcome pending)", not "FAILED"', async () => {
    const { adapter, history } = harness({ delayMs: 400, deadlineMs: 20 });
    await call(adapter, 'c4', 'browser_navigate', { url: 'https://openai.com' });
    adapter.onLiveTurnComplete({ userText: 'open openai', assistantText: 'Opening it now.', turnId: 1 });
    const sys = history.filter((h) => h.role === 'system').map((h) => h.text).join(' ');
    assert.match(sys, /browser_navigate started \(outcome pending\)/);
    assert.doesNotMatch(sys, /browser_navigate FAILED/);
  });
});

describe('A3 the episodic record can tell pending from failed on its own', () => {
  test('each action carries a status word, not just ok', async () => {
    const { adapter, episodic } = harness({ delayMs: 400, deadlineMs: 20 });
    await call(adapter, 'c5', 'browser_navigate', { url: 'https://openai.com' });
    adapter.onLiveTurnComplete({ userText: 'open openai', assistantText: 'Opening it.', turnId: 7 });

    const rec = episodic.find((r) => r.kind === 'conversation');
    assert.ok(rec, 'the conversation record must still be written');
    const action = rec.detail.actions[0];
    assert.equal(action.tool, 'browser_navigate');
    assert.equal(action.status, 'pending',
      'this record IS the vault, read back days later — ok alone could not tell an ack from a failure');
  });

  test('an unverified outcome is reported as unverified, not flattened to failed', async () => {
    // evaluateOutcome folds unverified INTO ok (ok: dispatchOk && !unverified),
    // so an unverified entry arrives with ok:false. src/core/CLAUDE.md's evidence
    // contract forbids flattening that into a plain failure.
    const { adapter, episodic } = harness({
      outcome: { ok: true, unverified: true, reason: 'the dashboard has not confirmed it rendered this', result: {} },
      deadlineMs: 500,
    });
    await call(adapter, 'c6', 'open_web', { type: 'web', url: 'https://example.com' });
    adapter.onLiveTurnComplete({ userText: 'open it', assistantText: 'Attempted.', turnId: 8 });
    const action = episodic.find((r) => r.kind === 'conversation').detail.actions[0];
    assert.equal(action.status, 'unverified');
  });

  test('a genuine failure records status:"failed"', async () => {
    const { adapter, episodic } = harness({ outcome: { ok: false, result: 'invalid_grant' }, deadlineMs: 500 });
    await call(adapter, 'c7', 'gmail_send', { to: 'a@b.c' });
    adapter.onLiveTurnComplete({ userText: 'send it', assistantText: 'That failed.', turnId: 9 });
    const action = episodic.find((r) => r.kind === 'conversation').detail.actions[0];
    assert.equal(action.status, 'failed');
  });
});

describe('A3 a completion claim over a PENDING tool is corrected as pending, not as a lie', () => {
  test('the correction says "has NOT returned yet", not "did NOT happen"', async () => {
    const { adapter, injected } = harness({ delayMs: 600, deadlineMs: 20 });
    await call(adapter, 'c8', 'whatsapp_send', { to: 'Alex', text: 'hi' });
    injected.length = 0;   // drop anything the ack itself sent

    adapter.onLiveTurnComplete({
      userText: 'message alex',
      assistantText: 'Message sent to Alex, sir.',
      turnId: 11,
    });

    const notice = injected.find((t) => /CORRECTION/.test(t));
    assert.ok(notice, 'a spoken completion claim over an unfinished tool must be corrected in code — '
      + 'STARTED_MESSAGE already asked the model not to, and it did anyway');
    assert.match(notice, /whatsapp_send/,
      'the correction must NAME the tool; the anomaly alone only ever named the category');
    assert.match(notice, /has NOT returned yet|still waiting/,
      'telling the model a pending action "did NOT happen" is its own false statement — the real '
      + 'outcome may arrive seconds later and contradict it');
    assert.doesNotMatch(notice, /did NOT happen/,
      'that phrasing belongs to the failure branch only');
  });

  test('a claim over a genuinely FAILED tool keeps the blunt retraction', async () => {
    const { adapter, injected } = harness({ outcome: { ok: false, result: 'no editable element found' }, deadlineMs: 500 });
    await call(adapter, 'c9', 'whatsapp_send', { to: 'Alex', text: 'hi' });
    injected.length = 0;

    adapter.onLiveTurnComplete({
      userText: 'message alex',
      assistantText: 'Message sent to Alex, sir.',
      turnId: 12,
    });
    const notice = injected.find((t) => /CORRECTION/.test(t));
    assert.ok(notice);
    assert.match(notice, /did NOT happen/,
      'a real failure must still be retracted plainly — that path is BUG-116/Wave 1 and is not changed here');
  });

  test('the anomaly names the tool and its real status alongside the category', async () => {
    const { adapter, anomalies } = harness({ delayMs: 600, deadlineMs: 20 });
    await call(adapter, 'c10', 'whatsapp_send', { to: 'Alex', text: 'hi' });
    adapter.onLiveTurnComplete({ userText: 'message alex', assistantText: 'Message sent to Alex, sir.', turnId: 13 });

    const claim = anomalies.find((a) => a.kind === 'claimed-action-not-taken');
    assert.ok(claim, 'the existing anomaly must still fire');
    assert.equal(claim.claimedTool, 'whatsapp_send');
    assert.equal(claim.claimedToolStatus, 'pending');
    // BUG-105: every immune consumer (diagnostician, healer, explainer, the
    // server's episodic summary line) keys on tool/target, and the healer's
    // playbooks match those two — so the tool is ADDED, never swapped in.
    assert.equal(claim.tool, 'sending');
    assert.equal(claim.target, 'sending');
  });

  test('a claim with no matching tool at all reports never-called, not a wrong tool name', async () => {
    const { adapter, anomalies } = harness({ deadlineMs: 500 });
    adapter.onLiveTurnComplete({ userText: 'log that', assistantText: "I've logged that.", turnId: 14 });
    const claim = anomalies.find((a) => a.kind === 'claimed-action-not-taken');
    assert.ok(claim);
    assert.equal(claim.claimedTool, null,
      'naming a tool that was never called would be the explainer-invents-a-component bug (BUG-105) again');
    assert.equal(claim.claimedToolStatus, 'never-called');
  });

  test('a backed claim is still not corrected — the detector must not become noise', async () => {
    const { adapter, injected } = harness({ deadlineMs: 500 });
    await call(adapter, 'c11', 'whatsapp_send', { to: 'Alex', text: 'hi' });
    injected.length = 0;
    adapter.onLiveTurnComplete({ userText: 'message alex', assistantText: 'Message sent to Alex, sir.', turnId: 15 });
    assert.equal(injected.filter((t) => /CORRECTION/.test(t)).length, 0,
      'a successful send backs the claim; correcting it would train the model to distrust true reports');
  });
});
