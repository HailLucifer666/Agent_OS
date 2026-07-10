'use strict';

// providers/embeddings.js — text-embedding chain for semantic memory recall.
// NOT routed through chain.js (chat-completion-shaped); embeddings are a
// different API shape. Same honest-degrade philosophy though: try Ollama
// (local, free) first, then Mistral's embeddings endpoint (existing key,
// free tier), and return null when both are down — recall degrades to
// keyword-only, never an error.
//
// Vectors from different providers are NEVER comparable — every result
// carries {provider, dim} and vector-index.js partitions by provider.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const MISTRAL_URL = process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1';
const MISTRAL_EMBED_MODEL = process.env.MISTRAL_EMBED_MODEL || 'mistral-embed';
const TIMEOUT_MS = 8000;

// Cooldown after a provider failure so a down provider doesn't add latency
// to every single memory write.
const COOLDOWN_MS = 60000;
const cooldownUntil = { ollama: 0, mistral: 0 };

async function embedOllama(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ollama embeddings ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding) || !data.embedding.length) throw new Error('ollama returned no embedding');
  return { provider: 'ollama', dim: data.embedding.length, vec: Float32Array.from(data.embedding) };
}

async function embedMistral(text) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('no MISTRAL_API_KEY');
  const res = await fetch(`${MISTRAL_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MISTRAL_EMBED_MODEL, input: [text] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mistral embeddings ${res.status}`);
  const data = await res.json();
  const emb = data.data && data.data[0] && data.data[0].embedding;
  if (!Array.isArray(emb) || !emb.length) throw new Error('mistral returned no embedding');
  return { provider: 'mistral', dim: emb.length, vec: Float32Array.from(emb) };
}

const CHAIN = [
  { name: 'ollama', fn: embedOllama },
  { name: 'mistral', fn: embedMistral },
];

// embed(text) -> { provider, dim, vec: Float32Array } | null. Never throws.
async function embed(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const now = Date.now();
  for (const entry of CHAIN) {
    if (now < cooldownUntil[entry.name]) continue;
    try {
      return await entry.fn(t.slice(0, 4000));
    } catch {
      cooldownUntil[entry.name] = Date.now() + COOLDOWN_MS;
    }
  }
  return null;
}

async function getStatus() {
  const probe = await embed('probe');
  return probe
    ? { available: true, provider: probe.provider, dim: probe.dim }
    : { available: false, provider: null, dim: 0 };
}

module.exports = { embed, getStatus, _internal: { embedOllama, embedMistral, cooldownUntil } };
