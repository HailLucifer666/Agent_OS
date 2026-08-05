'use strict';

// WAVE 3 — MYTHOS must not describe an outcome it does not have yet.
//
// Two separate races produced the same lie.
//
// BATCH PATH: voice-agent composes finalSay from the model's FIRST response,
// before any action runs, and only re-derives it when something returned
// ok:false. So an ok:true-but-unproven result kept whatever had already been
// said — which is how "I'm pleased to report I have successfully typed..."
// survived a Notepad that stayed empty.
//
// LIVE PATH: the Live turn completes while a cua-driven Spotify click (5-10s) is
// still running, so the model hit turnComplete with no outcome and narrated a
// guess. The 9+ live-tool-outcome-late-for-turn anomalies on 2026-07-31 were that.
// Awaiting harder cannot fix it — the turn boundary belongs to the model.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createVoiceAgent } = require('../src/core/voice/voice-agent');

function agent(opts) {
  const o = opts || {};
  const prompts = [];
  let turn = 0;
  const brain = {
    think: async ({ messages, prompt }) => {
      const text = prompt || (messages && messages[0] && messages[0].content) || '';
      prompts.push(String(text));
      turn++;
      const t = o.turns[Math.min(turn - 1, o.turns.length - 1)];
      return { content: JSON.stringify(t), parsed: t, offline: false };
    },
  };
  const a = createVoiceAgent({
    brain,
    leash: { check: () => ({ allow: true, requireConfirm: false, tier: 1 }), confirm: { create: () => 'c1', accept: () => null, reject: () => true } },
    bus: { emit: () => {}, subscribe: () => () => {} },
    dispatch: async () => o.outcome,
    hub: { catalog: () => [{ name: 'ui_type', description: 'type', params: { text: 'string' } }, { name: 'send_key', description: 'key', params: { key: 'string' } }] },
  });
  return { a, prompts };
}

const CLAIMED = { say: "I've typed it into Notepad for you.", actions: [{ tool: 'ui_type', args: { text: 'Hi Alex' } }], needs_result: false };
const HONEST = { say: "I sent the keystrokes but couldn't confirm they landed.", actions: [], needs_result: false };

