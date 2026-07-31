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
//
// BACK-COMPAT, load-bearing: a single-entry 'edge' chain resolves to the edge-tts
// module OBJECT ITSELF, because server/index.js requires that singleton directly and
// two tests monkey-patch it (barge-in-tts-cancel, tts-down-sentence-chunks).
// Wrapping it would break them silently.

const edgeTts = require('./edge-tts');
const geminiTts = require('./gemini-tts');
const piperTts = require('./piper-tts');

const BY_NAME = { edge: edgeTts, gemini: geminiTts, piper: piperTts };

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
  return cfg.VOICE_TTS_VOICE || process.env.VOICE_TTS_VOICE || undefined;
}

// A chain with a sticky active provider.
//
// synthesize() returns { audio, mime, provider } rather than a bare Buffer, because
// the engines emit different containers (edge=MP3, gemini/piper=WAV) and the client
// needs the mime PER CHUNK to decode it.
function createTtsChain({ config, logger } = {}) {
  const chain = parseChain(config);
  const log = logger || { info() {}, warn() {} };
  let active = null;          // resolved provider
  let resolving = null;       // in-flight resolve(), so concurrent turns share one probe

  function nameOf(p) { return (p && p.name) || 'unknown'; }

  async function probe(provider) {
    try { return await provider.isAvailable(); } catch { return false; }
  }

  // Pick the first available provider and REMEMBER it.
  async function resolve() {
    if (active) return active;
    if (resolving) return resolving;
    resolving = (async () => {
      for (const p of chain) {
        if (await probe(p)) {
          active = p;
          log.info('tts.resolved', { provider: nameOf(p), chain: chain.map(nameOf).join(',') });
          return p;
        }
        log.info('tts.unavailable', { provider: nameOf(p) });
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

  async function synthesize({ text, signal }) {
    const start = await resolve();
    if (!start) throw new Error('no TTS provider available');
    // Try the active provider first, then everything AFTER it in the chain. Never
    // walk backwards: re-trying a provider that already failed this session is what
    // would make the voice flap mid-conversation.
    const from = chain.indexOf(start);
    let lastErr = null;
    for (let i = from; i < chain.length; i++) {
      const p = chain[i];
      try {
        const audio = await p.synthesize({ text, voice: voiceFor(p, config), signal });
        if (audio && audio.length) {
          if (p !== active) {
            log.warn('tts.failover', { from: nameOf(active), to: nameOf(p), reason: lastErr && lastErr.message });
            active = p;   // stick to the new one for the rest of the session
          }
          return { audio, mime: mimeFor(p), provider: nameOf(p) };
        }
        lastErr = new Error(nameOf(p) + ' returned empty audio');
      } catch (err) {
        if (signal && signal.aborted) throw err;   // barge-in is not a provider failure
        lastErr = err;
        log.warn('tts.provider-failed', { provider: nameOf(p), error: err.message });
      }
    }
    throw lastErr || new Error('all TTS providers failed');
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

module.exports = { selectTts, mimeFor, voiceFor, createTtsChain, parseChain };
