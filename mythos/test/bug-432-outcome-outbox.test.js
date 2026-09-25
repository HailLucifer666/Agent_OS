'use strict';

// test/bug-432-outcome-outbox.test.js — BUG-432's measured pass and BUG-436's
// delivery half, 2026-09-23.
//
// THE MEASURED PASS (attended, VOICE_SERIALIZE_NOTICES=true, 51 turns). The queue
// stopped notices cutting EACH OTHER off — and then:
//   * it HELD THE ANSWER. A web_search result carrying "Price starts at ₹52,542 in
//     India" sat queued behind heal announcements for the full 15 s while the
//     reply in progress told the operator "I haven't found a current Indian price";
//   * its 15 s ceiling turned "wait" into "interrupt": 4 held notices were FORCED
//     into live turns, each cutting a reply off.
// BUG-436's delivery half: sendText() refused every frame while the socket was
// RECONNECTING, before the queue ever saw it, and the adapter's sendSystemNotice
// checked isOpen() — so a tool result that finished during a rotation was spoken
// by plain TTS outside Live, and the resumed session never learned it happened.
//
// THE RULES NOW (src/core/voice/notice-queue.js):
//   outcome     the answer to the operator's own request (late-outcome,
//               late-for-turn, confirm-resolved, …). Never held behind notices:
//               sent the moment the transport is ready — unless another answer's
//               turn is still being spoken, since two answers back-to-back would
//               cut each other off; then it waits at the FRONT. Held only while the
//               transport is down, then delivered first on resume, ONCE — a
//               receipt (any server frame after the send, on that socket) marks it
//               delivered; one sent and never receipted before a drop is replayed.
//   correction  ad4-*, turn-audit lines. Waits for the turn to end; never expires.
//   notice      everything else (proactive speech). Waits for the turn to end; if
//               it has waited NOTICE_MAX_AGE_MS it is DROPPED, with evidence.
//   NOTHING is ever forced into a turn in flight: the ceiling that used to do
//   that now releases only when nothing is being said.
//
// RED FIRST, 2026-09-23, against 9db9b967 — 12 of the first 13 tests failed, each
// for the reason named: (q1) "the answer to the operator's question was held
// behind a notice"; (q2) "the ceiling forced a notice into a turn in flight";
// (q3) "a correction was released into a live turn"; (q5) the answer did not go
// first; (q6)/(q7) no ack() existed at all; (q8) no class was handed back; (c1)
// no SITE_CLASSES; (s1) "a rotating session must accept the answer"; (s2) no
// acceptsNotices(); (a1) the answer was treated as "no open live session". (q4)
// and (a2) are the adjacent cases and passed on the old code, as they must.
// (q1b)(h1)(h2)(s3)(s4)(w1) were written after the fix and proved by the
// mutations below instead.
//
// MUTATIONS, 2026-09-23: table at the bottom of this file.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const nq = () => require('../src/core/voice/notice-queue');

function rig({ inFlight = () => false, sendResult = true } = {}) {
  const sent = [];
  const undelivered = [];
  const logs = [];
  let t = 1_000_000;
  let fire = null;
  const queue = nq().createNoticeQueue({
    inFlight,
    send: (text, meta) => { sent.push({ text, meta }); return typeof sendResult === 'function' ? sendResult() : sendResult; },
    onUndelivered: (text, meta, reason, cls) => undelivered.push({ text, reason, cls }),
    setTimer: (fn) => { fire = fn; return 'timer'; },
    clearTimer: () => { fire = null; },
    now: () => t,
    logger: { info: (msg, f) => logs.push({ msg, ...f }), warn: (msg, f) => logs.push({ msg, ...f }) },
  });
  return {
    queue, sent, undelivered, logs,
    advance: (ms) => { t += ms; },
    fire: () => { if (!fire) return false; const f = fire; fire = null; f(); return true; },
  };
}

