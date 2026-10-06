'use strict';

// test/bug-170-reasoning-strip-and-silent-turn.test.js — BUG-170.
//
// Two symptoms from the same 2026-08-07 session, both in live-session.js:
//
// 1. "Reasoning:" reached the operator three times. BUG-118 had already added
//    a `p.thought === true` filter for exactly this and deliberately refused
//    to regex-strip, arguing a prefix match would eat legitimate replies. The
//    leak arriving anyway is the evidence that decision was waiting for: the
//    thought flag is never set on this model, so the filter never fires. The
//    strip added here is narrower than the one BUG-118 refused — start of the
//    turn only, a recognised label only, and it removes the LABEL, not the
//    text behind it — and every strip is logged, so a false positive is
//    findable instead of silent. The tests below spend more assertions on
//    what it must NOT strip than on what it must.
//
// 2. One turn produced reply text and no audio. From the room that is
//    indistinguishable from being ignored: the HUD shows an answer, nothing is
//    said. live-turn-no-transcript did not cover it (that fires only when the
//    turn is empty on BOTH channels). The session now reports it and hands the
//    text to the caller, which speaks it through the TTS chain.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { createLiveSession, stripReasoningLead } = require('../src/core/voice/live-session');

describe('BUG-170 — stripReasoningLead strips the label, never the reply', () => {
  it('strips the labels actually observed leaking', () => {
    for (const lead of ['Reasoning: ', 'reasoning:', 'Thinking: ', 'THOUGHT: ', 'Chain-of-thought: ', '**Reasoning:** ']) {
      const r = stripReasoningLead(lead + 'the volume is now 40 percent');
      assert.equal(r, 'the volume is now 40 percent', 'must strip: ' + JSON.stringify(lead));
    }
  });

  it('leaves a legitimate reply that merely talks about reasoning alone', () => {
    const keep = [
      'My reasoning was that Spotify had no live audio session.',
      'I was thinking we could try the other browser.',
      'Reasoning about this out loud helps.',            // no colon
      'The thought occurred to me.',
      "Here's the plan: open Spotify, then set the volume.", // a colon, not a label
    ];
    for (const text of keep) {
      const r = stripReasoningLead(text);
      assert.equal(r, text, 'must NOT strip: ' + text);
    }
  });

  it('removes only the label, never the content behind it', () => {
    const r = stripReasoningLead('Reasoning: I should check the window title first.');
    assert.equal(r, 'I should check the window title first.');
  });

  it('tolerates empty and non-string input', () => {
    assert.equal(stripReasoningLead(''), '');
    assert.equal(stripReasoningLead(null), null);
  });
});

