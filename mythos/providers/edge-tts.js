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
const HEALTH_CACHE_MS = 10000; // cache health check for 10s to avoid per-poll latency
const VOICE_CACHE_MS = 5 * 60 * 1000; // cache voice list for 5 min

let _healthCache = { at: 0, ok: false, voices: 0 };
let _voiceCache = { at: 0, voices: [] };

// Health-check the local Python service. Cached briefly so status polling doesn't spawn
// a fetch storm. Never throws — returns {ok:false} on any error.
async function checkHealth() {
  const now = Date.now();
  if (now - _healthCache.at < HEALTH_CACHE_MS) return _healthCache;
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
async function synthesize({ text, voice, format, rate, pitch }) {
  if (!text || !text.trim()) throw new Error('text required');
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${BASE}/v1/voices`);
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
