'use strict';

// test/live-session.test.js — Phase 1 (V2 §6, merged-order step 4). Scripted
// server-frame sequences against a fake socket (the wire protocol in §3 is
// frozen; the transport constructor is the only injected seam — see
// live-session.js's `createSocket` dep).
//
// THE §3 TRAP (test matrix, "Combined-field frame must yield audio and both
// transcripts"): a single serverContent frame can carry inputTranscription,
// outputTranscription, inlineData audio, AND turnComplete all at once. An
// `else if` implementation would only ever fire one of these per frame. This
// file's 'combined frame' test proves the real implementation handles all of
// them, and documents (in a comment) why an else-if version would fail it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');

// Fake 'ws'-shaped socket: EventEmitter + { readyState, OPEN, send, close }.
// script() is driven by the test to push server->client frames.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.CLOSED = 3;
    this.readyState = 0; // CONNECTING
    this.sent = [];
  }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() {
    this.readyState = this.CLOSED;
    this.emit('close', 1000, 'client-close');
  }
  // test helper — not part of the real ws surface
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  simulateOpen() {
    this.readyState = this.OPEN;
    this.emit('open');
  }
}

function fakeDeps(overrides) {
  const sockets = [];
  const createSocket = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const events = { state: [], audio: [], transcripts: [], turns: [] };
  const deps = Object.assign({
    config: {},
    bus: { emit() {} },
    logger: { warn() {}, info() {} },
    spend: { recordCall(rec) { events.spendCalls = events.spendCalls || []; events.spendCalls.push(rec); } },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut: (b64) => events.audio.push(b64),
    onTranscript: (t) => events.transcripts.push(t),
    onState: (s) => events.state.push(s),
    onTurnComplete: (t) => events.turns.push(t),
    createSocket,
  }, overrides || {});
  return { deps, sockets, events };
}

