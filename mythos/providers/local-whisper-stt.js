'use strict';

// providers/local-whisper-stt.js — on-device Whisper STT via
// @huggingface/transformers (Node backend, no network after the model is
// cached). Same {name, isAvailable, transcribe} shape as providers/groq-stt.js
// so it slots into the same chain (providers/stt.js).
//
// WAV-ONLY, on purpose: pure Node has no built-in audio decoder, and decoding
// arbitrary MediaRecorder output (webm/opus, ogg/opus) without vendoring
// ffmpeg or a native codec is out of scope for this stage. This is not the
// gap it sounds like — ui/public/js/voice/voice-loop.js's normal path
// (mergePrerollAndTranscribe) already decodes the recorded blob client-side
// and re-encodes it as WAV before POSTing to /api/voice/transcribe; raw
// webm/ogg only reaches the server on that function's own fallback branch
// (decode/merge failed). A non-WAV mime type here throws immediately so
// providers/stt.js's chain falls through to the next provider for that one
// utterance, rather than silently mistranscribing or hanging.
//
// KNOWN RISK, handled honestly (voice-loop.js and the plan for this work both
// record that on-device model downloads can stall indefinitely on this
// network): isAvailable() bounds the first cold-load attempt with a timeout,
// exactly like providers/kokoro-tts.js.

const path = require('path');

const LOAD_TIMEOUT_MS = 15000; // bounds only the FIRST probe of a cold load
const TARGET_SAMPLE_RATE = 16000; // what Whisper's feature extractor expects

let pipelinePromise = null; // resolved ASR pipeline, cached for the process lifetime
let pipelineFailed = false; // sticky: a genuine load failure (bad model id) shouldn't retry every call

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`whisper model load timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function loadPipeline() {
  if (!pipelinePromise) {
    const modelId = process.env.WHISPER_MODEL_ID || 'onnx-community/whisper-base';
    const dtype = process.env.WHISPER_DTYPE || 'q8';
    const modelDir = process.env.WHISPER_MODEL_DIR || path.join(__dirname, '..', 'models', 'whisper');
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = modelDir;
      return pipeline('automatic-speech-recognition', modelId, { device: 'cpu', dtype });
    })();
    pipelinePromise.catch(() => { pipelineFailed = true; });
  }
  return pipelinePromise;
}

async function isAvailable() {
  if (pipelineFailed) return false;
  try {
    await withTimeout(loadPipeline(), LOAD_TIMEOUT_MS);
    return true;
  } catch {
    // Either the load itself failed (sticky) or the bound timeout tripped on
    // a slow/stalled download. Unavailable for THIS probe only — the
    // in-flight load (if any) keeps running for a later probe to pick up.
    return false;
  }
}

// Parse a little-endian PCM WAV buffer into { samples: Float32Array (mono,
// -1..1), sampleRate }. Walks chunks rather than assuming a fixed 44-byte
// header so it tolerates extra chunks before 'data' (e.g. a 'LIST' chunk),
// while still matching exactly what voice-loop.js's own encodeWav() produces:
// 16-bit PCM. Pure, network-free, unit-testable with fixture bytes.
function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file (missing RIFF/WAVE header)');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataSize = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV missing fmt chunk');
  if (dataOffset < 0) throw new Error('WAV missing data chunk');
  if (fmt.audioFormat !== 1) throw new Error(`unsupported WAV encoding (audioFormat=${fmt.audioFormat}); only 16-bit PCM is supported`);
  if (fmt.bitsPerSample !== 16) throw new Error(`unsupported WAV bit depth (${fmt.bitsPerSample}); only 16-bit PCM is supported`);

  const frameSize = 2 * fmt.channels;
  const numSamples = Math.floor(Math.min(dataSize, buffer.length - dataOffset) / frameSize);
  const mono = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      sum += buffer.readInt16LE(dataOffset + i * frameSize + c * 2);
    }
    mono[i] = (sum / fmt.channels) / 32768;
  }
  return { samples: mono, sampleRate: fmt.sampleRate };
}

// Linear-interpolation resampler — good enough for speech-to-text (Whisper's
// own feature extractor further reduces to mel bins), and zero dependencies.
// Identity when the rates already match, which is the common case: the
// worklet/MediaRecorder in voice-loop.js already runs near 16kHz-multiples.
function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] ?? 0;
    const b = idx + 1 < samples.length ? samples[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Transcribe an audio Buffer. Throws on failure (including "not WAV") so
// providers/stt.js's chain moves to the next provider rather than hanging or
// mistranscribing.
async function transcribe(buffer, mimeType) {
  if (!buffer || !buffer.length) throw new Error('empty audio');
  if (!mimeType || !mimeType.includes('wav')) {
    throw new Error(`local-whisper-stt only accepts WAV audio, got ${mimeType || '(no content-type)'}`);
  }
  const { samples, sampleRate } = parseWav(buffer);
  const resampled = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
  const asr = await loadPipeline();
  const output = await asr(resampled, { language: 'en', task: 'transcribe' });
  const text = typeof output?.text === 'string' ? output.text.trim() : '';
  return text;
}

module.exports = { name: 'local-whisper-stt', isAvailable, transcribe, parseWav, resampleLinear };
