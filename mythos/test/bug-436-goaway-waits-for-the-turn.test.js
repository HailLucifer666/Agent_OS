'use strict';

// test/bug-436-goaway-waits-for-the-turn.test.js — BUG-436, the goAway half.
//
// THE TICKET SAID the 09:47:42Z goAway "closed the session while screen_read_text
// was in flight" and "the tool result had no session to return to". The log
// says otherwise: screen_read_text returned ok at 09:47:39.948 (836 ms), the
// toolResponse went back on the open socket, and the model was already SPEAKING
// its answer (own-voice hold at :41.183) when goAway arrived at :42.508. What
// killed the turn was our own close('goaway') on the same tick — with 50 s of
// grace unused. After the ~2 s reconnect nothing re-prompted the model, and
// MYTHOS said nothing until the operator spoke at :59. The re-delivery the
// ticket proposed would have re-sent a result that had already arrived.
//
// THE FIX (src/core/voice/goaway-gate.js): a goAway that lands mid-turn holds
// the non-final close until turnComplete, or until timeLeft minus a margin,
// whichever first. A goAway with nothing in flight closes at once, as before.
//
// MUTATION RUN 2026-09-10, before trusting this file. Restoring the old branch
// (`if (msg.goAway) close('goaway', { final: false })`) fails test (1) with
// "socket must still be OPEN after goAway mid-turn (got 3)" and test (3) with
// the same; test (2) — nothing in flight — passes either way, which is the
// adjacent case pinned so the fix cannot widen into deferring every rotation.
// A second probe, making isTurnInFlight() always true, fails test (2) with
// "a goAway with nothing in flight must close immediately".
//
// Branch traversed: the deferred branch of goAwayGate.arrive() (tests 1, 3, 4),
// the immediate branch (test 2), fire('turn-complete') (test 1),
// fire('hold-expired') (test 3), and cancel() from close() (test 4).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { createGoAwayGate, parseTimeLeft, GOAWAY_CLOSE_MARGIN_MS } = require('../src/core/voice/goaway-gate');

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

