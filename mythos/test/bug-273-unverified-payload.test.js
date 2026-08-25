'use strict';

// test/bug-273-unverified-payload.test.js — BUG-273 B1.
//
// THE INCIDENT. 2026-08-18, live voice session: launch_app('wt') came back
// ok:true + unverified:true, reason "launched, but no windowed process matching
// the name could be confirmed; a later focus_window/ui_type has no trustworthy
// target." That is exactly what BUG-272 T1 built, and it is honest. MYTHOS then
// told the operator it had opened Windows Terminal, and the operator logged an
// incident reading "Your tools are lying. Your tools are not wired properly."
//
// ROOT CAUSE — measured, and NOT the "the model ignored the instruction" story
// the bug plan started from. Three paths narrate an unverified outcome to a Live
// model, and they carried three different strengths of hedge:
//   * handleLiveToolCalls' awaited branch — 'Report only that it was attempted.'
//   * reportLateOutcome                   — nothing; it fell through to the
//     neutral 'Report this to the operator accurately.', because only its
//     FAILURE branch escalated to NO_SUCCESS_CLAIM.
//   * resolveLiveConfirm                  — a prohibition inlined into `verdict`,
//     i.e. into the AUDIT record, with the instruction left neutral.
// launch_app is in SLOW_TOOLS as of BUG-272 slice 4 (190cd74) for sound duration
// reasons — it polls up to 6-8s for a windowed process. That commit therefore
// moved its narration off the strongest of the three paths and onto the weakest,
// three commits before the session that caught it. The tool did not become less
// honest; the sentence carrying its honesty did.
//
// WHY THIS FILE EXISTS RATHER THAN A THIRD PER-BRANCH PATCH. Q6: this is the
// third instance of one invariant. BUG-068 — only the late path honored
// `unverified`, so the awaited path said status:'ok' over an unprovable ui_type.
// BUG-116 — the failure branches carried a bare error string, so the model
// narrated a click it had just failed to make. Both were closed by making one
// shared sentence mandatory on every branch of one kind, and neither wrote down
// the assertion that would have caught the next branch. This is that assertion:
// it enumerates all three narration paths and requires the prohibition on each,
// so a fourth path (or a tool moved between them) fails here rather than in a
// voice session.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// Both halves must be present. "Unverified" is NOT "failed" — evidence.js is
// explicit that it means "may well have landed, cannot be proven" — so a hedge
// that only forbids the success claim would push MYTHOS into denying things it
// actually did, which is the same bug wearing the other hat (Q8).
function assertForbidsBothClaims(text, label) {
  assert.ok(text, `${label}: there must be instruction text at all`);
  const s = String(text);
  assert.match(s, /NO proof either way/i, `${label}: must state that nothing is proven`);
  assert.match(s, /Do NOT say it worked/i, `${label}: must forbid the success claim`);
  assert.match(s, /later in this conversation/i,
    `${label}: must forbid claiming it later too — BUG-116 was a 49s-late success claim`);
  assert.match(s, /Do NOT claim it FAILED/i,
    `${label}: must ALSO forbid the failure claim, or unverified collapses into failed`);
}

function baseDeps(overrides) {
  return Object.assign({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-273', reject: () => {} },
    },
    dispatchAction: async () => ({ ok: true, result: { done: true } }),
    bus: { emit() {} },
    logger: { warn() {}, info() {}, error() {} },
    connectionId: 'conn-273',
    memory: { working: {}, episodic: { write: async () => {} } },
    historyAppend: () => {},
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
    sanitizeErrorForClient: (e) => String((e && e.message) || e),
  }, overrides || {});
}

// The verbatim launch_app('wt') outcome from the 2026-08-18 session.
const LAUNCH_WT = {
  ok: true,
  unverified: true,
  reason: 'launched, but no windowed process matching the name could be confirmed',
  result: { pid: 17996, name: 'wt', note: 'launched, but no windowed process matching the name could be confirmed' },
};

