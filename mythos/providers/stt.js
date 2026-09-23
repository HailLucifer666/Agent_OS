'use strict';

// providers/stt.js — smallest possible STT router, parallel to
// providers/tts.js but deliberately much simpler: unlike TTS engines, STT
// engines don't have a "sticky voice identity" the operator can hear change
// mid-session, so there's no reason to generalize createTtsChain to cover
// both (the plan for this work is explicit about that). Every call just
// tries the chain fresh, first-available-wins — no cached "active" state.
//
// VOICE_STT_CHAIN is an ordered, comma-separated provider list. Default
// 'groq': /api/voice/transcribe used to call providers/groq-stt.js directly,
// and an unset (or all-invalid) chain reproduces that exactly.
//
//   groq   — Groq Whisper API. Needs GROQ_API_KEY + network.
//   local  — on-device Whisper (providers/local-whisper-stt.js). No network
//            after the model is cached; WAV audio only (see that file for why).
//   gemini — Google Gemini transcription (providers/gemini-stt.js). Needs
//            GOOGLE_API_KEY + network. ADDED 2026-09-11 after a round-trip test
//            on the already-configured key transcribed a sentence exactly in
//            2876 ms. NOT in the default chain: 'groq' remains the default, so
//            this rung is inert until an operator names it in VOICE_STT_CHAIN.
//            One clean synthetic sentence is proof the wiring works, not proof
//            it beats Whisper on real room audio — that is BUG-406's corpus.

const groqStt = require('./groq-stt');
const localWhisperStt = require('./local-whisper-stt');
const geminiStt = require('./gemini-stt');

const BY_NAME = { groq: groqStt, local: localWhisperStt, gemini: geminiStt };

function parseChain(config) {
  const raw = String((config && config.VOICE_STT_CHAIN) || process.env.VOICE_STT_CHAIN || 'groq');
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const n of names) {
    if (BY_NAME[n] && out.indexOf(BY_NAME[n]) === -1) out.push(BY_NAME[n]);
  }
  return out.length ? out : [groqStt];
}

// Try each provider in the chain in order; the first one that is available
// AND doesn't throw wins. A provider returning '' (e.g. groq-stt's own
// no-speech/hallucination filtering) is a legitimate result, not a failure —
// it is returned as-is, matching the pre-existing single-provider behavior.
async function transcribe(buffer, mimeType, config) {
  const chain = parseChain(config);
  let lastErr = null;
  for (const p of chain) {
    try {
      const available = await p.isAvailable();
      if (!available) { lastErr = lastErr || new Error(`${p.name} unavailable`); continue; }
      return await p.transcribe(buffer, mimeType);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no STT provider available');
}

module.exports = { parseChain, transcribe, BY_NAME };
