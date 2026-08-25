'use strict';

// providers/edge-tts.js — untouched CA of app/lib/providers/edge-tts.js. Node provider
// for the local edge-tts Python service. Wraps Microsoft Neural TTS (322 voices, 74
// languages) via a local Python service. Genuinely free: no key, no account. Zero NOVA
// lib deps (uses global fetch + env var only) — nothing to re-point.
//
// HONEST LABELING: edge-tts reverse-engineers Edge's Read Aloud endpoint. It is NOT
// an officially offered Microsoft API. Personal/hobby use only — commercial
// deployment violates Microsoft ToS. Use Azure Free Tier or Piper for commercial needs.
//
// If the Python service isn't running, isAvailable() returns false honestly.

const BASE = process.env.EDGE_TTS_URL || 'http://127.0.0.1:5050';
const HEALTH_CACHE_MS = 10000; // cache a HEALTHY result for 10s to avoid a fetch storm
// A FAILED health check is cached far more briefly. The sidecar is autostarted at
// boot (src/core/effectors/edge-tts-child.js) and needs ~2s to import edge_tts and
// bind, so the first check after boot always fails. Caching that for the full 10s
// made the entity answer its own boot greeting in the browser's voice instead of
// its own, and — because server/index.js gates onToken on isAvailable() — disabled
// sentence streaming for that window too. Observed 2026-07-31: synthesize() worked
// while isAvailable() still reported false from the poisoned cache.
const HEALTH_FAIL_CACHE_MS = 1500;
const VOICE_CACHE_MS = 5 * 60 * 1000; // cache voice list for 5 min

let _healthCache = { at: 0, ok: false, voices: 0 };
let _voiceCache = { at: 0, voices: [] };

// Health-check the local Python service. Cached briefly so status polling doesn't spawn
// a fetch storm. Never throws — returns {ok:false} on any error.
async function checkHealth() {
  const now = Date.now();
  const ttl = _healthCache.ok ? HEALTH_CACHE_MS : HEALTH_FAIL_CACHE_MS;
  if (_healthCache.at && now - _healthCache.at < ttl) return _healthCache;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`health ${res.status}`);
    const data = await res.json();
    _healthCache = { at: now, ok: Boolean(data.ok), voices: Number(data.voices) || 0 };
  } catch {
    _healthCache = { at: now, ok: false, voices: 0 };
  }
  return _healthCache;
}

async function isAvailable() {
  const h = await checkHealth();
  return h.ok;
}

async function getStatus() {
  const h = await checkHealth();
  return { ok: h.ok, voices: h.voices };
}

// Synthesize text to an MP3 audio Buffer. Throws if the service is down or returns an error.
//
// `signal` is not optional decoration. providers/tts.js's chain passes one into
// every provider (tts.js:133) and treats an abort as barge-in rather than as a
// provider failure (tts.js:143) — and this file used to accept the argument
// implicitly and drop it on the floor. gemini-tts, piper-tts and kokoro-tts all
// honour it; edge-tts is in the DEFAULT chain, so the one engine most likely to
// be speaking was the one engine that could not be cut off. The operator would
// interrupt, the state machine would agree, and the audio would keep arriving.
async function synthesize({ text, voice, format, rate, pitch, signal }) {
  if (!text || !text.trim()) throw new Error('text required');
  // Already-aborted: do not even open the connection. Mirrors kokoro-tts.js.
  if (signal && signal.aborted) throw new Error('aborted');
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal,
    body: JSON.stringify({
      input: text,
      voice: voice || 'en-US-AriaNeural',
      response_format: format || 'mp3',
      rate: rate || '+0%',
      pitch: pitch || '+0Hz',
    }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const e = await res.json(); detail = e.error || detail; } catch { /* keep statusText */ }
    throw new Error(`edge-tts synthesis failed: ${res.status} ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// List available voices. Cached for VOICE_CACHE_MS. Returns [] if service is down.
async function listVoices() {
  const now = Date.now();
  if (now - _voiceCache.at < VOICE_CACHE_MS) return _voiceCache.voices;
  try {
    // GAP-ANALYSIS-2026-08-24 M2: this fetch had no timeout — a sidecar that
    // accepted the connection but never answered blocked the caller for undici's
    // ~300s default. 8s matches the voice path's tolerance elsewhere
    // (news-feed.js uses the same budget); fail-soft behaviour below is unchanged.
    const res = await fetch(`${BASE}/v1/voices`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`voices ${res.status}`);
    const data = await res.json();
    _voiceCache = { at: now, voices: Array.isArray(data.voices) ? data.voices : [] };
  } catch {
    // keep stale cache if present, else empty
    if (!_voiceCache.voices.length) _voiceCache = { at: now, voices: [] };
  }
  return _voiceCache.voices;
}

module.exports = {
  name: 'edge-tts',
  isAvailable,
  getStatus,
  synthesize,
  listVoices,
};
