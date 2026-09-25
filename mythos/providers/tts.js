'use strict';

// providers/tts.js — decides WHICH engine speaks, and makes that decision STICK.
//
// THE REQUIREMENT THIS EXISTS FOR (operator, 2026-07-31): "the greeting message as
// soon as it starts should be the same until switch... I should not hear a new
// voice." The entity previously changed voice inside a single session — the boot
// greeting came out of edge-tts while the conversation came out of Gemini Live, so
// it greeted as a British man and answered as a woman. Fixing the voice IDS was
// only half of it; the other half is that the ENGINE must not change underfoot.
//
// So this is not a per-call picker. resolve() probes the configured chain ONCE,
// caches the winner, and every later call — greeting, proactive announcement,
// batch reply — uses that same provider. The active provider only changes when it
// actually FAILS, and then it stays changed for the rest of the session rather than
// flapping back on the next call. A voice change is therefore always evidence of a
// real outage, never of a routine re-probe.
//
// VOICE_TTS_CHAIN is an ordered, comma-separated list, matching the CHAIN_* naming
// the brain lanes already use. Default 'edge': unchanged behaviour for anyone who
// sets nothing.
//
//   gemini — Gemini TTS. Same prebuilt voice as the Live/S2S path (Aoede), so the
//            greeting matches the conversation. ~3.9s/sentence, metered.
//   edge   — edge-tts. ~1011ms, free, unofficial Microsoft endpoint (personal/
//            hobby-only, which is a live problem for a product that is sold).
//   piper  — local Piper. ~350ms, fully OFFLINE (proven: works with sockets
//            blocked), free, MIT + open voices, and the only one shippable.
//   kokoro — local Kokoro-82M (onnxruntime, in-process). Offline after the
//            model is cached, Apache-2.0 code AND weights. A second offline
//            option beside Piper, not a replacement for it.
//
// BACK-COMPAT, load-bearing: a single-entry 'edge' chain resolves to the edge-tts
// module OBJECT ITSELF, because server/index.js requires that singleton directly and
// two tests monkey-patch it (barge-in-tts-cancel, tts-down-sentence-chunks).
// Wrapping it would break them silently.

const edgeTts = require('./edge-tts');
const geminiTts = require('./gemini-tts');
const piperTts = require('./piper-tts');
const kokoroTts = require('./kokoro-tts');

const BY_NAME = { edge: edgeTts, gemini: geminiTts, piper: piperTts, kokoro: kokoroTts };

function parseChain(config) {
  const raw = String(
    (config && (config.VOICE_TTS_CHAIN || config.VOICE_TTS_PROVIDER)) ||
    process.env.VOICE_TTS_CHAIN || process.env.VOICE_TTS_PROVIDER || 'edge'
  );
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const n of names) {
    if (BY_NAME[n] && out.indexOf(BY_NAME[n]) === -1) out.push(BY_NAME[n]);
  }
  return out.length ? out : [edgeTts];
}

// Kept for callers that only need "which one would be first" without probing.
function selectTts(config) {
  return parseChain(config)[0];
}

function mimeFor(provider) {
  return (provider && provider.mime) || 'audio/mpeg';
}

// The voice id belongs to the ENGINE, not the app — the namespaces are disjoint and
// crossing them is a hard 400 per chunk (observed live: an edge id sent to Gemini
// returned mime=audio/wav with 0 bytes on every chunk). Gemini deliberately reads
// GEMINI_LIVE_VOICE, the same key the Live path uses, so 'gemini' in the chain
// really does mean "the same voice you hear when talking".
function voiceFor(provider, config) {
  const cfg = config || {};
  const name = provider && provider.name;
  if (name === 'gemini-tts') return cfg.GEMINI_LIVE_VOICE || process.env.GEMINI_LIVE_VOICE || 'Aoede';
  if (name === 'piper-tts') return cfg.PIPER_VOICE || process.env.PIPER_VOICE || undefined;
  if (name === 'kokoro-tts') return cfg.KOKORO_VOICE || process.env.KOKORO_VOICE || 'af_heart';
  return cfg.VOICE_TTS_VOICE || process.env.VOICE_TTS_VOICE || undefined;
}

