'use strict';

// providers/gemini-stt.js — transcription through Google's Gemini models.
//
// WHY THIS EXISTS, measured 2026-09-11. The STT chain had exactly two rungs,
// `groq` (Whisper) and `local` (on-device Whisper), and Google was never in it —
// while `GOOGLE_API_KEY` was already configured for the voice, vision, memory
// and text lanes. A round-trip test on that key (synthesize a sentence with
// gemini TTS, feed the bytes straight back) transcribed it EXACTLY:
//
//     gemini-3.5-flash-lite   2876 ms   exact
//     gemini-3.6-flash        6128 ms   exact (punctuation only)
//     gemini-3.5-transcribe   503       "high demand", retryable
//
// `gemini-3.5-transcribe` is the purpose-built id and it is deliberately NOT the
// default: it answered 503 on every attempt during the session that added this
// file, and a default that is rationed is worse than a general model that is not.
// Set GEMINI_STT_MODEL to use it once demand settles.
//
// WHAT THIS IS NOT. It is not a replacement for Groq Whisper and it is not
// placed ahead of it — `VOICE_STT_CHAIN` still defaults to 'groq', so adding
// this file changes nothing until an operator opts in. The measurement above is
// ONE sentence of clean synthetic speech with no background noise, no accent and
// no crosstalk. That is enough to prove the wiring works and nowhere near enough
// to claim it beats Whisper on real room audio, which is what BUG-406's corpus
// is for.

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// One sentence of speech is a small request, but a long dictation is not, and a
// transcription that never returns would hold the voice turn open. Bounded here
// rather than left to the platform default.
const TIMEOUT_MS = 30000;
// Asking for the transcript and nothing else. Without this a chat model will
// happily add "Sure, here is the transcript:" and that preamble would be
// treated as spoken words by everything downstream.
const INSTRUCTION = 'Transcribe this audio verbatim. Output ONLY the transcript text, '
  + 'with no preamble, no quotation marks, and no commentary. If there is no intelligible '
  + 'speech, output nothing at all.';

function getApiKey() {
  const k = process.env.GOOGLE_API_KEY;
  return k && String(k).trim() ? String(k).trim() : null;
}

function isAvailable() {
  return Boolean(getApiKey());
}

// Gemini needs a concrete audio mime type. The recorder sends webm/opus in the
// browser path and wav from the packaged capture path; anything else is passed
// through unchanged rather than guessed at, so an unsupported type fails loudly
// at the API instead of being mislabelled here.
function normalizeMime(mimeType) {
  const m = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!m) return 'audio/wav';
  if (m === 'audio/x-wav' || m === 'audio/wave') return 'audio/wav';
  return m;
}

async function transcribe(buffer, mimeType) {
  const key = getApiKey();
  if (!key) throw new Error('gemini-stt: GOOGLE_API_KEY is not set');
  const model = process.env.GEMINI_STT_MODEL || DEFAULT_MODEL;

  const res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: INSTRUCTION },
          { inlineData: { mimeType: normalizeMime(mimeType), data: Buffer.from(buffer).toString('base64') } },
        ],
      }],
      // temperature 0 because this is a transcription, not a composition: the
      // same audio must produce the same words on every call.
      generationConfig: { temperature: 0, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (_) { /* body already consumed or not JSON */ }
    // The status is kept in the message because 429 (quota) and 503 (demand) are
    // retryable while 400 (bad audio) is not, and the chain's caller can only
    // tell them apart if the reason survives.
    throw new Error(`gemini-stt failed: ${res.status}${detail ? ' ' + detail : ''}`);
  }

  const json = await res.json();
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  const text = parts.map((p) => p.text || '').join(' ').trim();
  // An empty result is a legitimate outcome, not an error — the router's own
  // comment says so for groq-stt, and silence must reach the caller as silence
  // rather than as a failure that falls through to the next rung.
  return text;
}

module.exports = { name: 'gemini-stt', isAvailable, transcribe, DEFAULT_MODEL };
