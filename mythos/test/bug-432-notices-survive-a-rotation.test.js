'use strict';

// BUG-432, second half — a held notice must survive the socket it was held on.
//
// The FIRST half (test/bug-432-notices-take-turns.test.js) is the pure queue:
// six notices become six turns instead of six interruptions. It works, and a
// CLEAN rotation was already fine — probe: notice held, socket dropped,
// replacement up, one turnComplete, and the notice reached the new socket.
//
// TWO NARROWER PATHS DESTROYED IT SILENTLY, both measured 2026-09-11:
//
// (1) AN UNSOLICITED DROP NEVER CALLS close(). live-session.js's ws 'close'
//     handler goes straight to setState('reconnecting') + reconnect(), and
//     close() is where cancel() lived. So on the MOST COMMON rotation trigger
//     the queue was never told the transport had gone: its ceiling timer stayed
//     armed, fired mid-rotation, and release() sent into a CONNECTING socket.
//     Probe with LIVE_NOTICE_HOLD_MAX_MS=25 — `live.text-injected {site:'b'}`
//     written, `live.notice-undelivered {reason:'hold-expired'}` right after,
//     and the replacement socket's text wire EMPTY both immediately and after a
//     full completed turn.
//
// (2) A DEFERRED goAway RELEASED INTO A NULLED SOCKET. goAwayGate.turnComplete()
//     calls close('goaway',{final:false}), which nulls `ws`; release() then ran
//     in the SAME synchronous frame handler. Probe: two sockets, socket 0's wire
//     empty, socket 1's wire empty even after its own completed turn, and the
//     only records were one injection and one undelivered.
//
// In both, release() had `shift()`ed the item BEFORE calling send, so a refusal
// could not retain it. And sendNoticeFrame set turnSystemInitiated and wrote
// live.text-injected BEFORE the send, so a refused frame left a PHANTOM
// in-flight notice and a log row claiming it had reached the wire — in the very
// field BUG-432's own measurement is counted from. The phantom is not cosmetic:
// probe showed it moving the half-blind-transcript suppression onto the
// replacement session's FIRST REAL TURN, i.e. suppressing the check exactly
// where it was most needed.
//
// WHAT THIS FILE DOES NOT CLAIM. Every test here drives a FakeSocket. The real
// `ws` library closes asynchronously, so the live ordering differs — in the
// deferred-goAway case it differs in the direction that makes the old bug WORSE
// (ws stays null rather than becoming a CONNECTING replacement), but that is
// reasoning, not measurement. Nothing here is evidence that a real Gemini
// rotation behaves this way, and the BUG-432 entry says so.
//
// 2026-09-23 (BUG-432 measured pass, BUG-436): the per-item 15 s DEADLINE this
// file pinned in (e)/(f)/(g) is gone — it forced held notices into live turns.
// Those tests are re-pointed below, each with its own dated note: (e) now pins
// that a notice's AGE survives a rotation, (f) that an idle release sends one at
// a time, (g) that a held correction still waits out the post-resume grace.
// LIVE_NOTICE_HOLD_MAX_MS no longer exists, so (a) no longer shortens anything.
//
// Run: cd mythos && node --test test/bug-432-notices-survive-a-rotation.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const { createNoticeQueue, MIN_RELEASE_GAP_MS, POST_RESUME_GRACE_MS } = require('../src/core/voice/notice-queue');

// Same FakeSocket shape as test/live-session-rotation.test.js — the only harness
// in the repo that models simulateServerDrop and a second socket. Reused rather
// than re-invented so the two files cannot drift apart about what a drop is.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = []; }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
  simulateServerDrop() { this.readyState = this.CLOSED; this.emit('close', 1011, 'going away'); }
  texts() { return this.sent.filter((m) => m.realtimeInput && typeof m.realtimeInput.text === 'string').map((m) => m.realtimeInput.text); }
}

