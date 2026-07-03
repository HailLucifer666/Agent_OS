// minimax-video.js — MiniMax b-roll video provider (Video Studio, MiniMax engine).
const { pollUntil } = require('./_poll-util');

async function generateVideo({ prompt, duration = 6, resolution = '1080P' }) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY missing — add it to app/.env');

  const genRes = await fetch('https://api.minimax.io/v1/video_generation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'MiniMax-Hailuo-02', prompt, duration, resolution }),
  });

  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => genRes.statusText);
    throw new Error(`minimax generate failed: ${genRes.status} ${detail}`);
  }
  const genJson = await genRes.json();
  const taskId = genJson?.task_id;
  if (!taskId) throw new Error(`minimax generate did not return a task_id: ${JSON.stringify(genJson)}`);

  let attempts = 0;
  const fileId = await pollUntil(async () => {
    attempts += 1;
    const statusRes = await fetch(`https://api.minimax.io/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!statusRes.ok) throw new Error(`minimax status check failed: ${statusRes.status}`);
    const statusJson = await statusRes.json();
    const status = statusJson?.status;
    if (status === 'Success') return statusJson.file_id;
    if (status === 'Fail') throw new Error('minimax video generation failed');
    if (attempts >= 2 && status === undefined) {
      throw new Error('MiniMax video generation status endpoint may have changed — unexpected response shape');
    }
    return null;
  }, { intervalMs: 5000, timeoutMs: 300000 });

  const retrieveRes = await fetch(`https://api.minimax.io/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!retrieveRes.ok) {
    throw new Error(`MiniMax file retrieval endpoint may have changed — status ${retrieveRes.status}`);
  }
  const retrieveJson = await retrieveRes.json();
  const downloadUrl = retrieveJson?.file?.download_url || retrieveJson?.download_url;
  if (!downloadUrl) {
    throw new Error('MiniMax file retrieval endpoint may have changed — no download_url in response');
  }

  const videoRes = await fetch(downloadUrl);
  if (!videoRes.ok) throw new Error(`failed to download minimax video: ${videoRes.status}`);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  return { videoBuffer };
}

module.exports = { generateVideo };
