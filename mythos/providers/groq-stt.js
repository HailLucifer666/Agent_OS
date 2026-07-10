'use strict';

// providers/groq-stt.js — Groq Whisper speech-to-text. Same host/key as
// providers/groq.js (proven reachable on this network all session, via
// standard HTTPS multipart POST) — used to replace Chrome's built-in
// SpeechRecognition, whose Google-hosted cloud backend is unreachable from
// this machine ('network' error in under half a second) and whose on-device
// model download stalls indefinitely for the same underlying reason.

const BASE = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

function getApiKey() {
  const v = process.env.GROQ_API_KEY;
  return v && v.trim() ? v.trim() : null;
}

function isAvailable() {
  return Boolean(getApiKey());
}

function extFor(mimeType) {
  if (mimeType && mimeType.includes('wav')) return 'wav';
  if (mimeType && mimeType.includes('mp4')) return 'm4a';
  if (mimeType && mimeType.includes('ogg')) return 'ogg';
  return 'webm';
}

// Transcribe an audio Buffer. Throws on any failure — the server route turns
// that into an honest HTTP error, never a silent hang.
async function transcribe(buffer, mimeType) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('GROQ_API_KEY missing — add it to mythos/.env to enable voice input');
  if (!buffer || !buffer.length) throw new Error('empty audio');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `utterance.${extFor(mimeType)}`);
  form.append('model', MODEL);
  form.append('response_format', 'json');

  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const e = await res.json(); detail = e?.error?.message || detail; } catch { /* keep statusText */ }
    throw new Error(`groq transcription failed: ${res.status} ${detail}`);
  }
  const data = await res.json();
  return typeof data.text === 'string' ? data.text.trim() : '';
}

module.exports = { name: 'groq-stt', isAvailable, transcribe };