// A chain with a sticky active provider.
//
// synthesize() returns { audio, mime, provider } rather than a bare Buffer, because
// the engines emit different containers (edge=MP3, gemini/piper=WAV) and the client
// needs the mime PER CHUNK to decode it.
// BUG-380: `providers` is an optional injection seam, and it exists for the
// reason routes/config.js's `wakewordModelsDir` does — a test that has to name
// real rungs to reach this code ends up probing the REAL kokoro provider, which
// on a machine with no weights pays LOAD_TIMEOUT_MS. Measured while writing this:
// 15,109ms per test case. Production passes nothing and still gets parseChain().
//
// BUG-450 (2026-09-23): `circuits` is the per-engine circuit registry
// (providers/tts-circuit.js). The server passes the SHARED one to every chain it
// builds, so a rebuilt chain remembers what is parked; a chain given none gets
// its own, which keeps tests that swap the real engine modules isolated.
function createTtsChain({ config, logger, providers, circuits } = {}) {
  const chain = Array.isArray(providers) && providers.length ? providers.slice() : parseChain(config);
  const log = logger || { info() {}, warn() {} };
  const registry = circuits || require('./tts-circuit').createCircuitRegistry({ logger: log });
  if (circuits && typeof circuits.useLogger === 'function' && logger) circuits.useLogger(logger);
  const circuitOf = (p) => registry.forProvider(p, config);
  let active = null;          // resolved provider
  let resolving = null;       // in-flight resolve(), so concurrent turns share one probe

  function nameOf(p) { return (p && p.name) || 'unknown'; }

  // BUG-380: WHY A RUNG DECLINED, AND WHAT IT COST TO FIND OUT.
  //
  // This was `try { return await provider.isAvailable(); } catch { return false; }`
  // — a bare catch that made a load timeout, a bad model id and a corrupt cache
  // one indistinguishable `false`. The caller then logged only WHICH rung was
  // skipped, so nothing anywhere recorded that fifteen seconds had just gone into
  // a stalled Hugging Face download. doctor.js can predict that cost from disk
  // ("the first fallback to kokoro will spend up to 15000ms"); the runtime paid it
  // and said nothing. Two routes that disagreed, and the silent one was the one
  // the operator actually hears.
  //
  // Returns a record rather than a boolean because the boolean was the bug.
  // `isAvailable(): boolean` stays every provider's contract — the optional
  // `unavailableReason()` hook is additive, and a provider that does not
  // implement it still gets its thrown message and its timing, which is strictly
  // more than before.
  async function probe(provider) {
    const started = Date.now();
    try {
      const ok = await provider.isAvailable();
      if (ok) return { ok: true, ms: Date.now() - started };
      let reason = null;
      try {
        if (typeof provider.unavailableReason === 'function') reason = provider.unavailableReason();
      } catch (_) {
        reason = null;   // a reason lookup must never be what fails the probe
      }
      return {
        ok: false,
        ms: Date.now() - started,
        reason: (typeof reason === 'string' && reason.trim())
          ? reason.trim()
          : nameOf(provider) + ' reported itself unavailable and gave no reason',
      };
    } catch (err) {
      // The message that used to be thrown away. For kokoro this is literally
      // "kokoro model load timed out after 15000ms", i.e. the whole diagnosis.
      const text = (err && err.message) || String(err || '');
      return {
        ok: false,
        ms: Date.now() - started,
        reason: text.trim() || (nameOf(provider) + ' threw a non-Error while probing'),
      };
    }
  }

  // Pick the first available provider and REMEMBER it.
  async function resolve() {
    if (active) return active;
    if (resolving) return resolving;
    resolving = (async () => {
      for (const p of chain) {
        // BUG-450: an engine parked by a REAL failure is skipped without asking it
        // again, so a rebuilt chain (voice picker, restart of the chain) does not
        // re-pay the outage.
        if (circuitOf(p).state === 'cooling') {
          log.info('tts.unavailable', { provider: nameOf(p), reason: 'parked after a failure (tts.provider-parked)', ms: 0 });
          continue;
        }
        const r = await probe(p);
        if (r.ok) {
          active = p;
          log.info('tts.resolved', { provider: nameOf(p), ms: r.ms, chain: chain.map(nameOf).join(',') });
          return p;
        }
        // NOT parked. "Unavailable when asked" is not a failure: a sidecar that
        // starts a second late would otherwise be silenced for a whole cooldown
        // (found by tts-down-sentence-chunks.test.js while this was being written).
        log.info('tts.unavailable', { provider: nameOf(p), reason: r.reason, ms: r.ms });
      }
      active = null;
      log.warn('tts.none-available', { chain: chain.map(nameOf).join(',') });
      return null;
    })();
    try { return await resolving; } finally { resolving = null; }
  }

  async function isAvailable() {
    return Boolean(await resolve());
  }

  // BUG-450 (2026-09-23): start at the active engine, as before, and ask each
  // engine's circuit first — a parked one is skipped without a call; one nobody has
  // proven yet admits ONE call and makes concurrent sentences wait for its answer;
  // a failure parks it (tts-circuit.js). The one walk BACKWARDS is to an engine
  // parked by a failure: once its cooldown ends, ONE probe may win it back. Engines
  // that merely reported unavailable when resolved are not revisited, exactly as
  // before — the voice does not flap.
  async function synthesize({ text, signal }) {
    const start = await resolve();
    if (!start) throw new Error('no TTS provider available');
    let lastErr = null;
    const from = chain.indexOf(start);
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      const circuit = circuitOf(p);
      if (i < from && circuit.state !== 'cooling' && circuit.state !== 'probing') continue;
      const ticket = await circuit.admit(signal); // rejects only if the caller aborts while waiting
      if (!ticket) continue;
      let err = null;
      try {
        const audio = await p.synthesize({ text, voice: voiceFor(p, config), signal });
        if (audio && audio.length) {
          ticket.success();
          if (p !== active) {
            log.warn('tts.failover', { from: nameOf(active), to: nameOf(p), reason: lastErr && lastErr.message });
            active = p;
          }
          return { audio, mime: mimeFor(p), provider: nameOf(p) };
        }
        err = new Error(nameOf(p) + ' returned empty audio');
      } catch (e) {
        err = e;
      }
      if (signal && signal.aborted) { ticket.cancelled(); throw err; }   // barge-in is not a provider failure
      ticket.failure(err, signal);
      lastErr = err;
      log.warn('tts.provider-failed', { provider: nameOf(p), error: err.message });
    }
    throw lastErr || new Error('all TTS providers failed or are parked');
  }

  return {
    synthesize,
    isAvailable,
    resolve,
    get name() { return nameOf(active); },
    get mime() { return mimeFor(active); },
    chainNames: chain.map(nameOf),
  };
}

