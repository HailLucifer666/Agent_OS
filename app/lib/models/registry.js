// registry.js — probes configured model providers and produces ranked, alive-only
// model lists for 'text' and 'vision' kinds. Read by lib/models/chain.js and by
// GET /api/models/status. Never throws; an unreachable provider just comes back empty
// (honest-inert, same posture as the rest of the voice stack).
const ollama = require('../providers/ollama');

const NIM_URL = process.env.NIM_API_URL || 'https://integrate.api.nvidia.com/v1';

function nimKeys() {
  return [process.env.NIM_API_KEY, process.env.NIM_API_KEY_2].filter((k) => k && k.trim());
}

// Static preference tables, ranked best-first. `provider: 'nim'` entries are expanded by
// chain.js into one attempt per configured NIM key (key rotation) — the model catalog is
// identical across both keys, so registry.js only needs to track it once.
// Env overrides: CHAIN_TEXT / CHAIN_VISION as comma lists of "provider:model".
const PREF_TEXT = [
  { provider: 'nim', model: 'z-ai/glm-5.2' },
  { provider: 'nim', model: 'deepseek-ai/deepseek-v4-pro' },
  { provider: 'nim', model: 'moonshotai/kimi-k2.6' },
  { provider: 'ollama', model: 'kimi-k2.5:cloud' },
  { provider: 'ollama', model: 'qwen3:14b' },
  { provider: 'ollama', model: 'qwen3:8b' },
];
const PREF_VISION = [
  { provider: 'nim', model: 'minimaxai/minimax-m3' },
  { provider: 'ollama', model: 'qwen2.5vl:7b' },
];

let cache = { at: 0, nimModels: [], ollamaModels: [], probing: null };
const TTL_MS = Number(process.env.MODEL_REGISTRY_TTL_MS) || 5 * 60 * 1000;

async function probeNim() {
  const key = nimKeys()[0];
  if (!key) return [];
  try {
    const res = await fetch(`${NIM_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function probeOllama() {
  try {
    return await ollama.listModels();
  } catch {
    return [];
  }
}

// Coalesces concurrent refreshes into one in-flight probe so N simultaneous callers
// (e.g. /api/models/status hit right as a voice turn also needs the chain) never fire
// N redundant probe round-trips.
async function refresh(force = false) {
  const now = Date.now();
  if (!force && now - cache.at < TTL_MS) return cache;
  if (cache.probing) return cache.probing;
  cache.probing = (async () => {
    const [nimModels, ollamaModels] = await Promise.all([probeNim(), probeOllama()]);
    cache = { at: Date.now(), nimModels, ollamaModels, probing: null };
    return cache;
  })();
  return cache.probing;
}

function parseOverride(env) {
  return (env || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : null;
    })
    .filter(Boolean);
}

// Ranked, alive-only chain for a kind. Never throws; empty array = nothing alive.
async function chainFor(kind /* 'text' | 'vision' */) {
  const c = await refresh();
  const override = parseOverride(kind === 'vision' ? process.env.CHAIN_VISION : process.env.CHAIN_TEXT);
  const prefs = override.length ? override : (kind === 'vision' ? PREF_VISION : PREF_TEXT);
  return prefs.filter((p) =>
    p.provider === 'nim' ? c.nimModels.includes(p.model) && nimKeys().length > 0 : c.ollamaModels.includes(p.model)
  );
}

async function getStatus() {
  const c = await refresh();
  return {
    nim: { configured: nimKeys().length, aliveModels: c.nimModels.length },
    ollama: { aliveModels: c.ollamaModels.length, models: c.ollamaModels },
    chains: { text: await chainFor('text'), vision: await chainFor('vision') },
    probedAt: c.at,
  };
}

module.exports = {
  chainFor,
  getStatus,
  refresh,
  _internal: { PREF_TEXT, PREF_VISION, parseOverride },
};