describe('WAVE 3 — batch: an unverified outcome re-derives the spoken reply', () => {
  it('an ok-but-unverified ui_type forces a corrective pass', async () => {
    const { a, prompts } = agent({
      turns: [CLAIMED, HONEST],
      outcome: { ok: true, unverified: true, reason: 'the text could not be read back out of the window' },
    });
    const res = await a.handleUtterance({ text: 'type Hi Alex in notepad', ctx: { channel: 'voice', connectionId: 'w' } });

    const corrective = prompts.filter((p) => /CORRECTIVE PASS/.test(p));
    assert.equal(corrective.length, 1, 'ok:true was previously enough to skip correction entirely');
    assert.match(res.say, /couldn't confirm|could not confirm/i, 'the re-derived reply must be the honest one');
  });

  it('the corrective prompt distinguishes unverified from failed, and carries the reason', async () => {
    const { a, prompts } = agent({
      turns: [CLAIMED, HONEST],
      outcome: { ok: true, unverified: true, reason: 'no readable text pattern' },
    });
    await a.handleUtterance({ text: 'type it', ctx: { channel: 'voice', connectionId: 'w' } });

    const p = prompts.find((x) => /CORRECTIVE PASS/.test(x));
    assert.match(p, /"unverified":\s*true/, 'the model must see the actual flag');
    assert.match(p, /RAN but could not be confirmed/i,
      'conflating this with a failure would make MYTHOS apologise for something that did happen');
    assert.match(p, /no readable text pattern/, 'and the reason has to reach the prompt');
  });

  it('a fully verified outcome does NOT trigger a corrective pass (no wasted brain call)', async () => {
    const { a, prompts } = agent({
      turns: [CLAIMED],
      outcome: { ok: true, unverified: false, evidence: { oracle: 'read-back', observed: 'Hi Alex' } },
    });
    const res = await a.handleUtterance({ text: 'type it', ctx: { channel: 'voice', connectionId: 'w' } });
    assert.deepEqual(prompts.filter((p) => /CORRECTIVE PASS/.test(p)), []);
    assert.match(res.say, /typed it/i, 'a proven action may be stated flatly');
  });

  it('an unverified keystroke does NOT trigger a corrective pass — cost discipline', async () => {
    // send_key is unverified by nature now: a keystroke cannot observe its own
    // effect. Correcting on it would fire an extra brain call on every Ctrl+N for
    // no honesty gained, since nobody hears "I pressed ctrl+n" as a claim.
    const { a, prompts } = agent({
      turns: [{ say: 'Opening a new document.', actions: [{ tool: 'send_key', args: { key: 'ctrl+n' } }], needs_result: false }],
      outcome: { ok: true, unverified: true, reason: 'pressed ctrl+n — the keystroke was accepted' },
    });
    await a.handleUtterance({ text: 'new document', ctx: { channel: 'voice', connectionId: 'w' } });
    assert.deepEqual(prompts.filter((p) => /CORRECTIVE PASS/.test(p)), []);
  });
});

describe('WAVE 3 — live: a slow tool reports "started", then the real outcome', () => {
  const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

  function liveAdapter(dispatchImpl) {
    const sent = [];
    const session = { isOpen: () => true, sendText: (t) => sent.push(t) };
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 2 }), confirm: { create: () => 'c1' } },
      dispatchAction: dispatchImpl,
      getLiveSession: () => session,
      bus: { emit: (type, payload) => sent.push({ anomaly: payload && payload.kind }) },
      logger: { warn() {}, info() {} },
      connectionId: 'ws1',
      memory: { audit: { write() {} }, episodic: { write: async () => ({ ref: 'e' }) } },
      historyAppend: () => {},
      reflection: null,
      summarizeActionsForResult: () => null,
    });
    return { adapter, sent, session };
  }

  it('a slow tool answers "started" immediately and tells the model not to claim completion', async () => {
    let resolveDispatch;
    const { adapter, sent } = liveAdapter(() => new Promise((r) => { resolveDispatch = r; }));

    const responses = [];
    await adapter.handleLiveToolCalls(
      [{ id: 'call1', name: 'spotify_play', args: { query: 'Slow It Down' } }],
      { sendToolResponse: (r) => responses.push(...r) }
    );

    assert.equal(responses.length, 1, 'the turn must be answered without waiting');
    assert.equal(responses[0].response.status, 'started');
    assert.match(responses[0].response.message, /do NOT claim completion/i);

    // Now the real outcome lands, after the turn is over.
    resolveDispatch({ ok: true, result: { nowPlaying: 'Slow It Down' } });
    await new Promise((r) => setTimeout(r, 10));

    const systemPush = sent.filter((s) => typeof s === 'string' && /^\[SYSTEM NOTICE/.test(s));
    assert.equal(systemPush.length, 1, 'the outcome must arrive through the [SYSTEM] channel');
    assert.match(systemPush[0], /finished/i);
    assert.match(systemPush[0], /Slow It Down/);
  });

  it('an expected late outcome does not raise the late-for-turn anomaly', async () => {
    // That anomaly exists to catch accidental misattribution. A deliberately
    // deferred outcome is not that, and 9 of them in one session was noise
    // hiding the real problem.
    let resolveDispatch;
    const { adapter, sent } = liveAdapter(() => new Promise((r) => { resolveDispatch = r; }));
    await adapter.handleLiveToolCalls([{ id: 'c', name: 'spotify_play', args: {} }], { sendToolResponse: () => {} });
    resolveDispatch({ ok: true, result: {} });
    await new Promise((r) => setTimeout(r, 10));

    const anomalies = sent.filter((s) => s && s.anomaly === 'live-tool-outcome-late-for-turn');
    assert.deepEqual(anomalies, []);
  });

  it('a slow tool that comes back UNVERIFIED tells the model not to say it worked', async () => {
    let resolveDispatch;
    const { adapter, sent } = liveAdapter(() => new Promise((r) => { resolveDispatch = r; }));
    await adapter.handleLiveToolCalls([{ id: 'c', name: 'spotify_play', args: {} }], { sendToolResponse: () => {} });
    resolveDispatch({ ok: true, unverified: true, reason: 'clicked but Spotify is playing BACK 2 LOVE' });
    await new Promise((r) => setTimeout(r, 10));

    const push = sent.find((s) => typeof s === 'string' && /^\[SYSTEM NOTICE/.test(s));
    assert.match(push, /could NOT be confirmed/i);
    assert.match(push, /BACK 2 LOVE/, 'the contradicting evidence must reach the model verbatim');
    assert.match(push, /Do not tell the operator it worked/i);
  });

  it('a slow tool that FAILS reports the real error late, never a fabricated success', async () => {
    // Coverage moved here from live-tool-adapter.test.js, which asserted this
    // against spotify_play before spotify_play became a slow tool.
    let resolveDispatch;
    const { adapter, sent } = liveAdapter(() => new Promise((r) => { resolveDispatch = r; }));
    await adapter.handleLiveToolCalls([{ id: 'c', name: 'spotify_play', args: {} }], { sendToolResponse: () => {} });
    resolveDispatch({ ok: false, result: { error: 'circuit-open' } });
    await new Promise((r) => setTimeout(r, 10));

    const push = sent.find((s) => typeof s === 'string' && /^\[SYSTEM NOTICE/.test(s));
    assert.match(push, /FAILED/);
    assert.match(push, /circuit-open/);
  });

  it('a fast tool is still awaited inside the turn and answers ok', async () => {
    const { adapter } = liveAdapter(async () => ({ ok: true, result: { volume: 30 } }));
    const responses = [];
    await adapter.handleLiveToolCalls([{ id: 'c', name: 'set_volume', args: { level: 30 } }], { sendToolResponse: (r) => responses.push(...r) });
    assert.equal(responses[0].response.status, 'ok', 'only slow tools change shape');
  });
});
