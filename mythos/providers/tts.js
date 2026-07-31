'use strict';

// providers/tts.js — chooses which engine speaks.
//
// The entity has always had more than one voice path and no single place that
// decided between them, which is how it ended up greeting the operator as a
// British man (edge-tts en-GB-RyanNeural) and then answering as a woman (Gemini
// Live Aoede). This is that single place for the NON-Live paths; the Live/S2S
// path picks its own voice from GEMINI_LIVE_VOICE inside live-session.js.
//
// VOICE_TTS_PROVIDER:
//   'edge'   (default) — edge-tts. ~900ms/sentence, free, unofficial endpoint.
//   'gemini'           — Gemini TTS. ~3.9s/sentence, metered, and the SAME
//                        prebuilt voice the Live path uses, so the entity sounds
//                        like one person everywhere.
//
// BACK-COMPAT, load-bearing: when the provider is 'edge' this returns the
// edge-tts module object ITSELF, not a wrapper. Several tests monkey-patch that
// singleton (test/barge-in-tts-cancel.test.js, test/tts-down-sentence-chunks.test.js)
// because server/index.js requires it directly, and wrapping it would silently
// break them.

const edgeTts = require('./edge-tts');
const geminiTts = require('./gemini-tts');

function selectTts(config) {
  const choice = String((config && config.VOICE_TTS_PROVIDER) || process.env.VOICE_TTS_PROVIDER || 'edge')
    .trim().toLowerCase();
  if (choice === 'gemini') return geminiTts;
  return edgeTts;
}

// The mime a given provider's synthesize() output should be shipped with.
// edge-tts returns MP3, which is the client's default when no mime is sent;
// gemini-tts returns WAV and MUST declare it or the browser will not decode it.
function mimeFor(provider) {
  return (provider && provider.mime) || 'audio/mpeg';
}

// The voice id belongs to the ENGINE, not to the app. The two namespaces are
// disjoint: edge-tts wants a Microsoft Neural id ('en-GB-SoniaNeural') and Gemini
// wants one of its prebuilt names ('Aoede'). Passing the wrong one is a hard 400,
// which is exactly what happened the first time this was wired — the caller sent
// VOICE_TTS_VOICE to Gemini and every chunk came back audio-less:
//   "Voice name en-GB-SoniaNeural is not supported. Allowed voice names are:
//    achernar, achird, ... aoede, ..."
// Gemini deliberately reads GEMINI_LIVE_VOICE, the SAME key the Live path uses,
// so selecting the gemini provider genuinely produces one voice everywhere
// instead of a second thing to keep in sync.
function voiceFor(provider, config) {
  const cfg = config || {};
  if (provider && provider.name === 'gemini-tts') {
    return cfg.GEMINI_LIVE_VOICE || process.env.GEMINI_LIVE_VOICE || 'Aoede';
  }
  return cfg.VOICE_TTS_VOICE || process.env.VOICE_TTS_VOICE || undefined;
}

module.exports = { selectTts, mimeFor, voiceFor };
