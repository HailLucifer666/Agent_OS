'use strict';

// test/bug-116-live-failed-tool-no-success-claim.test.js — BUG-116.
//
// 2026-08-05, 17:13:04: MYTHOS said "The click went through, and the screen did
// change afterwards" while the audit for that same moment records see_and_click
// FAILED. 49 seconds after the failure it asserted the opposite of what happened.
// At 17:10 the same shape twice more: "I've played Starboy" over a real error 153,
// and "YouTube is now present" when the window was Chrome.
//
// The BATCH (non-Live) path already closes this class deterministically — a
// corrective pass on any failed/unverified action plus the Slice-2 honesty guard
// that PREPENDS "That didn't work — X failed. I won't claim it succeeded." when
// every action in the turn failed (voice-agent.js, covered by
// voice-agent-tools.test.js's BUG-007 block). The LIVE (Gemini Live S2S) path has
// no turn boundary of ours to hook: Gemini speaks its own audio as tool results
// arrive, so the ONLY thing that teaches it what happened — now and for the rest
// of the retained session — is the text inside the functionResponse we send back.
//
// And that text was silent about honesty on exactly the two branches that mean
// "this did not happen": status:'failed' carried a bare `error` string, and
// status:'error' carried a bare `error` string. Meanwhile status:'started' says
// "do NOT claim completion" and status:'unverified' says "Do not tell the
// operator it worked". The failure branches — the strongest reason to forbid a
// success claim — were the ones with no instruction at all.
//
// THE RULE PINNED HERE: a turn that claims a world-changing action succeeded must
// cite a status:'ok' for that tool in the same turn. Every non-ok outcome the
// model is told about must carry explicit language forbidding a success claim,
// exactly as the slow/unverified branches already do.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');

// Every assertion below reads the response TEXT, not just the status field —
// the status is for us, the text is what the model actually reasons over.
function assertForbidsSuccessClaim(text, label) {
  assert.ok(text, `${label}: there must be instruction text at all`);
  assert.match(String(text), /did NOT succeed/i, `${label}: must state plainly that it did not succeed`);
  assert.match(String(text), /do NOT claim it worked/i, `${label}: must forbid the success claim`);
  assert.match(String(text), /changed as a result/i,
    `${label}: must forbid the "and the screen did change afterwards" embellishment too`);
}

function harness(overrides) {
  const opts = overrides || {};
  const sent = [];
  const history = [];
  const episodic = [];
  const session = { isOpen: () => true, sendText: (t) => sent.push(t) };
  const adapter = createLiveToolAdapter({
    leash: opts.leash || {
      check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'confirm-116' },
    },
    dispatchAction: opts.dispatchAction || (async () => ({ ok: false, result: { error: 'no match' } })),
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-116',
    memory: { working: { tick: 3 }, episodic: { write: async (rec) => { episodic.push(rec); } } },
    historyAppend: (role, content) => history.push({ role, content }),
    reflection: null,
    // The REAL summarizer, so the record-side assertions below are about
    // production behaviour rather than a stub that agrees with them.
    summarizeActionsForResult,
    getLiveSession: () => (opts.noSession ? null : session),
  });
  return { adapter, sent, history, episodic };
}

async function callOnce(adapter, name, args) {
  const responses = [];
  await adapter.handleLiveToolCalls([{ id: 'call-116', name, args: args || {} }],
    { sendToolResponse: (r) => responses.push(...r) });
  return responses[0].response;
}

describe('BUG-116 — a failed Live tool call must forbid the success claim in its own response', () => {
  test("status:'failed' carries explicit anti-fabrication language, not just an error string", async () => {
    // The 17:13:04 turn: see_and_click came back ok:false and the model was told
    // only "failed" + a reason, then narrated a click that never landed.
    const { adapter } = harness({
      dispatchAction: async () => ({ ok: false, result: { error: 'no element matched "Subscribe"' } }),
    });
    const response = await callOnce(adapter, 'see_and_click', { target: 'Subscribe' });

    assert.equal(response.status, 'failed');
    assert.match(response.error, /no element matched/, 'the real reason must still reach the model');
    assertForbidsSuccessClaim(response.message, "status:'failed'");
    assert.match(response.message, /see_and_click/, 'the instruction must name the tool that failed');
  });

  test("status:'error' (dispatchAction threw) carries the same explicit language", async () => {
    const { adapter } = harness({ dispatchAction: async () => { throw new Error('pc-child offline'); } });
    const response = await callOnce(adapter, 'see_and_click', { target: 'Subscribe' });

    assert.equal(response.status, 'error');
    assertForbidsSuccessClaim(response.message, "status:'error' (dispatch threw)");
  });

  test("status:'error' from a gate failure (leash.check threw) carries it too", async () => {
    const { adapter } = harness({ leash: { check: () => { throw new Error('leash exploded'); } } });
    const response = await callOnce(adapter, 'ui_click', { target: 'x' });

    assert.equal(response.status, 'error');
    assert.match(response.error, /gate failure/);
    assertForbidsSuccessClaim(response.message, "status:'error' (gate failure)");
  });

  test('every failure-shaped outcome is instructed — no shape slips through uninstructed', async () => {
    // The shapes that actually reach this seam in the wild: fail() with a
    // result.error, a bare {ok:false, error} (BUG-101's effectors), a bare
    // {ok:false} with nothing to say, and a {ok:false, reason}.
    const shapes = [
      { label: 'result.error', outcome: { ok: false, result: { error: 'error 153' } } },
      { label: 'top-level error', outcome: { ok: false, error: 'Could not parse that time.' } },
      { label: 'nothing to say', outcome: { ok: false } },
      { label: 'reason only', outcome: { ok: false, reason: 'window vanished' } },
    ];
    for (const shape of shapes) {
      const { adapter } = harness({ dispatchAction: async () => shape.outcome });
      const response = await callOnce(adapter, 'spotify_pause', {});
      assert.equal(response.status, 'failed', shape.label);
      assertForbidsSuccessClaim(response.message, shape.label);
    }
  });

  test('a genuine success is NOT polluted with failure language (no over-correction)', async () => {
    const { adapter } = harness({
      dispatchAction: async () => ({ ok: true, evidence: { oracle: 'read-back' }, result: { clicked: true } }),
    });
    const response = await callOnce(adapter, 'see_and_click', { target: 'Subscribe' });

    assert.equal(response.status, 'ok');
    assert.equal(response.message, undefined, 'a proven success needs no honesty instruction');
  });
});