describe('BUG-432 — the answer is never held behind a notice', () => {
  test('(q1) THE ₹52,542 CASE: an outcome arriving mid-turn goes out NOW', () => {
    const r = rig({ inFlight: () => true });
    r.queue.offer('a heal announcement', { site: 'proactive-speak' });
    const res = r.queue.offer('web_search finished. Result: Price starts at ₹52,542 in India', { site: 'late-outcome', tool: 'web_search', receiptKey: 'call-1' });
    assert.equal(res, 'sent', 'the answer to the operator\'s question was held behind a notice');
    assert.deepEqual(r.sent.map((s) => s.meta.site), ['late-outcome']);
    assert.equal(r.queue.size(), 1, 'the notice is still the one waiting');
  });

  test('(q2) a notice is NEVER forced into a live turn: it waits, then is dropped at NOTICE_MAX_AGE_MS, with evidence', () => {
    const r = rig({ inFlight: () => true });
    r.queue.offer('Self-healed: …', { site: 'proactive-speak' });
    for (let i = 0; i < 80; i++) { r.advance(1000); r.fire(); }
    assert.deepEqual(r.sent, [], 'the ceiling forced a notice into a turn in flight');
    assert.equal(r.queue.size(), 0, 'after its max age the notice is gone');
    const dropped = r.logs.find((l) => l.msg === 'live.notice-expired');
    assert.ok(dropped && dropped.dropped === true && dropped.site === 'proactive-speak' && dropped.ageMs >= nq().NOTICE_MAX_AGE_MS,
      'the drop is recorded with its site and age: ' + JSON.stringify(dropped));
  });

  test('(q3) a CORRECTION never expires and is never forced in: it goes at the next turn end, however late', () => {
    let speaking = true;
    const r = rig({ inFlight: () => speaking });
    r.queue.offer('Correction: that did not happen.', { site: 'ad4-correction-retract' });
    for (let i = 0; i < 600; i++) { r.advance(1000); r.fire(); }
    assert.deepEqual(r.sent, [], 'a correction was released into a live turn');
    assert.equal(r.queue.size(), 1, 'ten minutes later it is still held — corrections do not expire');
    speaking = false;
    r.queue.release({});
    assert.deepEqual(r.sent.map((s) => s.meta.site), ['ad4-correction-retract']);
  });

  test("(q1b) two ANSWERS take turns with each other: the second waits for the first's turn, then goes ahead of older notices", () => {
    const r = rig({ inFlight: () => true });
    r.queue.offer('a heal announcement', { site: 'proactive-speak' });
    assert.equal(r.queue.offer('answer one', { site: 'late-outcome', receiptKey: 'k1' }), 'sent');
    assert.equal(r.queue.offer('answer two', { site: 'confirm-resolved', receiptKey: 'k2' }), 'queued',
      'sent at once it would cut answer one off mid-sentence — the BUG-432 shape, between answers');
    r.queue.release({});
    assert.deepEqual(r.sent.map((x) => x.text), ['answer one', 'answer two'], 'at the turn end the waiting ANSWER goes, not the older notice');
    r.queue.release({});
    assert.deepEqual(r.sent.map((x) => x.text), ['answer one', 'answer two', 'a heal announcement']);
  });

  test('(q4) ADJACENT: with nothing in flight, an ordinary notice still goes out at once, and the operator never waits', () => {
    const r = rig({ inFlight: () => false });
    assert.equal(r.queue.offer('hello', { site: 'proactive-speak' }), 'sent');
    const busy = rig({ inFlight: () => true });
    busy.queue.offer('a notice', { site: 'proactive-speak' });
    assert.equal(busy.queue.offer('what time is it', { operator: true }), 'sent');
  });
});

