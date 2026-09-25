'use strict';
// BUG-447, resume after a barge-in, the live misfire of 2026-09-24 (written 2026-09-25).
//
// WHAT HAPPENED. 15:06:56 an answer ("... It should be open on your screen now.
// What's next?") ended with 50 characters unheard, and the server remembered them.
// 15:07:16 a newer answer played in full. 15:08:05 the superposition answer was cut
// by Gemini's own VAD, with no report. 15:08:07 the operator said "hold on", the
// model called resume_interrupted_answer, and got the 15:06:56 words: it said "I was
// saying that ... Notepad should still be open", then invented a reason (BUG-451).
//
// THE MECHANISM. The store held "the latest unheard remainder" per connection, and
// only a new report or a closed socket replaced it. A newer answer that produced no
// report left the older one standing. A remainder is only true of the answer the
// room heard last; so the tracker now discards the stored one whenever a turn that
// carried audio ends. A turn with no audio (a silent tool turn) leaves it alone,
// because the room heard nothing newer.
//
// Probe letters and their dated results: BUGS.md, BUG-447.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const ua = require('../src/core/voice/unheard-answer');

// 24 kHz, 16-bit mono: 48 bytes per millisecond.
const pcmChunk = (ms) => Buffer.alloc(ms * 48, 0).toString('base64');

// Verbatim from the 2026-09-24 timeline (turns at 15:06:56, 15:07:16, 15:08:05).
const BRAVE = 'Understood, Sir. I\'ve launched Brave in debug mode for you and navigated to that link on Smartprix showing the price. It should be open on your screen now. What\'s next?';
const NOTED = 'Understood, Sir. I\'ll be sure to launch Brave in debug mode and open it there next time.';
const SUPERPOSITION = 'Right, so superposition is like telling a particle it doesn\'t need to pick just one state yet.';

function tracker(connectionId) {
  ua.forgetUnheard(connectionId);
  return ua.createUnheardTracker({
    remember: (e) => ua.rememberUnheard(connectionId, e),
    forget: () => ua.forgetUnheard(connectionId),
  });
}
function answer(t, text, ms, turnId) {
  for (let i = 0; i < ms / 100; i++) t.audio(pcmChunk(100));
  t.turnEnd({ assistantText: text, turnId });
}

test('(a) the 09-24 replay: a newer answer that was heard retires the older remainder, so "hold on" resumes nothing', async () => {
  const t = tracker('c-replay');
  answer(t, BRAVE, 8000, 44);
  const kept = t.unheard({ cutMs: 6500, turnMs: 8000 });
  assert.ok(kept && /It should be open on your screen now\./.test(kept.text), 'fixture: the 15:06:56 cut is remembered');
  answer(t, NOTED, 5000, 45); // 15:07:16, played in full, no report
  answer(t, SUPERPOSITION, 9800, 46); // 15:08:05, cut by Gemini, no report
  const r = await ua.resumeInterruptedAnswer({}, { connectionId: 'c-replay' });
  assert.equal(r.result.unheard, null, 'the words of an answer two turns back must not come back as "what I was saying"');
  assert.match(r.result.message, /Nothing of your last answer went unheard/);
});

test('(b) adjacent, the feature itself: the latest answer\'s remainder is still handed back, once', async () => {
  const t = tracker('c-latest');
  answer(t, NOTED, 5000, 1);
  answer(t, BRAVE, 8000, 2);
  t.unheard({ cutMs: 6500, turnMs: 8000 });
  const r = await ua.resumeInterruptedAnswer({}, { connectionId: 'c-latest' });
  assert.match(r.result.unheard || '', /It should be open on your screen now\. What's next\?/);
  assert.equal((await ua.resumeInterruptedAnswer({}, { connectionId: 'c-latest' })).result.unheard, null, 'taken once, as before');
});

test('(c) a turn with no audio in between (a silent tool turn) does not retire the remainder: the room heard nothing newer', async () => {
  const t = tracker('c-silent');
  answer(t, BRAVE, 8000, 1);
  t.unheard({ cutMs: 6500, turnMs: 8000 });
  t.turnEnd({ assistantText: '', turnId: 2 }); // no audio forwarded
  const r = await ua.resumeInterruptedAnswer({}, { connectionId: 'c-silent' });
  assert.match(r.result.unheard || '', /It should be open on your screen now\./);
});

test('(d) the tracker cannot be built without a way to retire a stale remainder', () => {
  assert.throws(() => ua.createUnheardTracker({ remember: () => {} }), /forget/);
});

test('(e) end to end, real server and Live session: an answer heard after the cut one retires it', async () => {
  const { createServer } = require('../server');
  const { createBus } = require('../src/core/bus');
  const { baseDeps, FakeGeminiSocket, waitFor } = require('./pr3-wire-helpers.cjs');
  const { buildTools } = require('../src/core/effectors/from-memory');
  const toolDef = buildTools({}).find((x) => x.name === 'resume_interrupted_answer');
  const effectors = new Map([[toolDef.name, { name: toolDef.name, description: toolDef.description, params: toolDef.params, tier: 0 }]]);
  const sockets = [];
  const prev = process.env.GOOGLE_API_KEY; process.env.GOOGLE_API_KEY = 'test-key';
  const server = createServer(baseDeps(createBus({ historySize: 30 }), {
    config: { VOICE_S2S_ENABLED: true },
    effectors: {
      effectors, catalog: () => [...effectors.values()], get: (n) => effectors.get(n), breakers: { allow: () => true },
      invoke: async (name, args, ctx) => (name === toolDef.name ? toolDef.fn(args, ctx) : { ok: true }),
    },
    createLiveSocket: () => { const s = new FakeGeminiSocket(); sockets.push(s); return s; },
  }));
  await server.ready;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/ws`);
    const hud = [];
    ws.on('message', (d) => { try { hud.push(JSON.parse(String(d))); } catch { /* not JSON */ } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({ type: 'live-open' })); await waitFor(() => sockets.length);
    const gemini = sockets[0];
    gemini.simulateOpen(); gemini.serverFrame({ setupComplete: {} });
    await waitFor(() => gemini.sent.some((f) => f.setup));
    const turn = (text, ms) => {
      gemini.serverFrame({ serverContent: { outputTranscription: { text } } });
      for (let i = 0; i < ms / 100; i++) gemini.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmChunk(100) } }] } } });
      gemini.serverFrame({ serverContent: { turnComplete: true } });
    };
    turn(BRAVE, 8000);
    await waitFor(() => hud.filter((m) => m.type === 'live-turn-complete').length === 1);
    ws.send(JSON.stringify({ type: 'voice-unheard', cutMs: 6500, turnMs: 8000 }));
    await waitFor(() => [...ua._internal.store.values()].some((e) => /It should be open/.test(e.text)));
    turn(NOTED, 5000); // heard in full: the HUD sends no report
    await waitFor(() => hud.filter((m) => m.type === 'live-turn-complete').length === 2);
    gemini.serverFrame({ toolCall: { functionCalls: [{ id: 'call-1', name: 'resume_interrupted_answer', args: {} }] } });
    await waitFor(() => gemini.sent.some((f) => f.toolResponse));
    const response = JSON.stringify(gemini.sent.find((f) => f.toolResponse).toolResponse);
    assert.doesNotMatch(response, /It should be open on your screen/, 'the older answer\'s words must not be served');
    assert.match(response, /Nothing of your last answer went unheard/);
  } finally {
    if (ws) ws.close();
    await server.stop();
    if (prev === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prev;
  }
});
