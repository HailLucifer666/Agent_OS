'use strict';

// test/live-frame-trace.test.js — C0 of the validated-speech design: the
// measurement instrument that has to exist BEFORE the release margin M, the
// quiet window Q and the rate band can be set (design §1, "Neither may be
// guessed"). Off by default behind LIVE_FRAME_TRACE.
//
// WHY THIS IS THE RIGHT TEST. The attended measurement reads transcript lead or
// lag against audio from these lines and nothing else, so the measurement is
// only as good as two numbers per frame: the cumulative audio milliseconds and
// the cumulative output characters. The test drives the REAL live-session.js
// over its createSocket seam, through the same wrapper server/index.js uses, so
// it proves the lines come from the wire frames the session itself handles. And
// it pins the binding privacy invariant: a log line never carries transcript
// text (the same rule test/bug-272-echo-check-instrumentation.test.js pins for
// live.echo-check).
//
// RED FIRST, 2026-10-06, against 323fba62: the whole file failed at require()
// ("Cannot find module '../src/core/voice/live-frame-trace'").
//
// MUTATIONS, 2026-10-06 — four probes, each applied once to live-frame-trace.js,
// confirmed applied by `git diff --no-index` against a copy, run against this
// file (8 tests), restored from the copy and hash-verified. All four were green
// BEFORE the probe; each turned red:
//   (m1) count audio by base64 length, not PCM ms (1+/1-) .. red: (a)
//   (m2) drop outCharsSoFar from the line (0+/1-) .......... red: (a) (c)
//   (m3) put the transcript text on the line (1+/1-) ....... red: (b) (c)
//   (m4) remove the try/catch around observe() (1+/3-) ..... red: (e)
// Adjacent case that kept passing under all four: (d) the flag off returns the
// socket factory untouched and writes no line.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');
const trace = require('../src/core/voice/live-frame-trace');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 0; this.sent = []; }
  send(json) { this.sent.push(JSON.parse(json)); }
  close() { this.readyState = this.CLOSED; this.emit('close', 1000, 'client-close'); }
  serverFrame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  simulateOpen() { this.readyState = this.OPEN; this.emit('open'); }
}

// 4800 bytes of 16-bit mono PCM at 24 kHz = 2400 samples = exactly 100 ms.
// Its base64 is 6400 characters, so counting base64 length cannot pass.
const PCM_100MS = Buffer.alloc(4800, 1).toString('base64');

function captureLogger() {
  const lines = [];
  return { lines, info: (event, fields) => lines.push({ event, fields }), warn: (event, fields) => lines.push({ event, fields }) };
}

async function openTracedSession(logger, onTranscript) {
  const sockets = [];
  const createSocket = trace.wrapLiveSocket(() => { const s = new FakeSocket(); sockets.push(s); return s; }, { config: { LIVE_FRAME_TRACE: true }, logger });
  const transcripts = [];
  const session = createLiveSession({
    config: {}, bus: { emit() {} }, logger, spend: { recordCall() {} },
    breakers: { allow: () => true, fail() {}, success() {} },
    systemInstruction: 'test', functionDeclarations: [],
    onAudioOut: () => {}, onTranscript: (t) => { transcripts.push(t); if (onTranscript) onTranscript(t); },
    onState: () => {}, onTurnComplete: () => {}, createSocket,
  });
  process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'test-key';
  const opened = session.open();
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  await opened;
  return { session, socket: sockets[0], transcripts };
}

const frames = (logger) => logger.lines.filter((l) => l.event === 'live.frame').map((l) => l.fields);