// A live session driven entirely through its injected socket seam — no
// network, no real ws. handleFrame is reached by emitting 'message' exactly
// as the real transport does.
function makeHarness(overrides) {
  const transcripts = [];
  const logs = [];
  const anomalies = [];
  const busEvents = [];
  const silentTurns = [];
  const audioOut = [];

  // Same 'ws'-shaped fake the existing live-session tests use: readyState +
  // OPEN/CLOSED constants matter, sendRaw() checks them.
  const socket = new EventEmitter();
  socket.OPEN = 1;
  socket.CLOSED = 3;
  socket.readyState = 0;
  socket.sent = [];
  socket.send = (json) => socket.sent.push(JSON.parse(json));
  socket.close = () => { socket.readyState = socket.CLOSED; socket.emit('close', 1000, 'client-close'); };

  const session = createLiveSession(Object.assign({
    // The real default model since 2026-10-06 (was 'models/test'): an unclassified
    // model id is refused for the 'live' job unless chosen (BUG-467 closure), and
    // the session would never open. These tests are about transcripts, not models.
    config: { GEMINI_LIVE_MODEL: 'models/gemini-3.1-flash-live-preview', LIVE_IDLE_TIMEOUT_MS: 600000 },
    // B3 (2026-08-14): busEvents captures EVERY emit, not just health.anomaly, so
    // the reasoning strip can be asserted on its own channel after it was moved
    // off the fault channel. `anomalies` still holds only health.anomaly, which is
    // what the other tests in this file legitimately assert on.
    bus: {
      emit: (type, payload) => {
        busEvents.push({ type, payload });
        if (type === 'health.anomaly') anomalies.push(payload);
      },
    },
    logger: {
      info: (msg, data) => logs.push({ level: 'info', msg, data }),
      warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
      error: () => {}, debug: () => {},
    },
    systemInstruction: 'test',
    functionDeclarations: [],
    onAudioOut: (b64) => audioOut.push(b64),
    onTranscript: (t) => transcripts.push(t),
    onSilentTurn: (t) => silentTurns.push(t),
    createSocket: () => socket,
  }, overrides || {}));

  // open() awaits setupComplete; drive it.
  const prevKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = 'test-key';
  const opened = session.open().finally(() => {
    if (prevKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = prevKey;
  });
  socket.readyState = socket.OPEN;
  socket.emit('open');
  socket.emit('message', Buffer.from(JSON.stringify({ setupComplete: {} })));

  const frame = (msg) => socket.emit('message', Buffer.from(JSON.stringify(msg)));
  return { session, opened, frame, transcripts, logs, anomalies, busEvents, silentTurns, audioOut };
}

describe('BUG-170 — a leaked reasoning label never reaches the transcript', () => {
  it('strips it from outputTranscription and says so, naming the channel that already spoke it', async () => {
    const h = makeHarness();
    await h.opened;

    h.frame({ serverContent: { outputTranscription: { text: 'Reasoning: I will check the title.' } } });

    assert.equal(h.transcripts.length, 1);
    assert.equal(h.transcripts[0].text, 'I will check the title.');

    const stripLog = h.logs.find((l) => l.msg === 'live.reasoning-stripped');
    assert.ok(stripLog, 'a strip must never be silent');
    assert.equal(stripLog.data.channel, 'outputTranscription');
    assert.equal(stripLog.data.spokenAnyway, true,
      'outputTranscription mirrors the AUDIO — the operator already heard it, and the log must say so');
    // B3 (2026-08-14): the strip is still announced on the bus — BUG-170's "a
    // strip is never silent" rule is intact — but NOT on health.anomaly. It fired
    // 24 times in one session and produced 24 no-match heal round trips while
    // being a report that the filter WORKED, i.e. that the leak never reached the
    // operator. Same reasoning and same remedy as voice.live.idle-closed
    // (2026-08-10), where the explainer narrated a normal socket close as a fault.
    const filtered = h.busEvents.find((e) => e.type === 'voice.live.reasoning-filtered');
    assert.ok(filtered, 'a strip must never be silent — it moved channel, it did not disappear');
    assert.equal(filtered.payload.channel, 'outputTranscription');
    assert.equal(filtered.payload.spokenAnyway, true,
      'the one fact that decides whether a text filter could ever have been enough must survive the move');
    assert.equal(h.anomalies.some((a) => a.kind === 'live-reasoning-leak'), false,
      'and it must no longer reach the fault channel, or the immune system keeps diagnosing a success');
  });

  it('strips it from an unflagged modelTurn text part — the case BUG-118\'s thought filter misses', async () => {
    const h = makeHarness();
    await h.opened;

    // No `thought: true`. That is the whole point: BUG-118's filter is a no-op
    // against this frame, which is why the leak survived it.
    h.frame({ serverContent: { modelTurn: { parts: [{ text: 'Reasoning: the app has no audio session.' }] } } });

    assert.equal(h.transcripts[0].text, 'the app has no audio session.');
    const stripLog = h.logs.find((l) => l.msg === 'live.reasoning-stripped');
    assert.equal(stripLog.data.channel, 'modelTurn.part');
  });

  it('does not strip mid-reply, where a label is not what a leak looks like', async () => {
    const h = makeHarness();
    await h.opened;

    h.frame({ serverContent: { outputTranscription: { text: 'Sure. ' } } });
    h.frame({ serverContent: { outputTranscription: { text: 'Reasoning: is what I do.' } } });

    assert.equal(h.transcripts[1].text, 'Reasoning: is what I do.');
    assert.equal(h.logs.filter((l) => l.msg === 'live.reasoning-stripped').length, 0);
  });
});

describe('BUG-170 — a turn with text but no audio is spoken, not dropped', () => {
  it('reports the silent turn and hands the shown text to the caller', async () => {
    const h = makeHarness();
    await h.opened;

    h.frame({ serverContent: { outputTranscription: { text: 'The volume is at forty percent.' } } });
    h.frame({ serverContent: { turnComplete: true } });

    assert.equal(h.audioOut.length, 0, 'precondition: this turn made no sound');
    assert.equal(h.silentTurns.length, 1, 'the caller must be told so it can speak it another way');
    assert.equal(h.silentTurns[0].text, 'The volume is at forty percent.');
    assert.ok(h.anomalies.some((a) => a.kind === 'live-turn-silent'));
    assert.ok(h.logs.some((l) => l.msg === 'live.turn-silent'));
  });

  it('a turn that DID produce audio is not reported as silent', async () => {
    const h = makeHarness();
    await h.opened;

    h.frame({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    h.frame({ serverContent: { outputTranscription: { text: 'Done.' } } });
    h.frame({ serverContent: { turnComplete: true } });

    assert.equal(h.audioOut.length, 1);
    assert.equal(h.silentTurns.length, 0);
    assert.equal(h.anomalies.filter((a) => a.kind === 'live-turn-silent').length, 0);
  });

  it('an entirely empty turn stays the existing no-transcript anomaly, not a silent-turn one', async () => {
    const h = makeHarness();
    await h.opened;

    h.frame({ serverContent: { turnComplete: true } });

    assert.equal(h.silentTurns.length, 0, 'there is no text to speak — this is the blind case, not the mute one');
    assert.ok(h.anomalies.some((a) => a.kind === 'live-turn-no-transcript'));
  });

  it('the audio-part counter resets between turns', async () => {
    const h = makeHarness();
    await h.opened;

    h.frame({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
    h.frame({ serverContent: { outputTranscription: { text: 'First.' } } });
    h.frame({ serverContent: { turnComplete: true } });
    h.frame({ serverContent: { outputTranscription: { text: 'Second, silently.' } } });
    h.frame({ serverContent: { turnComplete: true } });

    assert.equal(h.silentTurns.length, 1, 'the second turn must be caught despite the first one having audio');
    assert.equal(h.silentTurns[0].text, 'Second, silently.');
  });
});

describe('BUG-170 — the server speaks a silent turn through the TTS chain', () => {
  const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

  it('wires onSilentTurn to proactiveSpeak with skipLive', () => {
    assert.match(SERVER, /onSilentTurn:/, 'server/index.js must wire the callback at all');
    const block = /onSilentTurn:[\s\S]{0,950}?\n\s{10}\},/.exec(SERVER);
    assert.ok(block, 'onSilentTurn handler must be findable');
    assert.match(block[0], /proactiveSpeak\(text, ws, \{ skipLive: true \}\)/,
      'it must route to the TTS chain, and skipLive is what stops it going back into the session that just failed to speak');
  });

  it('proactiveSpeak honours skipLive on both of its Live branches', () => {
    assert.match(SERVER, /const skipLive = !!\(opts && opts\.skipLive\)/);
    assert.match(SERVER, /!skipLive && targetWs && typeof targetWs\.getLiveSession/,
      'the existing-session branch must be skippable');
    assert.match(SERVER, /if \(!skipLive && !\(liveSession && liveSession\.isOpen\(\)\)/,
      'the open-one-on-demand branch must be skippable too — otherwise it opens a session to re-speak into');
  });
});
