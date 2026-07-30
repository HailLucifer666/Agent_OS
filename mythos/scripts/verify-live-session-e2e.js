'use strict';

// verify-live-session-e2e.js — end-to-end proof that MYTHOS's OWN
// live-session.js module (not a hand-rolled probe) can open a real Gemini
// Live socket, take synthetic 16kHz PCM in, and get real 24kHz audio +
// transcripts back out through the module's real onAudioOut/onTranscript/
// onTurnComplete callbacks.
//
// Distinct from scripts/verify-gemini-live.js (which talks to the raw wire
// protocol directly to answer "does this key have Live access at all?"):
// this script exercises mythos/src/core/voice/live-session.js's actual
// createLiveSession() — the real module Phase 5's server wiring uses — with
// a real 'ws' connection to the real Gemini endpoint, over a real API key.
//
// Read-only, honest-inert: reports real byte counts and real transcript text,
// or an explicit failure. Never fabricates a pass.
//
// Run:  node scripts/verify-live-session-e2e.js
// Exit: 0 = real audio + turnComplete observed through live-session.js
//       1 = connected but no audio/turnComplete within the timeout
//       2 = no GOOGLE_API_KEY configured

const path = require('path');

if (!process.env.GOOGLE_API_KEY && typeof process.loadEnvFile === 'function') {
  for (const rel of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env.local')]) {
    try { process.loadEnvFile(rel); } catch { /* optional */ }
    if (process.env.GOOGLE_API_KEY) break;
  }
}

if (!process.env.GOOGLE_API_KEY) {
  console.error('FAIL: GOOGLE_API_KEY unset — cannot run the live-session.js end-to-end probe.');
  process.exit(2);
}

const { createLiveSession } = require('../src/core/voice/live-session');

// 1.5s of 16kHz mono 440Hz tone, base64 PCM — a real signal, not silence.
function tone(ms, rate, hz) {
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
  }
  return buf.toString('base64');
}

const stubBus = { emit() {}, subscribe() {} };
const stubLogger = { info() {}, warn() {}, error() {} };
const stubBreakers = { allow: () => true, fail() {}, success() {} };
const stubSpend = { recordCall(rec) { console.log('  usageMetadata -> spend.recordCall:', JSON.stringify(rec)); } };

let audioBytes = 0;
let transcript = '';
let turnCompleted = false;
let sawSetupState = null;

const session = createLiveSession({
  config: {}, // defaults: gemini-3.1-flash-live-preview, voice Aoede
  bus: stubBus,
  logger: stubLogger,
  spend: stubSpend,
  breakers: stubBreakers,
  systemInstruction: 'Reply with one short spoken sentence in response to whatever the user sends.',
  functionDeclarations: [],
  onAudioOut: (b64) => { audioBytes += Buffer.from(b64, 'base64').length; },
  onTranscript: (t) => { if (t.role === 'assistant') transcript += t.text; },
  onState: (s) => { sawSetupState = s.state; console.log('  live-session state ->', s.state, s.reason || ''); },
  onTurnComplete: (turn) => {
    turnCompleted = true;
    console.log('  onTurnComplete ->', JSON.stringify(turn));
  },
});

(async () => {
  console.log('Opening a real Gemini Live socket through live-session.js ...');
  const opened = await session.open();
  if (!opened) {
    console.error('FAIL: live-session.js could not open (state:', sawSetupState, ')');
    process.exit(1);
  }
  console.log('Session open. Sending synthetic PCM + a text nudge (tone alone may not trip VAD) ...');
  session.sendAudio(tone(1500, 16000, 440));
  session.sendText('Say hello in one short sentence.');

  const deadline = Date.now() + 20000;
  while (!turnCompleted && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  session.close('probe-done');

  console.log('');
  console.log('audioBytes:', audioBytes);
  console.log('transcript:', JSON.stringify(transcript));
  console.log('turnCompleted:', turnCompleted);

  if (turnCompleted && audioBytes > 0) {
    console.log('\nPASS: live-session.js delivered real audio and a real turnComplete through its own onAudioOut/onTurnComplete callbacks.');
    process.exit(0);
  }
  console.error('\nFAIL: no audio and/or no turnComplete observed within the timeout.');
  process.exit(1);
})();
