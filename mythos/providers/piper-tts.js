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
// the machine.
//
// LICENCE NOTE CORRECTED 2026-08-19 (BUG-274 T2). This block used to assert that Piper
// carried a permissive licence, that its voice models were uniformly open, and — on
// that basis — that it was the one engine of the three fit for a product being sold.
// All three parts were true when written and none of them holds now. Nothing rechecks
// a licence claim once it is in a comment, which is the whole reason this survived:
//
//   rhasspy/piper         MIT      ARCHIVED 2025-08-26
//   OHF-Voice/piper1-gpl  GPL-3.0  the only maintained fork
//   rhasspy/piper-voices  per-voice licences (CC BY 4.0 / CC0 / MIT, mixed)
//
// (Read from the GitHub API on 2026-08-19.) So whichever Piper the operator installs
// behind PIPER_URL is either archived or copyleft, and "the voice models carry their
// own open licences" hides a per-voice check nobody has done.
//
// This file states the facts and stops there. Whether any of it is compatible with
// selling MYTHOS is the step 6.5 gate's question and a lawyer's call, not a comment's
// — CLAUDE.md is explicit about that, and the sentence removed above is exactly the
// kind of verdict it warns against. providers/kokoro-tts.js is Apache-2.0 for code and
// weights and now leads the derived default chain (BUG-274 T1); Piper remains a
// supported offline fallback and nothing here argues against using it.
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
