'use strict';

// providers/piper-tts.js — Node provider for the local Piper service
// (services/piper-server.py). Deliberately the same shape as providers/edge-tts.js
// so the two are interchangeable inside the TTS chain.
//
// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER VOICE PATH: it is genuinely offline.
// Proven, not assumed — with socket.connect/create_connection/getaddrinfo all
// patched to raise, Piper still produced 144,940 bytes of audio in 292ms while
// edge-tts failed immediately with "NETWORK CALL ATTEMPTED". No API, no key, no
// per-call cost, no rate limit, and nothing about what the operator says leaves
// the machine. Piper is MIT and the voice models carry their own open licences,
// which is also why it is the only one of the three usable in a product that is
// sold — edge-tts is an unofficial Microsoft endpoint labelled personal/hobby-only.
// (An observation about licences, not legal advice.)
//
// MEASURED 2026-07-31, same sentence, best of 3, model load excluded:
//   piper en_US-hfc_female-medium   350ms   local
//   piper en_US-kristin-medium      351ms   local
//   piper en_US-amy-medium          379ms   local
//   edge-tts en-GB-SoniaNeural     1011ms   network
//   gemini-tts Aoede              ~3900ms   network, metered
//
// Returns WAV, so callers must ship mime 'audio/wav' (the client already supports
// a per-chunk mime — the reminder alert tone is a WAV).

const BASE = process.env.PIPER_URL || 'http://127.0.0.1:5051';
const HEALTH_CACHE_MS = 10000;
const HEALTH_FAIL_CACHE_MS = 1500; // recover fast after boot, same as edge-tts

let _healthCache = { at: 0, ok: false, voices: 0 };

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
    // The service reports ok:false when its model dir is empty. Honour that —
    // claiming available with zero voices makes the chain pick a provider that
    // then fails on every chunk instead of falling through to the next one.
    _healthCache = { at: now, ok: Boolean(data.ok), voices: Number(data.voices) || 0 };
  } catch {
    _healthCache = { at: now, ok: false, voices: 0 };
  }
  return _healthCache;
}

async function isAvailable() {
  return (await checkHealth()).ok;
}

async function getStatus() {
  const h = await checkHealth();
  return { ok: h.ok, voices: h.voices, provider: 'piper-tts' };
}

// Synthesize to a WAV Buffer. Throws on failure so the chain moves to the next
// provider rather than shipping a silent chunk.
async function synthesize({ text, voice, signal }) {
  if (!text || !String(text).trim()) throw new Error('text required');
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: signal,
    body: JSON.stringify({ input: String(text), voice: voice || undefined }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const e = await res.json(); detail = e.error || detail; } catch { /* keep statusText */ }
    throw new Error(`piper synthesis failed: ${res.status} ${detail}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('piper returned empty audio');
  return buf;
}

async function listVoices() {
  try {
    const res = await fetch(`${BASE}/v1/voices`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.voices) ? data.voices : [];
  } catch {
    return [];
  }
}

module.exports = {
  name: 'piper-tts',
  mime: 'audio/wav',
  isAvailable,
  getStatus,
  synthesize,
  listVoices,
};
