'use strict';

// providers/kokoro/client.js — the host side of the Kokoro worker.
//
// One worker, one active synthesis at a time, and a generation counter so a
// reply from a worker we have already given up on cannot touch the state of its
// replacement. Every rule below exists because of a specific way this could go
// wrong; the comments say which.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { resolveKokoroModelDir, legacyCacheDirs } = require('./paths');

const WORKER_PATH = path.join(__dirname, 'worker.js');

function createKokoroClient({
  env = process.env,
  initTimeoutMs,
  synthTimeoutMs,
  now = Date.now,
  spawn = (file) => new Worker(file),
} = {}) {
  let worker = null;
  let gen = 0;
  let nextId = 1;
  let loadPromise = null;
  let loadMeta = null;
  const live = new Map();      // id -> { resolve, reject, deadlineAt, op, timer }
  const queue = [];            // admitted synthesis requests waiting their turn
  let active = null;

  function opts() {
    const explicitDir = !!(env.KOKORO_MODEL_DIR && String(env.KOKORO_MODEL_DIR).trim());
    return {
      modelDir: resolveKokoroModelDir(env),
      modelId: env.KOKORO_MODEL_ID || 'onnx-community/Kokoro-82M-v1.0-ONNX',
      dtype: env.KOKORO_DTYPE || 'q8',
      explicitDir,
      legacyDirs: explicitDir ? [] : legacyCacheDirs(env),
      offline: String(env.KOKORO_OFFLINE || '').toLowerCase() === 'true',
    };
  }

  function ensureWorker() {
    if (worker) return worker;
    gen += 1;
    const w = spawn(WORKER_PATH);
    const myGen = gen;
    w.on('message', (msg) => onMessage(myGen, msg));
    w.on('error', (err) => failGeneration(myGen, (err && err.message) || String(err)));
    w.on('exit', (code) => { if (code !== 0) failGeneration(myGen, 'kokoro worker exited with code ' + code); });
    // Idle until something is admitted. An idle worker must never be the reason
    // a clean exit hangs.
    if (typeof w.unref === 'function') w.unref();
    worker = w;
    return w;
  }

  function refIfBusy() {
    if (!worker) return;
    const busy = active !== null || queue.length > 0 || live.size > 0;
    if (busy && typeof worker.ref === 'function') worker.ref();
    else if (!busy && typeof worker.unref === 'function') worker.unref();
  }

  // A reply is acted on ONLY when its generation is current AND its id is still
  // live. That makes an obsolete-generation reply and a cancelled-request reply
  // both harmless without either needing its own path.
  //
  // BOTH generations are checked, and they are not the same check. `msgGen` is
  // bound per-worker at spawn and catches a reply from a worker we have already
  // replaced. `msg.gen` is echoed back by the worker and catches a reply that
  // belongs to a request issued before a replacement — the literal
  // "correlate by id AND generation" the contract asks for. Checking only the
  // first leaves the second unenforced, which a test caught.
  function onMessage(msgGen, msg) {
    if (msgGen !== gen || !msg || msg.gen !== gen || !live.has(msg.id)) return;
    const entry = live.get(msg.id);
    live.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (active && active.id === msg.id) { active = null; pump(); }
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'kokoro worker failed'));
    refIfBusy();
  }

  // The worker died, or we gave up on it. Reject everything that belonged to that
  // generation — but only that generation.
  function failGeneration(badGen, reason) {
    if (badGen !== gen) return;
    worker = null;
    loadPromise = null;
    const pending = [...live.values()];
    live.clear();
    active = null;
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    // Queued-but-not-yet-sent work is NOT failed: it never reached this worker,
    // so a replacement can still run it under its ORIGINAL deadline.
    pump();
  }

  function post(op, payload, deadlineAt) {
    const w = ensureWorker();
    const id = nextId; nextId += 1;
    return new Promise((resolve, reject) => {
      const remaining = deadlineAt - now();
      if (remaining <= 0) { reject(new Error('kokoro ' + op + ' deadline passed before it could start')); return; }
      const timer = setTimeout(() => {
        if (!live.has(id)) return;
        live.delete(id);
        if (active && active.id === id) { active = null; }
        // A timed-out load or synthesis means the worker is in an unknown state:
        // onnxruntime inference is not interruptible, so there is nothing to
        // cancel and the only way to reclaim the thread is to replace it.
        replaceWorker('kokoro ' + op + ' timed out after ' + (deadlineAt - (deadlineAt - remaining)) + 'ms');
        reject(new Error('kokoro ' + op + ' timed out'));
      }, remaining);
      if (typeof timer.unref === 'function') timer.unref();
      live.set(id, { resolve, reject, timer, op });
      w.postMessage({ id, gen, op, opts: opts(), ...payload });
      refIfBusy();
    });
  }

  function replaceWorker(reason) {
    const dying = worker;
    worker = null;
    loadPromise = null;
    const survivors = [...queue];
    queue.length = 0;
    if (dying) { try { dying.terminate(); } catch (_) { /* already gone */ } }
    gen += 1; // anything still in flight from the old worker is now unaddressable
    for (const s of survivors) queue.push(s);
    pump();
    return reason;
  }

  // The shared load. A caller that gives up waiting for it must NOT settle or
  // cancel it for everyone else — that is why the abort race happens at the
  // CALLER (see the facade) and not here.
  function load() {
    if (loadPromise) return loadPromise;
    const deadlineAt = now() + initTimeoutMs;
    loadPromise = post('load', {}, deadlineAt).then((meta) => { loadMeta = meta; return meta; });
    loadPromise.catch(() => { loadPromise = null; });
    return loadPromise;
  }

  function pump() {
    if (active || !queue.length) { refIfBusy(); return; }
    const next = queue.shift();
    if (next.cancelled) { pump(); return; }
    if (next.deadlineAt <= now()) {
      next.reject(new Error('kokoro synthesis deadline passed while queued'));
      pump();
      return;
    }
    active = next;
    post('synthesize', { text: next.text, voice: next.voice }, next.deadlineAt)
      .then((r) => { next.resolve(r); if (active === next) active = null; pump(); })
      .catch((e) => { next.reject(e); if (active === next) active = null; pump(); });
    // post() assigns its own id; record it so a cancel can find the active one.
    next.id = nextId - 1;
    refIfBusy();
  }

  // Deadlines are recorded at ADMISSION, before queueing, so time spent waiting
  // behind another utterance is inside the budget rather than added to it. A
  // request resubmitted after a worker replacement carries its ORIGINAL
  // deadlineAt — a replacement must not silently grant a fresh 60 seconds.
  function synthesize({ text, voice, signal }) {
    const deadlineAt = now() + synthTimeoutMs;
    return new Promise((resolve, reject) => {
      const req = { text, voice, deadlineAt, resolve, reject, cancelled: false, id: null };
      if (signal) {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => {
          req.cancelled = true;
          const idx = queue.indexOf(req);
          if (idx !== -1) {
            // QUEUED cancel: remove just this one. Siblings keep their places
            // AND their original deadlines; the worker is untouched.
            queue.splice(idx, 1);
            reject(new Error('aborted'));
            return;
          }
          if (active === req) {
            // ACTIVE cancel: inference is not interruptible, so the only way to
            // stop it is to terminate. Reject THIS request and re-queue every
            // survivor for a replacement worker, each with its original deadline.
            reject(new Error('aborted'));
            active = null;
            replaceWorker('cancelled');
          }
        }, { once: true });
      }
      queue.push(req);
      pump();
    });
  }

  async function listVoices() {
    await load();
    return post('listVoices', {}, now() + initTimeoutMs);
  }

  async function shutdown() {
    const dying = worker;
    worker = null;
    loadPromise = null;
    const pending = [...live.values()];
    live.clear();
    const queued = [...queue];
    queue.length = 0;
    active = null;
    // Settle explicitly rather than leaving callers hanging on a promise whose
    // worker is gone. A server shutting down must not leave a TTS await pending
    // forever; an error is an answer.
    for (const entry of pending) { if (entry.timer) clearTimeout(entry.timer); entry.reject(new Error('kokoro shut down')); }
    for (const q of queued) q.reject(new Error('kokoro shut down'));
    if (!dying) return;
    try { dying.postMessage({ op: 'shutdown' }); } catch (_) { /* already gone */ }
    // AWAIT termination. "No worker may outlive server shutdown" is not
    // satisfied by asking it to leave.
    try { await dying.terminate(); } catch (_) { /* already gone */ }
  }

  return {
    load,
    listVoices,
    synthesize,
    shutdown,
    meta: () => loadMeta,
    hasWorker: () => worker !== null,
    generation: () => gen,
    queueDepth: () => queue.length,
  };
}

module.exports = { createKokoroClient, WORKER_PATH };