describe('BUG-436 — an outcome that finishes during a rotation reaches the new socket, once', () => {
  test('(q5) held while suspended; delivered FIRST on resume, ahead of older notices', () => {
    const r = rig({ inFlight: () => false });
    r.queue.suspend('reconnecting');
    r.queue.offer('an older notice', { site: 'proactive-speak' });
    assert.equal(r.queue.offer('think_deeply finished. Result: …', { site: 'late-outcome', receiptKey: 'call-7' }), 'queued');
    r.queue.resume({ generation: 2 });
    assert.equal(r.sent[0] && r.sent[0].meta.site, 'late-outcome', 'the answer goes first');
  });

  test('(q6) RECEIPTS: sent and receipted is never replayed; sent and NOT receipted before a drop is replayed once', () => {
    const r = rig({ inFlight: () => false });
    r.queue.resume({ generation: 1 });
    r.queue.offer('outcome A', { site: 'late-outcome', receiptKey: 'call-A' });
    r.queue.ack({ generation: 1 });                      // a server frame arrived after it: delivered
    r.queue.release({ generation: 1 });                  // and A's turn ended, so B need not wait for it
    r.queue.offer('outcome B', { site: 'late-outcome', receiptKey: 'call-B' });
    r.queue.suspend('reconnecting');                     // socket died before any frame after B
    r.queue.resume({ generation: 2 });
    assert.deepEqual(r.sent.map((s) => s.text), ['outcome A', 'outcome B', 'outcome B'],
      'B had no receipt, so it is replayed on the new socket; A had one, so it is not');
    r.queue.ack({ generation: 2 });
    r.queue.suspend('reconnecting');
    r.queue.resume({ generation: 3 });
    assert.equal(r.sent.length, 3, 'once receipted, never again');
  });

  test('(q7) a DUPLICATE offer of an outcome already delivered is refused, and says so', () => {
    const r = rig({ inFlight: () => false });
    r.queue.resume({ generation: 1 });
    r.queue.offer('outcome', { site: 'late-outcome', receiptKey: 'call-9' });
    r.queue.ack({ generation: 1 });
    assert.equal(r.queue.offer('outcome', { site: 'late-outcome', receiptKey: 'call-9' }), 'duplicate');
    assert.equal(r.sent.length, 1);
  });

  test('(q8) a FINAL close hands a held outcome back as an OUTCOME — and nothing is replayed after', () => {
    const r = rig({ inFlight: () => false });
    r.queue.suspend('reconnecting');
    r.queue.offer('outcome', { site: 'late-outcome', receiptKey: 'call-3' });
    r.queue.cancel({ final: true });
    assert.deepEqual(r.undelivered.map((u) => u.cls), ['outcome']);
    r.queue.resume({ generation: 9 });
    assert.equal(r.sent.length, 0, 'a stale result must never be spoken into a later conversation');
  });
});

describe('BUG-436 — a FINAL close hands an answer back, and only an answer', () => {
  test('(h1) an outcome goes into the history, and its spoken form over TTS; a correction or notice does neither', async () => {
    const history = []; const spoken = [];
    const handler = nq().createUndeliveredHandler({ historyAppend: (role, text) => history.push({ role, text }),
      speak: async (t) => { spoken.push(t); }, logger: { warn() {} } });
    assert.equal(handler('[SYSTEM] web_search finished.', { site: 'late-outcome', speech: 'The price is ₹52,542.' }, 'session-closed', 'outcome'), true);
    assert.equal(handler('[SYSTEM] CORRECTION …', { site: 'ad4-correction-retract', speech: 'x' }, 'session-closed', 'correction'), false);
    assert.equal(handler('[SYSTEM] Self-healed …', { site: 'proactive-speak', speech: 'y' }, 'session-closed', 'notice'), false);
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(history, [{ role: 'system', text: '[SYSTEM] web_search finished.' }], 'the next session must know the answer arrived');
    assert.deepEqual(spoken, ['The price is ₹52,542.']);
  });

  test('(h2) ADJACENT: an outcome with no spoken form is recorded but not spoken, and a failing speaker is logged, not thrown', async () => {
    const warns = []; const history = [];
    const handler = nq().createUndeliveredHandler({ historyAppend: (r, t) => history.push(t),
      speak: async () => { throw new Error('tts down'); }, logger: { warn: (m, fields) => warns.push({ m, ...fields }) } });
    handler('quick result', { site: 'late-outcome' }, 'session-closed', 'outcome');
    handler('slow result', { site: 'late-outcome', speech: 'It finished.' }, 'session-closed', 'outcome');
    await new Promise((res) => setImmediate(res)); await new Promise((res) => setImmediate(res));
    assert.equal(history.length, 2);
    assert.ok(warns.some((w) => w.m === 'live.outcome-handback-failed' && w.step === 'speech'), JSON.stringify(warns));
  });
});

