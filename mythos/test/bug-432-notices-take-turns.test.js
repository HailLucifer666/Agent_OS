'use strict';

// test/bug-432-notices-take-turns.test.js — BUG-432.
//
// THE MEASUREMENT, 2026-09-09. Fifteen of thirty-five `live.interrupted` rows
// landed within 300 ms of our own `live.text-injected`, and the boot greeting
// was cut on two boots out of two. Nothing external was interrupting MYTHOS;
// MYTHOS was interrupting itself. `onLiveTurnComplete` reaches
// `sendSystemNotice` from six sites in one synchronous pass — the unheard-input
// correction, the premature-claim and retraction branches, and four
// `reportTurnAudit` calls that fire once per detected row — and each one called
// `liveSession.sendText` straight away. Gemini treats a realtimeInput text frame
// as a new turn, so notice two arrives while the model is still speaking notice
// one. `serializeSpeech` in server/index.js guards only its own two callers and
// never sees this path.
//
// A DEADLOCK THE FIRST DRAFT WOULD HAVE SHIPPED. `turnSystemInitiated` is a term
// in `inFlight`, and it used to be set inside `sendText` BEFORE the frame went
// anywhere — so the very first notice would have been held against a turn that
// notice had itself just claimed to start, released only by the 15s ceiling.
// Test (1) is that case and it is the reason the flag now moves with the frame
// (set in sendNoticeFrame, at the moment one actually goes out) rather than at
// the door. Reading the design could not see it; the idle-session test does.
//
// MUTATION RUN 2026-09-10, each verified applied by grep and restored
// sha256-identical:
//   set turnSystemInitiated in sendText again (the first draft's shape)
//     -> (1) red: the only notice on an idle session is held.
//   drop turnSystemInitiated from inFlight
//     -> (2) red: two synchronous notices both reach the wire, which is the bug.
//   release() draining the whole backlog instead of one item
//     -> (4) red: three notices arrive as one burst a turn later.
//   remove the ceiling timer
//     -> (5) red: a turn that never completes silences a correction forever.
//   [2026-09-23: the ceiling itself is gone — BUG-432's measured pass found it
//   FORCED 4 held notices into live turns. (5) is re-pointed to the idle tick
//   that replaced it: it releases only when nothing is in flight. The current
//   rules and their probes are in test/bug-432-outcome-outbox.test.js.]
//   cancel() draining on a NON-final close too
//     -> (7) red: a rotation would lose the notices it is supposed to carry.
//
// NOT COVERED, DELIBERATELY. Coalescing. Six notices become six turns taken in
// order, never one merged paragraph: merging means deciding which of six honest
// statements to drop or how to fuse them, and getting that wrong turns a true
// report into a summary — the failure the whole turn-audit family exists to
// prevent. Ordering is the half that was measured. [2026-09-23: the next
// sentences are superseded — a held ANSWER is now handed back to the server on a
// final close (createUndeliveredHandler); corrections and notices still are not.]
// Also not wired: routing a
// drained notice to the adapter's speakWhenClosed fallback. It needs a new
// dependency threaded through server/index.js, which is at its own ratchet
// ceiling, so a notice held when the session finally closes is logged
// (`live.notice-undelivered`) rather than spoken in the other voice. With the
// flag off — the default — nothing is held and nothing can be lost.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { createNoticeQueue, createNoticeQueueFromEnv, NOTICE_MAX_AGE_MS } = require('../src/core/voice/notice-queue');

// ---- the pure queue, with hand-driven timers -----------------------------

function queueRig({ inFlight = () => false, sendResult = true, holdMaxMs } = {}) {
  const sent = [];
  const undelivered = [];
  let fire = null;
  const queue = createNoticeQueue({
    inFlight,
    send: (text, meta) => { sent.push({ text, meta }); return sendResult; },
    onUndelivered: (text, meta, reason) => undelivered.push({ text, reason }),
    holdMaxMs,
    setTimer: (fn) => { fire = fn; return 'timer'; },
    clearTimer: () => { fire = null; },
  });
  return { queue, sent, undelivered, expire: () => { if (!fire) throw new Error('no ceiling armed'); const f = fire; fire = null; f(); }, armed: () => fire !== null };
}

