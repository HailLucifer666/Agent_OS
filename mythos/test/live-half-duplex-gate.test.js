'use strict';

// live-half-duplex-gate.test.js — BUG-224. MYTHOS's own Live voice must not be
// fed back to Gemini's server-side VAD.
//
// THE BUG THIS FILE EXISTS FOR (operator, 2026-08-14): "it keeps interrupting,
// I'm not even done", and "the very last word of a sentence is half spoken, like
// it was hard stopped".
//
// One mechanism produces both. Gemini Live's VAD is configured
// START_SENSITIVITY_HIGH (live-session.js) so speech onset is caught fast. The
// model's own reply comes out of the speakers, back in through the mic, and
// s2s-bridge streamed those frames straight on to that VAD — so it heard its own
// trailing word, decided the operator had started talking, and fired
// serverContent.interrupted. The server then STOPS SYNTHESIZING mid-word.
//
// That is why pcm-player's 250ms tail guard (BUG-084) never cured the clipping:
// it protects audio already buffered on the client, and cannot recover a word
// the server never sent. The cut happens upstream of the client entirely.
//
// The two properties under test are what stop this being a mute button:
//   1. the barge-in backstop keeps observing every frame while the gate is held,
//      so a real interruption is still detected and opens the gate;
//   2. frames held during the gate are replayed on release, so the first word of
//      an interruption is not swallowed.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const VOICE_DIR = path.join(__dirname, '..', 'ui', 'public', 'js', 'voice');
const bridgeSrc = fs.readFileSync(path.join(VOICE_DIR, 's2s-bridge.js'), 'utf8');

// pcm-player.js is a browser ES module, loaded through its contextFactory seam —
// same dynamic-import pattern as test/pcm-player.test.js.
const PCM_PLAYER_URL = pathToFileURL(path.join(VOICE_DIR, 'pcm-player.js')).href;

function fakeSource() {
  const src = {
    buffer: null, connect() {}, onended: null, stopped: false,
    start() {}, stop() { src.stopped = true; if (src.onended) src.onended(); },
  };
  return src;
}

function fakeContext() {
  return {
    state: 'running',
    currentTime: 0,
    async resume() {},
    async close() {},
    createBuffer(_ch, len, rate) {
      return { duration: len / rate, getChannelData: () => new Float32Array(len) };
    },
    createBufferSource() { return fakeSource(); },
    destination: {},
  };
}

// One 100ms chunk of 24kHz 16-bit PCM, base64 — the shape enqueue() expects.
const CHUNK = Buffer.alloc(2400 * 2).toString('base64');