describe('BUG-432 — every notice site is classed, so a new one cannot default silently', () => {
  test('(c1) every site: literal in src/ and server/ has an explicit class', () => {
    const root = path.join(__dirname, '..');
    const sites = new Set();
    for (const dir of ['src/core/voice', 'server']) {
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!e.name.endsWith('.js')) continue;
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/site: *'([a-z0-9-]+)'/g)) sites.add(m[1]);
        }
      })(path.join(root, dir));
    }
    const { SITE_CLASSES } = nq();
    const unclassed = [...sites].filter((s) => !(s in SITE_CLASSES));
    assert.deepEqual(unclassed, [], 'a notice site with no class would be treated as a droppable notice');
    assert.equal(SITE_CLASSES['late-outcome'], 'outcome');
    assert.equal(SITE_CLASSES['ad4-correction-retract'], 'correction');
    assert.equal(SITE_CLASSES['proactive-speak'], 'notice');
  });
});

// ---- the real session on a fake socket, and the real adapter ----------------

const { createLiveSession } = require('../src/core/voice/live-session');

function sessionRig() {
  const sockets = [];
  const make = () => {
    const socket = new EventEmitter();
    socket.OPEN = 1; socket.readyState = 0; socket.wire = [];
    socket.send = (json) => { socket.wire.push(JSON.parse(json)); };
    socket.close = () => { socket.readyState = 3; socket.emit('close', 1000, 'done'); };
    sockets.push(socket);
    return socket;
  };
  const session = createLiveSession({ config: {}, logger: { info() {}, warn() {}, error() {} },
    createSocket: make, systemInstruction: 'test', functionDeclarations: [] });
  const texts = (s) => s.wire.filter((f) => f.realtimeInput && typeof f.realtimeInput.text === 'string').map((f) => f.realtimeInput.text);
  return { session, sockets, texts };
}
async function openFirst(r) {
  const opening = r.session.open();
  const s = r.sockets[0]; s.readyState = 1; s.emit('open'); s.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
  await opening;
}
function withQueue(fn) {
  return async () => {
    const prev = process.env.VOICE_SERIALIZE_NOTICES; const key = process.env.GOOGLE_API_KEY;
    process.env.VOICE_SERIALIZE_NOTICES = 'true'; process.env.GOOGLE_API_KEY = 'test-key-bug-432';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.VOICE_SERIALIZE_NOTICES; else process.env.VOICE_SERIALIZE_NOTICES = prev;
      if (key === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = key;
    }
  };
}

function withKeyOnly(fn) {
  return async () => {
    const prev = process.env.VOICE_SERIALIZE_NOTICES; const key = process.env.GOOGLE_API_KEY;
    delete process.env.VOICE_SERIALIZE_NOTICES; process.env.GOOGLE_API_KEY = 'test-key-bug-432';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.VOICE_SERIALIZE_NOTICES; else process.env.VOICE_SERIALIZE_NOTICES = prev;
      if (key === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = key;
    }
  };
}

