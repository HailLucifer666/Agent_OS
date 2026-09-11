'use strict';

// providers/kokoro-tts.js — Node provider for Kokoro-82M (Apache-2.0), an
// offline TTS engine that runs entirely on-device through onnxruntime
// (kokoro-js + @huggingface/transformers). Same shape as providers/piper-tts.js
// so it slots into providers/tts.js's chain as a fourth interchangeable engine.
//
// This file is now a FACADE. Every export below means exactly what it meant
// before; the model load, phonemization, inference and WAV conversion moved to
// providers/kokoro/worker.js, and providers/kokoro/client.js supervises it.
//
// ---------------------------------------------------------------------------
// WHY THE WORK MOVED OFF THIS THREAD. Measured 2026-09-11 (node v26.1.0, 8 cpus),
// one utterance through the old in-process path:
//
//     synthesize   wall 8388 ms
//                  process CPU 22265 ms   (onnxruntime is multi-threaded)
//                  MAIN-THREAD CPU 8203 ms   <-- 98% of wall, on the event loop
//                  max loop lag 253 ms
//
// The server answers nothing during that window. Not slow: blocked.
//
// WHY THE CACHE PATH CHANGED, AND WHAT WAS ACTUALLY BROKEN. The previous version
// did `env.cacheDir = modelDir` on `@huggingface/transformers` resolved from
// THIS directory, then loaded through `kokoro-js`, which resolves its OWN nested
// copy (4.2.0 hoisted vs 3.8.1 nested — kokoro-js pins ^3.5.1). It configured a
// module nothing loads from, so `KOKORO_MODEL_DIR` did nothing at all. Proof on
// disk: a 92,361,116-byte `model_quantized.onnx` in the nested instance's
// default cache, while `mythos/models/kokoro` had never been created. The worker
// now requires transformers through kokoro-js's own resolution context, and
// reports both resolved filenames so a test can assert identity rather than
// trust this paragraph. See providers/kokoro/paths.js for the full measurement.
//
// AND THE INFERENCE THAT MUST NOT BE MADE FROM AN EMPTY DIRECTORY. With
// `mythos/models/kokoro` absent, an OFFLINE load still succeeded in 1488 ms and
// downloaded zero bytes. A missing cache directory is not evidence that anything
// downloads.
//
// KNOWN RISK, handled honestly: a Hugging Face download can stall indefinitely
// on this network. isAvailable() bounds the FIRST probe with LOAD_TIMEOUT_MS — a
// stalled download resolves to "unavailable" so the chain falls through instead
// of hanging the caller. The in-flight load is NOT aborted by that; it keeps
// running so a later probe can pick up the finished model. What IS new is that
// the background initialization is itself hard-bounded by
// KOKORO_LOAD_TIMEOUT_MS, so a stall cannot pin a worker forever.
//
// Licences: the pipeline code (Apache-2.0) and the weights (also Apache-2.0 —
// see the model card) are recorded in THIRD_PARTY_NOTICES.md. That is an
// observation about licences, not legal advice.
// ---------------------------------------------------------------------------

const { createKokoroClient } = require('./kokoro/client');
const { resolveKokoroModelDir } = require('./kokoro/paths');
const { resolveTimeouts, LOAD_TIMEOUT_MS } = require('./kokoro/timeouts');

let client = null;          // created lazily — requiring this file must spawn nothing
let modelFailed = false;    // sticky: a genuine load failure is not retried per call
let lastUnavailableReason = null;

// Validated once, lazily. A bad KOKORO_* timeout makes kokoro UNAVAILABLE with a
// precise reason; it must NEVER throw, because providers/tts.js requires this
// module at boot and an optional provider cannot be allowed to fail the server.
function config() {
  const t = resolveTimeouts(process.env);
  if (!t.ok) return { ok: false, reason: t.reason };
  return t;
}

