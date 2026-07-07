// tts.js — voice-turn speech synthesis via the local edge-tts service, WITHOUT the
// vault-persistence path the existing /api/tts/synthesize route uses (that route writes
// every synthesis to vault/builds/tts/ for history; per-turn voice replies would flood it).
// Truncates to ~350 chars at a sentence boundary (never mid-word) before synthesizing.
// Returns null (never throws) when edge-tts is unavailable — callers (WS wiring, browser)
// fall back to client-side speechSynthesis.

const edgeTts = require('../providers/edge-tts');

const MAX_CHARS = 350;
const DEFAULT_VOICE = process.env.VOICE_TTS_VOICE || 'en-US-AriaNeural';

// Truncates `text` to at most MAX_CHARS, preferring to cut at a sentence boundary
// (., !, ?) so speech never stops mid-word. Falls back to a whitespace boundary, then a
// hard cut, if no sentence boundary exists within the limit.
function truncateAtSentenceBoundary(text, maxChars = MAX_CHARS) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= maxChars) return trimmed;

  const window = trimmed.slice(0, maxChars);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    window.endsWith('.') || window.endsWith('!') || window.endsWith('?') ? window.length - 1 : -1);
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd + 1).trim();

  const spaceIdx = window.lastIndexOf(' ');
  if (spaceIdx > 0) return window.slice(0, spaceIdx).trim();

  return window.trim();
}

// speak(text, opts) -> Buffer | null. Never throws.
async function speak(text, opts = {}) {
  try {
    if (!text || !String(text).trim()) return null;
    const available = await edgeTts.isAvailable();
    if (!available) return null;
    const truncated = truncateAtSentenceBoundary(text);
    const buf = await edgeTts.synthesize({
      text: truncated,
      voice: opts.voice || DEFAULT_VOICE,
      format: opts.format,
      rate: opts.rate,
      pitch: opts.pitch,
    });
    return buf;
  } catch {
    return null;
  }
}

module.exports = { speak, truncateAtSentenceBoundary, MAX_CHARS };
