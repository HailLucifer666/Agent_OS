'use strict';

// voice/proactive-speech.js — server-initiated speech (no reqId). Everything the
// assistant said before was a REPLY to a client request; this is the push channel
// for checkpoint questions, build/mission/forge/research milestones, and completion
// announcements. Reuses the exact sentence-chunk TTS pipeline sendSpokenReply uses,
// broadcast to every connected tab (single-operator premise). The client
// (voice-loop.js beginTurn/onExternalChunk/deliverExternalReply, keyed by pushId)
// plays it through the same barge-in-safe machinery as a normal voice reply.

const crypto = require('crypto');

function createProactiveSpeech({ config, edgeTts, sanitizeSpoken, splitSentences, logger, broadcastAll, bus }) {
  let pushCounter = 0;

  async function speak(text, opts) {
    opts = opts || {};
    if (config.PROACTIVE_SPEECH === false) return { skipped: true, reason: 'muted' };
    const say = String(text || '').trim().slice(0, config.PROACTIVE_SPEECH_MAX_CHARS);
    if (!say) return { skipped: true, reason: 'empty' };

    const pushId = 'push-' + (++pushCounter) + '-' + crypto.randomUUID().slice(0, 8);
    const kind = opts.kind || 'announcement';
    const relatedId = opts.relatedId || null;
    const spoken = sanitizeSpoken(say);
    let ttsUp = false;
    try { ttsUp = await edgeTts.isAvailable(); } catch (_) { ttsUp = false; }
    const chunks = ttsUp ? splitSentences(spoken) : [];

    for (let i = 0; i < chunks.length; i++) {
      let audioB64 = null;
      try {
        const buf = await edgeTts.synthesize({ text: chunks[i], voice: config.VOICE_TTS_VOICE });
        audioB64 = buf.toString('base64');
      } catch (err) {
        if (logger) logger.warn('edge-tts.proactive-chunk-failed', { error: err.message, index: i });
      }
      broadcastAll({ type: 'speak-push', pushId, kind, relatedId, index: i, total: chunks.length, audioB64, text: chunks[i] });
    }
    broadcastAll({ type: 'speak-push', pushId, done: true, kind, relatedId, say, speak: spoken, chunked: ttsUp && chunks.length > 0 });
    if (bus) bus.emit('action.speak-requested', { text: say, kind });
    return { pushId, ok: true };
  }

  return { speak };
}

module.exports = { createProactiveSpeech };
