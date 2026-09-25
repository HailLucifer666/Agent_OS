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

const routePolicy = require('../src/core/brain/route-policy');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const MISTRAL_URL = process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1';
const MISTRAL_EMBED_MODEL = process.env.MISTRAL_EMBED_MODEL || 'mistral-embed';
// THIRD RUNG ADDED 2026-09-11, and it was added because the chain had silently
// become one rung deep. Ollama was uninstalled from this machine that day, which
// left `mistral-embed` as the only embedder standing between the assistant and
// keyword-only recall — and Mistral answered `429 Rate limit exceeded` on four
// other models on the same key that afternoon, so a tier limit taking out the
// last rung was not hypothetical.
//
// Dimensions do NOT have to match the other rungs: this file's own contract is
// that vectors from different providers are never compared and vector-index.js
// partitions by provider. 1024 is requested anyway, because it matches
// mistral-embed and keeps the partitions the same size — gemini-embedding-001
// defaults to 3072, measured 2026-09-11, and an unrequested default would triple
// the stored vector for no benefit.
const GOOGLE_EMBED_MODEL = process.env.GOOGLE_EMBED_MODEL || 'gemini-embedding-001';
const GOOGLE_EMBED_DIM = 1024;
const TIMEOUT_MS = 8000;

// Cooldown after a provider failure so a down provider doesn't add latency
// to every single memory write.
const COOLDOWN_MS = 60000;
const cooldownUntil = { ollama: 0, mistral: 0, google: 0 };

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

// Google's embeddings live on a different endpoint shape again (embedContent,
// singular, with the model in the path) — hence its own function rather than a
// parameterised OpenAI-style caller.
async function embedGoogle(text) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('google embeddings: GOOGLE_API_KEY is not set');
  const res = await fetch(`${GOOGLE_EMBED_BASE}/${GOOGLE_EMBED_MODEL}:embedContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GOOGLE_EMBED_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: GOOGLE_EMBED_DIM,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`google embeddings ${res.status}`);
  const data = await res.json();
  const vec = data && data.embedding && (data.embedding.values || data.embedding.value);
  if (!Array.isArray(vec) || !vec.length) throw new Error('google returned no embedding');
  return { provider: 'google', dim: vec.length, vec: Float32Array.from(vec) };
}

// Order is cheapest-and-most-local first, unchanged. Google sits LAST rather
// than second on purpose: it shares GOOGLE_API_KEY with the voice, vision,
// memory and text lanes, so a burst of memory writes must not be what exhausts
// the quota the operator hears. It is the rung that keeps recall alive when the
// two ahead of it are gone, not the one that carries normal traffic.
// `route` is what MODEL_BILLING_POLICY judges (Wave 0c, brain/route-policy.js):
// the model and the host each rung will actually call, after env overrides.
const GOOGLE_EMBED_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const CHAIN = [
  { name: 'ollama', fn: embedOllama, route: { provider: 'ollama', model: OLLAMA_EMBED_MODEL, endpoint: OLLAMA_URL, mode: 'embed' } },
  { name: 'mistral', fn: embedMistral, route: { provider: 'mistral', model: MISTRAL_EMBED_MODEL, endpoint: MISTRAL_URL, mode: 'embed' } },
  { name: 'google', fn: embedGoogle, route: { provider: 'google', model: GOOGLE_EMBED_MODEL, endpoint: GOOGLE_EMBED_BASE, mode: 'embed' } },
];

// A refused rung is skipped like a cooling one, but said once — this function
// never throws and has no other channel, and a rung that silently stops being
// tried is how the chain went one-deep unnoticed on 2026-09-11 (above).
const refusalsReported = new Set();
function refusedByPolicy(entry) {
  const d = routePolicy.decide(entry.route);
  if (d.allowed) return false;
  if (!refusalsReported.has(d.reason)) {
    refusalsReported.add(d.reason);
    try { console.warn('[embeddings] ' + d.reason); } catch (_) {}
  }
  return true;
}

// embed(text) -> { provider, dim, vec: Float32Array } | null. Never throws.
async function embed(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const now = Date.now();
  for (const entry of CHAIN) {
    if (now < cooldownUntil[entry.name]) continue;
    if (refusedByPolicy(entry)) continue;
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

module.exports = { embed, getStatus, _internal: { embedOllama, embedMistral, embedGoogle, cooldownUntil, CHAIN } };
