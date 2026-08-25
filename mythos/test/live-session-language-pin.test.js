'use strict';

// test/live-session-language-pin.test.js — Wave 6 (2026-08-13).
//
// GEMINI_LIVE_LANGUAGE lets an operator pin the Live session's speech
// language (BCP-47) when a session's STT drifts into a different language
// mid-conversation. Default unset = auto-detect, unchanged from before this
// existed — this only proves the opt-in path actually reaches the wire
// setup frame, and that leaving it unset changes nothing.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLiveSession } = require('../src/core/voice/live-session');

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

function fakeDeps(config) {
  const sockets = [];
  const createSocket = () => { const s = new FakeSocket(); sockets.push(s); return s; };
  return {
    deps: {
      config: config || {},
      bus: { emit() {} },
      logger: { warn() {}, info() {} },
      spend: { recordCall() {} },
      breakers: { allow: () => true, fail() {}, success() {} },
      systemInstruction: 'test instruction',
      functionDeclarations: [],
      onAudioOut: () => {},
      onTranscript: () => {},
      onState: () => {},
      onTurnComplete: () => {},
      createSocket,
    },
    sockets,
  };
}

async function openAndGetSetup(config) {
  process.env.GOOGLE_API_KEY = 'test-key';
  const { deps, sockets } = fakeDeps(config);
  const session = createLiveSession(deps);
  const openPromise = session.open();
  sockets[0].simulateOpen();
  sockets[0].serverFrame({ setupComplete: {} });
  await openPromise;
  const setupFrame = sockets[0].sent.find((f) => f.setup);
  session.close();
  return setupFrame.setup;
}

describe('GEMINI_LIVE_LANGUAGE — Wave 6 language pin', () => {
  test('unset (default) never adds languageCode — auto-detect stays the default', async () => {
    const setup = await openAndGetSetup({});
    assert.equal(setup.generationConfig.speechConfig.languageCode, undefined);
    // voiceConfig must still be present and untouched.
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  });

  test('an explicit language pins languageCode on the wire setup frame', async () => {
    const setup = await openAndGetSetup({ GEMINI_LIVE_LANGUAGE: 'es-ES' });
    assert.equal(setup.generationConfig.speechConfig.languageCode, 'es-ES');
  });

  test('whitespace-only language is treated as unset', async () => {
    const setup = await openAndGetSetup({ GEMINI_LIVE_LANGUAGE: '   ' });
    assert.equal(setup.generationConfig.speechConfig.languageCode, undefined);
  });

  test('a pinned language coexists with a custom voice — both apply independently', async () => {
    const setup = await openAndGetSetup({ GEMINI_LIVE_LANGUAGE: 'fr-FR', GEMINI_LIVE_VOICE: 'Kore' });
    assert.equal(setup.generationConfig.speechConfig.languageCode, 'fr-FR');
    assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  });
});