describe('BUG-432 — system notices take turns instead of interrupting each other', () => {
  test('(1) a notice on an IDLE session is sent immediately, not held', () => {
    // The deadlock pin. If inFlight can be true because of the notice being
    // offered, the first notice never goes out until the ceiling fires.
    const { queue, sent } = queueRig({ inFlight: () => false });
    assert.equal(queue.offer('first', { site: 'boot-greeting' }), 'sent');
    assert.equal(sent.length, 1);
    assert.equal(queue.size(), 0);
  });

  test('(2) two notices in one synchronous pass: one on the wire, one held', () => {
    // The measured bug. `speaking` goes true the moment the first frame is sent,
    // exactly as turnSystemInitiated does in live-session.
    let speaking = false;
    const { queue, sent } = queueRig({ inFlight: () => speaking });
    const rig = { offer: (t) => queue.offer(t, { site: 'turn-audit' }) };
    assert.equal(rig.offer('correction one'), 'sent');
    speaking = true;
    assert.equal(rig.offer('correction two'), 'queued');
    assert.equal(sent.length, 1, 'the second frame must not reach the wire while the first is being spoken');
    assert.equal(queue.size(), 1);
  });

  test('(3) the operator never waits, even behind a backlog', () => {
    // The operator's words are the input the model is answering. Holding them
    // would hold up the conversation to protect a notice about it.
    const { queue, sent } = queueRig({ inFlight: () => true });
    queue.offer('a notice', { site: 'turn-audit' });
    assert.equal(queue.offer('what time is it', { operator: true }), 'sent');
    assert.deepEqual(sent.map((s) => s.text), ['what time is it']);
    assert.equal(queue.size(), 1, 'the notice stays held');
  });

  test('(4) release sends exactly ONE per turn', () => {
    // Releasing the whole backlog at once would recreate the interruption one
    // turn later, which is the bug wearing a fix's clothes.
    const { queue, sent } = queueRig({ inFlight: () => true });
    for (const text of ['one', 'two', 'three']) queue.offer(text, { site: 'turn-audit' });
    assert.equal(queue.size(), 3);
    assert.equal(queue.release(), true);
    assert.deepEqual(sent.map((s) => s.text), ['one']);
    queue.release();
    assert.deepEqual(sent.map((s) => s.text), ['one', 'two']);
    assert.equal(queue.size(), 1);
    queue.release();
    assert.equal(queue.release(), false, 'an empty queue releases nothing and says so');
  });

  // RE-POINTED 2026-09-23. This test used to pin a 15 s ceiling that released a
  // held notice whether or not the model was speaking. The measured pass showed
  // that ceiling forcing 4 notices into live turns, each cutting a reply off, so
  // it was removed; the timer that remains is an idle tick that never sends into
  // a turn in flight.
  test('(5) a turn that never completes: the held correction is never FORCED in, and goes once nothing is in flight', () => {
    let speaking = true;
    const { queue, sent, expire, armed } = queueRig({ inFlight: () => speaking });
    queue.offer('correction', { site: 'ad4-correction-retract' });
    assert.ok(armed(), 'holding arms the idle tick');
    expire();
    assert.deepEqual(sent, [], 'the model is still speaking, so nothing is sent into its turn');
    speaking = false;
    expire();
    assert.deepEqual(sent.map((s) => s.text), ['correction'], 'the turn ended without a turnComplete reaching us; the tick still delivers');
    assert.equal(NOTICE_MAX_AGE_MS, 60000, 'the documented notice age and the code agree');
  });

  test('(6) the ceiling is disarmed when the queue empties, and not left to fire on nothing', () => {
    const { queue, armed } = queueRig({ inFlight: () => true });
    queue.offer('correction', { site: 'turn-audit' });
    assert.ok(armed());
    queue.release();
    assert.equal(armed(), false, 'an empty queue holds no timer');
  });

  test('(7) a FINAL close hands held notices back; a rotation keeps them', () => {
    const { queue, undelivered } = queueRig({ inFlight: () => true });
    queue.offer('kept', { site: 'turn-audit' });
    assert.equal(queue.cancel({ final: false }), 0, 'a rotation is the same session on a new socket');
    assert.equal(queue.size(), 1);
    assert.equal(queue.cancel({ final: true }), 1);
    assert.equal(queue.size(), 0);
    assert.deepEqual(undelivered.map((u) => [u.text, u.reason]), [['kept', 'session-closed']]);
  });

  test('(8) a refused send is not silently swallowed', () => {
    // Three outcomes, three values (class 15). A boolean here would make "held"
    // and "the socket refused it" indistinguishable to sendSystemNotice.
    const { queue } = queueRig({ inFlight: () => false, sendResult: false });
    assert.equal(queue.offer('notice', { site: 'turn-audit' }), false);
  });

  test('(9) the queue refuses to be constructed without the two things it cannot guess', () => {
    assert.throws(() => createNoticeQueue({ send: () => true }), /inFlight/);
    assert.throws(() => createNoticeQueue({ inFlight: () => false }), /send/);
  });

  test('(10) the flag is off by default, and only the word true turns it on', () => {
    const prev = process.env.VOICE_SERIALIZE_NOTICES;
    try {
      delete process.env.VOICE_SERIALIZE_NOTICES;
      assert.equal(createNoticeQueueFromEnv({ inFlight: () => false, send: () => true }), null);
      process.env.VOICE_SERIALIZE_NOTICES = '1';
      assert.equal(createNoticeQueueFromEnv({ inFlight: () => false, send: () => true }), null,
        'a truthy value is not the word true — a kill switch must be unambiguous');
      process.env.VOICE_SERIALIZE_NOTICES = 'TRUE';
      assert.ok(createNoticeQueueFromEnv({ inFlight: () => false, send: () => true }));
    } finally {
      if (prev === undefined) delete process.env.VOICE_SERIALIZE_NOTICES; else process.env.VOICE_SERIALIZE_NOTICES = prev;
    }
  });
});

