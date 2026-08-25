'use strict';

// bug-357-reply-grounding.test.js — BUG-357.
//
// THE MEASURED SESSION (2026-08-24 20:23–20:29 UTC, mythos-server.log + vault
// Episodic/2026-08-25.jsonl + Audit/2026-08-25.jsonl): MYTHOS told the operator
// "Confirmed, Sir. 'Hi' has been sent to mom on WhatsApp." and later
// "Confirmed, Sir. Message sent to 'mom' on WhatsApp." — while the audit trail
// shows NO send dispatched at all behind either claim, and every later REAL
// dispatch ending outcome:"fail" ("could not identify its window" x2,
// "Process 17056 has no main window" x1). The operator's word for what followed
// was "lying", and at the reply layer that is exactly what it was.
//
// Why the existing post-hoc detector (detectUnbackedClaims) missed BOTH claims,
// measured against this session:
//
//   1. CROSS-TURN BLINDNESS. Its evidence window is actionsThisTurn only. Both
//      false claims were spoken in turns where the whatsapp_send attempt or its
//      confirm-pending row belonged to an EARLIER turn, so the elliptical tier's
//      evidence gate found nothing this turn and stayed shut.
//   2. SUBJECT GAP. sending.ellipticalRe only accepts the subject nouns
//      {message, text, email, mail}; the actual phrasing was "'Hi' has been
//      sent" — quoted message CONTENT in subject position, which slips past.
//
// And a third hole with no detector to miss: a spoken go-ahead ("Yeah. Yeah.
// Go ahead.") over still-pending confirms produced NO notice of any kind, so
// nothing told the model that spoken words dispatch nothing and a click is
// still required. The silence is what the completion claim filled.
//
// Run: cd mythos && node --test test/bug-357-reply-grounding.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { detectUnbackedClaims } = require('../src/core/voice/claim-check');
const {
  createLiveToolAdapter, SYSTEM_NOTICE_PREFIX,
} = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

// ---------------------------------------------------------------- unit half

describe('BUG-357 A — the detector sees across turns', () => {
  // Verbatim shapes from the 2026-08-24 session (episodic ticks 304240 / 304363).
  const CLAIM_1 = "'Hi' has been sent to mom on WhatsApp.";
  const CLAIM_2 = 'Confirmed, Sir. Message sent to mom on WhatsApp.';
  const FAILED_EARLIER_TURN = [
    { tool: 'whatsapp_send', ok: false, status: 'awaiting-confirmation', ts: Date.now() },
  ];

  test("claim 1: \"'X' has been sent\" over an earlier-turn unproven send is flagged", () => {
    const claims = detectUnbackedClaims(CLAIM_1, [], FAILED_EARLIER_TURN);
    assert.equal(claims.length, 1,
      'the exact sentence MYTHOS spoke at 20:23:44 must be reachable by the detector');
    assert.equal(claims[0].category, 'sending');
  });

  test('claim 2: the elliptical gate opens on an earlier-turn attempt, not just this turn', () => {
    const claims = detectUnbackedClaims(CLAIM_2, [], FAILED_EARLIER_TURN);
    assert.equal(claims.length, 1,
      '"Message sent" was already matchable prose — what closed it was the gate '
      + 'seeing only this turn, where whatsapp_send never appeared');
    assert.equal(claims[0].category, 'sending');
  });

  test('NEGATIVE CONTROL: a real ok:true send backs the same claim across turns', () => {
    const claims = detectUnbackedClaims(CLAIM_2, [], [
      { tool: 'whatsapp_send', ok: true, status: 'ok', ts: Date.now() },
    ]);
    assert.deepEqual(claims, [],
      'the window must BACK true references too, or the next fix makes MYTHOS '
      + 'retract statements that were honest — the F1b failure class');
  });

  test('"was sent" stays out of scope — the package sentence must never fire', () => {
    const claims = detectUnbackedClaims('Your package was sent yesterday.', [], [
      { tool: 'whatsapp_send', ok: false, status: 'failed', ts: Date.now() },
    ]);
    assert.deepEqual(claims, [],
      'the header file documents this exact false positive; perfect aspect only');
  });

  test('negation never fires — "has not been sent" is the opposite claim', () => {
    const claims = detectUnbackedClaims('The message has not been sent.', [], [
      { tool: 'whatsapp_send', ok: false, status: 'failed', ts: Date.now() },
    ]);
    assert.deepEqual(claims, []);
  });

  test('no recent actions anywhere: behaviour identical to before (old callers unaffected)', () => {
    // The widened prose must stay evidence-gated: without an attempted-unproven
    // send somewhere in view, nothing fires. This is what keeps the widening
    // from becoming an unconditional grammar tripwire.
    assert.deepEqual(detectUnbackedClaims(CLAIM_1, []), []);
    assert.deepEqual(detectUnbackedClaims(CLAIM_2, [], undefined), []);
    // Two-arg callers keep working, including the this-turn gate they relied on.
    const flagged = detectUnbackedClaims(CLAIM_2, [{ tool: 'whatsapp_send', ok: false }]);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].category, 'sending');
  });
});

