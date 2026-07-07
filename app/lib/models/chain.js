// chain.js — walks the ranked model list from registry.js, calling the matching provider's
// EXISTING chat() (reuses lib/providers/nim.js, nim2.js, ollama.js — no reimplemented HTTP),
// with a per-lane cooldown so a rate-limited model is skipped for a while instead of failing
// every subsequent turn. Throws only when every lane is exhausted (err.chainExhausted = true);
// callers must catch that and degrade honestly — this module never retries forever on its own.
const registry = require('./registry');
const nim = require('../providers/nim');
const nim2 = require('../providers/nim2');
const ollama = require('../providers/ollama');

const LANES = { nim, nim2 };
const COOLDOWN_MS = Number(process.env.CHAIN_COOLDOWN_MS) || 60000;
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
// out to every configured NIM key (key rotation); 'ollama' entries are a single attempt.
function expand(entries) {
  const out = [];
  for (const e of entries) {
    if (e.provider === 'nim') {
      for (const lane of nimLanesAvailable()) out.push({ lane, model: e.model });
    } else {
      out.push({ lane: 'ollama', model: e.model });
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

// complete({ messages, kind, signal, onAttempt }) -> { content, provider, model }
// kind: 'text' | 'json' | 'vision' (json shares the text chain; JSON discipline lives in
// the prompt, not in provider selection).
async function complete({ messages, kind = 'text', signal, onAttempt } = {}) {
  const ranked = await registry.chainFor(kind === 'vision' ? 'vision' : 'text');
  const attempts = expand(ranked);
  const errors = [];

  for (const { lane, model } of attempts) {
    if (signal && signal.aborted) throw new Error('aborted');
    if (isCooling(lane, model)) continue;
    if (onAttempt) onAttempt({ provider: lane, model });
    try {
      let content;
      if (lane === 'ollama') {
        const msgs = kind === 'vision' ? toOllamaVisionMessages(messages) : messages;
        content = await ollama.chat(msgs, { model, keepAlive: process.env.VOICE_OLLAMA_KEEP_ALIVE || '10m', signal });
      } else {
        content = await LANES[lane].chat(messages, { model, signal, source: 'voice-chain' });
      }
      return { content, provider: lane, model };
    } catch (err) {
      errors.push(`${lane}:${model}: ${err.message}`);
      markCooldown(lane, model);
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
