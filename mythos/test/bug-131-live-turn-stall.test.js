'use strict';

// test/bug-131-live-turn-stall.test.js — BUG-131, instrumentation only.
//
// 2026-08-06: the operator spoke, MYTHOS transcribed the words, and then
// nothing came back — the HUD went straight back to listening. Nothing in the
// system noticed. live-turn-no-transcript only fires for a turnComplete that
// ARRIVED empty, and the only other timer is the 120s idle one, by which point
// the operator has repeated themselves twice.
//
// This adds the missing watchdog and nothing else. A stall could be the client,
// the network or Gemini; naming a cause without evidence is exactly what AD-4
// forbids, so the anomaly says only that a turn stalled, and carries BUG-124's
// turnId so the next occurrence can be pinned to a specific turn's frames.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');

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

// A short stall deadline so the test measures behaviour, not patience.
function harness(stallMs = 40) {
  const anomalies = [];
  const sockets = [];
  const session = createLiveSession({
    config: { LIVE_TURN_STALL_MS: stallMs },
    bus: { emit: (type, payload) => { if (type === 'health.anomaly') anomalies.push(payload); } },
    logger: { warn() {}, info() {} },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut: () => {},
    onTranscript: () => {},
    onState: () => {},
    onTurnComplete: () => {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  return { session, sockets, anomalies };
}

async function opened(h) {
  process.env.GOOGLE_API_KEY = 'test-key-for-bug-131';
  const p = h.session.open();
  h.sockets[0].simulateOpen();
  h.sockets[0].serverFrame({ setupComplete: {} });
  await p;
  return h.sockets[0];
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const stalls = (anomalies) => anomalies.filter((a) => a.kind === 'live-turn-stalled');

describe('BUG-131 — a turn that never comes back must not pass in silence', () => {
  test('the operator is transcribed, no reply ever arrives → live-turn-stalled', async () => {
    const h = harness(40);
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'what is the weather' } } });
    await settle(140);

    const fired = stalls(h.anomalies);
    assert.equal(fired.length, 1, 'exactly one anomaly for one stalled turn');
    assert.equal(fired[0].turnId, 1, 'the id the turn WOULD have been reported under');
    assert.equal(fired[0].waitedMs, 40);
    h.session.close('test');
  });

  test('a normal turn raises nothing — spoken output disarms the watchdog', async () => {
    const h = harness(40);
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'hello' } } });
    sock.serverFrame({ serverContent: { outputTranscription: { text: 'hello there' } } });
    sock.serverFrame({ serverContent: { turnComplete: true } });
    await settle(140);

    assert.equal(stalls(h.anomalies).length, 0);
    h.session.close('test');
  });

  test('audio-only output also counts as answering', async () => {
    const h = harness(40);
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'play something' } } });
    sock.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    await settle(140);

    assert.equal(stalls(h.anomalies).length, 0, 'the model speaking is a reply even with no transcript yet');
    h.session.close('test');
  });

  test('a tool call counts as answering — a slow tool is not a stall', async () => {
    const h = harness(40);
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'open youtube' } } });
    sock.serverFrame({ toolCall: { functionCalls: [{ id: 'c1', name: 'open_web', args: {} }] } });
    await settle(140);

    assert.equal(stalls(h.anomalies).length, 0);
    h.session.close('test');
  });

  test('still-arriving speech re-arms rather than fires — the deadline runs from the LAST word', async () => {
    const h = harness(60);
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'what ' } } });
    await settle(40);
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'is ' } } });
    await settle(40);
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'the time' } } });
    // 80ms have passed, well over the 60ms deadline, but the operator was still
    // talking for all of it — a long question is not a stalled turn.
    assert.equal(stalls(h.anomalies).length, 0);

    await settle(140);
    assert.equal(stalls(h.anomalies).length, 1, 'and it fires once they actually stop');
    h.session.close('test');
  });

  test('closing the session cancels a pending watchdog — no anomaly about a turn nobody awaits', async () => {
    const h = harness(40);
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { inputTranscription: { text: 'goodbye' } } });
    h.session.close('client-request');
    await settle(140);

    assert.equal(stalls(h.anomalies).length, 0);
  });
});