describe('BUG-116 — the late/slow and confirm channels forbid it as explicitly', () => {
  test('a slow tool that FAILS late tells the model not to claim it worked ("I\'ve played Starboy" over error 153)', async () => {
    let resolveDispatch;
    const { adapter, sent } = harness({ dispatchAction: () => new Promise((r) => { resolveDispatch = r; }) });

    const started = await callOnce(adapter, 'spotify_play', { query: 'Starboy' });
    assert.equal(started.status, 'started');

    resolveDispatch({ ok: false, result: { error: 'spotify returned error 153' } });
    await new Promise((r) => setTimeout(r, 10));

    const systemPush = sent.filter((s) => typeof s === 'string' && /^\[SYSTEM\]/.test(s));
    assert.equal(systemPush.length, 1);
    assert.match(systemPush[0], /error 153/, 'the real reason must reach the model');
    assertForbidsSuccessClaim(systemPush[0], 'late failure [SYSTEM] push');
  });

  test('the late-failure RECORD stays a clean reason — the instruction is for the model, not the audit', async () => {
    let resolveDispatch;
    const { adapter } = harness({ dispatchAction: () => new Promise((r) => { resolveDispatch = r; }) });
    await callOnce(adapter, 'spotify_play', { query: 'Starboy' });
    resolveDispatch({ ok: false, result: { error: 'spotify returned error 153' } });
    await new Promise((r) => setTimeout(r, 10));

    const entry = adapter._internal.liveTurnActions.at(-1);
    assert.equal(entry.ok, false);
    assert.match(entry.summary, /FAILED: .*error 153/);
    assert.doesNotMatch(entry.summary, /do NOT claim/i,
      'prompt instructions must not leak into the episodic/audit record');
  });

  test('an APPROVED-but-FAILED confirm forbids the success claim as well', async () => {
    let capturedConfirmId = null;
    const { adapter, sent } = harness({
      leash: {
        check: () => ({ allow: false, requireConfirm: true, tier: 3, reason: 'tier-3-requires-confirm' }),
        confirm: { create: () => { capturedConfirmId = 'confirm-116-t3'; return capturedConfirmId; } },
      },
    });
    await callOnce(adapter, 'gmail_send', { to: 'a@b.c' });
    await adapter.resolveLiveConfirm(capturedConfirmId, { ok: false, result: 'SMTP refused' }, true);

    assert.equal(sent.length, 1);
    assert.match(sent[0], /FAILED/);
    assert.match(sent[0], /SMTP refused/);
    assertForbidsSuccessClaim(sent[0], 'approved-but-failed confirm');
  });
});

describe('BUG-116 — the turn record can never represent a failed action as a completed success', () => {
  test("the 17:13:04 turn: the model claims the click landed, the record says FAILED", async () => {
    const { adapter, history, episodic } = harness({
      dispatchAction: async () => ({ ok: false, result: { error: 'no element matched "Subscribe"' } }),
    });
    await callOnce(adapter, 'see_and_click', { target: 'Subscribe' });

    // Verbatim from the 17:13:04 transcript — the claim that must not survive.
    adapter.onLiveTurnComplete({
      userText: 'click subscribe',
      assistantText: 'The click went through, and the screen did change afterwards.',
    });

    const note = history.find((h) => h.role === 'system');
    assert.ok(note, 'a system outcome note must be appended over the model\'s claim');
    assert.match(note.content, /see_and_click FAILED/);
    assert.doesNotMatch(note.content, /succeeded/,
      'the real summarizer must never render a failed action as succeeded');

    const write = episodic.find((w) => w.kind === 'conversation');
    assert.equal(write.detail.actions[0].ok, false, 'AD-4: the record is the outcome, not the claim');
  });

  test('a slow tool\'s in-progress marker is still "started", never "FAILED" (no regression on BUG-063)', async () => {
    const { adapter, history } = harness({ dispatchAction: () => new Promise(() => {}) });
    await callOnce(adapter, 'spotify_play', { query: 'Starboy' });
    adapter.onLiveTurnComplete({ userText: 'play starboy', assistantText: 'Putting it on now.' });

    const note = history.find((h) => h.role === 'system');
    assert.match(note.content, /spotify_play started \(outcome pending\)/);
    assert.doesNotMatch(note.content, /FAILED/);
  });
});
