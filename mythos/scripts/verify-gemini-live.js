'use strict';

// verify-gemini-live.js — does THIS key actually have Gemini Live API access?
//
// Phase 0.3 of the MYTHOS x IRIS synthesis plan, and a HARD BLOCKER for the
// native speech-to-speech work: lanes.default.js records that free Google keys
// return 429 on every Pro-tier Gemini model, and the Live API may be gated the
// same way. Find that out in one minute instead of after building a bridge to an
// endpoint the key cannot reach.
//
// Read-only probe. Opens a real WebSocket, sends a real setup frame plus a real
// audio buffer, and reports the actual number of audio bytes that came back.
// Honest-inert: it never reports success it did not observe.
//
// Run:  node scripts/verify-gemini-live.js
// Exit: 0 = a Live-capable model was found (prints which one)
//       1 = the key reached the endpoint but no model produced audio
//       2 = no key configured

const WebSocket = require('ws');
const path = require('path');

// Standalone scripts do not get main.js's env loading. Pull mythos/.env in the
// same way (process.loadEnvFile, no dotenv dependency) when the key is absent.
if (!process.env.GOOGLE_API_KEY && typeof process.loadEnvFile === 'function') {
  for (const rel of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env.local')]) {
    try { process.loadEnvFile(rel); } catch { /* optional */ }
    if (process.env.GOOGLE_API_KEY) break;
  }
}

const KEY = process.env.GOOGLE_API_KEY;
if (!KEY) {
  console.error('FAIL: GOOGLE_API_KEY unset (checked env, mythos/.env, .env.local)');
  process.exit(2);
}

// Candidates in preference order. gemini-3.1-flash-live-preview is Google's
// recommended Live model; the native-audio preview is the documented secondary.
const MODELS = [
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-preview-12-2025',
  'models/gemini-2.0-flash-live-001',
];

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + KEY;

// 1s of 16 kHz mono 440 Hz tone. A real signal, not silence — silence plus
// server-side VAD produces no reply at all, which would read as a false failure.
function tone(ms, rate, hz) {
  const sampleRate = rate || 16000;
  const freq = hz || 440;
  const n = Math.floor(sampleRate * (ms || 1000) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 12000), i * 2);
  }
  return buf.toString('base64');
}

function probe(model) {
  return new Promise((resolve) => {
    let ws;
    let audioBytes = 0;
    let transcript = '';
    let setupOk = false;
    let finished = false;

    function done(verdict, detail) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch { /* already closing */ }
      resolve({ model, verdict, detail: detail || '', audioBytes, transcript });
    }

    const timer = setTimeout(() => done(setupOk ? 'NO_AUDIO' : 'NO_SETUP', 'timeout 25s'), 25000);

    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      return done('ERROR', err.message);
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({
        setup: {
          model: model,
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: { parts: [{ text: 'Reply with one short spoken sentence.' }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.setupComplete && !setupOk) {
        setupOk = true;
        // Audio proves the realtimeInput audio path; the text nudge guarantees a
        // turn even if a pure tone does not trip VAD as speech.
        ws.send(JSON.stringify({
          realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: tone(1000, 16000, 440) } },
        }));
        ws.send(JSON.stringify({ realtimeInput: { text: 'Say hello in one short sentence.' } }));
        return;
      }

      const sc = msg.serverContent;
      if (sc) {
        // NOT else-if: one serverContent frame can carry audio AND transcripts
        // AND turnComplete simultaneously. Dropping fields here is the #1
        // data-loss bug in Live integrations.
        const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
        for (const p of parts) {
          if (p.inlineData && p.inlineData.data) {
            audioBytes += Buffer.from(p.inlineData.data, 'base64').length;
          }
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
          transcript += sc.outputTranscription.text;
        }
        if (sc.turnComplete) {
          return done(audioBytes > 0 ? 'PASS' : 'NO_AUDIO', 'turnComplete');
        }
      }

      if (msg.goAway) return done('GOAWAY', JSON.stringify(msg.goAway));
    });

    ws.on('error', (err) => done('ERROR', err.message));

    ws.on('close', (code, reason) => {
      const detail = ('code=' + code + ' ' + String(reason || '')).trim();
      if (audioBytes > 0) return done('PASS', detail);
      done(setupOk ? 'CLOSED_NO_AUDIO' : 'REJECTED', detail);
    });
  });
}

(async function main() {
  console.log('Probing Gemini Live with GOOGLE_API_KEY (' + KEY.length + ' chars)\n');
  const results = [];
  for (const model of MODELS) {
    const r = await probe(model);
    results.push(r);
    console.log(
      r.verdict.padEnd(16) + ' ' + r.model.padEnd(52) +
      ' audio=' + String(r.audioBytes).padStart(7) + 'B' +
      '  "' + r.transcript.slice(0, 50).replace(/\s+/g, ' ') + '"' +
      (r.detail ? '  ' + r.detail : '')
    );
    if (r.verdict === 'PASS') {
      console.log('\nPASS. Set this in mythos/.env:');
      console.log('  VOICE_S2S_ENABLED=true');
      console.log('  GEMINI_LIVE_MODEL=' + r.model);
      process.exit(0);
    }
  }
  console.error('\nFAIL: no Live-capable model on this key.');
  console.error('Plan Phases 1-5 (native speech-to-speech) are BLOCKED.');
  console.error('Phase 6 (persona unclamp) and Phase 7 (capability gaps) are unaffected — do those.');
  process.exit(1);
})();
