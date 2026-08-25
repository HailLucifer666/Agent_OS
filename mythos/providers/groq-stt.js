'use strict';

// providers/groq-stt.js — Groq Whisper speech-to-text. Same host/key as
// providers/groq.js (proven reachable on this network all session, via
// standard HTTPS multipart POST) — used to replace Chrome's built-in
// SpeechRecognition, whose Google-hosted cloud backend is unreachable from
// this machine ('network' error in under half a second) and whose on-device
// model download stalls indefinitely for the same underlying reason.

const BASE = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
// The transcription POST has to be bounded, and not only for latency: this
// provider is the FIRST link in providers/stt.js's chain, and that chain only
// walks to local-whisper-stt.js when this one THROWS. An unbounded fetch on a
// stalled connection never throws, so the documented on-device fallback is
// never reached and the whole voice turn hangs instead. Generous by design —
// whisper-large-v3-turbo answers a normal utterance in ~1-2s, so this only
// trips on a genuinely dead connection, never on a slow-but-working one.
const TIMEOUT_MS = Number(process.env.GROQ_STT_TIMEOUT_MS) || 20000;

// Whisper hallucinates plausible-sounding phrases from near-silent or noisy
// audio instead of reporting nothing was said. verbose_json exposes per-segment
// no_speech_prob/avg_logprob, the documented signals for this — kept as one
// layer of defense, but verified LIVE against Groq's real API to be unreliable
// here: feeding it pure digital silence returned "Thank you." with
// no_speech_prob 0 and avg_logprob -0.29, well inside "confident real speech"
// range by these thresholds. So the primary defense is the client-side peak-
// energy gate in voice-loop.js (never sends a clip that didn't get louder than
// ambient noise); this is the backstop for whatever gets past it — Whisper's
// hallucinations on silence/near-silence are a well-documented, narrow set of
// stock phrases (its training data is full of YouTube-style sign-offs). An
// EXACT match (after trimming punctuation/case) against this list is dropped
// regardless of confidence scores; a real command that happens to CONTAIN one
// of these phrases as part of a longer sentence is untouched.
const NO_SPEECH_PROB_MAX = 0.6;
const AVG_LOGPROB_MIN = -1.0;
const HALLUCINATION_PHRASES = new Set([
  'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'please subscribe', 'subscribe', 'bye', 'goodbye', 'see you next time',
  'see you later', 'hi', 'hello', 'you', 'the end', 'okay', 'bye bye',
  // Noise-induced single-word hallucinations — Whisper emits these from
  // near-silent or ambient-noise audio when it can't find real speech.
  'yeah', 'huh', 'uh', 'um', 'hmm', 'mmm', 'oh', 'wow', 'wait', 'so',
  'and', 'the', 'a', 'i', 'me', 'my', 'we', 'it', 'its', 'is',
  'en el', 'el', 'la', 'de', 'que', 'y',  // Spanish fragments Whisper emits on noise
]);

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
  form.append('response_format', 'verbose_json');
  // temperature 0 = most stable decoding, least likely to hallucinate from
  // near-silent/ambient-noise audio. language 'en' = skip language detection
  // (which burns decode budget AND misfires on noise, producing foreign-language
  // fragments like "Ég hef miklu..." from pure ambient). Hardcoded 'en' matches
  // the persona/UI locale.
  form.append('temperature', '0');
  form.append('language', 'en');
  // RECOGNITION HINTS (2026-08-22). Whisper takes an optional `prompt` that
  // biases decoding toward the vocabulary it contains, and this provider was
  // sending none — so every MYTHOS-specific word competed against ordinary
  // English on equal terms, which is why "MYTHOS" came back as "methos" and
  // "mythos" in the same session.
  //
  // The idea is lifted from Claude Code's published voice-dictation behaviour
  // ("your current project name and git branch name are added as recognition
  // hints automatically"), not its implementation — that service is unavailable
  // outside a Claude.ai session. See providers/stt-hints.js for what the prompt
  // contains, why it is a bare term list rather than a sentence, and why it is
  // length-bounded.
  //
  // Opt-out rather than opt-in, because the failure mode is mild (a slightly
  // more confident recognizer) while the defect it fixes is constant. Set
  // VOICE_STT_HINTS=off to disable and compare.
  if (String(process.env.VOICE_STT_HINTS || '').toLowerCase() !== 'off') {
    var hint = require('./stt-hints').buildPrompt(null);
    if (hint) form.append('prompt', hint);
  }

  const res = await fetch(`${BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const e = await res.json(); detail = e?.error?.message || detail; } catch { /* keep statusText */ }
    throw new Error(`groq transcription failed: ${res.status} ${detail}`);
  }
  const data = await res.json();
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  // A bare "." or "..." (no actual letters) is as meaningless as an empty
  // string — Whisper emits these on pure noise about as often as real phrases.
  const hasWord = /\w/.test(text);
  if (!text || !hasWord || isLowConfidence(data.segments) || isStockHallucination(text)) return '';
  return text;
}

// No segments (some response shapes omit them) — nothing to filter on, trust
// the text. Otherwise: any segment Whisper itself flagged as likely-no-speech,
// or with very low average token confidence, means this clip was noise/silence
// that got transcribed into a plausible-sounding phrase anyway.
function isLowConfidence(segments) {
  if (!Array.isArray(segments) || !segments.length) return false;
  return segments.some((s) =>
    (typeof s.no_speech_prob === 'number' && s.no_speech_prob > NO_SPEECH_PROB_MAX) ||
    (typeof s.avg_logprob === 'number' && s.avg_logprob < AVG_LOGPROB_MIN)
  );
}

function isStockHallucination(text) {
  const normalized = text.toLowerCase().replace(/[.!?,]+$/g, '').trim();
  return HALLUCINATION_PHRASES.has(normalized);
}

module.exports = { name: 'groq-stt', isAvailable, transcribe };