describe('live.frame trace (C0): one numbers-only line per turn frame', () => {
  test('(a) one line per frame, with cumulative audio ms and output chars that are exact', async () => {
    const logger = captureLogger();
    const { session, socket, transcripts } = await openTracedSession(logger);
    socket.serverFrame({ serverContent: { inputTranscription: { text: 'what time is it' } } });
    socket.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: PCM_100MS } }] }, outputTranscription: { text: 'It is ' } } });
    socket.serverFrame({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: PCM_100MS } }, { inlineData: { mimeType: 'audio/pcm;rate=24000', data: PCM_100MS } }] } } });
    socket.serverFrame({ serverContent: { outputTranscription: { text: 'three o\'clock.' } } });
    socket.serverFrame({ serverContent: { generationComplete: true } });
    socket.serverFrame({ serverContent: { turnComplete: true } });
    socket.serverFrame({ toolCall: { functionCalls: [] } }); // next turn's first frame
    const f = frames(logger);
    assert.equal(f.length, 7, 'one live.frame per turn-content frame; setupComplete is not one');
    assert.deepEqual(f.map((x) => x.seq), [0, 1, 2, 3, 4, 5, 0]);
    assert.deepEqual(f.map((x) => x.turnId), [1, 1, 1, 1, 1, 1, 2], 'the turnComplete frame belongs to the turn it ends');
    assert.deepEqual(f.map((x) => x.audioMsSoFar), [0, 100, 300, 300, 300, 300, 0]);
    assert.deepEqual(f.map((x) => x.outCharsSoFar), [0, 6, 6, 20, 20, 20, 0]);
    assert.deepEqual(f.map((x) => x.inTxChars), [15, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(f.map((x) => x.fields), ['inputTranscription', 'modelTurn,outputTranscription', 'modelTurn',
      'outputTranscription', 'generationComplete', 'turnComplete', 'toolCall']);
    for (const x of f) assert.ok(Number.isFinite(x.msSinceTurnStart) && x.msSinceTurnStart >= 0);
    assert.ok(transcripts.some((t) => t.role === 'assistant'), 'the session itself still handled every frame');
    session.close();
  });

  test('(b) no line carries transcript text', async () => {
    const logger = captureLogger();
    const { session, socket } = await openTracedSession(logger);
    socket.serverFrame({ serverContent: { inputTranscription: { text: 'secretoperatorword' }, outputTranscription: { text: 'secretreplyword' }, turnComplete: true } });
    const all = JSON.stringify(frames(logger));
    assert.ok(frames(logger).length === 1);
    assert.ok(!all.includes('secretoperatorword') && !all.includes('secretreplyword'), all);
    session.close();
  });

  test('(c) the line has exactly the design\'s keys', async () => {
    const logger = captureLogger();
    const { session, socket } = await openTracedSession(logger);
    socket.serverFrame({ serverContent: { outputTranscription: { text: 'x' } } });
    assert.deepEqual(Object.keys(frames(logger)[0]).sort(),
      ['audioMsSoFar', 'fields', 'inTxChars', 'msSinceTurnStart', 'outCharsSoFar', 'seq', 'turnId']);
    session.close();
  });

  test('(d) MUST KEEP PASSING: off by default — the factory comes back untouched and nothing is logged', () => {
    const factory = () => new FakeSocket();
    const logger = captureLogger();
    assert.equal(trace.wrapLiveSocket(factory, { config: {}, logger }), factory);
    assert.equal(trace.wrapLiveSocket(undefined, { config: { LIVE_FRAME_TRACE: false }, logger }), undefined,
      'production passes undefined; off must keep it undefined so live-session picks the real ws');
    assert.equal(logger.lines.length, 0);
  });

  test('(e) a trace that throws can never stop live-session handling the frame', async () => {
    const logger = captureLogger();
    const { session, socket, transcripts } = await openTracedSession(logger);
    const realInfo = logger.info;
    logger.info = (event, fields) => { if (event === 'live.frame') throw new Error('logger down'); realInfo(event, fields); };
    socket.serverFrame({ serverContent: { outputTranscription: { text: 'still heard' } } });
    assert.ok(transcripts.some((t) => t.text === 'still heard'), 'the session handler still ran');
    session.close();
  });

  test('(f) the text-lane latency line is numbers only and refuses an unmeasured turn', () => {
    assert.deepEqual(trace.textLaneLatency(1000, 2500), { msToFirstChunk: 1500 });
    assert.equal(trace.textLaneLatency(undefined, 2500), null, 'no mic-stop time: no sample, never an estimate');
    assert.equal(trace.textLaneLatency(3000, 2500), null, 'a negative delta is a clock problem, not a latency');
  });

  test('(g) server/index.js routes the Live socket factory and the text-lane first chunk through this module', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    assert.match(src, /createSocket:\s*require\('\.\.\/src\/core\/voice\/live-frame-trace'\)\.wrapLiveSocket\(createLiveSocket,/);
    assert.match(src, /voice\.text-lane-latency', require\('\.\.\/src\/core\/voice\/live-frame-trace'\)\.textLaneLatency\(micStoppedAt, Date\.now\(\)\)/);
  });

  test('(h) LIVE_FRAME_TRACE is a registered, documented flag that defaults off', () => {
    const { SCHEMA } = require('../src/core/config/schema');
    assert.deepEqual(SCHEMA.LIVE_FRAME_TRACE, { type: 'bool', default: false });
    const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    assert.match(example, /^# LIVE_FRAME_TRACE=false$/m);
  });
});
