// heygen.js — HeyGen avatar video provider (Video Studio, Presenter mode).
// Uses voice.type:'text' (HeyGen does its own TTS) rather than voice.type:'audio',
// since HeyGen's servers would need to fetch a locally-generated audio file from a
// public URL our local app cannot provide — a deliberate, honest deviation.
const { pollUntil } = require('./_poll-util');

const FALLBACK_VOICES = [
  { voice_id: '1bd001e7e50f421d891986aad5158bc8', name: 'HeyGen — Default (fallback list)' },
  { voice_id: '2d5b0e6cf36f460aa7fc47e3eee4ba54', name: 'HeyGen — Alt Voice (fallback list)' },
];

async function generateAvatarVideo({ script, avatarId, voiceId }) {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) throw new Error('HEYGEN_API_KEY missing — add it to app/.env');

  const genRes = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
        voice: { type: 'text', input_text: script, voice_id: voiceId },
      }],
      dimension: { width: 1280, height: 720 },
    }),
  });

  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => genRes.statusText);
    throw new Error(`heygen generate failed: ${genRes.status} ${detail}`);
  }
  const genJson = await genRes.json();
  const videoId = genJson?.data?.video_id;
  if (!videoId) throw new Error(`heygen generate did not return a video_id: ${JSON.stringify(genJson)}`);

  const videoUrl = await pollUntil(async () => {
    const statusRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, {
      headers: { 'X-Api-Key': apiKey },
    });
    if (!statusRes.ok) throw new Error(`heygen status check failed: ${statusRes.status}`);
    const statusJson = await statusRes.json();
    const status = statusJson?.data?.status;
    if (status === 'completed') return statusJson.data.video_url;
    if (status === 'failed') throw new Error(`heygen video generation failed: ${statusJson?.data?.error?.message || 'unknown error'}`);
    return null;
  }, { intervalMs: 5000, timeoutMs: 300000 });

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) throw new Error(`failed to download heygen video: ${videoRes.status}`);
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  return { videoBuffer };
}

async function listVoices() {
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) throw new Error('HEYGEN_API_KEY missing — add it to app/.env');
  try {
    const res = await fetch('https://api.heygen.com/v2/voices', {
      headers: { 'X-Api-Key': apiKey },
    });
    if (!res.ok) return FALLBACK_VOICES;
    const json = await res.json();
    const voices = json?.data?.voices;
    if (!Array.isArray(voices) || !voices.length) return FALLBACK_VOICES;
    return voices.map((v) => ({ voice_id: v.voice_id, name: v.name || v.voice_id }));
  } catch {
    return FALLBACK_VOICES;
  }
}

module.exports = { generateAvatarVideo, listVoices };