function harness(overrides) {
  process.env.GOOGLE_API_KEY = 'test-key';
  const sockets = [];
  const logs = [];
  const anomalies = [];
  const deps = Object.assign({
    config: {},
    bus: { emit(type, payload) { if (type === 'health.anomaly') anomalies.push(payload); } },
    logger: { warn(event, f) { logs.push({ event, f }); }, info(event, f) { logs.push({ event, f }); } },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut() {}, onTranscript() {}, onState() {}, onTurnComplete() {},
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  }, overrides || {});
  return { session: createLiveSession(deps), sockets, logs, anomalies };
}

async function openSession(session, sockets, index) {
  const p = session.open();
  sockets[index].simulateOpen();
  sockets[index].serverFrame({ setupComplete: {} });
  await p;
  return sockets[index];
}

// Make the model "busy" so a notice is held rather than sent: a text part from
// the server sets turnTextParts, which is a term in the queue's inFlight().
function beginModelTurn(socket) { socket.serverFrame({ serverContent: { modelTurn: { parts: [{ text: 'speaking' }] } } }); }
// assistantText accumulates from outputTranscription, NOT from modelTurn parts
// (live-session.js:690). The half-blind check reads turn.assistantText, so a
// test that only sends modelTurn parts produces a turn with NO assistant text
// and the check never fires — which looks exactly like the guard being broken.
function modelSpeaks(socket, text) { socket.serverFrame({ serverContent: { outputTranscription: { text } } }); }
function completeTurn(socket) { socket.serverFrame({ serverContent: { turnComplete: true } }); }

function withFlag(value, fn) {
  const prev = process.env.VOICE_SERIALIZE_NOTICES;
  const prevCeiling = process.env.LIVE_NOTICE_HOLD_MAX_MS;
  process.env.VOICE_SERIALIZE_NOTICES = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.VOICE_SERIALIZE_NOTICES; else process.env.VOICE_SERIALIZE_NOTICES = prev;
    if (prevCeiling === undefined) delete process.env.LIVE_NOTICE_HOLD_MAX_MS; else process.env.LIVE_NOTICE_HOLD_MAX_MS = prevCeiling;
  }
}

