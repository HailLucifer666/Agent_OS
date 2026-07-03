// grok-video.js — xAI Grok b-roll video provider (Video Studio, Grok engine — alternate
// to MiniMax, per the existing UI toggle).
const { pollUntil } = require('./_poll-util');

async function generateVideo({ prompt }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY missing — add it to app/.env');

  const model = process.env.XAI_VIDEO_MODEL || 'grok-imagine-video-1.5';

  const genRes = await fetch('https://api.x.ai/v1/videos/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, prompt }),
  });

  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => genRes.statusText);
    throw new Error(`grok video generate failed: ${genRes.status} ${detail}`);
  }
  const genJson = await genRes.json();
  const requestId = genJson?.request_id;
  if (!requestId) throw new Error(`grok video generate did not return a request_id: ${JSON.stringify(genJson)}`);

  const videoUrl = await pollUntil(async () => {
    const statusRes = await fetch(`https://api.x.ai/v1/videos/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusRes.ok) throw new Error(`grok video status check failed: ${statusRes.status}`);
    const statusJson = await statusRes.json();
    if (statusJson?.status === 'done') return statusJson?.video?.url;
    if (statusJson?.status === 'failed') throw new Error('grok video generation failed');
    return null;
  }, { intervalMs: 5000, timeoutMs: 300000 });

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`failed to download grok video: ${videoRes.status}`);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  return { videoBuffer };
}

module.exports = { generateVideo };