// What this machine could speak with, for the HUD's voice picker.
//
// Walks the WHOLE registry, not the configured chain: the question the picker
// asks is "what can I choose from", which is independent of what is active or
// default right now. An engine that is not installed still appears, with
// available:false — the operator needs to see that piper exists and is missing,
// not have it silently absent as though it were never an option.
//
// Every probe is wrapped. A dead sidecar or a provider that throws yields
// available:false / voices:[] rather than failing the whole listing, and
// listVoices() is only called for an engine that reported available — asking a
// missing engine for its catalogue answers nothing and, for kokoro, would mean
// pulling a model down just to populate a dropdown.
// The four engines answer in three different shapes: gemini returns bare
// strings, the edge/piper sidecars return {id,name,language,gender} rows, kokoro
// returns {id,label}. Flatten to one {id,label} shape here so the picker never
// has to know which engine it is rendering.
function normalizeVoice(v) {
  if (typeof v === 'string') return { id: v, label: v };
  if (!v || typeof v !== 'object') return null;
  const id = v.id || v.name || v.voice || v.short_name || v.shortName;
  if (!id) return null;
  const label = v.label || v.name || id;
  const detail = [v.language, v.gender].filter(Boolean).join(' · ');
  return detail ? { id: String(id), label: String(label), detail } : { id: String(id), label: String(label) };
}

async function listEngines() {
  const entries = Object.entries(BY_NAME);
  return Promise.all(entries.map(async ([short, provider]) => {
    let available = false;
    try { available = Boolean(await provider.isAvailable()); } catch { available = false; }
    let voices = [];
    if (available && typeof provider.listVoices === 'function') {
      try {
        const raw = (await provider.listVoices()) || [];
        voices = raw.map(normalizeVoice).filter(Boolean);
      } catch { voices = []; }
    }
    return { provider: provider.name, short, available, voices };
  }));
}

// Direct access for the audition route, which synthesizes a sample with an
// explicitly chosen engine+voice and must NOT go through a chain — resolving a
// chain would probe, cache and stick a provider as a side effect of pressing
// play on a sample.
function providerByShortName(short) {
  return BY_NAME[String(short || '').trim().toLowerCase()] || null;
}

module.exports = { selectTts, mimeFor, voiceFor, createTtsChain, parseChain, listEngines, providerByShortName };
