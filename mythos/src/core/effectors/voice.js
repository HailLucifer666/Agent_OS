'use strict';

// effectors/voice.js — TTS as an Effector (CA from app/lib/voice/tts.js). Registered in
// the hub as id 'speak', tier 0 (read-only side effect on the human's speakers, not on
// entity state — no different in kind from a log line). Truncation logic is verbatim.

var edgeTts = require('../../../providers/edge-tts');

var MAX_CHARS = 350;

function truncateAtSentenceBoundary(text, maxChars) {
  maxChars = maxChars || MAX_CHARS;
  var trimmed = String(text || '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  var window = trimmed.slice(0, maxChars);
  var sentenceEnd = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
    (window.endsWith('.') || window.endsWith('!') || window.endsWith('?')) ? window.length - 1 : -1
  );
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd + 1).trim();
  var spaceIdx = window.lastIndexOf(' ');
  if (spaceIdx > 0) return window.slice(0, spaceIdx).trim();
  return window.trim();
}

function createVoiceEffector({ config }) {
  var defaultVoice = (config && config.VOICE_TTS_VOICE) || 'en-US-AriaNeural';

  return {
    id: 'speak',
    tier: 0,
    describe: function() { return 'Synthesize text to speech via the local edge-tts service.'; },
    validate: function(params) {
      if (!params || !params.text || !String(params.text).trim()) {
        return { ok: false, reason: 'text is required' };
      }
      return { ok: true };
    },
    async invoke(params) {
      try {
        var available = await edgeTts.isAvailable();
        if (!available) return { ok: false, result: 'tts-unavailable' };
        var truncated = truncateAtSentenceBoundary(params.text);
        var buf = await edgeTts.synthesize({ text: truncated, voice: params.voice || defaultVoice });
        return { ok: true, result: { audioBase64: buf.toString('base64'), truncated: truncated !== params.text } };
      } catch (err) {
        return { ok: false, result: err.message };
      }
    }
  };
}

// Split text into speakable sentences for chunked TTS. Groups very short
// fragments with their successor so we never synthesize a 2-word chunk (the
// per-request overhead would dominate). Same boundary set as
// truncateAtSentenceBoundary above.
var MIN_CHUNK_CHARS = 25;

function splitSentences(text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return [];
  var parts = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [trimmed];
  var chunks = [];
  var buf = '';
  for (var i = 0; i < parts.length; i++) {
    buf += parts[i];
    if (buf.trim().length >= MIN_CHUNK_CHARS || i === parts.length - 1) {
      var t = buf.trim();
      if (t) chunks.push(t);
      buf = '';
    }
  }
  return chunks;
}

module.exports = { createVoiceEffector, truncateAtSentenceBoundary, splitSentences };
