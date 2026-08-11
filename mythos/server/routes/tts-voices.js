'use strict';

// server/routes/tts-voices.js — the HUD voice picker's server side.
//
// WHY (operator, 2026-08-11): the packaged app spoke in the browser's flat
// speechSynthesis voice and there was no way to change it, because every voice id
// lives in an environment variable inside mythos/.env — a file the installer
// deliberately does not ship. Worse, there was no way to HEAR a voice before
// committing to it. Three routes close that:
//
//   GET  /api/tts/voices    what this machine could speak with, honestly marked
//   POST /api/tts/voice     make one the default, effective on the NEXT reply
//   POST /api/tts/audition  synthesize a short sample, right now, changing nothing
//
// AUDITION NEVER TOUCHES THE SESSION CHAIN. It calls the chosen provider module
// directly (providerByShortName) rather than through createTtsChain, because a
// chain resolve() probes and then STICKS — pressing play on a sample would
// otherwise silently decide which engine the entity speaks with for the rest of
// the session. Structural, not a matter of care: this file never sees a chain it
// could disturb, only getTts()/setTts() for the deliberate default change.
//
// All three sit behind the same /api token gate and global limiter as every
// other route (server/index.js). Nothing here is exempt.

const { listEngines, providerByShortName, voiceFor } = require('../../providers/tts');
const { createTtsChain } = require('../../providers/tts');
const { createLimiter } = require('../rate-limit');
const {
  KNOWN_PROVIDERS, SHORT_NAME, VOICE_ENV_KEY, MAX_VOICE_LEN, applyVoiceChoice,
} = require('../../src/core/config/voice-choice');
const { readVoiceChoice, writeVoiceChoice } = require('../../src/core/config/voice-choice-store');

// The reverse of SHORT_NAME (full provider name -> short token). VOICE_TTS_CHAIN
// is written in short tokens (providers/tts.js's BY_NAME keys); chainAfter()
// needs to go both ways, so it is built once here rather than re-derived per call.
const FULL_NAME = Object.fromEntries(Object.entries(SHORT_NAME).map(([full, short]) => [short, full]));

// One sentence. Gemini TTS measures ~3.9s/sentence and is metered, so a sample is
// deliberately a sample — an operator auditioning eight voices should not be
// billed for eight paragraphs.
const MAX_AUDITION_CHARS = 200;
// A hung provider must not hold an HTTP socket open forever behind the
// 8/min expensive limiter.
const AUDITION_TIMEOUT_MS = 15000;

const DEFAULT_SAMPLE = 'This is how I will sound when I speak to you.';

// Which engine the entity would use right now, and with which voice. Read off
// the resolved config, so it reports whatever won the precedence chain (env,
// then the picked file, then the derived default) without exposing which layer
// that was — the operator asked what they will hear, not where it came from.
function currentDefault(config, chain) {
  const activeName = (chain && chain.name && chain.name !== 'unknown') ? chain.name : null;
  const firstInChain = (chain && chain.chainNames && chain.chainNames[0]) || null;
  const provider = activeName || firstInChain || 'edge-tts';
  return { provider, voice: voiceFor({ name: provider }, config) || null };
}

// The tail of the configured chain AFTER `provider`, as full provider names
// (e.g. 'kokoro-tts') so callers can round-trip through SHORT_NAME/byShort the
// same way the rest of this file already does. Pure — no I/O, no config
// mutation — so an explicit fallback audition is easy to reason about.
//
// `provider` NOT FOUND in the chain returns an empty tail (no fallback), not
// "the whole chain" and not "an error". The chain is the operator's own
// ordering of engines they trust for THIS session; a provider absent from it
// (VOICE_TTS_CHAIN edited by hand, or a provider the picker never put there)
// has no defined position relative to it, so there is no ordering to walk.
// Guessing a fallback order would risk auditioning an engine the operator
// never asked to test right now — silence is the safer failure.
//
// Duplicates are collapsed (parseChain does the same for the live chain; this
// reads VOICE_TTS_CHAIN directly rather than through parseChain, so it repeats
// that de-dupe rather than assuming it) so 'gemini,gemini,kokoro' still yields
// exactly ['kokoro-tts'].
function chainAfter(chainCsv, provider) {
  const shorts = [];
  for (const s of String(chainCsv || 'edge').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (shorts.indexOf(s) === -1) shorts.push(s);
  }
  const at = shorts.indexOf(SHORT_NAME[provider]);
  if (at === -1) return [];
  return shorts.slice(at + 1).map((s) => FULL_NAME[s]).filter(Boolean);
}

