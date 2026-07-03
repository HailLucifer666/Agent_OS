// elevenlabs.js — ElevenLabs TTS provider (Video Studio, Voiceover mode only — narration
// over b-roll, no avatar; audio is saved locally so there's no public-reachability problem).

const FALLBACK_VOICES = [
  { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
  { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' },
  { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi' },
];

async function textToSpeech({ text, voiceId }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing — add it to app/.env');

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`elevenlabs tts failed: ${res.status} ${detail}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

async function listVoices() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing — add it to app/.env');
  try {
    const res = await fetch('https://api.elevenlabs.io/v2/voices', {
      headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) return FALLBACK_VOICES;
    const json = await res.json();
    const voices = json?.voices;
    if (!Array.isArray(voices) || !voices.length) return FALLBACK_VOICES;
    return voices.map((v) => ({ voice_id: v.voice_id, name: v.name || v.voice_id }));
  } catch {
    return FALLBACK_VOICES;
  }
}

module.exports = { textToSpeech, listVoices };
