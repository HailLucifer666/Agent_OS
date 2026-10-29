'use strict';

// providers/kokoro/worker.js — Kokoro model load, phonemization, inference and
// WAV conversion, on a thread that is not the event loop.
//
// WHY. Measured 2026-09-11 on this machine (node v26.1.0, 8 cpus), one utterance
// through the in-process provider:
//
//     synthesize  wall 8388 ms
//                 process CPU  22265 ms   (onnxruntime is multi-threaded)
//                 MAIN-THREAD CPU  8203 ms   <-- 98% of wall, on the event loop
//                 max loop lag 253 ms
//
// So synthesis does not merely take a long time, it BLOCKS. While it runs the
// server answers nothing: no /health, no WebSocket frame, no tool result. The
// 250 ms acceptance threshold is already breached by a single sentence.
//
// THE FIRST worker_threads IN THIS REPO. There is no precedent here, which is
// the reason for the care below rather than an excuse for less. In particular
// this file uses require(), never `await import()`: ESM dynamic import cannot
// read from inside an asar archive (recorded in this repo), and import() would
// also land on the .mjs builds — a THIRD distinct module instance, which is the
// exact defect this whole change exists to fix.
//
// THE DEPENDENCY-IDENTITY RULE, which is the whole point of the load sequence.
// `@huggingface/transformers` must be required from KOKORO-JS'S OWN resolution
// context, not from this file's. Resolved on this machine:
//     from providers/  -> mythos/node_modules/@huggingface/transformers          (4.2.0 at the fix; re-verified 4.3.2, 2026-10-29, same hoisted position)
//     from kokoro-js/  -> mythos/node_modules/kokoro-js/node_modules/@huggingface/transformers (3.8.1)
// The old provider set `env.cacheDir` on the first and `from_pretrained` loaded
// through the second. Configuring the instance that does NOT load the model is
// indistinguishable from configuring nothing, and that is what shipped.

const { parentPort } = require('node:worker_threads');
const path = require('node:path');
const { migrateLegacyCache } = require('./migrate-cache');

let ttsPromise = null;
let voicesCache = null;

// BUG-422 (2026-09-23): this file now runs as a forked child PROCESS by default
// (child-transport.js) and still runs as a worker thread when a caller injects one.
// Same protocol either way; the transfer list only means something to a thread —
// over IPC with 'advanced' serialization the ArrayBuffer is copied as bytes.
function reply(msg, transfer) {
  if (parentPort) parentPort.postMessage(msg, transfer);
  else if (typeof process.send === 'function' && process.connected) process.send(msg);
}

// Resolve transformers THROUGH kokoro-js, and report both resolved filenames so
// the host can assert identity rather than trust this comment.
function resolveThroughKokoro() {
  const kokoroEntry = require.resolve('kokoro-js');
  const kreq = require('node:module').createRequire(kokoroEntry);
  const transformersEntry = kreq.resolve('@huggingface/transformers');
  return { kokoroEntry, transformersEntry, transformers: kreq('@huggingface/transformers') };
}