function mountTtsVoiceRoutes(app, deps) {
  const { config, logger, getTts, setTts, expensiveLimit } = deps;
  const vaultRoot = deps.vaultRoot || config.MYTHOS_VAULT_ROOT;
  const log = logger || { info() {}, warn() {} };
  // A write plus a chain rebuild: cheap, but state-changing and operator-driven.
  // Nobody legitimately sets their default voice 20 times a minute.
  const setLimit = deps.setLimit || createLimiter({ windowMs: 60000, max: 20, scope: 'tts-voice-set' });
  const auditionLimit = expensiveLimit || createLimiter({ windowMs: 60000, max: 8, scope: 'tts-audition' });
  const enumerate = deps.listEngines || listEngines;
  const byShort = deps.providerByShortName || providerByShortName;

  app.get('/api/tts/voices', async (req, res) => {
    try {
      const engines = await enumerate();
      res.json({ engines, default: currentDefault(config, getTts && getTts()) });
    } catch (err) {
      // A listing that cannot be built is a server condition. Answering 200 with
      // an empty engine list would read as "this machine can speak with nothing",
      // which is a different and more alarming claim.
      res.status(500).json({ error: 'voice listing failed: ' + err.message });
    }
  });

  app.post('/api/tts/voice', setLimit, async (req, res) => {
    const body = req.body || {};
    const provider = String(body.provider || '');
    const voice = String(body.voice || '').trim();
    if (KNOWN_PROVIDERS.indexOf(provider) === -1) {
      return res.status(400).json({ error: 'Unknown provider. Expected one of: ' + KNOWN_PROVIDERS.join(', ') });
    }
    if (!voice || voice.length > MAX_VOICE_LEN) {
      return res.status(400).json({ error: `A voice id is required, at most ${MAX_VOICE_LEN} characters.` });
    }

    // Soft check, and soft on purpose. If the engine can enumerate right now we
    // reject a typo'd id; if its sidecar is down we store the choice anyway
    // rather than refuse a perfectly good voice because the service that could
    // confirm it happens to be off. Same reasoning as the chain's own philosophy:
    // fail honestly at use, do not pre-emptively forbid.
    const mod = byShort(SHORT_NAME[provider]);
    if (mod && typeof mod.listVoices === 'function') {
      let known = [];
      try { known = (await mod.listVoices()) || []; } catch { known = []; }
      const ids = known.map((v) => (typeof v === 'string' ? v : (v && (v.id || v.name)))).filter(Boolean).map(String);
      if (ids.length && ids.indexOf(voice) === -1) {
        return res.status(400).json({ error: `${provider} does not have a voice called "${voice}".`, voices: ids });
      }
    }

    try {
      writeVoiceChoice(vaultRoot, { provider, voice });
    } catch (err) {
      // Report the failure instead of a save that did not happen — the operator
      // would otherwise restart into the old voice with no explanation.
      log.warn('tts.voice-choice-write-failed', { error: err.message });
      return res.status(500).json({ error: 'Could not save that choice: ' + err.message });
    }

    // Rebuild the chain so the NEXT reply speaks in it. The reply currently in
    // flight, if any, finishes in the old voice — see currentTts() in
    // server/index.js for why that is the intended reading of "immediate".
    let chainNames = null;
    try {
      const overlay = applyVoiceChoice(process.env, readVoiceChoice(vaultRoot), config.VOICE_TTS_CHAIN || 'edge');
      const next = createTtsChain({ config: { ...config, ...overlay }, logger: log });
      if (setTts) setTts(next);
      chainNames = next.chainNames;
    } catch (err) {
      // Stored but not live: say so rather than claim success. A restart will
      // pick it up regardless, because the file is already written.
      log.warn('tts.chain-rebuild-failed', { error: err.message });
      return res.status(200).json({ ok: true, provider, voice, applied: false, error: 'Saved, but it needs a restart to take effect: ' + err.message });
    }

    // A Gemini voice is BOTH surfaces' voice — providers/tts.js's voiceFor()
    // and live-session.js read the same GEMINI_LIVE_VOICE key. Tell the server
    // so a currently-open Live session is closed and reopens speaking as the
    // newly picked voice; without this the operator would pick a voice, hear
    // the old one for the rest of the session, and reasonably call it broken.
    let liveSessionsClosed = 0;
    if (provider === 'gemini-tts' && typeof deps.setLiveVoice === 'function') {
      try { liveSessionsClosed = deps.setLiveVoice(voice) || 0; } catch (err) {
        log.warn('tts.live-voice-swap-failed', { error: err.message });
      }
    }

    log.info('tts.voice-chosen', { provider, voice, liveSessionsClosed });
    res.json({
      ok: true, provider, voice, applied: true, chain: chainNames,
      voiceKey: VOICE_ENV_KEY[provider], liveSessionsClosed,
    });
  });

  app.post('/api/tts/audition', auditionLimit, async (req, res) => {
    const body = req.body || {};
    const provider = String(body.provider || '');
    const voice = String(body.voice || '').trim();
    const text = String(body.text || DEFAULT_SAMPLE).trim();
    if (KNOWN_PROVIDERS.indexOf(provider) === -1) {
      return res.status(400).json({ error: 'Unknown provider. Expected one of: ' + KNOWN_PROVIDERS.join(', ') });
    }
    if (!voice || voice.length > MAX_VOICE_LEN) {
      return res.status(400).json({ error: `A voice id is required, at most ${MAX_VOICE_LEN} characters.` });
    }
    if (!text || text.length > MAX_AUDITION_CHARS) {
      return res.status(400).json({ error: `Sample text must be 1 to ${MAX_AUDITION_CHARS} characters.` });
    }

    const mod = byShort(SHORT_NAME[provider]);
    if (!mod) return res.status(400).json({ error: 'Unknown provider.' });
    let available = false;
    try { available = Boolean(await mod.isAvailable()); } catch { available = false; }
    if (!available) {
      return res.status(503).json({ error: `${provider} is not available on this machine.` });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AUDITION_TIMEOUT_MS);
    // An operator who navigates away mid-sample should not leave a metered
    // Gemini call running to completion.
    req.on('close', () => ctrl.abort());
    try {
      const audio = await mod.synthesize({ text, voice, signal: ctrl.signal });
      if (!audio || !audio.length) throw new Error('the engine returned no audio');
      res.json({ mime: mod.mime || 'audio/mpeg', audioB64: Buffer.from(audio).toString('base64'), provider, voice });
    } catch (err) {
      log.warn('tts.audition-failed', { provider, voice, error: err.message });

      // A quota refusal is not a broken engine — it is a wait. Give the
      // operator the one fact they can act on (retry in N seconds) instead of
      // Google's billing URLs, and offer a local voice meanwhile.
      const quota = /\b429\b|exceeded your current quota/i.test(err.message);
      const retryMatch = err.message.match(/retry in ([\d.]+)s/i);
      const retryAfterSec = retryMatch ? Math.ceil(Number(retryMatch[1])) : null;

      // Only an explicit fallback request walks the chain — a preview must
      // never silently audition a DIFFERENT voice than the one clicked unless
      // the caller asked for it. And it must not reuse an ALREADY-ABORTED
      // signal: the timeout fires at AUDITION_TIMEOUT_MS and req.on('close')
      // aborts ctrl the instant the operator navigates away, so if ctrl is
      // aborted here the request's whole time budget is already spent, or
      // nobody is listening for the response — either way a fallback attempt
      // would fail (or succeed) for nobody. Reusing ctrl.signal when it is
      // still live is deliberate, not an oversight: primary and fallback share
      // ONE 15s budget, which is the same "never hold the socket open forever"
      // guarantee AUDITION_TIMEOUT_MS already promised for a single attempt.
      if (body.allowFallback && !ctrl.signal.aborted) {
        const next = chainAfter(config.VOICE_TTS_CHAIN, provider);
        for (const candidate of next) {
          const mod2 = byShort(SHORT_NAME[candidate]);
          if (!mod2) continue;
          let up = false;
          try { up = Boolean(await mod2.isAvailable()); } catch { up = false; }
          if (!up) continue;
          const voice2 = voiceFor(mod2, config);
          try {
            const audio2 = await mod2.synthesize({ text, voice: voice2, signal: ctrl.signal });
            if (audio2 && audio2.length) {
              return res.json({
                mime: mod2.mime || 'audio/mpeg',
                audioB64: Buffer.from(audio2).toString('base64'),
                provider: candidate,
                voice: voice2,
                fellBackFrom: provider,
              });
            }
          } catch (err2) {
            log.warn('tts.audition-fallback-failed', { provider: candidate, error: err2.message });
          }
        }
      }

      if (quota) {
        return res.status(429).json({
          error: retryAfterSec
            ? `${provider} is out of quota — retry in about ${retryAfterSec}s, or preview a local voice.`
            : `${provider} is out of quota — preview a local voice instead.`,
          retryAfterSec,
          provider,
          voice,
        });
      }
      res.status(502).json({ error: `${provider} could not speak that sample: ` + err.message });
    } finally {
      clearTimeout(timer);
    }
  });
}

module.exports = { mountTtsVoiceRoutes, MAX_AUDITION_CHARS, DEFAULT_SAMPLE, currentDefault };