describe('BUG-436 — through the real session: a result finishing mid-rotation is not lost', () => {
  test('(s1) while RECONNECTING, an outcome is queued (not refused) and reaches the replacement socket', withQueue(async () => {
    const r = sessionRig();
    await openFirst(r);
    r.sockets[0].readyState = 3; r.sockets[0].emit('close', 1011, 'goaway');  // unsolicited drop -> reconnecting
    await new Promise((res) => setImmediate(res));
    assert.equal(r.session.acceptsNotices && r.session.acceptsNotices(), true, 'a rotating session must accept the answer for its replacement');
    const res = r.session.sendText('late outcome: price found', { site: 'late-outcome', receiptKey: 'call-s1' });
    assert.equal(res, 'queued', 'sendText refused the answer because the socket was reconnecting');
    const next = r.sockets[1];
    assert.ok(next, 'fixture check: the session reconnected');
    next.readyState = 1; next.emit('open'); next.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    await new Promise((res2) => setImmediate(res2));
    assert.deepEqual(r.texts(next), ['late outcome: price found']);
    r.session.close();
  }));

  test('(s2) ADJACENT: a CLOSED session still refuses, and with the flag off a rotating one does too (old contract)', withKeyOnly(async () => {
    const r = sessionRig();
    await openFirst(r);
    r.sockets[0].readyState = 3; r.sockets[0].emit('close', 1011, 'drop');
    await new Promise((res) => setImmediate(res));
    assert.equal(r.session.acceptsNotices(), false, 'with the queue OFF nothing is held for a replacement');
    r.session.close();
    assert.equal(r.session.sendText('too late', { site: 'late-outcome' }), false);
  }));
});

describe('BUG-436 — receipts through the real session', () => {
  test('(s3) an answer flushed on setupComplete is NOT receipted by that same frame: a drop before any later frame replays it', withQueue(async () => {
    const r = sessionRig();
    await openFirst(r);
    r.sockets[0].readyState = 3; r.sockets[0].emit('close', 1011, 'goaway');
    await new Promise((res) => setImmediate(res));
    r.session.sendText('the answer', { site: 'late-outcome', receiptKey: 'call-s3' });
    const second = r.sockets[1];
    second.readyState = 1; second.emit('open'); second.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    assert.deepEqual(r.texts(second), ['the answer'], 'fixture check: delivered on the replacement');
    second.readyState = 3; second.emit('close', 1011, 'drop');     // dies before ANY frame after the send
    await new Promise((res) => setImmediate(res));
    const third = r.sockets[2];
    third.readyState = 1; third.emit('open'); third.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    assert.deepEqual(r.texts(third), ['the answer'],
      'the setupComplete that triggered the send must not count as its receipt — nothing proved the second socket carried it');
    third.emit('message', Buffer.from(JSON.stringify({ serverContent: { outputTranscription: { text: 'It is ₹52,542.' } } })));
    third.readyState = 3; third.emit('close', 1011, 'drop');
    await new Promise((res) => setImmediate(res));
    const fourth = r.sockets[3];
    fourth.readyState = 1; fourth.emit('open'); fourth.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));
    assert.deepEqual(r.texts(fourth), [], 'once a later frame arrived on its socket it is receipted, and never replayed');
    r.session.close();
  }));

  test('(s4) a rotation that cannot reconnect hands the held answer back — it does not wait for a session that may never come', withQueue(async () => {
    const handedBack = [];
    const sockets = [];
    const session = createLiveSession({ config: {}, logger: { info() {}, warn() {}, error() {} }, systemInstruction: 't', functionDeclarations: [],
      onNoticeUndelivered: (text, meta, reason, cls) => handedBack.push({ text, cls }),
      createSocket: () => { const x = new EventEmitter(); x.OPEN = 1; x.readyState = 0; x.send = () => {}; x.close = () => {}; sockets.push(x); return x; } });
    const opening = session.open(); sockets[0].readyState = 1; sockets[0].emit('open'); sockets[0].emit('message', Buffer.from(JSON.stringify({ setupComplete: {} }))); await opening;
    sockets[0].readyState = 3; sockets[0].emit('close', 1011, 'drop');
    await new Promise((res) => setImmediate(res));
    assert.equal(session.sendText('held answer', { site: 'late-outcome', receiptKey: 'call-s4' }), 'queued');
    sockets[1].emit('close', 1006, 'refused');                     // the replacement never opens
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(handedBack, [{ text: 'held answer', cls: 'outcome' }]);
    assert.equal(session.acceptsNotices(), false, 'and a closed session no longer accepts');
  }));
});

