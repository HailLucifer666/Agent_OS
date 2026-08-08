'use strict';

// verify-node-playback.js — prove that a phone node actually PLAYS a reply.
//
// WHY THIS EXISTS SEPARATELY FROM verify-voice-nodes.js. That script drives
// everything above the BLE radio against the real aggregator, but it cannot make
// a phone emit sound: MYTHOS only routes speech to a node that Aether has ELECTED
// (server/index.js nodeSpeechTarget), election needs beacon readings, and readings
// need a physical watch. So on a rig with no beacon the reply is spoken locally —
// correct fail-honest behaviour, and a complete blind spot for the phone's audio
// path.
//
// This script closes that spot by removing election from the picture entirely. It
// speaks the SERVER half of the node protocol and nothing else: accept a socket,
// wait for `identify`, then send the exact frames VoiceNodeService.consumeInbound()
// handles — `speech-chunk` with base64 audio, then `done`. If the phone makes a
// sound, SpeechPlayer/ExoPlayer works on a real device. If it does not, the fault
// is in the phone and nowhere else, which is the whole point of testing it alone.
//
// It matters that this runs at all: SpeechPlayer's Looper marshalling was written
// to fix a crash found by reading the code, and has never once executed on real
// hardware. A unit test cannot run it — the thread-affinity contract belongs to
// ExoPlayer at runtime.
//
// DELIBERATELY NOT UNDER node --test. Every file in mythos/test/ is collected by
// the suite, and this one needs a human holding a phone. Same reasoning as
// verify-voice-nodes.js.
//
//   node mythos/scripts/verify-node-playback.js
//   → point the phone's MYTHOS address at the printed ws:// URL, save, listen.

const http = require('node:http');
const os = require('node:os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.VERIFY_PLAYBACK_PORT) || 4479;
const EDGE_TTS_URL = process.env.EDGE_TTS_URL || 'http://127.0.0.1:5050';
// A node that connects but never identifies is a different failure from one that
// never connects; both are worth failing on rather than hanging forever.
const WAIT_MS = Number(process.env.VERIFY_PLAYBACK_WAIT_MS) || 120000;

function log(msg) { process.stdout.write(`${msg}\n`); }

/** The LAN address to type into the phone. Loopback is useless to another device. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/**
 * One second of 440 Hz, as a RIFF/WAVE PCM16 buffer.
 *
 * The fallback when edge-tts is not running. A tone is enough to answer the
 * question this script asks — did any audio reach the speaker — and it needs no
 * network, no key and no sidecar.
 */
function toneWav(seconds = 1, freq = 440, sampleRate = 16000) {
  const n = sampleRate * seconds;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);       // PCM
  h.writeUInt16LE(1, 22);       // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Real speech from the edge-tts sidecar when it is up, because the two formats
 * take DIFFERENT decode paths inside ExoPlayer: edge-tts emits mp3, gemini/piper
 * emit wav. A rig that only ever proved wav would leave the format most replies
 * actually arrive in untested.
 */
async function speechChunk(text) {
  try {
    const res = await fetch(`${EDGE_TTS_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice: 'en-US-AriaNeural',
        response_format: 'mp3',
        rate: '+0%',
        pitch: '+0Hz',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { audio: buf, mime: 'audio/mpeg', real: true };
  } catch (err) {
    // Not fatal, but say so: "you heard a beep" and "you heard a sentence" test
    // different decoders, and the operator must know which one they just proved.
    log(`  edge-tts unavailable (${err.message}) — falling back to a generated WAV tone.`);
    log('  This still proves playback, but exercises the wav path, NOT the mp3 one');
    log('  that real edge-tts replies use.');
    return { audio: toneWav(), mime: 'audio/wav', real: false };
  }
}

async function main() {
  const lines = [
    'This is the MYTHOS phone node speaking.',
    'If you can hear this sentence, the audio path works end to end.',
  ];

  log('');
  log('  MYTHOS — phone node playback check');
  log('  ----------------------------------');
  log('  Set the phone\'s MYTHOS address to:');
  log('');
  log(`      ws://${lanAddress()}:${PORT}`);
  log('');
  log('  ...then Save and reconnect. The node id and token do not matter here —');
  log('  this script is not MYTHOS and checks neither.');
  log('');
  log('  IMPORTANT: put the address back to your real MYTHOS afterwards.');
  log('');

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  let identified = false;

  const done = new Promise((resolve) => {
    wss.on('connection', (ws, req) => {
      log(`  → node connected from ${req.socket.remoteAddress}`);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type !== 'identify') return;
        if (identified) return;
        identified = true;
        log(`  → identified as "${msg.nodeId}" — sending speech`);

        for (const [i, line] of lines.entries()) {
          const chunk = await speechChunk(line);
          // The exact frame VoiceNodeService.consumeInbound() expects. `text`
          // rides along so the caption is right even when audio is absent —
          // matching what the real server sends.
          ws.send(JSON.stringify({
            type: 'speech-chunk',
            audioB64: chunk.audio.toString('base64'),
            mime: chunk.mime,
            text: line,
          }));
          log(`  → chunk ${i + 1}/${lines.length} sent (${chunk.mime}, ${chunk.audio.length} bytes${chunk.real ? '' : ', generated tone'})`);
        }
        ws.send(JSON.stringify({ type: 'done', say: lines.join(' ') }));
        log('  → done frame sent');
        log('');
        log('  LISTEN NOW. The phone should speak within a second or two.');
        log('  Chunks queue into ONE playlist, so it should sound continuous,');
        log('  not like two separate clips.');
        log('');
        log('  If nothing plays, `adb logcat` will show whether ExoPlayer threw —');
        log('  a wrong-thread IllegalStateException is the failure this checks for.');
        setTimeout(() => resolve(true), 15000);
      });

      ws.on('close', () => log('  → node disconnected'));
    });
  });

  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), WAIT_MS));

  await new Promise((resolve, reject) => {
    server.listen(PORT, '0.0.0.0', resolve);
    server.on('error', reject);
  });
  log(`  listening on 0.0.0.0:${PORT} — waiting for the phone...`);

  const ok = await Promise.race([done, timeout]);
  wss.close();
  server.close();

  if (!ok) {
    log('');
    if (!identified) {
      log('  FAILED: no node identified within the wait window.');
      log('  The phone never reached this script. Check that the address above is');
      log('  exactly what is in the app, that both are on the same Wi-Fi, and that');
      log('  the phone shows a reason under its NO LINK chip.');
    } else {
      log('  FAILED: the node identified but the exchange did not complete.');
    }
    process.exitCode = 2;
    return;
  }

  log('  Frames delivered. Whether SOUND came out is yours to confirm — this');
  log('  script can prove delivery and nothing beyond it. "Routed" is not "spoken".');
}

main().catch((err) => {
  log(`  FAILED: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
