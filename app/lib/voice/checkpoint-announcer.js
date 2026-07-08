'use strict';
// Speaks pipeline checkpoints for voice-originated builds only. Major transitions
// only — no per-token chatter. Broadcast voice-say with reqId:null rides the existing
// ws.js broadcast fallthrough; no client protocol changes needed.
const pipeline = require('../pipeline');
const tts = require('./tts');

const STAGE_COPY = {
  queued: (card) => `Got it. "${card.text.slice(0, 60)}" is queued to build.`,
  generating: () => 'Building phase started.',
  'writing-artifact': () => 'Build finished. Saving the result.',
  done: (card, job) => `Done. Here is what I built: ${job.artifact && job.artifact.title ? job.artifact.title : 'your project'}.`,
  failed: (card, job) => `The build failed: ${job.error || 'unknown error'}.`,
};
const announced = new Set(); // `${jobId}:${stage}` idempotency

function attach(broadcastAll) {
  return async function onJobUpdate(job) {
    try {
      if (job.kind !== 'pipeline-execute' || !job.cardId) return;
      const found = pipeline.findCard(job.cardId);
      if (!found) return;
      if (found.card.origin !== 'voice') return;
      const copyFn = STAGE_COPY[job.stage];
      if (!copyFn) return;
      const key = `${job.id}:${job.stage}`;
      if (announced.has(key)) return;
      announced.add(key);
      const card = found.card;
      const text = copyFn(card, job);
      const audioBuf = await tts.speak(text).catch(() => null);
      broadcastAll({
        type: 'voice-say', reqId: null, checkpoint: true, text,
        audioB64: audioBuf ? audioBuf.toString('base64') : null,
        jobId: job.id, cardId: job.cardId, stage: job.stage,
        artifact: job.artifact || null,
      });
    } catch { /* announcer must never break the orchestrator */ }
  };
}
module.exports = { attach };