describe('BUG-436 — the server wires the hand-back', () => {
  test('(w1) server/index.js gives every Live session the undelivered-answer handler, with history and TTS', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const line = src.split(/\r?\n/).find((l) => /^\s*onNoticeUndelivered:/.test(l));
    assert.ok(line, 'no onNoticeUndelivered in the createLiveSession call: a held answer would only be logged at a final close');
    assert.ok(line.includes('createUndeliveredHandler({ historyAppend, speak: (text) => proactiveSpeak(text, ws, { skipLive: true })'),
      'the hand-back must reach the conversation history and the TTS path that skips Live');
  });
});

describe('BUG-436 — the adapter hands a rotating session the answer instead of speaking it over TTS', () => {
  // Driven through the production entry point — a slow tool's late outcome —
  // rather than a test-only door, the way bug-273-d3's harness drives it.
  function adapterRig(session) {
    const { createLiveToolAdapter } = require('../src/core/voice/live-tool-adapter');
    const { summarizeActionsForResult } = require('../src/core/voice/action-outcome-summary');
    const spokenByTts = [];
    // The spoken form exists only for an outcome that took 30 s or more
    // (lateOutcomeSpeech), so the clock is moved past that before the tool returns.
    let clock = 0; let finish;
    const done = new Promise((res) => { finish = res; });
    const adapter = createLiveToolAdapter({
      leash: { check: () => ({ allow: true, requireConfirm: false, tier: 2, reason: 'within-autonomous-max' }),
        confirm: { create: () => 'confirm-436', reject: () => {} } },
      dispatchAction: () => done.then(() => ({ ok: true, result: { launched: true } })),
      now: () => clock,
      bus: { emit() {} }, logger: { info() {}, warn() {} }, connectionId: 'conn-436',
      memory: { working: { tick: 1 }, episodic: { write: async () => {} } }, historyAppend: () => {},
      reflection: null, summarizeActionsForResult, getLiveSession: () => session,
      speakWhenClosed: async (t) => { spokenByTts.push(t); }, config: {},
    });
    return { adapter, spokenByTts, finishAfter: (ms) => { clock = ms; finish(); } };
  }
  async function lateOutcome(rig) {
    const calling = rig.adapter.handleLiveToolCalls([{ id: 'call-436', name: 'launch_app', args: { name: 'wt' } }], { sendToolResponse: () => {} });
    rig.finishAfter(45000);
    await calling;
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  }

  test('(a1) a late outcome during a ROTATION goes to the session that will resume — no TTS fallback', async () => {
    const sent = [];
    const rig = adapterRig({ isOpen: () => false, acceptsNotices: () => true,
      sendText: (text, meta) => { sent.push({ text, meta }); return 'queued'; } });
    await lateOutcome(rig);
    const outcome = sent.find((s) => s.meta && s.meta.site === 'late-outcome');
    assert.ok(outcome, 'the answer must be handed to the rotating session, not treated as "no open live session"');
    assert.equal(outcome.meta.receiptKey, 'call-436', 'correlated by the tool call it answers, so a replay can be deduplicated');
    assert.equal(typeof outcome.meta.speech, 'string', 'and it carries its spoken form, for a final close to hand back');
    assert.deepEqual(rig.spokenByTts, [], 'spoken over TTS while the session was merely reconnecting — the BUG-436 shape');
  });

  test('(a2) ADJACENT: a genuinely CLOSED session still falls back to TTS, as before', async () => {
    const rig = adapterRig({ isOpen: () => false, acceptsNotices: () => false, sendText: () => false });
    await lateOutcome(rig);
    assert.equal(rig.spokenByTts.length, 1, 'no session to resume: the operator still hears the answer, in the other voice');
  });
});

