'use strict';

// voice-gate-recording.js — BUG-406: the server half of the mic-gate recorder
// (ui/public/js/voice/gate-recorder.js). Takes one window of samples per gate
// release from the HUD and appends it to a local JSON-lines file.
//
// OFF unless VOICE_GATE_RECORDER=true, and the check is HERE as well as in the
// HUD: the socket carries whatever a client sends, so a client alone must not be
// able to make the server write files.
//
// LOCAL ONLY. The files go under the repository's own .cache/ (gitignored), never
// the vault, which syncs. In a packaged install that directory is inside the
// read-only app archive, so the write fails and is logged once — this is an
// instrument for attended runs from source, which is where the acoustic study
// will happen (BUG-406, decision D9).
//
// VALIDATED AT THE EDGE. Only the recorder's own numeric and boolean fields are
// kept; anything else a client sends is dropped, and the sample count is capped.
// No text beyond a short reason slug can reach the file.

const fsp = require('fs').promises;
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', '.cache', 'voice-gate-recorder');
const MAX_SAMPLES = 1000;
const NUMERIC = ['t', 'rms', 'aheadMs', 'micContextTime', 'playContextTime'];
const BOOLEAN = ['captureSuspended', 'ownVoiceGate', 'speaking'];

function enabledFromEnv(env) {
  return String((env || process.env).VOICE_GATE_RECORDER || '').toLowerCase() === 'true';
}

function cleanSample(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of NUMERIC) out[k] = Number.isFinite(s[k]) ? s[k] : null;
  for (const k of BOOLEAN) out[k] = s[k] === true;
  return out;
}

function cleanRecording(msg, now) {
  const samples = Array.isArray(msg && msg.samples) ? msg.samples.slice(0, MAX_SAMPLES).map(cleanSample).filter(Boolean) : [];
  const reason = String((msg && msg.reason) || '').slice(0, 80);
  return {
    at: Number.isFinite(msg && msg.at) ? msg.at : now(),
    reason: /^[a-z0-9-]*$/i.test(reason) ? reason : 'unrecognised',
    n: samples.length,
    samples,
  };
}

function createGateRecordingSink({ logger, enabled = enabledFromEnv(), dir = DEFAULT_DIR, now = Date.now } = {}) {
  let warned = false;
  async function handle(msg) {
    if (!enabled) return false;
    const rec = cleanRecording(msg, now);
    if (!rec.n) return false;
    const file = path.join(dir, new Date(rec.at).toISOString().slice(0, 10) + '.jsonl');
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
      return true;
    } catch (err) {
      if (!warned && logger && typeof logger.warn === 'function') {
        warned = true;
        logger.warn('voice.gate-recorder.write-failed', { error: String((err && err.message) || err) });
      }
      return false;
    }
  }
  return { handle, enabled, dir };
}

module.exports = { createGateRecordingSink, cleanRecording, enabledFromEnv, MAX_SAMPLES, DEFAULT_DIR };