// ------------------------------------------------------------ adapter half

function harness(opts = {}) {
  const sent = [];
  const emitted = [];
  const session = {
    isOpen: () => (opts.open === undefined ? true : opts.open),
    sendText: (text, meta) => { sent.push({ text, meta }); return true; },
  };
  const verdict = opts.verdict || { allow: true, requireConfirm: false, tier: 2 };
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => verdict,
      confirm: { create: () => 'confirm-357', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: {} }),
    bus: { emit: (...a) => emitted.push(a) },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-357',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
  });
  return { adapter, sent, emitted, session };
}

const CONFIRM_VERDICT = { allow: false, requireConfirm: true, tier: 3, reason: 'never-trustable' };

async function armPendingConfirm(h) {
  await h.adapter.handleLiveToolCalls(
    [{ id: 'c1', name: 'whatsapp_send', args: { to: 'mom', text: 'hi' } }],
    { sendToolResponse: () => {} },
  );
}

describe('BUG-357 B — the cross-turn correction reaches the model through the real path', () => {
  test('turn-1 pending send + turn-2 "Message sent" claim produces the retract correction', async () => {
    const h = harness({ verdict: CONFIRM_VERDICT });
    await armPendingConfirm(h);
    h.adapter.onLiveTurnComplete({
      userText: 'can you send hi to mom',
      assistantText: 'Ready to send, Sir.',
    });

    // Turn 2: NO tool runs, and the model completes the action out loud anyway.
    h.adapter.onLiveTurnComplete({
      userText: 'and?',
      assistantText: 'Confirmed, Sir. Message sent to mom on WhatsApp.',
    });

    const corrections = h.sent.filter((s) => s.meta && s.meta.site === 'ad4-correction-retract');
    assert.equal(corrections.length, 1,
      'the claim lived two turns away from its attempt — exactly the gap that '
      + 'produced the 2026-08-24 "lying" exchange');
    assert.ok(corrections[0].text.startsWith(SYSTEM_NOTICE_PREFIX));
    assert.match(corrections[0].text, /Message sent/);

    const anomaly = h.emitted.find((e) => e[0] === 'health.anomaly'
      && e[1] && e[1].kind === 'claimed-action-not-taken');
    assert.ok(anomaly, 'the audit-stream anomaly must fire too, not only the correction');
  });
});

describe('BUG-357 C — a spoken go-ahead over a pending confirm is answered with the truth', () => {
  test('the model is told its words dispatched nothing while the click is still owed', async () => {
    const h = harness({ verdict: CONFIRM_VERDICT });
    await armPendingConfirm(h);
    h.adapter.onLiveTurnComplete({
      userText: 'Yeah. Yeah. Go ahead.',
      assistantText: '',
    });

    const notices = h.sent.filter((s) => s.meta && s.meta.site === 'spoken-go-ahead-no-dispatch');
    assert.equal(notices.length, 1);
    assert.ok(notices[0].text.startsWith(SYSTEM_NOTICE_PREFIX));
    assert.match(notices[0].text, /did NOT dispatch/i,
      'the one sentence that was missing at 20:23:44');
    assert.match(notices[0].text, /whatsapp_send/, 'names what is actually waiting');
    assert.match(notices[0].text, /approval|confirm/i);
  });

  test('an unrelated utterance over a pending confirm stays quiet (noise control)', async () => {
    const h = harness({ verdict: CONFIRM_VERDICT });
    await armPendingConfirm(h);
    h.adapter.onLiveTurnComplete({ userText: 'what is the weather', assistantText: '' });
    const notices = h.sent.filter((s) => s.meta && s.meta.site === 'spoken-go-ahead-no-dispatch');
    assert.equal(notices.length, 0,
      'every injection provokes a spoken turn (BUG-273 D3); only approval-shaped '
      + 'speech earns one here');
  });

  test('a spoken no still cancels instead — B3 keeps ownership of negatives', async () => {
    const h = harness({ verdict: CONFIRM_VERDICT });
    await armPendingConfirm(h);
    h.adapter.onLiveTurnComplete({ userText: 'no', assistantText: '' });

    const notices = h.sent.filter((s) => s.meta && s.meta.site === 'spoken-go-ahead-no-dispatch');
    assert.equal(notices.length, 0);
    assert.equal(h.adapter._internal.livePendingConfirms.size, 0, 'cancelled, not nagged');
  });

  test('nothing pending: a go-ahead produces no notice at all', async () => {
    const h = harness();
    h.adapter.onLiveTurnComplete({ userText: 'go ahead', assistantText: '' });
    assert.equal(h.sent.filter((s) => s.meta && s.meta.site === 'spoken-go-ahead-no-dispatch').length, 0);
  });
});