describe('BUG-432 — a held notice survives the socket it was held on', () => {
  test('(a) an UNSOLICITED drop suspends delivery — the ceiling cannot fire into a dead socket', async () => {
    await withFlag('true', async () => {
      // 2026-09-23: this used to set LIVE_NOTICE_HOLD_MAX_MS=25 so the old
      // ceiling would fire mid-rotation. The ceiling and the variable are gone;
      // the live.notice-suspended assertion below is what carries M1 now.
      const { session, sockets, logs } = harness();
      const first = await openSession(session, sockets, 0);
      beginModelTurn(first);
      assert.equal(session.sendText('held notice', { site: 'a' }), 'queued');

      first.simulateServerDrop();          // the path that never calls close()
      await new Promise((r) => setTimeout(r, 60)); // well past the 25ms ceiling

      assert.deepEqual(first.texts(), [],
        'the ceiling must NOT have fired a send into the socket that just died');
      assert.ok(logs.some((l) => l.event === 'live.notice-suspended'),
        'setState leaving "open" is the choke point — close() is not, because an unsolicited drop never calls it');
      assert.ok(!logs.some((l) => l.event === 'live.notice-undelivered'),
        'and the notice must not have been handed back as undeliverable — it is still held');
    });
  });

  test('(b) the held notice reaches the REPLACEMENT socket after its own turn completes', async () => {
    await withFlag('true', async () => {
      const { session, sockets } = harness();
      const first = await openSession(session, sockets, 0);
      beginModelTurn(first);
      assert.equal(session.sendText('survivor', { site: 'a' }), 'queued');

      first.simulateServerDrop();
      const second = sockets[1];
      second.simulateOpen();
      second.serverFrame({ setupComplete: {} });
      beginModelTurn(second);
      completeTurn(second);

      assert.deepEqual(second.texts(), ['survivor'],
        'the whole point: the notice outlives the socket it was held on');
      assert.deepEqual(first.texts(), [], 'and never went to the dead one');
    });
  });

  test('(c) a deferred goAway does not release into the socket it just closed', async () => {
    await withFlag('true', async () => {
      const { session, sockets, logs } = harness();
      const first = await openSession(session, sockets, 0);
      // A turn is in flight, so goAwayGate defers its close to turnComplete.
      beginModelTurn(first);
      assert.equal(session.sendText('audit row', { site: 'turn-audit' }), 'queued');
      first.serverFrame({ goAway: { timeLeft: '50s' } });
      assert.equal(first.readyState, first.OPEN, 'the gate holds the socket open mid-turn');

      // turnComplete fires the deferred close AND the queue release, in one
      // synchronous frame handler. The release must be a no-op, not a send.
      completeTurn(first);

      assert.deepEqual(first.texts(), [], 'nothing went out on the closed socket');
      assert.ok(!logs.some((l) => l.event === 'live.notice-undelivered'),
        'and the notice was retained rather than destroyed by a failed send');

      const second = sockets[1];
      second.simulateOpen();
      second.serverFrame({ setupComplete: {} });
      beginModelTurn(second);
      completeTurn(second);
      assert.deepEqual(second.texts(), ['audit row'], 'it arrives on the replacement instead');
    });
  });

  test('(d) a refused send RETAINS the item and leaves no phantom in-flight notice', () => {
    let allow = false;
    const q = createNoticeQueue({
      inFlight: () => false,
      send: () => (allow ? true : false),
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    assert.equal(q.offer('n1', { site: 'x' }), false, 'a refused immediate send is honestly false');
    // Now hold one, then refuse its release.
    const q2 = createNoticeQueue({
      inFlight: () => true,
      send: () => false,
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    assert.equal(q2.offer('n2', { site: 'y' }), 'queued');
    assert.equal(q2.size(), 1);
    assert.equal(q2.release(), false, 'the send was refused');
    assert.equal(q2.size(), 1,
      'and the item is STILL HELD — the old code shifted before sending, so a refusal destroyed it');
    assert.equal(q2.isSuspended(), true,
      'a refusal suspends rather than retrying: an immediate retry loop against a dead socket would '
      + 'burn the deadline and fill the log');
    assert.equal(q2.release(), false, 'and a second release while suspended does nothing');
    assert.equal(q2.size(), 1, 'still held');
    allow = true; // unrelated queue, kept so the linter sees the variable used
  });

  // RE-POINTED 2026-09-23. It pinned the remaining time of a 15 s forced-release
  // deadline across a rotation. That deadline is gone; what survives a rotation now
  // is a notice's AGE, counted from when it was offered, against NOTICE_MAX_AGE_MS.
  test('(e) a notice\'s ORIGINAL age survives a rotation, not restarted by it', () => {
    let t = 1000;
    const scheduled = [];
    const q = createNoticeQueue({
      inFlight: () => true,
      send: () => true,
      now: () => t,
      setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
      clearTimer: () => {},
    });
    q.offer('first', { site: 'proactive-speak' });   // offered at t=1000
    t = 11000; q.suspend('rotation');
    t = 14000; q.resume({ generation: 2, audioFlushed: false });

    t = 60000; scheduled[scheduled.length - 1].fn();
    assert.equal(q.size(), 1, 'aged 59 s: still held');
    t = 61000; scheduled[scheduled.length - 1].fn();
    assert.equal(q.size(), 0,
      'aged 60 s from its ORIGINAL offer, it is dropped — a rotation at 11 s did not buy it another minute');
  });

  // RE-POINTED 2026-09-23. The backlog used to drain when its forced deadlines
  // expired together; nothing is forced now, so the same bound is pinned where a
  // backlog CAN still go at once — the moment the model falls quiet.
  test('(f) a backlog does not drain in one callback when the model falls quiet', () => {
    let speaking = true;
    const sent = [];
    const scheduled = [];
    const q = createNoticeQueue({
      inFlight: () => speaking,
      send: (text) => { sent.push(text); return true; },
      setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
      clearTimer: () => {},
    });
    q.offer('one', {}); q.offer('two', {}); q.offer('three', {});
    speaking = false;                           // the turn ended without a turnComplete
    scheduled[scheduled.length - 1].fn();       // fire the idle tick once
    assert.deepEqual(sent, ['one'], 'exactly ONE notice per callback');
    assert.equal(q.size(), 2, 'the rest wait for a turn or another gap');
    const next = scheduled[scheduled.length - 1];
    assert.ok(next.ms >= MIN_RELEASE_GAP_MS,
      'and the next one is floored at MIN_RELEASE_GAP_MS, so an expired backlog cannot recreate the '
      + 'back-to-back interruption this whole file exists to prevent');
  });

  // 2026-09-23: a CORRECTION now (it was an unlabelled item, i.e. a notice, which
  // at t=99999 would be past its 60 s age). Resume still releases nothing but an
  // outcome synchronously; outcomes have their own test in bug-432-outcome-outbox.
  test('(g) buffered operator audio wins the floor — resume never releases a correction synchronously', () => {
    let t = 1000;
    const sent = [];
    const scheduled = [];
    const q = createNoticeQueue({
      inFlight: () => true,
      send: (text) => { sent.push(text); return true; },
      now: () => t,
      setTimer: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
      clearTimer: () => {},
    });
    q.offer('correction', { site: 'ad4-correction-retract' });
    t = 99999;                                  // long held
    q.suspend('rotation');
    q.resume({ generation: 3, audioFlushed: true });
    assert.deepEqual(sent, [], 'resume() sends nothing itself');
    assert.equal(scheduled[scheduled.length - 1].ms, POST_RESUME_GRACE_MS,
      'an expired notice still waits out the grace, so the turn the flushed audio provokes gets '
      + 'first refusal — "wait for that turn, or the existing hold ceiling"');
  });

  test('(h) a callback from an OBSOLETE socket generation cannot release', () => {
    const sent = [];
    const q = createNoticeQueue({
      inFlight: () => true,
      send: (text) => { sent.push(text); return true; },
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    q.offer('n', {});
    q.resume({ generation: 7 });
    assert.equal(q.release({ generation: 6 }), false, 'a stale generation releases nothing');
    assert.deepEqual(sent, []);
    assert.equal(q.release({ generation: 7 }), true, 'the current one does');
    assert.deepEqual(sent, ['n']);
  });

  test('(i) a FINAL close drains once and cannot replay into a later session', () => {
    const undelivered = [];
    const sent = [];
    const q = createNoticeQueue({
      inFlight: () => true,
      send: (text) => { sent.push(text); return true; },
      onUndelivered: (text, meta, reason) => undelivered.push({ text, reason }),
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    q.offer('goodbye', { site: 'z' });
    assert.equal(q.cancel({ final: true }), 1);
    assert.deepEqual(undelivered, [{ text: 'goodbye', reason: 'session-closed' }]);
    assert.equal(q.size(), 0);
    // Replay is prevented by DRAINING, not by a check: there is structurally
    // nothing left to replay. Reopening and releasing sends nothing.
    q.resume({ generation: 99 });
    assert.equal(q.release({ generation: 99 }), false);
    assert.deepEqual(sent, [], 'a later session gets none of the old session"s notices');
    assert.equal(q.cancel({ final: true }), 0, 'and draining twice hands nothing back twice');
  });

  test('(j) FLAG OFF — sendText is the old boolean and no queue exists', async () => {
    await withFlag('false', async () => {
      const { session, sockets } = harness();
      const first = await openSession(session, sockets, 0);
      beginModelTurn(first);
      const r = session.sendText('straight through', { site: 'a' });
      assert.equal(r, true, 'with the flag off this is a boolean, exactly as before the queue existed');
      assert.deepEqual(first.texts(), ['straight through'], 'and it went out immediately, mid-turn');
    });
  });

  test('(k) the operator bypass is not held, even while suspended', () => {
    const sent = [];
    const q = createNoticeQueue({
      inFlight: () => true,
      send: (text) => { sent.push(text); return true; },
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    q.suspend('rotation');
    assert.equal(q.offer('what the operator typed', { operator: true }), 'sent',
      'the operator"s own words are the input the model is answering — holding them would hold up '
      + 'the conversation to protect a notice about it');
    assert.deepEqual(sent, ['what the operator typed']);
    assert.equal(q.offer('a system notice', { site: 's' }), 'queued', 'a notice still waits');
  });

  test('(n) a notice offered while SUSPENDED is held without ever touching the socket', () => {
    // THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Removing `suspended ||` from
    // offer()'s hold condition left every other test green, because test (k)
    // builds its queue with `inFlight: () => true` — so the notice was held for
    // the OTHER reason and nothing could tell the two apart. The suspended half
    // of that condition was, until now, completely untested.
    //
    // The distinguishing case is the one that matters in production: the model
    // is idle (nothing in flight) and the transport is down. Without the
    // suspension check, offer() hands the frame straight to a dead socket —
    // which writes an injection record for a frame nobody will ever hear, in the
    // exact field BUG-432's measurement is counted from.
    const attempts = [];
    const q = createNoticeQueue({
      inFlight: () => false,                       // the model is NOT speaking
      send: (text) => { attempts.push(text); return false; }, // and the socket is dead
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    q.suspend('rotation');
    assert.equal(q.offer('correction', { site: 's' }), 'queued',
      'held, not attempted — "queued" is the honest answer while the transport is down');
    assert.deepEqual(attempts, [],
      'and send() was never called: no frame handed to a dead socket, so no injection record for one');
    assert.equal(q.size(), 1);

    // The adjacent case, so the bound is written down: READY and idle still
    // sends immediately. A queue that held everything would be a worse bug.
    const sent = [];
    const q2 = createNoticeQueue({
      inFlight: () => false,
      send: (text) => { sent.push(text); return true; },
      holdMaxMs: 10000,
      setTimer: () => 1, clearTimer: () => {},
    });
    assert.equal(q2.offer('immediate', { site: 's' }), 'sent');
    assert.deepEqual(sent, ['immediate'], 'an idle model on a live socket is still answered at once');
  });

  test('(m) a REFUSED frame leaves no phantom, so the half-blind check still runs on the next turn', async () => {
    await withFlag('true', async () => {
      const { session, sockets, logs, anomalies } = harness();
      const first = await openSession(session, sockets, 0);

      // Refuse at the WIRE without changing session state. This is the real
      // window: close(reason,{final:false}) nulls ws and returns without
      // touching state, and with the asynchronous `ws` library state stays
      // 'open' until the close event lands a tick later — so sendText's
      // `state !== 'open'` gate passes and sendRaw refuses underneath it.
      first.readyState = first.CLOSED;
      assert.equal(session.sendText('a notice nobody will hear', { site: 'x' }), false,
        'nothing is in flight, so this is an immediate send — and the socket refuses it');

      const injected = logs.filter((l) => l.event === 'live.text-injected');
      assert.equal(injected.length, 1, 'the row is still written — the record must not go missing');
      assert.equal(injected[0].f.accepted, false,
        'but it says the frame was REFUSED. It used to be written before sendRaw, so every refused '
        + 'frame was recorded as injected, in the very field BUG-432 counts interruptions against');

      // Now a normal turn: the model answers, and nothing the operator said was
      // transcribed. That is the half-blind shape AD-6 exists to catch, and it
      // must NOT be suppressed — the refused notice started no turn.
      first.readyState = first.OPEN;
      modelSpeaks(first, 'here is my answer');   // assistantText, and no inputTranscription
      completeTurn(first);
      assert.ok(anomalies.some((a) => a.kind === 'live-turn-no-user-transcript'),
        'the phantom flag suppressed this check on the NEXT real turn — measured 2026-09-11, it moved '
        + 'the suppression onto the replacement session"s first turn, which is exactly where the '
        + 'check is most needed');
    });
  });

  test('(l) repeated rotations keep one notice exactly once', async () => {
    await withFlag('true', async () => {
      const { session, sockets } = harness();
      const first = await openSession(session, sockets, 0);
      beginModelTurn(first);
      assert.equal(session.sendText('persistent', { site: 'a' }), 'queued');

      first.simulateServerDrop();
      const second = sockets[1];
      second.simulateOpen(); second.serverFrame({ setupComplete: {} });
      second.simulateServerDrop();               // rotate again before any turn
      const third = sockets[2];
      third.simulateOpen(); third.serverFrame({ setupComplete: {} });
      beginModelTurn(third); completeTurn(third);

      assert.deepEqual(first.texts(), []);
      assert.deepEqual(second.texts(), []);
      assert.deepEqual(third.texts(), ['persistent'], 'delivered once, on the socket that survived');
    });
  });
});

// MUTATION PROOF — MEASURED 2026-09-11, not predicted. Applied to the real
// source, confirmed present on disk, node --check'ed (a mutation that only
// breaks the parse proves nothing), run under --test-reporter=tap (the default
// spec reporter makes `# fail` grep to nothing), restored and re-hashed
// sha256-identical. All 14 tests were GREEN before each mutation.
//
//   M1  remove the setState suspend hook                  -> fail 1  (a)
//   M2  release() shifts BEFORE sending (the old order)   -> fail 2  (d)(f)
//   M3  re-arm a flat holdMaxMs, not the item's deadline  -> fail 3  (e)(f)(g)
//       [2026-09-23: M3 is obsolete — there is no deadline to re-arm. (e) now
//       reddens if a rotation restarts a notice's age; see the outbox file.]
//   M4  drop the MIN_RELEASE_GAP_MS floor                 -> fail 2  (f)(g)
//   M5  release synchronously from resume()               -> fail 4  (e)(g)(h)(l)
//   M6  drop the socket-generation check                  -> fail 1  (h)
//   M7  a final cancel copies instead of draining         -> fail 1  (i)
//   M8  do not restore turnSystemInitiated (the phantom)  -> fail 1  (m)
//   M9  write live.text-injected BEFORE the send again    -> fail 1  (m)
//   M10 offer() ignores suspension                        -> fail 1  (n)
//
// TWO THINGS THE MEASUREMENT CORRECTED, both worth more than the green run:
//
// M10 SURVIVED on the first pass. Test (k) built its queue with
// `inFlight: () => true`, so a notice offered while suspended was held for the
// OTHER reason and nothing could tell the two conditions apart — the suspended
// half of offer()'s guard was completely untested. Test (n) was written from
// that, with the distinguishing case: model idle, transport down.
//
// M1 reddens (a) ONLY, not (b)(c)(l) as expected. That is correct and it is
// worth knowing why: (a) is the only test that shortens the ceiling to 25 ms, so
// it is the only one where the un-suspended timer actually gets to fire during
// the rotation. The others rotate faster than the default 15 s ceiling and
// survive the mutation on timing alone. A single test carries that guard.
//
// ADJACENT CASES THAT MUST KEEP PASSING, run as a named set rather than trusted
// to the full suite: test/bug-432-notices-take-turns.test.js (the pure queue,
// all of it, unchanged), test/bug-273-d3-system-notice-logged.test.js (the three
// source-shape counts that must each stay at exactly 1),
// test/live-session-rotation.test.js (audio across a rotation),
// test/bug-436-goaway-waits-for-the-turn.test.js, test/live-session.test.js,
// and test/file-size-ratchet.test.js — live-session.js must stay <= 1204.