function ensureClient() {
  if (client) return client;
  const t = config();
  if (!t.ok) return null;
  client = createKokoroClient({ env: process.env, initTimeoutMs: t.initMs, synthTimeoutMs: t.synthMs });
  return client;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`kokoro model load timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// modelCacheDir(env) — the ONE place the kokoro cache location is decided.
//
// Exported so scripts/doctor.js reports on the directory this provider ACTUALLY
// READS rather than forming a second opinion about where the model ought to
// live. BUG-360 is the bill for the alternative: for weeks doctor printed
// "OK Android platform-tools (adb)" while all 14 phone_* tools were dead,
// because the report and the runtime resolved the same binary differently.
//
// Until 2026-09-11 this function WAS that bug in a new form — it named
// `mythos/models/kokoro`, doctor reported on it, and the loader read somewhere
// else entirely. It now delegates to the resolver the worker uses.
function modelCacheDir(env) {
  return resolveKokoroModelDir(env || process.env);
}

// BUG-380: the text of the last decline, so the chain can say WHY this rung was
// skipped. `isAvailable()` stays boolean — that is every provider's contract —
// and this is an additive optional hook the chain asks for only after a false.
function unavailableReason() {
  return lastUnavailableReason;
}

async function isAvailable() {
  const t = config();
  if (!t.ok) { lastUnavailableReason = t.reason; return false; }
  if (modelFailed) {
    if (!lastUnavailableReason) {
      lastUnavailableReason = 'a previous kokoro model load failed in this process '
        + '(sticky; not retried per call) — weights dir: ' + modelCacheDir();
    }
    return false;
  }
  try {
    const c = ensureClient();
    if (!c) { lastUnavailableReason = 'kokoro client could not be created'; return false; }
    // Race a COPY of the wait, not the load itself: a probe giving up must not
    // cancel the shared load for anyone else still waiting on it.
    await withTimeout(c.load(), LOAD_TIMEOUT_MS);
    lastUnavailableReason = null;
    return true;
  } catch (err) {
    const text = (err && err.message) || String(err || '');
    // Distinguish the three cases a bare `false` made identical: a bounded
    // timeout on a cold download, a genuine load failure, and a sticky
    // already-failed state. Only the second is sticky.
    if (!/timed out/i.test(text)) modelFailed = true;
    lastUnavailableReason = (text.trim() || 'kokoro declined to load and gave no reason')
      + ' (weights dir: ' + modelCacheDir() + ')';
    return false;
  }
}

// The voice ids this engine can actually speak, for the HUD picker.
//
// Read off the LOADED MODEL DATA, never off `list_voices()`. Verified
// 2026-09-11: kokoro-js's `list_voices()` is `console.table(...)` and returns
// undefined, so the old `Object.keys(raw)` threw into a bare catch and the
// picker got ZERO voices for an engine that has 28 — while a 28-row table was
// printed to stdout, which is how the defect was found at all.
//
// Never triggers a download of its own: the picker only asks engines that
// reported isAvailable(), and for kokoro that probe has already loaded (or
// failed to load) the model.
async function listVoices() {
  if (modelFailed) return [];
  try {
    const c = ensureClient();
    if (!c) return [];
    return await withTimeout(c.listVoices(), LOAD_TIMEOUT_MS);
  } catch {
    return [];
  }
}

// Synthesize to a WAV Buffer. Throws on failure so the chain moves to the next
// provider rather than shipping silence.
//
// CANCELLATION IS NOT FAILURE. An aborted signal must not set the sticky failure
// state and must not make kokoro the reason the chain falls through — the caller
// changed its mind, the engine did nothing wrong, and the next request should
// still find kokoro available.
async function synthesize({ text, voice, signal }) {
  if (!text || !String(text).trim()) throw new Error('text required');
  if (signal && signal.aborted) throw new Error('aborted');
  const c = ensureClient();
  if (!c) { const t = config(); throw new Error(t.ok ? 'kokoro unavailable' : t.reason); }
  const r = await c.synthesize({ text: String(text), voice: voice || undefined, signal });
  const buf = Buffer.from(r.audio);
  if (buf.length === 0) throw new Error('kokoro returned empty audio');
  return buf;
}

// Explicit teardown. No worker may outlive server shutdown, and asking it to
// leave is not the same as watching it go — this awaits termination.
async function shutdown() {
  if (!client) return;
  const c = client;
  client = null;
  await c.shutdown();
}

module.exports = {
  name: 'kokoro-tts',
  mime: 'audio/wav',
  isAvailable,
  unavailableReason,
  listVoices,
  synthesize,
  modelCacheDir,
  shutdown,
  LOAD_TIMEOUT_MS,
};
