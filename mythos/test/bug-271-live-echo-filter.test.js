'use strict';

// test/bug-271-live-echo-filter.test.js — BUG-271, commit 1: echo filter on
// the Live path.
//
// MYTHOS's own voice, replayed through the speakers, reaches Gemini's mic
// input and comes back as an inputTranscription that live-session.js used to
// accept as the operator's words — an echo loop. The batch path has solved
// this class for years with voice-loop.js's echoMatch (word-overlap >= 60%
// against text spoken in the last 3s); the Live path never got it.
//
// This file pins the server-side port: the pure module's semantics first
// (including the time window, via an injected clock), then the wiring through
// the existing createLiveSession(deps) fake-socket seam — the same fixture
// shape as test/live-session.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { echoMatch, createEchoFilter } = require('../src/core/voice/echo-filter');
const { createLiveSession } = require('../src/core/voice/live-session');

describe('echoMatch — batch semantics, ported verbatim', () => {
  test('no reference is never an echo', () => {
    assert.equal(echoMatch('anything at all', ''), false);
    assert.equal(echoMatch('anything at all', null), false);
    assert.equal(echoMatch('anything at all', undefined), false);
  });

  test('>= 60% of the candidate words found in the reference = echo', () => {
    // 3 of 5 candidate words in the reference = exactly 0.6 -> echo.
    assert.equal(echoMatch('it sunny today rain clouds', 'It is sunny today.'), true);
    // 2 of 5 = 0.4 -> not an echo.
    assert.equal(echoMatch('it sunny rain clouds storm', 'It is sunny today.'), false);
    // A one-word candidate present in the reference is always 1.0.
    assert.equal(echoMatch('sunny', 'It is sunny today.'), true);
    assert.equal(echoMatch('weather', 'It is sunny today.'), false);
  });

  test('a wordless candidate is an echo whenever a reference exists', () => {
    // Batch semantics: nothing real was said, so it cannot be the operator.
    assert.equal(echoMatch('', 'It is sunny today.'), true);
    assert.equal(echoMatch('!!! ...', 'It is sunny today.'), true);
    // ...but with no reference there is nothing to echo.
    assert.equal(echoMatch('', ''), false);
  });

  test('case and punctuation insensitive', () => {
    assert.equal(echoMatch('SUNNY, today!', 'it is sunny today'), true);
  });

  test("apostrophes stay inside words", () => {
    assert.equal(echoMatch("don't", "don't stop"), true);
    assert.equal(echoMatch("don't", 'do not stop'), false);
  });
});

describe('createEchoFilter — the 3s time window', () => {
  test('matches against text noted within the window and returns the overlap ratio', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('It is sunny today.');
    assert.equal(f.match('it is sunny today'), 1);
    assert.ok(Math.abs(f.match('weather is sunny') - 2 / 3) < 1e-9,
      'the ratio is hits/candidate-words, so the wiring can log it');
    assert.equal(f.match('what time is it'), null, '0.5 overlap is below the 0.6 floor');
  });

  test('the reference expires at exactly the window edge', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('It is sunny today.');
    t = 1000 + 2999;
    assert.notEqual(f.match('it is sunny today'), null, 'one ms inside the window still matches');
    t = 1000 + 3000;
    assert.equal(f.match('it is sunny today'), null, 'at exactly 3s the reference is gone');
  });

  test('multiple utterances in the window — the best ratio wins', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('it is raining');
    f.endUtterance();
    t = 1500;
    f.noteSpoken('It is sunny today.');
    // 'it is sunny' is 2/3 against the first utterance (also >= 0.6) but 3/3
    // against the second — the logged ratio must be the best one.
    assert.equal(f.match('it is sunny'), 1);
  });

  test('fragments accumulate into one utterance until endUtterance', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('the weather ');
    t = 1200;
    f.noteSpoken('is sunny today');
    // 'weather is sunny' straddles the fragment boundary — only catchable
    // against the accumulated text, which is how a real echo arrives.
    assert.equal(f.match('weather is sunny'), 1);
    f.endUtterance();
    t = 1400;
    f.noteSpoken('playing it now');
    assert.equal(f.match('playing it'), 1, 'a fresh utterance starts after the close');
    // 0.5 against each utterance alone (below the floor), 1.0 if the closed
    // utterance were wrongly concatenated with the new one.
    assert.equal(f.match('today playing'), null,
      'a closed utterance is not concatenated with the next one');
  });

  test('a closed utterance stays a reference until its own window expires', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('It is sunny today.');
    f.endUtterance();
    t = 3900; // 2.9s after the last fragment
    assert.notEqual(f.match('it is sunny today'), null);
    t = 4000; // 3.0s after
    assert.equal(f.match('it is sunny today'), null);
  });

  test('a wordless candidate echoes if anything was spoken in the window', () => {
    let t = 1000;
    const f = createEchoFilter({ now: () => t });
    f.noteSpoken('hello there');
    assert.equal(f.match(''), 1);
    assert.equal(f.match('!!!'), 1);
  });

  test('nothing spoken, nothing to echo', () => {
    const f = createEchoFilter({ now: () => 1000 });
    assert.equal(f.match('it is sunny today'), null);
    assert.equal(f.match(''), null);
  });
});

// ---- wiring through the real createLiveSession(deps) seam ----

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