function harness(overrides) {
  process.env.GOOGLE_API_KEY = 'test-key';
  const sockets = [];
  const logs = [];
  const deps = Object.assign({
    config: {},
    bus: { emit() {} },
    logger: { warn(event, f) { logs.push({ event, f }); }, info(event, f) { logs.push({ event, f }); } },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut() {}, onTranscript() {}, onState() {}, onTurnComplete() {},
    onToolCall() {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  }, overrides || {});
  const session = createLiveSession(deps);
  return { session, sockets, logs };
}

async function openSession(session, sockets, index) {
  const p = session.open();
  const s = sockets[index];
  s.simulateOpen();
  s.serverFrame({ setupComplete: {} });
  await p;
  return s;
}

const TOOL_CALL = { toolCall: { functionCalls: [{ id: 'fc_1', name: 'screen_read_text', args: {} }] } };
const AUDIO_PART = { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } }] } } };
const TURN_COMPLETE = { serverContent: { turnComplete: true } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('BUG-436 — goAway waits for the turn in flight', () => {
  test('(1) a goAway mid-reply holds the socket open until turnComplete, then rotates', async () => {
    const { session, sockets, logs } = harness();
    const s0 = await openSession(session, sockets, 0);
    s0.serverFrame(TOOL_CALL);                 // the model is waiting on our toolResponse
    s0.serverFrame(AUDIO_PART);                // ...and then speaking its answer
    s0.serverFrame({ goAway: { timeLeft: '50s' } });
    assert.equal(s0.readyState, s0.OPEN, `socket must still be OPEN after goAway mid-turn (got ${s0.readyState})`);
    assert.equal(session.getState(), 'open');
    assert.equal(sockets.length, 1, 'no reconnect may start while the turn is still streaming');
    const deferred = logs.find((l) => l.event === 'live.goaway');
    assert.equal(deferred && deferred.f.deferred, true, 'the log must say the close was deferred');

    s0.serverFrame(TURN_COMPLETE);             // the reply landed — now rotate
    assert.equal(s0.readyState, s0.CLOSED, 'turnComplete must release the held close');
    assert.equal(sockets.length, 2, 'the held close must reconnect exactly as an immediate one does');
    const closed = logs.find((l) => l.event === 'live.goaway-close');
    assert.equal(closed && closed.f.why, 'turn-complete');
  });

  test('(2) adjacent, unchanged: a goAway with nothing in flight closes immediately', async () => {
    const { session, sockets, logs } = harness();
    const s0 = await openSession(session, sockets, 0);
    s0.serverFrame({ goAway: { timeLeft: '50s' } });
    assert.equal(s0.readyState, s0.CLOSED, 'a goAway with nothing in flight must close immediately');
    assert.equal(sockets.length, 2, 'and reconnect at once');
    const row = logs.find((l) => l.event === 'live.goaway');
    assert.equal(row.f.deferred, false);
    assert.equal(row.f.reason, 'no-turn-in-flight');
  });

  test('(3) the hold expires on its own when turnComplete never comes', async () => {
    const { session, sockets, logs } = harness();
    const s0 = await openSession(session, sockets, 0);
    s0.serverFrame(TOOL_CALL);
    // margin is 2000 ms, so 2.05 s of grace is a 50 ms hold.
    s0.serverFrame({ goAway: { timeLeft: '2.05s' } });
    assert.equal(s0.readyState, s0.OPEN, `socket must still be OPEN after goAway mid-turn (got ${s0.readyState})`);
    await sleep(150);
    assert.equal(s0.readyState, s0.CLOSED, 'the hold must not outlive timeLeft');
    assert.equal(sockets.length, 2);
    const closed = logs.find((l) => l.event === 'live.goaway-close');
    assert.equal(closed && closed.f.why, 'hold-expired');
  });

  test('(4) a final close during a hold disarms it — the replacement session is never closed by a stale hold', async () => {
    const { session, sockets } = harness();
    const s0 = await openSession(session, sockets, 0);
    s0.serverFrame(TOOL_CALL);
    s0.serverFrame({ goAway: { timeLeft: '2.05s' } });
    session.close('client-request');           // final
    assert.equal(session.getState(), 'closed');
    await sleep(150);
    // A live hold timer would have called close('goaway', {final:false}) here,
    // which on a closed session still logs and still flips state via setState
    // in the non-final path's ws handler. Nothing must have happened at all.
    assert.equal(sockets.length, 1, 'no reconnect may follow a final close');
    assert.equal(session.getState(), 'closed');
  });
});

describe('goaway-gate — the pure decision', () => {
  test('parseTimeLeft reads the Duration JSON form and refuses anything else', () => {
    assert.equal(parseTimeLeft('50s'), 50000);
    assert.equal(parseTimeLeft('0.5s'), 500);
    assert.equal(parseTimeLeft(' 2.05s '), 2050);
    assert.equal(parseTimeLeft(3), 3000);
    assert.equal(parseTimeLeft('50'), null);
    assert.equal(parseTimeLeft('50ms'), null);
    assert.equal(parseTimeLeft(''), null);
    assert.equal(parseTimeLeft(undefined), null);
    assert.equal(parseTimeLeft(null), null);
    assert.equal(parseTimeLeft(-1), null);
  });

  function fakeTimers() {
    const scheduled = [];
    const cleared = [];
    return {
      scheduled, cleared,
      setTimer: (fn, ms) => { const h = { fn, ms }; scheduled.push(h); return h; },
      clearTimer: (h) => cleared.push(h),
    };
  }

  test('in flight: schedules timeLeft minus the margin, and turnComplete closes once', () => {
    const t = fakeTimers();
    const closes = [];
    const gate = createGoAwayGate({ closeNow: (r) => closes.push(r), isTurnInFlight: () => true,
      logger: { info() {} }, setTimer: t.setTimer, clearTimer: t.clearTimer });
    assert.equal(gate.arrive('50s'), true);
    assert.equal(t.scheduled.length, 1);
    assert.equal(t.scheduled[0].ms, 50000 - GOAWAY_CLOSE_MARGIN_MS);
    assert.equal(gate.isHolding(), true);
    assert.deepEqual(closes, []);
    assert.equal(gate.turnComplete(), true);
    assert.deepEqual(closes, ['goaway']);
    assert.equal(gate.isHolding(), false);
    assert.equal(t.cleared.length, 1, 'the hold timer must be cleared, not left to fire a second close');
    assert.equal(gate.turnComplete(), false, 'a second turnComplete is a no-op');
  });

  test('not in flight, or unparseable timeLeft: closes now and schedules nothing', () => {
    for (const [inFlight, timeLeft, reason] of [[false, '50s', 'no-turn-in-flight'], [true, 'soon', 'unparseable-time-left']]) {
      const t = fakeTimers();
      const closes = [];
      const rows = [];
      const gate = createGoAwayGate({ closeNow: (r) => closes.push(r), isTurnInFlight: () => inFlight,
        logger: { info: (e, f) => rows.push({ e, f }) }, setTimer: t.setTimer, clearTimer: t.clearTimer });
      assert.equal(gate.arrive(timeLeft), false);
      assert.deepEqual(closes, ['goaway']);
      assert.equal(t.scheduled.length, 0);
      assert.equal(rows[0].f.reason, reason);
    }
  });

  test('the hold firing closes once; cancel() disarms without closing', () => {
    const t = fakeTimers();
    const closes = [];
    const gate = createGoAwayGate({ closeNow: (r) => closes.push(r), isTurnInFlight: () => true,
      logger: { info() {} }, setTimer: t.setTimer, clearTimer: t.clearTimer });
    gate.arrive('10s');
    t.scheduled[0].fn();
    assert.deepEqual(closes, ['goaway']);
    assert.equal(gate.isHolding(), false);

    gate.arrive('10s');
    gate.cancel();
    assert.equal(gate.isHolding(), false);
    assert.equal(t.cleared.length, 1);
    assert.deepEqual(closes, ['goaway'], 'cancel must not close');
  });
});
