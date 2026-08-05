'use strict';

// test/bug-117-system-notice-attribution.test.js — BUG-117.
//
// 2026-08-05: MYTHOS told the operator they had said things they never said.
// The cause is protocol-shaped, not model-shaped: the frozen Gemini Live wire
// protocol (V2 spine §3) allows exactly four client frames after setup, and none
// of them carries a system role. Everything the pipeline injects mid-session —
// a slow tool's real outcome, a confirm accept/decline, a proactive alert —
// leaves through liveSession.sendText() as realtimeInput:{text}, which Gemini
// attributes to the USER. A bare "[SYSTEM]" prefix told the model nothing it
// could act on, so it read the whole line as operator speech.
//
// The fix is framing, in two halves that must agree: a self-describing prefix on
// every injection, and a clause in the Live system instruction that explains the
// prefix before the model ever sees one. Both are exported from
// live-tool-adapter.js so they cannot drift apart; this file pins that they are
// actually used at every injection site.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLiveToolAdapter, SYSTEM_NOTICE_PREFIX, LIVE_SYSTEM_NOTICE_INSTRUCTION,
} = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

function harness(overrides) {
  const opts = overrides || {};
  const sent = [];
  const session = { isOpen: () => true, sendText: (t) => sent.push(t) };
  const adapter = createLiveToolAdapter({
    leash: opts.leash || {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-117' },
    },
    dispatchAction: opts.dispatchAction || (async () => ({ ok: true, result: {} })),
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-117',
    memory: { working: { tick: 1 }, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: null,
    summarizeActionsForResult,
    getLiveSession: () => session,
  });
  return { adapter, sent };
}

describe('BUG-117 — pipeline injections must not read as operator speech', () => {
  test('the prefix is self-describing on its own, not a bare tag', () => {
    // "[SYSTEM]" is meaningless to a model that was never told what it means,
    // and the model only ever sees the prefix — not this codebase.
    assert.match(SYSTEM_NOTICE_PREFIX, /automated/i, 'must say it is automated');
    assert.match(SYSTEM_NOTICE_PREFIX, /NOT the operator/i,
      'must state, in the line itself, that the operator did not say this');
  });

  test('the Live system instruction explains the prefix and forbids blaming the operator', () => {
    assert.ok(LIVE_SYSTEM_NOTICE_INSTRUCTION.includes(SYSTEM_NOTICE_PREFIX),
      'the instruction must quote the exact prefix the model will see — the two halves must agree');
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /never blame the operator/i);
    assert.match(LIVE_SYSTEM_NOTICE_INSTRUCTION, /ground truth/i,
      'the model must still ACT on the notice — this is an attribution fix, not a trust downgrade');
  });

  test('a slow tool\'s late outcome is pushed with the self-describing prefix', async () => {
    let resolveDispatch;
    const { adapter, sent } = harness({ dispatchAction: () => new Promise((r) => { resolveDispatch = r; }) });
    await adapter.handleLiveToolCalls([{ id: 'c1', name: 'spotify_play', args: { query: 'Starboy' } }],
      { sendToolResponse: () => {} });

    resolveDispatch({ ok: true, result: { playing: 'Starboy' } });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith(SYSTEM_NOTICE_PREFIX), 'late outcome must carry the prefix');
    assert.doesNotMatch(sent[0], /^\[SYSTEM\]/, 'the bare, unexplained tag must be gone');
  });

  test('a resolved confirm is pushed with the self-describing prefix', async () => {
    let capturedConfirmId = null;
    const { adapter, sent } = harness({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: () => { capturedConfirmId = 'confirm-117-t3'; return capturedConfirmId; } },
      },
    });
    await adapter.handleLiveToolCalls([{ id: 'c2', name: 'gmail_send', args: { to: 'a@b.c' } }],
      { sendToolResponse: () => {} });
    await adapter.resolveLiveConfirm(capturedConfirmId, { ok: true, result: 'sent' }, true);

    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith(SYSTEM_NOTICE_PREFIX), 'confirm outcome must carry the prefix');
  });

  test('the prefix stays out of the audit/episodic record — it is prompt framing, not history', async () => {
    let resolveDispatch;
    const { adapter } = harness({ dispatchAction: () => new Promise((r) => { resolveDispatch = r; }) });
    await adapter.handleLiveToolCalls([{ id: 'c3', name: 'spotify_play', args: {} }],
      { sendToolResponse: () => {} });
    resolveDispatch({ ok: true, result: {} });
    await new Promise((r) => setTimeout(r, 10));

    const entry = adapter._internal.liveTurnActions.at(-1);
    assert.doesNotMatch(entry.summary, /SYSTEM NOTICE/,
      'the record is a plain statement of what happened, same discipline as BUG-116');
  });
});