function harness(config) {
  const sockets = [];
  const transcripts = [];
  const logs = [];
  const anomalies = [];
  const turns = [];
  const busEvents = [];
  const session = createLiveSession({
    config: config || {},
    bus: {
      emit: (type, payload) => {
        busEvents.push({ type, payload });
        if (type === 'health.anomaly') anomalies.push(payload);
      },
    },
    logger: { warn() {}, info: (event, detail) => logs.push({ event, detail }) },
    spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test instruction',
    functionDeclarations: [],
    onAudioOut: () => {},
    onTranscript: (t) => transcripts.push(t),
    onState: () => {},
    onTurnComplete: (t) => turns.push(t),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  return { session, sockets, transcripts, logs, anomalies, turns, busEvents };
}

async function opened(h) {
  process.env.GOOGLE_API_KEY = 'test-key';
  const p = h.session.open();
  h.sockets[0].simulateOpen();
  h.sockets[0].serverFrame({ setupComplete: {} });
  await p;
  return h.sockets[0];
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

describe('BUG-271 — the Live path drops its own voice coming back as the operator', () => {
  test('an input transcript echoing what MYTHOS just said is dropped — no userText, no onTranscript, ratio logged', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'It is sunny today.' } } });
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'it is sunny today' } } });

    assert.deepEqual(h.transcripts.filter((t) => t.role === 'user'), [],
      'the echo must never reach the transcript channel as the operator');
    sock.serverFrame({ serverContent: { turnComplete: true } });
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0].userText, '', 'the echo must not enter the turn record');
    assert.equal(h.turns[0].assistantText, 'It is sunny today.');

    const drop = h.logs.find((l) => l.event === 'live.echo-dropped');
    assert.ok(drop, 'a dropped echo is never silent');
    assert.equal(typeof drop.detail.ratio, 'number');
    assert.ok(drop.detail.ratio >= 0.6 && drop.detail.ratio <= 1);
    assert.ok(!JSON.stringify(drop.detail).toLowerCase().includes('sunny'),
      'the log carries the ratio, never transcript text');

    h.session.close('test');
  });

  test('output fragments accumulate — a cross-fragment echo is still caught', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'the weather ' } } });
    sock.serverFrame({ serverContent: { outputTranscription: { text: 'is sunny today' } } });
    // Straddles the fragment boundary: 0.5 against each fragment alone, 1.0
    // against the accumulated utterance.
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'weather is sunny' } } });

    assert.deepEqual(h.transcripts.filter((t) => t.role === 'user'), []);
    assert.ok(h.logs.some((l) => l.event === 'live.echo-dropped'));
    h.session.close('test');
  });

  test('a non-echo transcript still passes untouched', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'It is sunny today.' } } });
    // 'what time is it' shares 'is'+'it' = 2/4 = 0.5 — below the floor.
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'what time is it' } } });

    assert.deepEqual(h.transcripts.filter((t) => t.role === 'user').map((t) => t.text),
      ['what time is it']);
    sock.serverFrame({ serverContent: { turnComplete: true } });
    assert.equal(h.turns[0].userText, 'what time is it');
    assert.ok(!h.logs.some((l) => l.event === 'live.echo-dropped'));
    h.session.close('test');
  });

  test('the utterance outlives turnComplete — an echo arriving right after the turn lands is still dropped', async () => {
    const h = harness();
    const sock = await opened(h);

    sock.serverFrame({
      serverContent: { outputTranscription: { text: 'It is sunny today.' }, turnComplete: true },
    });
    // Speaker bleed arrives after the turn completed — the reference must
    // survive the turn boundary for its window (batch's post-playback guard).
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'it is sunny today' } } });

    assert.deepEqual(h.transcripts.filter((t) => t.role === 'user'), []);
    assert.ok(h.logs.some((l) => l.event === 'live.echo-dropped'));
    h.session.close('test');
  });

  test('an echoed transcript behaves as if it never arrived — it does not arm the turn stall', async () => {
    const h = harness({ LIVE_TURN_STALL_MS: 40 });
    const sock = await opened(h);

    sock.serverFrame({ serverContent: { outputTranscription: { text: 'hello there friend' } } });
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'hello there friend' } } });
    await settle(140);

    assert.equal(h.anomalies.filter((a) => a.kind === 'live-turn-stalled').length, 0,
      'no reply is owed for words nobody said');

    // Control: a REAL (non-echo) transcript in the same session still arms it.
    sock.serverFrame({ serverContent: { inputTranscription: { text: 'please play some music' } } });
    await settle(140);
    assert.equal(h.anomalies.filter((a) => a.kind === 'live-turn-stalled').length, 1,
      'the watchdog still fires for a genuine unheard transcript');
    h.session.close('test');
  });

  test('an echoed transcript does not reset the idle-rotation ceiling', async () => {
    const h = harness({ LIVE_IDLE_TIMEOUT_MS: 12 });
    const sock = await opened(h);

    // One idle rotation first, so the counter is at 1 — only then can a
    // (wrong) reset be told apart from no reset.
    await settle(40);
    assert.equal(h.sockets.length, 2, 'the first idle timeout rotated');
    h.sockets[1].simulateOpen();
    h.sockets[1].serverFrame({ setupComplete: {} });
    await new Promise((r) => setImmediate(r));

    h.sockets[1].serverFrame({ serverContent: { outputTranscription: { text: 'hello there friend' } } });
    h.sockets[1].serverFrame({ serverContent: { inputTranscription: { text: 'hello there friend' } } });

    // Three more idle timeouts with no REAL speech: counter 2, 3, then 4 >
    // the ceiling of 3 → exhausted close. If the echo had reset the counter
    // to 0, the third timeout would still rotate instead of closing.
    for (let i = 0; i < 3; i++) {
      await settle(40);
      const last = h.sockets[h.sockets.length - 1];
      if (last.readyState !== last.OPEN) { last.simulateOpen(); last.serverFrame({ setupComplete: {} }); }
      await new Promise((r) => setImmediate(r));
    }

    assert.ok(h.busEvents.some((e) => e.type === 'voice.live.idle-closed'),
      'an echo is not evidence of an occupied room — the ceiling still exhausts');
    h.session.close('test');
  });
});
