'use strict';

// providers/gemini-tts.js — Google Gemini TTS, so the entity can speak in the SAME
// voice on every path.
//
// WHY THIS EXISTS: `Aoede` is a Gemini prebuilt voice. Until now it was reachable
// only inside a Live (BidiGenerateContent) session, so the operator heard Aoede
// during conversation but edge-tts for the boot greeting and every proactive
// announcement — two different people (see test/voice-identity-consistent.test.js).
// The same prebuilt voices are also available on the NON-streaming TTS models via
// generateContent, which is what this wraps. One voice, every path.
//
// TRADE-OFFS, MEASURED 2026-07-31 against the real API, not estimated:
//   edge-tts                        ~900ms/sentence   free, unofficial endpoint
//   gemini-2.5-flash-preview-tts   ~3.9s/sentence    metered
//   gemini-3.1-flash-tts-preview   ~17.6s/sentence   metered  <- do not default to this
//
// RE-MEASURED 2026-09-11, and the ordering REVERSED. Same sentence, three
// samples each, alternating so a warm/cold effect could not land on one model:
//   gemini-2.5-flash-preview-tts   median 6382ms   [6162, 6382, 21015]
//   gemini-3.1-flash-tts-preview   median 5589ms   [4445, 5589, 5992]
// The 3.1 model is now both faster AND far steadier — the older one produced a
// 21-second outlier in three attempts, which in a voice path is a turn the
// operator hears nothing during. So DEFAULT_MODEL moved to 3.1 below.
//
// BOTH measurements are kept. The July numbers were not wrong when taken; a
// preview model changed under us, which is the argument for re-measuring rather
// than for trusting either figure indefinitely. One sample did NOT trigger this
// change — the first 2026-09-11 sample showed 5.5s vs 8.4s and was deliberately
// not acted on, because a single sample against a recorded contrary measurement
// is how a stale number gets replaced by a lucky one.
//
// So this is OFF by default. edge-tts stays the default for latency; this is opt-in
// via VOICE_TTS_PROVIDER=gemini for voice consistency, and it is also the path that
// avoids edge-tts's personal/hobby-only labelling. Whether either is licensed for a
// SOLD product is a question for a lawyer — deliberately not concluded here.
//
// AUDIO FORMAT: the API returns raw little-endian PCM (`audio/L16; rate=24000`),
// which `new Audio('data:...')` in the browser cannot play. synthesize() therefore
// wraps it in a WAV container and callers must ship mime 'audio/wav' — the client
// already supports a per-chunk mime (the reminder alert tone is a real WAV).

// Moved off gemini-2.5-flash-preview-tts 2026-09-11 on the re-measurement above.
// GEMINI_TTS_MODEL still overrides, so reverting is an env var and not a deploy.
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE = 'Aoede';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const HEALTH_CACHE_MS = 10000;
const HEALTH_FAIL_CACHE_MS = 1500; // same asymmetry as edge-tts: recover fast after boot

let _healthCache = { at: 0, ok: false };

function apiKey() {
  return process.env.GOOGLE_API_KEY || '';
}

// Wrap raw mono 16-bit PCM in a minimal WAV header. No dependency: the header is
// 44 fixed bytes and getting it wrong is audible immediately.
function pcmToWav(pcm, sampleRate) {
  const rate = Number(sampleRate) || 24000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // PCM chunk size
  header.writeUInt16LE(1, 20);           // format = PCM
  header.writeUInt16LE(1, 22);           // channels = mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);    // byte rate = rate * channels * bytesPerSample
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// 'audio/L16; rate=24000; channels=1' -> 24000. Defaults rather than throwing:
// a wrong rate is a chipmunk voice, a throw is silence.
function rateFromMime(mime) {
  const m = /rate=(\d+)/i.exec(String(mime || ''));
  return m ? Number(m[1]) : 24000;
}

// Availability is a key check, not a network call. A round-trip would cost a real
// billed synthesis on every status poll, and the poll happens per reply.
async function isAvailable() {
  const now = Date.now();
  const ttl = _healthCache.ok ? HEALTH_CACHE_MS : HEALTH_FAIL_CACHE_MS;
  if (_healthCache.at && now - _healthCache.at < ttl) return _healthCache.ok;
  _healthCache = { at: now, ok: Boolean(apiKey()) };
  return _healthCache.ok;
}

async function getStatus() {
  return { ok: await isAvailable(), voices: 0, provider: 'gemini-tts' };
}

// Synthesize to a WAV Buffer. Throws on failure — the caller (server/index.js)
// already treats a throw as "this chunk has no audio" and ships text only, so a
// billing or quota error degrades to the browser voice instead of silence.
async function synthesize({ text, voice, model, signal }) {
  if (!text || !String(text).trim()) throw new Error('text required');
  const key = apiKey();
  if (!key) throw new Error('GOOGLE_API_KEY missing — gemini-tts unavailable');

  const useModel = model || process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL;
  const useVoice = voice || process.env.GEMINI_LIVE_VOICE || DEFAULT_VOICE;

  const res = await fetch(`${BASE}/${useModel}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: String(text) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: useVoice } } },
      },
    }),
  });

  if (!res.ok) {
    let detail = res.statusText;
    try { const e = await res.json(); detail = (e.error && e.error.message) || detail; } catch { /* keep statusText */ }
    throw new Error(`gemini-tts failed: ${res.status} ${detail}`);
  }

  const json = await res.json();
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = parts.find((p) => p && p.inlineData && p.inlineData.data);
  if (!inline) {
    // A 200 with no audio is a real outcome (safety block, empty candidate) and
    // must not be reported as success — AD-4.
    throw new Error('gemini-tts returned no audio');
  }
  const pcm = Buffer.from(inline.inlineData.data, 'base64');
  return pcmToWav(pcm, rateFromMime(inline.inlineData.mimeType));
}

async function listVoices() {
  // The prebuilt set is fixed and not enumerable via the API.
  return ['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];
}

module.exports = {
  name: 'gemini-tts',
  mime: 'audio/wav',
  isAvailable,
  getStatus,
  synthesize,
  listVoices,
  // exported for tests — the WAV header is easy to get subtly wrong
  _pcmToWav: pcmToWav,
  _rateFromMime: rateFromMime,
};
