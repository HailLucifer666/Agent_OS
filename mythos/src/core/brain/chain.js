// chain.js — walks the ranked model list from registry.js, calling the matching provider's
// chat() with a per-lane cooldown so a rate-limited model is skipped for a while.
// CA from NOVA app/lib/models/chain.js.
// Throws only when every lane is exhausted (err.chainExhausted = true); callers must catch
// that and degrade honestly — this module never retries forever on its own.
const registry = require('./registry');
const zcode = require('../../../providers/zcode');
const nim = require('../../../providers/nim');
const nim2 = require('../../../providers/nim2');
const groq = require('../../../providers/groq');
const mistral = require('../../../providers/mistral');
const cerebras = require('../../../providers/cerebras');
const openrouter = require('../../../providers/openrouter');
const ollama = require('../../../providers/ollama');

const LANES = { zcode, nim, nim2, groq, mistral, cerebras, openrouter };
const COOLDOWN_MS = Number(process.env.CHAIN_COOLDOWN_MS) || 60000;
const ATTEMPT_TIMEOUT_MS = Number(process.env.CHAIN_ATTEMPT_TIMEOUT_MS) || 30000;
const cooldowns = new Map(); // "lane:model" -> until-timestamp

function laneKey(lane, model) {
  return `${lane}:${model}`;
}
function isCooling(lane, model) {
  return (cooldowns.get(laneKey(lane, model)) || 0) > Date.now();
}
function markCooldown(lane, model) {
  cooldowns.set(laneKey(lane, model), Date.now() + COOLDOWN_MS);
}

function nimLanesAvailable() {
  return ['nim', 'nim2'].filter((id) => LANES[id].isAvailable());
}

// Expands a ranked registry entry into concrete (lane, model) attempts. A 'nim' entry fans
// out to every configured NIM key (key rotation); 'groq', 'mistral', and 'ollama' entries
// are single attempts (one lane per provider).
function expand(entries) {
  const out = [];
  for (const e of entries) {
    if (e.provider === 'nim') {
      for (const lane of nimLanesAvailable()) out.push({ lane, model: e.model });
    } else if (e.provider === 'ollama') {
      out.push({ lane: 'ollama', model: e.model });
    } else {
      // groq, mistral, zcode, or any future openai-compat lane
      out.push({ lane: e.provider, model: e.model });
    }
  }
  return out;
}

// Translates OpenAI-style multimodal content ([{type:'text'|'image_url', ...}]) into
// Ollama's native shape: one message with `content` (text) + `images` ([base64,...]).
function toOllamaVisionMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const images = m.content
      .filter((p) => p.type === 'image_url')
      .map((p) => (p.image_url.url || '').replace(/^data:image\/\w+;base64,/, ''));
    return { role: m.role, content: text, images };
  });
}

// complete({ messages, kind, brain, signal, onAttempt, onToken }) -> { content, provider, model }
// kind:  'text' | 'json' | 'vision' (json shares the text chain; JSON discipline lives in
//        the prompt, not in provider selection).
// brain: 'voice' | 'build' | 'simple' | 'text' | 'vision' | 'embed' — selects the
//        preference list. Defaults to 'text' for backward compatibility.
// onToken: optional (delta:string) => void — every provider below already speaks
// SSE/NDJSON streaming and already accepts an onToken passthrough (openai-compat.js,
// openrouter.js, ollama.js); this was simply never threaded above the provider layer
// until P20. Forwarded verbatim to whichever provider actually answers — a provider
// that fails mid-stream still falls through to the next attempt exactly as before,
// onToken just stops firing for that attempt (the caller only trusts the final
// resolved `content`, same as always).
async function complete({ messages, kind, brain, signal, onAttempt, onToken }) {
  // brain takes priority if explicitly set; otherwise fall back to kind-based routing.
  const effectiveKind = brain || (kind === 'vision' ? 'vision' : 'text');
  const ranked = await registry.chainFor(effectiveKind);
  const attempts = expand(ranked);
  const errors = [];

  for (const { lane, model } of attempts) {
    if (signal && signal.aborted) throw new Error('aborted');
    if (isCooling(lane, model)) continue;
    // Skip lanes whose provider isn't configured (e.g. GROQ_API_KEY not set).
    if (LANES[lane] && typeof LANES[lane].isAvailable === 'function' && !LANES[lane].isAvailable()) continue;
    if (onAttempt) onAttempt({ provider: lane, model });
    try {
      // Per-attempt timeout prevents a slow/hanging provider from blocking the
      // entire chain walk (critical on cloud depots where cold starts or
      // network latency can stall a single provider for 30+ seconds).
      const attemptCtrl = new AbortController();
      const attemptTimer = setTimeout(() => attemptCtrl.abort(), ATTEMPT_TIMEOUT_MS);
      // If the caller already has an abort signal, forward it.
      const onCallerAbort = () => attemptCtrl.abort();
      signal && signal.addEventListener('abort', onCallerAbort, { once: true });

      try {
        let content;
        if (lane === 'ollama') {
          const msgs = effectiveKind === 'vision' ? toOllamaVisionMessages(messages) : messages;
          content = await ollama.chat(msgs, { model, keepAlive: process.env.VOICE_OLLAMA_KEEP_ALIVE || '10m', signal: attemptCtrl.signal, onToken });
        } else {
          content = await LANES[lane].chat(messages, { model, signal: attemptCtrl.signal, source: 'voice-chain', onToken });
        }
        return { content, provider: lane, model };
      } finally {
        // Cleanup MUST run on BOTH success and error paths. Previously this was
        // before the return only — the catch block leaked the timer and the
        // abort listener on every failed provider attempt. Over a long-running
        // process each chain walk accumulated N stale 30s timers + N permanent
        // listeners on the caller's signal (slow memory + listener leak).
        clearTimeout(attemptTimer);
        signal && signal.removeEventListener('abort', onCallerAbort);
      }
    } catch (err) {
      errors.push(`${lane}:${model}: ${err.message}`);
      // Error discrimination: only cooldown on rate-limit (429) or network errors.
      // Auth failures (401/403) won't recover in 60s — let isAvailable() handle them.
      // Bad-request (400) means the provider is healthy, the request was wrong — don't
      // penalize the provider. Caller-abort is not a provider fault either.
      var msg = String(err && err.message || '');
      var isAbort = err && err.name === 'AbortError';
      var isRateLimit = /:\s*429\b/.test(msg);
      var isServerError = /:\s*5\d\d\b/.test(msg);
      var isNetwork = /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
      if (isRateLimit || isServerError || isNetwork || isAbort) {
        markCooldown(lane, model);
      }
    }
  }

  const err = new Error(`all models failed: ${errors.join(' | ') || 'no live models configured'}`);
  err.chainExhausted = true;
  throw err;
}

async function isAvailable() {
  return (await registry.chainFor('text')).length > 0;
}

module.exports = {
  complete,
  isAvailable,
  _internal: { cooldowns, markCooldown, expand, toOllamaVisionMessages, _resetCooldowns: () => cooldowns.clear() },
};