// ---- the real session, on a fake socket ----------------------------------

function sessionRig() {
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.readyState = 0;
  const wire = [];
  socket.send = (json) => { wire.push(JSON.parse(json)); };
  socket.close = () => { socket.readyState = 3; socket.emit('close', 1000, 'done'); };
  const session = createLiveSession({
    config: {}, logger: { info() {}, warn() {}, error() {} },
    createSocket: () => socket, systemInstruction: 'test', functionDeclarations: [],
  });
  const frame = (serverContent) => socket.emit('message', Buffer.from(JSON.stringify({ serverContent })));
  const texts = () => wire.filter((f) => f.realtimeInput && typeof f.realtimeInput.text === 'string')
    .map((f) => f.realtimeInput.text);
  return { session, socket, frame, texts };
}

async function openSession(rig) {
  const opening = rig.session.open();
  rig.socket.readyState = 1;
  rig.socket.emit('open');
  rig.socket.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  await opening;
}

function withEnv(value, fn) {
  return async () => {
    const prevFlag = process.env.VOICE_SERIALIZE_NOTICES;
    const prevKey = process.env.GOOGLE_API_KEY;
    if (value === undefined) delete process.env.VOICE_SERIALIZE_NOTICES; else process.env.VOICE_SERIALIZE_NOTICES = value;
    process.env.GOOGLE_API_KEY = 'test-key-bug-432';
    try { await fn(); } finally {
      if (prevFlag === undefined) delete process.env.VOICE_SERIALIZE_NOTICES; else process.env.VOICE_SERIALIZE_NOTICES = prevFlag;
      if (prevKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevKey;
    }
  };
}

describe('BUG-432 — live-session honours the queue, and is unchanged without it', () => {
  test('with the flag ON: the second of two synchronous notices is held, then released by turnComplete',
    withEnv('true', async () => {
      const rig = sessionRig();
      await openSession(rig);
      assert.equal(rig.session.sendText('first notice', { site: 'turn-audit' }), 'sent');
      assert.equal(rig.session.sendText('second notice', { site: 'turn-audit' }), 'queued',
        'the first notice set turnSystemInitiated, so the second waits');
      assert.deepEqual(rig.texts(), ['first notice']);
      rig.frame({ outputTranscription: { text: 'Understood.' } });
      rig.frame({ turnComplete: true });
      assert.deepEqual(rig.texts(), ['first notice', 'second notice'], 'the held notice goes when the turn ends');
      rig.session.close();
    }));

  test('with the flag OFF: both frames go out immediately, exactly as before this change',
    withEnv(undefined, async () => {
      const rig = sessionRig();
      await openSession(rig);
      assert.equal(rig.session.sendText('first notice', { site: 'turn-audit' }), true,
        'the old boolean contract survives with the queue off');
      assert.equal(rig.session.sendText('second notice', { site: 'turn-audit' }), true);
      assert.deepEqual(rig.texts(), ['first notice', 'second notice']);
      rig.session.close();
    }));

  test('operator text still bypasses a backlog through the real session',
    withEnv('true', async () => {
      const rig = sessionRig();
      await openSession(rig);
      rig.session.sendText('a notice', { site: 'turn-audit' });
      rig.session.sendText('a second notice', { site: 'turn-audit' });
      assert.equal(rig.session.sendText('what time is it', { site: 'operator-typed', operator: true }), 'sent');
      assert.deepEqual(rig.texts(), ['a notice', 'what time is it']);
      rig.session.close();
    }));

  test('a closed session still refuses, and the queue never sees it',
    withEnv('true', async () => {
      const rig = sessionRig();
      await openSession(rig);
      rig.session.close();
      assert.equal(rig.session.sendText('too late', { site: 'turn-audit' }), false);
    }));
});
