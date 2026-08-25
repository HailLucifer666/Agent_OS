'use strict';

// providers/kokoro-tts.js — Node provider for Kokoro-82M (Apache-2.0), an
// offline TTS engine that runs entirely on-device through onnxruntime
// (kokoro-js + @huggingface/transformers). Same shape as providers/piper-tts.js
// so it slots into providers/tts.js's chain as a fourth interchangeable engine.
//
// Model weights (~26MB q8 / ~86MB fp32) download from Hugging Face on first
// use into a gitignored cache dir (mythos/models/kokoro/ — same per-machine
// convention as /mythos/models/piper/). Never committed. Both the pipeline
// code (Apache-2.0) and the weights (also Apache-2.0 — see the model card)
// are recorded in THIRD_PARTY_NOTICES.md; this is an observation about
// licences, not legal advice.
//
// KNOWN RISK, handled honestly (recorded live in voice-loop.js and the plan
// for this work): a Hugging Face download can stall indefinitely on this
// network. isAvailable() bounds the FIRST load attempt with a timeout — a
// stalled download resolves to "unavailable" so the TTS chain falls through
// to the next provider instead of hanging the caller. A load already in
// flight is not aborted; it keeps running in the background so a later probe
// (or a later session) can pick up the finished model from cache.

const path = require('path');

const LOAD_TIMEOUT_MS = 15000; // bounds only the FIRST probe of a cold load

let modelPromise = null;   // resolved KokoroTTS instance, cached for the process lifetime
let modelFailed = false;   // sticky: once a load genuinely fails (bad model id, corrupt cache), don't retry every call

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`kokoro model load timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadModel() {
  if (!modelPromise) {
    const modelId = process.env.KOKORO_MODEL_ID || 'onnx-community/Kokoro-82M-v1.0-ONNX';
    const dtype = process.env.KOKORO_DTYPE || 'q8';
    const modelDir = process.env.KOKORO_MODEL_DIR || path.join(__dirname, '..', 'models', 'kokoro');
    modelPromise = (async () => {
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = modelDir;
      const { KokoroTTS } = await import('kokoro-js');
      return KokoroTTS.from_pretrained(modelId, { dtype, device: 'cpu' });
    })();
    modelPromise.catch(() => { modelFailed = true; });
  }
  return modelPromise;
}

async function isAvailable() {
  if (modelFailed) return false;
  try {
    await withTimeout(loadModel(), LOAD_TIMEOUT_MS);
    return true;
  } catch {
    // Either the load itself failed (sticky — modelFailed is now true) or the
    // bound timeout tripped on a slow/stalled download. Report unavailable
    // for THIS probe only; the in-flight load is untouched.
    return false;
  }
}

// The voice ids this engine can actually speak, for the HUD picker.
//
// It reads them off the LOADED model rather than a list copied into this repo.
// kokoro-js does export a static VOICES table, but only in its type
// declarations — the runtime entry point exposes just { KokoroTTS,
// TextSplitterStream, env }, and list_voices() is an INSTANCE method. A
// hardcoded copy here would drift silently the first time upstream adds a
// voice, and offering a voice the installed model cannot speak is worse than
// offering none.
//
// So: no model, no list. That costs nothing in practice, because the picker only
// asks engines that reported isAvailable() — and for kokoro that probe has
// already loaded (or failed to load) the model. Never triggers a download of its
// own: a cold, uncached machine fails the probe first and is never asked.
async function listVoices() {
  if (modelFailed) return [];
  try {
    const tts = await withTimeout(loadModel(), LOAD_TIMEOUT_MS);
    const raw = typeof tts.list_voices === 'function' ? tts.list_voices() : (tts.voices || {});
    const ids = Array.isArray(raw) ? raw : Object.keys(raw);
    return ids.map((id) => {
      const meta = (tts.voices && tts.voices[id]) || {};
      return { id: String(id), label: meta.name || String(id) };
    });
  } catch {
    return [];
  }
}

// Synthesize to a WAV Buffer. Throws on failure so the chain moves to the
// next provider rather than shipping silence.
async function synthesize({ text, voice, signal }) {
  if (!text || !String(text).trim()) throw new Error('text required');
  if (signal && signal.aborted) throw new Error('aborted');
  const tts = await loadModel();
  const audio = await tts.generate(String(text), { voice: voice || undefined });
  const buf = Buffer.from(await audio.toBlob().arrayBuffer());
  if (buf.length === 0) throw new Error('kokoro returned empty audio');
  return buf;
}

module.exports = {
  name: 'kokoro-tts',
  mime: 'audio/wav',
  isAvailable,
  listVoices,
  synthesize,
};
