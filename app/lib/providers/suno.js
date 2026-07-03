// suno.js — Suno music provider (Music Studio), via sunoapi.org (unofficial third-party
// proxy — base URL configurable via SUNO_API_URL so the user can swap vendors).
// Polling is PRIMARY (this local server is not publicly reachable for the vendor's
// webhook); the webhook route is a best-effort bonus path for tunneled setups.
const { pollUntil } = require('./_poll-util');

// taskId -> webhook payload, populated by server.js's POST /api/music/webhook route.
const webhookPayloads = new Map();

function receiveWebhook(taskId, payload) {
  webhookPayloads.set(taskId, payload);
}

function baseUrl() {
  return (process.env.SUNO_API_URL || 'https://api.sunoapi.org').replace(/\/+$/, '');
}

async function generateTrack({ prompt, style, title, instrumental }) {
  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) throw new Error('SUNO_API_KEY missing — add it to app/.env');

  const port = process.env.PORT || 4477;
  const callBackUrl = `http://localhost:${port}/api/music/webhook`;

  const genRes = await fetch(`${baseUrl()}/api/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      customMode: true,
      instrumental: !!instrumental,
      prompt,
      style,
      title,
      model: process.env.SUNO_MODEL || 'V4_5',
      callBackUrl,
    }),
  });

  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => genRes.statusText);
    throw new Error(`suno generate failed: ${genRes.status} ${detail}`);
  }
  const genJson = await genRes.json();
  const taskId = genJson?.data?.taskId;
  if (!taskId) throw new Error(`suno generate did not return a taskId: ${JSON.stringify(genJson)}`);

  let attempts = 0;
  const sunoData = await pollUntil(async () => {
    attempts += 1;
    const webhookHit = webhookPayloads.get(taskId);
    if (webhookHit) {
      const data = webhookHit?.data?.sunoData || webhookHit?.sunoData;
      if (data && data.length) return data;
    }

    const pollRes = await fetch(`${baseUrl()}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollRes.ok) {
      if (attempts >= 2) {
        throw new Error(
          `Suno polling endpoint did not respond as expected — sunoapi.org's API may have changed; check https://docs.sunoapi.org (status ${pollRes.status})`
        );
      }
      return null;
    }

    let pollJson;
    try {
      pollJson = await pollRes.json();
    } catch {
      if (attempts >= 2) {
        throw new Error("Suno polling endpoint did not respond as expected — sunoapi.org's API may have changed; check https://docs.sunoapi.org");
      }
      return null;
    }

    const status = pollJson?.data?.status;
    const data = pollJson?.data?.response?.sunoData;
    if (data && data.length) return data;
    if (status && /fail|error/i.test(status)) {
      throw new Error(`suno generation failed: ${status}`);
    }
    if (attempts >= 2 && status === undefined && data === undefined) {
      throw new Error("Suno polling endpoint did not respond as expected — sunoapi.org's API may have changed; check https://docs.sunoapi.org");
    }
    return null;
  }, { intervalMs: 5000, timeoutMs: 300000 });

  const track = sunoData[0];
  const [audioRes, imageRes] = await Promise.all([
    fetch(track.audioUrl),
    fetch(track.imageUrl),
  ]);
  if (!audioRes.ok) throw new Error(`failed to download suno audio: ${audioRes.status}`);
  if (!imageRes.ok) throw new Error(`failed to download suno cover: ${imageRes.status}`);

  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  const coverBuffer = Buffer.from(await imageRes.arrayBuffer());

  return {
    audioBuffer,
    coverBuffer,
    duration: track.duration,
    title: track.title || title,
  };
}

module.exports = { generateTrack, receiveWebhook, webhookPayloads };