// ---------------------------------------------------------------------------
// Path 1 — reportLateOutcome. The path the incident actually came through,
// because launch_app is a SLOW_TOOL. Its outcome reaches the model only as
// prose on the [SYSTEM] sendText channel, so the prose is the whole fix.
// ---------------------------------------------------------------------------
describe('BUG-273 B1 — path 1: the late/SLOW_TOOLS outcome (the 2026-08-18 incident)', () => {
  function makeLateAdapter(outcome) {
    const sentText = [];
    const adapter = createLiveToolAdapter(baseDeps({
      dispatchAction: async () => outcome,
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));
    return { adapter, sentText };
  }

  test('an unverified launch_app is narrated with the full prohibition, not the neutral default', async () => {
    const { adapter, sentText } = makeLateAdapter(LAUNCH_WT);
    await adapter.handleLiveToolCalls(
      [{ id: 'c1', name: 'launch_app', args: { name: 'wt' } }],
      { sendToolResponse: () => {} },
    );
    // Guard the premise: if launch_app ever leaves SLOW_TOOLS this test would
    // silently stop covering the incident it was written for.
    assert.equal(sentText.length, 1,
      'launch_app must still be a SLOW_TOOL reporting via the [SYSTEM] channel — see SLOW_TOOLS');
    assert.match(sentText[0], /no windowed process/, 'the real reason must survive');
    assertForbidsBothClaims(sentText[0], 'reportLateOutcome (unverified)');
    assert.doesNotMatch(sentText[0], /Report this to the operator accurately/,
      'the neutral default is what let the model claim Windows Terminal was open');
  });

  test('Q2 — the audit record keeps the plain reason and no prompt text', async () => {
    const { adapter } = makeLateAdapter(LAUNCH_WT);
    await adapter.handleLiveToolCalls(
      [{ id: 'c2', name: 'launch_app', args: { name: 'wt' } }],
      { sendToolResponse: () => {} },
    );
    const entry = adapter._internal.liveTurnActions.at(-1);
    assert.equal(entry.unverified, true);
    assert.equal(entry.ok, false, 'AD-4: an unproven action is not an ok one');
    assert.match(entry.summary, /no windowed process/);
    assert.doesNotMatch(entry.summary, /NO proof either way/,
      'the prohibition is prompt text and must not pollute the audit/episodic record');
  });

  test('Q8 — a late FAILURE keeps its own distinct prohibition (no over-merge)', async () => {
    const { adapter, sentText } = makeLateAdapter({ ok: false, result: { error: 'spawn ENOENT' } });
    await adapter.handleLiveToolCalls(
      [{ id: 'c3', name: 'launch_app', args: { name: 'wt' } }],
      { sendToolResponse: () => {} },
    );
    assert.match(sentText[0], /did NOT succeed/i, 'a real failure must still say it failed');
    assert.doesNotMatch(sentText[0], /Do NOT claim it FAILED/i,
      'the unverified wording must not leak onto a genuine failure');
  });

  test('a late VERIFIED outcome is deliberately left un-hedged', async () => {
    const { adapter, sentText } = makeLateAdapter({
      ok: true,
      unverified: false,
      evidence: { oracle: 'process-window', observed: 'WindowsTerminal (pid 17996)' },
      result: { pid: 17996 },
    });
    await adapter.handleLiveToolCalls(
      [{ id: 'c4', name: 'launch_app', args: { name: 'wt' } }],
      { sendToolResponse: () => {} },
    );
    assert.doesNotMatch(sentText[0], /NO proof either way/,
      'hedging a PROVEN outcome is its own dishonesty — evidence.js says so');
    assert.match(sentText[0], /finished/);
  });
});

// ---------------------------------------------------------------------------
// Path 2 — the awaited branch. Not the path that fired on 2026-08-18, but the
// same invariant, and it had a second defect the late path cannot have: the
// effector's raw, success-shaped result object was attached beside the hedge.
// ---------------------------------------------------------------------------
describe('BUG-273 B1 — path 2: the awaited branch', () => {
  async function runAwaited(outcome, call) {
    const adapter = createLiveToolAdapter(baseDeps({ dispatchAction: async () => outcome }));
    const responses = [];
    await adapter.handleLiveToolCalls([call], { sendToolResponse: (r) => responses.push(...r) });
    return { response: responses[0].response, adapter };
  }

  // ui_type's real unverified payload, from BUG-068's own record.
  const UI_TYPE_UNVERIFIED = {
    ok: true,
    unverified: true,
    reason: 'the focused control exposes neither ValuePattern nor TextPattern, so its text cannot be read back',
    result: { typed: true, readBack: 'unavailable' },
  };

  test('the response message carries the same shared prohibition', async () => {
    const { response } = await runAwaited(UI_TYPE_UNVERIFIED, { id: 'c5', name: 'ui_type', args: { text: 'Hi Alex' } });
    assert.equal(response.status, 'unverified');
    assertForbidsBothClaims(response.message, 'awaited branch (unverified)');
    assert.match(response.message, /ValuePattern/, 'the model must still learn WHAT is unproven');
  });

  test('Q4 — no success-asserting field is attached un-nested beside the hedge', async () => {
    const { response } = await runAwaited(UI_TYPE_UNVERIFIED, { id: 'c6', name: 'ui_type', args: { text: 'Hi Alex' } });
    assert.equal(response.result.typed, undefined,
      '`typed: true` next to "could not be confirmed" is a fact beside a caveat, and the fact wins');
    assert.equal(response.result.confirmed, false,
      'the payload must carry the hedge itself rather than rely on a sibling field');
    assert.match(String(response.result.whatIsUnconfirmed), /could NOT be confirmed/);
  });

  test('Q3 — the payload is preserved, not dropped: from-documents/from-mcp/from-strix need it', async () => {
    // document_answer wraps a real answer in evidence.unverified(). Omission
    // here would be a bigger lie than the wrap.
    const { response } = await runAwaited({
      ok: true,
      unverified: true,
      reason: 'no document chunks matched this query',
      result: { answer: 'partial answer', sources: [] },
    }, { id: 'c7', name: 'document_answer', args: { query: 'x' } });
    assert.equal(response.result.unconfirmedDetails.answer, 'partial answer');
    assert.deepEqual(response.result.unconfirmedDetails.sources, []);
  });

  test('Q8 — a VERIFIED awaited outcome is left exactly as it was: status ok, raw result', async () => {
    const { response } = await runAwaited({
      ok: true,
      unverified: false,
      evidence: { oracle: 'read-back', observed: 'Hi Alex' },
      result: { typed: true, readBack: 'confirmed' },
    }, { id: 'c8', name: 'ui_type', args: { text: 'Hi Alex' } });
    assert.equal(response.status, 'ok');
    assert.equal(response.result.typed, true, 'proven outcomes must not be hedged or re-shaped');
    assert.equal(response.result.confirmed, undefined);
  });
});

// ---------------------------------------------------------------------------
// Path 3 — resolveLiveConfirm. A confirmation gates INTENT; only evidence gates
// OUTCOME, and on 2026-07-31 this path said "It succeeded" over an unprovable
// ui_type. It had a prohibition, but in the wrong field.
// ---------------------------------------------------------------------------
describe('BUG-273 B1 — path 3: the confirm path', () => {
  function makeConfirmAdapter() {
    const sentText = [];
    let confirmId = null;
    const adapter = createLiveToolAdapter(baseDeps({
      leash: {
        check: () => ({ allow: true, requireConfirm: true, tier: 3, reason: 'above-autonomous-max' }),
        confirm: { create: () => { confirmId = 'confirm-273'; return confirmId; }, reject: () => {} },
      },
      getLiveSession: () => ({ isOpen: () => true, sendText: (t) => sentText.push(t) }),
    }));
    return { adapter, sentText, id: () => confirmId };
  }

  test('an approved-but-unverified outcome carries the shared prohibition in the instruction', async () => {
    const { adapter, sentText, id } = makeConfirmAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c9', name: 'ui_type', args: { text: 'Hi Alex' } }],
      { sendToolResponse: () => {} },
    );
    await adapter.resolveLiveConfirm(id(), { ok: true, unverified: true, reason: 'no read-back available' }, true);
    const notice = sentText.at(-1);
    assert.match(notice, /UNVERIFIED/);
    assertForbidsBothClaims(notice, 'resolveLiveConfirm (approved, unverified)');
  });

  test('Q2 — the confirm-path audit summary is a statement of fact, not prompt text', async () => {
    const { adapter, id } = makeConfirmAdapter();
    await adapter.handleLiveToolCalls(
      [{ id: 'c10', name: 'ui_type', args: { text: 'Hi Alex' } }],
      { sendToolResponse: () => {} },
    );
    await adapter.resolveLiveConfirm(id(), { ok: true, unverified: true, reason: 'no read-back available' }, true);
    const entry = adapter._internal.liveTurnActions.at(-1);
    assert.match(entry.summary, /UNVERIFIED: no read-back available/);
    assert.doesNotMatch(entry.summary, /Do NOT/,
      'the prohibition moved to `instruction` — the record must read as a record');
    assert.equal(entry.unverified, true);
    assert.equal(entry.ok, false);
  });
});