// MUTATION PROOF — run 2026-09-23 by .cache/bug432/mutate.js (gitignored):
// each applied to the real source, confirmed applied by sha256, run under the
// TAP reporter, restored by byte copy and re-hashed identical. All 19 tests here
// and all 28 in the two older BUG-432 files were GREEN before each one.
//
//   M1  outcomes held like notices (no bypass)            -> (q1)(q1b)(q6)
//   M2  idle tick releases into a turn in flight (the
//       old ceiling, back)                                -> (q2)(q3), old (5)(e)
//   M3  corrections expire like notices                   -> (q3)
//   M4  notices never expire                              -> (q2), old (e)
//   M5  an unreceipted outcome is not replayed            -> (q6)(s3)
//   M6  receipt taken AFTER the frame is handled, so the
//       setupComplete receipts its own flush              -> (s3)
//   M7  sendText refuses while rotating (the BUG-436 gate) -> (s1)(s3)(s4)
//   M8  adapter treats a rotating session as closed       -> (a1)
//   M9  a failed reconnect keeps held answers             -> (s4)
//   M10 deduplication disabled                            -> (q7)
//   M11 two answers sent back-to-back                     -> (q1b)
//   M12 the hand-back speaks corrections and notices too  -> (h1)
//   M13 the server does not wire the hand-back            -> (w1)
//   M14 a final close hands back without the class        -> (q8)(s4)
//   M15 the adapter drops the correlation key             -> (a1)
//   M16 a rotation restarts a held notice's age           -> old (e)
//   M17 FIXTURE: a new site literal with no class         -> (c1)
//
// None survived. M2 was re-run against this file alone because the report
// truncates at four names; (q2) and (q3) both redden on it.
//
// WHAT THE FULL SUITE CAUGHT, 2026-09-23: test/proactive-speak-catch-guard.test.js
// failed on the first server wiring, `speak: (text) => proactiveSpeak(…)` with no
// `.catch` at the call site. The handler did catch — but only because this caller
// happened to pass its promise to one that does, which the guard cannot see and a
// later caller need not do. The site now owns its rejection like every other one;
// the guard was not touched. M13 was re-run against the corrected line.
//
// ADJACENT CASES THAT MUST KEEP PASSING, and do: (q4) an idle model still gets a
// notice at once and the operator never waits; (s2) a closed session still
// refuses, and with the flag OFF a rotating one does too; (a2) a genuinely closed
// session still falls back to TTS; (h2) an answer with no spoken form is recorded
// and not spoken; the two older BUG-432 files, re-pointed where they pinned the
// removed ceiling (dated notes in each).
//
// NOT COVERED, AND SAID SO:
//   * A receipt proves the SOCKET carried a frame after ours, not that Gemini read
//     ours. A frame already on its way to us can arrive after our send. Live's
//     SessionResumptionUpdate carries lastConsumedClientMessageIndex only with
//     transparent resumption, which this client does not request and which was
//     not verified to exist on this endpoint.
//   * A replay can duplicate an answer the old socket did deliver (see RECEIPTS in
//     notice-queue.js). Chosen: a repeated answer beats a lost one.
//   * An outcome arriving mid-reply is sent at once and so CUTS that reply. That is
//     the point in the ₹52,542 case (the reply was wrong); in a case where the reply
//     was right, it is an interruption. Only an attended comparison can weigh it.
//   * The ws 'error' path moves through 'closed' before 'reconnecting'. A result
//     offered in that instant is refused and takes the TTS fallback.
//   * A turn that never ends holds corrections until the session closes; then
//     they are logged, not spoken.
//   * Every test here drives a fake socket. The flag stays default OFF until an
//     attended comparison shows timely answers and fewer interruptions.
