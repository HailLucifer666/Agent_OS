'use strict';

// test/bug-124-live-turn-id.test.js — BUG-124, instrumentation only.
//
// The report is transcripts pairing the wrong user text with the wrong reply,
// plus occasional empty replies. live-session.js's accumulation is per the
// module invariant — every serverContent field handled with independent ifs, no
// else-if — so nothing on this side reorders fragments, which points upstream at
// Gemini's own frame ordering. But "points upstream" is a hypothesis, and NO
// pairing fix belongs in the code until a raw-frame log from a repro session
// says which side reordered what.
//
// What was actually missing is a join key. A live-turn-no-transcript anomaly and
// an episodic conversation record could not be tied to the same turn — two
// records a few hundred milliseconds apart cannot be ordered by eye — so every
// misalignment report was unfalsifiable. This adds a monotonic per-session
// turnId to the turn, to the anomalies this module raises, and to the episodic
// write. Nothing about pairing behaviour changes.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');

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

function harness() {
  const turns = [];
  const anomalies = [];
  const sockets = [];
  const session = createLiveSession({
    config: {},
    bus: { emit: (type, payload) => { if (type === 'health.anomaly') anomalies.push(payload); } },
    logger: { warn() {}, info() {} },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut: () => {},
    onTranscript: () => {},
    onState: () => {},
    onTurnComplete: (t) => turns.push(t),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  return { session, sockets, turns, anomalies };
}

async function openIt(session, sockets) {
  process.env.GOOGLE_API_KEY = 'test-key';
  const openPromise = session.open();
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  await openPromise;
}

describe('BUG-124 — every Live turn is identifiable', () => {
  test('turnId increments monotonically from 1', async () => {
    const { session, sockets, turns } = harness();
    await openIt(session, sockets);

    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'a' }, turnComplete: true } });
    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'b' }, turnComplete: true } });

    assert.deepEqual(turns.map((t) => t.turnId), [1, 2]);
    session.close();
  });

  test('a no-transcript anomaly names the turn it happened on', async () => {
    const { session, sockets, anomalies } = harness();
    await openIt(session, sockets);

    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'hello' }, turnComplete: true } });
    sockets[0].serverFrame({ serverContent: { turnComplete: true } }); // the blind turn

    const blind = anomalies.find((a) => a.kind === 'live-turn-no-transcript');
    assert.ok(blind, 'AD-6: a completed turn with no transcript must still be flagged');
    assert.equal(blind.turnId, 2,
      'without this the anomaly could not be joined to the episodic record for the same turn');

    session.close();
  });

  test('the episodic record carries the same turn number, not just a timestamp', async () => {
    const writes = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0 }), confirm: { create: () => 'c' } },
      dispatchAction: async () => ({ ok: true, result: {} }),
      bus: { emit() {} },
      logger: { warn() {}, info() {} },
      connectionId: 'conn-124',
      memory: { working: { tick: 1 }, episodic: { write: async (r) => { writes.push(r); } } },
      historyAppend: () => {},
      reflection: null,
      summarizeActionsForResult: () => null,
      getLiveSession: () => null,
    });

    adapter.onLiveTurnComplete({ userText: 'hi', assistantText: 'hello', turnId: 7 });

    assert.equal(writes[0].detail.turnId, 'live-turn-7',
      'the join key must reach the record, or the anomaly still cannot be correlated');
  });

  test('a caller with no turnId still gets a record — the timestamp fallback stays', () => {
    const writes = [];
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 0 }), confirm: { create: () => 'c' } },
      dispatchAction: async () => ({ ok: true, result: {} }),
      bus: { emit() {} },
      logger: { warn() {}, info() {} },
      connectionId: 'conn-124',
      memory: { working: { tick: 1 }, episodic: { write: async (r) => { writes.push(r); } } },
      historyAppend: () => {},
      reflection: null,
      summarizeActionsForResult: () => null,
      getLiveSession: () => null,
    });

    adapter.onLiveTurnComplete({ userText: 'hi', assistantText: 'hello' });

    assert.match(writes[0].detail.turnId, /^live-\d+$/, 'no turnId must not mean no record');
  });

  test('turn pairing itself is UNCHANGED — this commit adds a key, it does not fix alignment', async () => {
    // Pinned deliberately. A pairing "fix" without a raw-frame log would be a
    // guess dressed as a repair; if someone later changes accumulation, this
    // fails and forces the evidence to exist first.
    const { session, sockets, turns } = harness();
    await openIt(session, sockets);

    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'what is ' } } });
    sockets[0].serverFrame({ serverContent: { inputTranscription: { text: 'the time' } } });
    sockets[0].serverFrame({ serverContent: { outputTranscription: { text: 'It is noon.' }, turnComplete: true } });

    assert.deepEqual(turns[0], { userText: 'what is the time', assistantText: 'It is noon.', turnId: 1 });
    session.close();
  });
});