async function loadModel(opts) {
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async () => {
    const { kokoroEntry, transformersEntry, transformers } = resolveThroughKokoro();
    const canonicalDir = opts.modelDir;
    const modelId = opts.modelId;

    // Migrate BEFORE pointing the loader at the canonical dir, so the very first
    // load can already find the weights there instead of re-downloading them.
    // Skipped entirely when KOKORO_MODEL_DIR is explicit — an operator who named
    // a directory gets that directory and nothing else.
    let migration = null;
    if (!opts.explicitDir && Array.isArray(opts.legacyDirs) && opts.legacyDirs.length) {
      migration = { copied: 0, bytes: 0, conflicts: [], skipped: 0 };
      for (const from of opts.legacyDirs) {
        const r = migrateLegacyCache({ from, to: canonicalDir, modelId });
        migration.copied += r.copied.length;
        migration.bytes += r.bytes;
        migration.skipped += r.skipped.length;
        for (const c of r.conflicts) migration.conflicts.push(c);
      }
    }

    // THE SAME instance kokoro.cjs will use. This is the line the old provider
    // got wrong.
    transformers.env.cacheDir = canonicalDir;
    if (opts.offline) {
      // Only set when the caller is explicitly proving offline behaviour. Left
      // alone otherwise, because turning remote models off by default would turn
      // a first cold start into a permanent failure.
      transformers.env.allowRemoteModels = false;
    }

    const { KokoroTTS } = require('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(modelId, { dtype: opts.dtype, device: 'cpu' });
    return { tts, migration, kokoroEntry, transformersEntry, cacheDir: transformers.env.cacheDir };
  })();
  ttsPromise.catch(() => { ttsPromise = null; }); // a failed load must be retryable by a NEW worker
  return ttsPromise;
}

// Voice metadata read off the LOADED MODEL, never off list_voices().
//
// kokoro-js's `list_voices()` is `console.table(...)` and returns undefined —
// verified 2026-09-11 by running it: it printed a 28-row table to stdout and the
// provider's `Object.keys(undefined)` threw into a bare catch, so the HUD voice
// picker received ZERO voices for an engine that has 28. It also corrupted the
// stdout of the probe that found it. `tts.voices` is the actual data.
function voicesOf(tts) {
  if (voicesCache) return voicesCache;
  const raw = (tts && tts.voices) || {};
  voicesCache = Object.keys(raw).map((id) => {
    const meta = raw[id] || {};
    return {
      id: String(id),
      label: meta.name || String(id),
      language: meta.language || null,
      gender: meta.gender || null,
    };
  });
  return voicesCache;
}

async function handle(msg) {
  const { id, gen, op } = msg;
  try {
    if (op === 'load') {
      const loaded = await loadModel(msg.opts);
      reply({
        id,
        gen,
        ok: true,
        result: {
          cacheDir: loaded.cacheDir,
          kokoroEntry: loaded.kokoroEntry,
          transformersEntry: loaded.transformersEntry,
          migration: loaded.migration,
          voices: voicesOf(loaded.tts).length,
        },
      });
      return;
    }
    if (op === 'listVoices') {
      const loaded = await loadModel(msg.opts);
      reply({ id, gen, ok: true, result: voicesOf(loaded.tts) });
      return;
    }
    if (op === 'synthesize') {
      const loaded = await loadModel(msg.opts);
      const audio = await loaded.tts.generate(String(msg.text), { voice: msg.voice || undefined });
      const ab = await audio.toBlob().arrayBuffer();
      // Transfer an ArrayBuffer this worker OWNS, containing ONLY the intended
      // bytes. `.slice(0)` is deliberate and not redundant: a Buffer's `.buffer`
      // is a window into Node's shared 8 KB pool, so transferring one would hand
      // the host unrelated memory AND detach the pool out from under everything
      // else still running on this thread. Copying once is the cost of being
      // able to transfer at all.
      const owned = ab.slice(0);
      reply({ id, gen, ok: true, result: { audio: owned } }, [owned]);
      return;
    }
    reply({ id, gen, ok: false, error: 'unknown op: ' + String(op) });
  } catch (err) {
    reply({ id, gen, ok: false, error: (err && err.message) || String(err) });
  }
}

function onMessage(msg) {
  if (msg && msg.op === 'shutdown') { process.exit(0); return; }
  handle(msg);
}

if (parentPort) {
  parentPort.on('message', onMessage);
} else if (typeof process.send === 'function') {
  process.on('message', onMessage);
  // The server went away (quit, crash, TerminateProcess): leave with it. A child
  // that outlives its parent holds ~100 MB of model and a CPU core for nobody.
  process.on('disconnect', () => process.exit(0));
}

module.exports = { voicesOf, resolveThroughKokoro };
