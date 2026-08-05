'use strict';

// test/live-session-transcripts.test.js — Track B3, AD-6 MISSING HALF.
//
// AD-6 has two spine assertions. The COVERED half — a turnComplete frame with
// NO transcript at all emits health.anomaly — lives in
// test/live-session.test.js:155 ("a turnComplete frame with no transcript at
// all emits health.anomaly (AD-6)"). That assertion is NOT duplicated here.
//
// This file is the other half: "S2S turns are never amnesiac" also requires
// that every completed Live turn WRITES both transcripts to episodic memory,
// not merely that a blank one is flagged. live-session.js itself never
// touches memory — it only calls the injected onTurnComplete({userText,
// assistantText}) callback (module header comment, live-session.js:29-30).
// The real episodic write happens one level up, in
// src/core/voice/live-tool-adapter.js's onLiveTurnComplete (server/index.js
// wires session.onTurnComplete -> adapter.onLiveTurnComplete, see
// server/index.js:1335-1339). So the only way to prove the FULL spine wording
// — "feed a scripted server frame sequence, assert episodic write contains
// user + assistant text" — is to wire the two real modules together exactly
// as server/index.js does, drive it over live-session.js's injectable
// createSocket seam, and inspect the resulting episodic write. That is what
// this file does.
//
// THE §3 TRAP still applies here: the scripted frame below carries
// inputTranscription, outputTranscription AND turnComplete all on the SAME
// serverContent frame, exactly like live-session.test.js's combined-frame
// test — proving the episodic write isn't an artifact of transcripts arriving
// on separate frames.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

// Same fake 'ws'-shaped socket as test/live-session.test.js's FakeSocket —
// duplicated here rather than imported because that file doesn't export it
// (it's a local test fixture, not a module surface).
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0;
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
}

function fakeMemory() {
  const writes = [];
  return {
    working: { tick: 1 },
    episodic: { write: async (rec) => { writes.push(rec); } },
    _writes: writes,
  };
}

function wireRealSession(memory, history) {
  const adapter = createLiveToolAdapter({
    leash: {
      check: () => ({ allow: true, requireConfirm: false, tier: 0, reason: 'within-autonomous-max' }),
      confirm: { create: () => 'cf-1' },
    },
    dispatchAction: async () => ({ ok: true, result: {} }),
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    connectionId: 'conn-1',
    memory,
    historyAppend: (role, content) => history.push({ role, content }),
    reflection: { noteTurn() {} },
    summarizeActionsForResult: () => null,
    getLiveSession: () => null,
  });

  const sockets = [];
  const createSocket = () => { const s = new FakeSocket(); sockets.push(s); return s; };

  const session = createLiveSession({
    config: {},
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut: () => {},
    onTranscript: () => {},
    onState: () => {},
    // This is the exact wiring server/index.js uses (server/index.js:1335-1339):
    // live-session.js's onTurnComplete callback forwards straight into the
    // adapter's episodic-writing onLiveTurnComplete.
    onTurnComplete: (turn) => adapter.onLiveTurnComplete(turn),
    createSocket,
  });

  return { session, sockets, adapter };
}

describe('live-session -> live-tool-adapter wiring (AD-6, the missing half)', () => {
  test('a completed Live turn writes BOTH transcripts to episodic memory', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const memory = fakeMemory();
    const history = [];
    const { session, sockets } = wireRealSession(memory, history);

    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    // §3 trap: inputTranscription + outputTranscription + turnComplete on ONE
    // combined serverContent frame — not three separate frames.
    sockets[0].serverFrame({
      serverContent: {
        inputTranscription: { text: 'what is the weather' },
        outputTranscription: { text: 'It is sunny.' },
        turnComplete: true,
      },
    });

    assert.equal(memory._writes.length, 1, 'exactly one episodic write for the one completed turn');
    const rec = memory._writes[0];
    assert.equal(rec.kind, 'conversation');
    assert.equal(rec.detail.text, 'what is the weather', 'the user transcript must reach episodic memory');
    assert.equal(rec.detail.reply, 'It is sunny.', 'the assistant transcript must reach episodic memory');
    assert.equal(rec.detail.transport, 's2s');
    assert.match(rec.summary, /what is the weather/);
    assert.match(rec.summary, /It is sunny\./);

    session.close();
  });

  test('a turn split across MULTIPLE frames (partial transcripts accumulating) still lands both full texts in episodic memory on turnComplete', async () => {
    // Guards against a regression where only the LAST partial chunk of each
    // transcript gets persisted instead of the full accumulated text.
    process.env.GOOGLE_API_KEY = 'test-key';
    const memory = fakeMemory();
    const history = [];
    const { session, sockets } = wireRealSession(memory, history);

    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'what is ' } } });
    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'the weather' } } });
    sockets[0].serverFrame({ serverContent: { outputTranscription: { text: 'It is ' } } });
    sockets[0].serverFrame({ serverContent: { outputTranscription: { text: 'sunny.' }, turnComplete: true } });

    assert.equal(memory._writes.length, 1);
    assert.equal(memory._writes[0].detail.text, 'what is the weather');
    assert.equal(memory._writes[0].detail.reply, 'It is sunny.');

    session.close();
  });
});