describe('live-session (Phase 1, V2 §6)', () => {
  test('setupComplete transitions to open and calls onState', async () => {
    const { deps, sockets, events } = fakeDeps();
    process.env.GOOGLE_API_KEY = 'test-key';
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    const ok = await openPromise;
    assert.equal(ok, true);
    assert.equal(session.getState(), 'open');
    assert.ok(events.state.some((s) => s.state === 'open'));
    session.close();
  });

  test('open() refuses without GOOGLE_API_KEY', async () => {
    const { deps } = fakeDeps();
    const prev = process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const session = createLiveSession(deps);
    const ok = await session.open();
    assert.equal(ok, false);
    assert.equal(session.getState(), 'closed');
    if (prev !== undefined) process.env.GOOGLE_API_KEY = prev;
  });

  test('THE §3 TRAP — a single combined serverContent frame yields audio AND both transcripts AND turnComplete', async () => {
    // If handleFrame used `else if (sc.inputTranscription) {...} else if
    // (sc.outputTranscription) {...} else if (parts...) {...} else if
    // (sc.turnComplete) {...}` instead of independent `if`s, only the FIRST
    // matching branch (inputTranscription) would fire — assistantText would
    // never accumulate, onAudioOut would never be called, and turnComplete
    // would never fire for this frame. That is exactly the "#1 data-loss bug"
    // V2 §3 warns about, and exactly what this test would catch: an else-if
    // version fails this test because `events.audio` stays empty and
    // `events.turns` never receives a turn.
    process.env.GOOGLE_API_KEY = 'test-key';
    const { deps, sockets, events } = fakeDeps();
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    sockets[0].serverFrame({
      serverContent: {
        inputTranscription: { text: 'what is the weather' },
        outputTranscription: { text: 'It is sunny.' },
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUJD' } }] },
        turnComplete: true,
      },
    });

    assert.deepEqual(events.audio, ['QUJD'], 'audio must be delivered from the combined frame');
    assert.ok(events.transcripts.some((t) => t.role === 'user' && t.text === 'what is the weather'));
    assert.ok(events.transcripts.some((t) => t.role === 'assistant' && t.text === 'It is sunny.'));
    assert.equal(events.turns.length, 1, 'turnComplete must fire even though the same frame carried transcripts+audio');
    assert.equal(events.turns[0].userText, 'what is the weather');
    assert.equal(events.turns[0].assistantText, 'It is sunny.');
    session.close();
  });

  test('interrupted emits voice.live.interrupted on the bus AND fires the direct per-session onInterrupted callback', async () => {
    // Phase 5 fix: the bus event alone is not connection-scoped — with 2+
    // concurrent Live sessions on the shared process bus, a bare
    // bus.subscribe would fire for every OTHER connection's interruption
    // too. onInterrupted is the direct, per-session callback server/index.js
    // actually wires; the bus emit stays as a secondary observability signal.
    process.env.GOOGLE_API_KEY = 'test-key';
    const busEvents = [];
    let interruptedCalls = 0;
    const { deps, sockets } = fakeDeps({
      bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
      onInterrupted: () => { interruptedCalls += 1; },
    });
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    sockets[0].serverFrame({ serverContent: { interrupted: true } });
    assert.ok(busEvents.some((e) => e.name === 'voice.live.interrupted'));
    assert.equal(interruptedCalls, 1, 'the direct onInterrupted callback must fire exactly once');
    session.close();
  });

  test('a turnComplete frame with no transcript at all emits health.anomaly (AD-6)', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const busEvents = [];
    const { deps, sockets } = fakeDeps({ bus: { emit: (name, payload) => busEvents.push({ name, payload }) } });
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    sockets[0].serverFrame({ serverContent: { turnComplete: true } });
    assert.ok(busEvents.some((e) => e.name === 'health.anomaly' && e.payload.kind === 'live-turn-no-transcript'));
    session.close();
  });

  test('goAway triggers a transparent reconnect (new socket, setup resent)', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const { deps, sockets } = fakeDeps();
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    sockets[0].serverFrame({ goAway: { timeLeft: '5s' } });
    // reconnect() calls open() again synchronously-ish; give the microtask queue a turn.
    await new Promise((r) => setImmediate(r));
    assert.equal(sockets.length, 2, 'goAway must open a second socket');
    sockets[1].simulateOpen();
    sockets[1].serverFrame({ setupComplete: {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(session.getState(), 'open');
    session.close();
  });

  test('BUG-059 — idle-timeout rotates the session (preserves resumeHandle, reopens) instead of killing it', async () => {
    // Before the fix, armIdle()'s timeout called close('idle-timeout'), which
    // unconditionally sets closedByUs=true — the exact flag the ws.on('close')
    // reconnect branch checks to decide NOT to reconnect. So an idle timeout
    // could never trigger a reopen: the session just went silently dead with
    // no client notification. This test drives a real idle-timeout via a tiny
    // configured LIVE_IDLE_TIMEOUT_MS and asserts a second socket is opened
    // automatically, carrying the preserved sessionResumption handle, and the
    // session lands back in 'open' — not stuck 'closed'.
    process.env.GOOGLE_API_KEY = 'test-key';
    const { deps, sockets, events } = fakeDeps({ config: { LIVE_IDLE_TIMEOUT_MS: 15 } });
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    // A real session picks up a resume handle almost immediately; give it one.
    sockets[0].serverFrame({ sessionResumptionUpdate: { resumable: true, newHandle: 'resume-abc' } });

    // Wait past the (tiny, test-only) idle timeout.
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(sockets.length, 2, 'idle-timeout must open a fresh socket automatically, not just die');
    // The reason string comes from the fake socket's own close event (matching
    // the real ws.on('close') handler both idle-timeout and goAway now share —
    // see close(reason, {final:false}) in live-session.js), not a bespoke label.
    assert.ok(events.state.some((s) => s.state === 'reconnecting'),
      'the rotation must be observable as a reconnecting state, not a silent death');

    sockets[1].simulateOpen();
    sockets[1].serverFrame({ setupComplete: {} });
    await new Promise((r) => setImmediate(r));

    assert.equal(session.getState(), 'open', 'session must be OPEN again after an idle rotation, not stuck closed');
    assert.ok(
      sockets[1].sent.some((f) => f.setup && f.setup.sessionResumption && f.setup.sessionResumption.handle === 'resume-abc'),
      'the rotated connection must carry the preserved resumeHandle so context is not lost'
    );
    session.close();
  });

  test('BUG-059 — session-max rotates the session instead of killing it at the 10-minute mark', async () => {
    // Same defect, different trigger: MAX_MS used to call close('session-max')
    // unconditionally even though contextWindowCompression's slidingWindow
    // already keeps the content window healthy — this forced kill was
    // self-inflicted and, worse, unrecoverable for the same closedByUs reason.
    process.env.GOOGLE_API_KEY = 'test-key';
    const { deps, sockets } = fakeDeps({ config: { LIVE_SESSION_MAX_MS: 15 } });
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(sockets.length, 2, 'session-max must open a fresh socket automatically, not just die');
    sockets[1].simulateOpen();
    sockets[1].serverFrame({ setupComplete: {} });
    await new Promise((r) => setImmediate(r));

    assert.equal(session.getState(), 'open', 'session must be OPEN again after a session-max rotation, not stuck closed');
    session.close();
  });

  test('BUG-059 adversarial-review fix (A): idle rotation is bounded — an empty room stops rotating, a real word resets it', async () => {
    // Without a ceiling, an unattended mic rotates a brand new Live session
    // every IDLE_MS forever — real cost on BYO keys with per-day limits.
    process.env.GOOGLE_API_KEY = 'test-key';
    const busEvents = [];
    const { deps, sockets, events } = fakeDeps({
      config: { LIVE_IDLE_TIMEOUT_MS: 12 },
      bus: { emit: (name, payload) => busEvents.push({ name, payload }) },
    });
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    // Rotation 1 of 3 allowed: fresh socket opens each time, no exhaustion event yet.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 40));
      sockets[sockets.length - 1].simulateOpen();
      sockets[sockets.length - 1].serverFrame({ setupComplete: {} });
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(sockets.length, 4, 'first 3 idle timeouts must still rotate (open, +3 rotations)');
    assert.ok(!busEvents.some((e) => e.name === 'health.anomaly' && e.payload.kind === 'live-idle-exhausted'),
      'must not exhaust before the ceiling is actually crossed');

    // A real user word must reset the counter, not just delay it.
    sockets[sockets.length - 1].serverFrame({ serverContent: { inputTranscription: { text: 'hello' } } });

    // 3 more rotations should be allowed again after the reset.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 40));
      sockets[sockets.length - 1].simulateOpen();
      sockets[sockets.length - 1].serverFrame({ setupComplete: {} });
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(sockets.length, 7, 'a real transcript must reset the ceiling, not just postpone exhaustion');

    // Now exhaust it for real with no more speech.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const last = sockets[sockets.length - 1];
      if (last.readyState !== last.OPEN) { last.simulateOpen(); last.serverFrame({ setupComplete: {} }); }
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(busEvents.some((e) => e.name === 'health.anomaly' && e.payload.kind === 'live-idle-exhausted'),
      'past the ceiling with zero speech, the session must settle CLOSED for real, not rotate forever');
    assert.equal(session.getState(), 'closed');
    session.close();
  });

  test('BUG-059 adversarial-review fix (B): a late error on an abandoned (rotated-away) socket does not stomp the new session', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const { deps, sockets, events } = fakeDeps({ config: { LIVE_IDLE_TIMEOUT_MS: 12 } });
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    await new Promise((r) => setTimeout(r, 40)); // idle-timeout rotates
    assert.equal(sockets.length, 2);
    sockets[1].simulateOpen();
    sockets[1].serverFrame({ setupComplete: {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(session.getState(), 'open');

    // The ABANDONED socket (sockets[0]) fires a late 'error' — realistic for
    // a real TCP/TLS socket torn down out from under it.
    sockets[0].emit('error', new Error('late ECONNRESET from the abandoned socket'));

    assert.equal(session.getState(), 'open', 'a stale error from the abandoned socket must not stomp the live one to closed');
    assert.ok(!events.state.some((s) => s.state === 'closed' && /ECONNRESET/.test(s.reason || '')),
      'the abandoned socket\'s error handler must have been detached, not just outlived');
    session.close();
  });

  test('usageMetadata records real token counts via spend.recordCall (AD-5 — no invented numbers)', async () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const { deps, sockets, events } = fakeDeps();
    const session = createLiveSession(deps);
    const openPromise = session.open();
    sockets[0].simulateOpen();
    sockets[0].serverFrame({ setupComplete: {} });
    await openPromise;

    sockets[0].serverFrame({ usageMetadata: { promptTokenCount: 123, responseTokenCount: 45, totalTokenCount: 168 } });
    assert.equal(events.spendCalls.length, 1);
    assert.equal(events.spendCalls[0].inputTokens, 123);
    assert.equal(events.spendCalls[0].outputTokens, 45);
    assert.equal(events.spendCalls[0].provider, 'google-live');
    session.close();
  });
});