describe('BUG-224 half-duplex gate — source shape', () => {
  it('the mic frame handler gates the SEND, not the barge-in observer', () => {
    const start = bridgeSrc.indexOf('captureNode.port.onmessage');
    assert.ok(start !== -1, 'the mic frame handler must exist');
    const body = bridgeSrc.slice(start, start + 1200);

    const observeAt = body.indexOf('bargeBackstop.observe');
    const gateAt = body.indexOf('if (ownVoiceGate)');
    const sendAt = body.indexOf("sendMessage({ type: 'live-audio'");

    assert.ok(observeAt !== -1 && gateAt !== -1 && sendAt !== -1,
      'handler must observe, then gate, then send');
    assert.ok(observeAt < gateAt,
      'bargeBackstop.observe() must run BEFORE the own-voice gate returns — gating it too '
      + '(the way the media gate does) disables barge-in exactly while MYTHOS is speaking, '
      + 'which is the only time barge-in matters');
    assert.ok(gateAt < sendAt,
      'the gate must return before the send, or the echo still reaches Gemini\'s VAD');
  });

  it('a held frame is buffered for replay, not dropped', () => {
    const start = bridgeSrc.indexOf('if (ownVoiceGate)');
    const body = bridgeSrc.slice(start, start + 300);
    assert.match(body, /preroll\.push/,
      'frames held during the gate must be kept — without replay, "stop, actually..." '
      + 'reaches the model as "actually..."');
    assert.match(body, /preroll\.length > PREROLL_MAX_FRAMES/,
      'the preroll must be bounded, or a long reply grows it without limit');
  });

  it('a real barge-in opens the gate immediately', () => {
    // The CALL, not the import line at the top of the file.
    const start = bridgeSrc.indexOf('createBargeInBackstop({');
    assert.ok(start !== -1, 'the backstop must be constructed with options');
    const body = bridgeSrc.slice(start, start + 400);
    assert.match(body, /releaseOwnVoiceGate\('barge-in'\)/,
      'the local backstop is the ONLY thing that can notice the operator while the gate is '
      + 'held, so it must open it — otherwise interrupting MYTHOS is impossible');
  });

  it('the gate fails open on a ceiling, like every other suspend in this file', () => {
    assert.match(bridgeSrc, /MAX_OWN_VOICE_HOLD_MS/,
      'a gate with no ceiling leaves Live permanently deaf if onSpeakEnd never arrives');
    const holdBody = bridgeSrc.slice(bridgeSrc.indexOf('function holdOwnVoiceGate'), bridgeSrc.indexOf('function releaseOwnVoiceGate'));
    assert.match(holdBody, /setTimeout/, 'the ceiling must actually be armed when the gate is held');
    assert.match(bridgeSrc, /ceiling-fail-open/, 'the fail-open must be logged, not silent');
  });

  it('the operator can turn it off without a rebuild', () => {
    assert.match(bridgeSrc, /MYTHOS_LIVE_HALF_DUPLEX/,
      'an acoustic change that cannot be reverted in the field is not shippable — '
      + 'same localStorage idiom the VAD constants already use');
  });
});

describe('BUG-224 pcm-player — speech edges drive the gate', () => {
  it('fires onSpeakStart once per utterance, not once per chunk', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    let starts = 0;
    const player = createPcmPlayer({ contextFactory: fakeContext, onSpeakStart: () => { starts += 1; } });

    player.enqueue(CHUNK);
    player.enqueue(CHUNK);
    player.enqueue(CHUNK);

    assert.equal(starts, 1,
      'a reply arrives as many chunks; holding the gate must be one edge, not one per frame');
  });

  it('a barge-in cut reports the end of speech, so the mic reopens', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    let ends = 0;
    const ctx = fakeContext();
    const player = createPcmPlayer({ contextFactory: () => ctx, onSpeakEnd: () => { ends += 1; } });

    // Four 100ms chunks leaves ~340ms scheduled ahead of currentTime 0, which is
    // past the 250ms tail guard — so flush() really stops instead of letting a
    // nearly-finished reply run out (that guard is BUG-084 and is tested in
    // test/pcm-player.test.js; here it must NOT be the thing under test).
    player.enqueue(CHUNK);
    player.enqueue(CHUNK);
    player.enqueue(CHUNK);
    player.enqueue(CHUNK);
    player.flush();

    assert.equal(ends, 1,
      'interrupting MYTHOS must reopen the mic immediately — otherwise the operator stays '
      + 'muted until the timer measuring the audio we just discarded expires');
  });

  it('close() ends speech too, so a torn-down session cannot strand the gate', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    let ends = 0;
    const player = createPcmPlayer({ contextFactory: fakeContext, onSpeakEnd: () => { ends += 1; } });
    player.enqueue(CHUNK);
    player.close();
    assert.equal(ends, 1, 'close() is a real teardown and must release the gate');
  });

  it('a throwing callback cannot break playback', async () => {
    const { createPcmPlayer } = await import(PCM_PLAYER_URL);
    const player = createPcmPlayer({
      contextFactory: fakeContext,
      onSpeakStart: () => { throw new Error('boom'); },
    });
    assert.doesNotThrow(() => player.enqueue(CHUNK),
      'the gate is an optimisation; audio is the product. A bad listener must never '
      + 'take the voice down (same lesson as BUG-221\'s advisory SetFocus)');
  });
});