// BUG-118 — the operator heard MYTHOS speak its own private reasoning as the
// reply. Gemini marks a reasoning part with `thought: true`; this module used to
// forward every modelTurn part's text to onTranscript regardless. The filter is
// defensive: if the flag never appears on the wire it changes nothing, which is
// exactly why the per-turn part counters exist alongside it — they are what
// turns the suspicion into evidence in one live session.
describe('BUG-118 — a modelTurn part flagged as the model\'s own thinking is not the reply', () => {
  function sessionWithCapture() {
    const transcripts = [];
    const logs = [];
    const sockets = [];
    const session = createLiveSession({
      config: {},
      bus: { emit() {} },
      logger: { warn() {}, info: (event, detail) => logs.push({ event, detail }) },
      spend: { recordCall() {} },
      breakers: { allow: () => true, fail() {}, success() {} },
      systemInstruction: 'test instruction',
      functionDeclarations: [],
      onAudioOut: () => {},
      onTranscript: (t) => transcripts.push(t),
      onState: () => {},
      onTurnComplete: () => {},
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    return { session, sockets, transcripts, logs };
  }

  async function openIt(session, sockets) {
    process.env.GOOGLE_API_KEY = 'test-key';
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;
  }

  test('only the real answer reaches onTranscript — the thought part is dropped', async () => {
    const { session, sockets, transcripts } = sessionWithCapture();
    await openIt(session, sockets);

    sockets[0].serverFrame({
      serverContent: {
        modelTurn: {
          parts: [
            { text: 'The operator probably wants the Spotify one, not the browser tab.', thought: true },
            { text: 'Putting it on now.' },
          ],
        },
      },
    });

    const assistant = transcripts.filter((t) => t.role === 'assistant').map((t) => t.text);
    assert.deepEqual(assistant, ['Putting it on now.'],
      'private reasoning must never reach the transcript channel the operator hears');

    session.close();
  });

  test('an unflagged part is untouched — this is a filter, not a rewrite', async () => {
    const { session, sockets, transcripts } = sessionWithCapture();
    await openIt(session, sockets);

    sockets[0].serverFrame({ serverContent: { modelTurn: { parts: [{ text: 'plain answer' }] } } });

    assert.deepEqual(transcripts.map((t) => t.text), ['plain answer']);
    session.close();
  });

  test('every turn reports how many text parts were flagged — the negative case is the evidence', async () => {
    const { session, sockets, logs } = sessionWithCapture();
    await openIt(session, sockets);

    sockets[0].serverFrame({
      serverContent: {
        modelTurn: { parts: [{ text: 'thinking out loud', thought: true }, { text: 'answer' }] },
      },
    });
    sockets[0].serverFrame({ serverContent: { turnComplete: true } });

    const line = logs.find((l) => l.event === 'live.turn-parts');
    assert.ok(line, 'each completed turn must record its part counts');
    assert.equal(line.detail.thoughtParts, 1);
    assert.equal(line.detail.textParts, 1);

    session.close();
  });

  test('the counters reset per turn — turn 2 must not inherit turn 1\'s totals', async () => {
    const { session, sockets, logs } = sessionWithCapture();
    await openIt(session, sockets);

    sockets[0].serverFrame({
      serverContent: { modelTurn: { parts: [{ text: 'a', thought: true }] }, turnComplete: true },
    });
    sockets[0].serverFrame({
      serverContent: { modelTurn: { parts: [{ text: 'b' }] }, turnComplete: true },
    });

    const lines = logs.filter((l) => l.event === 'live.turn-parts');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1].detail, { textParts: 1, thoughtParts: 0 },
      'a stale count would make a clean turn look like it leaked reasoning');

    session.close();
  });
});
