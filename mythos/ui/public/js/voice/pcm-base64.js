// PCM <-> base64 helpers for the Live audio path. A plain ES module, so
// s2s-bridge.js imports it and node:test exercises it directly.

// Moved here unchanged from s2s-bridge.js on 2026-09-24 (BUG-447), to make room
// under that file's size ceiling rather than raise it. The mic's gated PCM frames
// go up as 'live-audio' through this.
export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// How many milliseconds of 16-bit mono PCM one base64 chunk holds. Mirrors
// src/core/voice/unheard-answer.js's pcmBase64Ms: the server is CommonJS and this
// directory has no build step, so the two cannot share one source (the same
// reason ui/CLAUDE.md gives for the resample math). Change both together; the
// BUG-447 test pins that they agree.
export function pcmBase64Ms(b64, sampleRate = 24000) {
  if (typeof b64 !== 'string' || !b64) return 0;
  const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  return bytes > 0 ? (bytes / 2 / sampleRate) * 1000 : 0;
}
