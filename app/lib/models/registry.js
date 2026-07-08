// registry.js — probes configured model providers and produces ranked, alive-only
// model lists for brain types ('voice', 'build', 'simple', 'text', 'vision'). Read by
// lib/models/chain.js and by GET /api/models/status. Never throws; an unreachable provider
// just comes back empty (honest-inert, same posture as the rest of the voice stack).
const ollama = require('../providers/ollama');
const groq = require('../providers/groq');
const mistral = require('../providers/mistral');

const NIM_URL = process.env.NIM_API_URL || 'https://integrate.api.nvidia.com/v1';
const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
const MISTRAL_URL = process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1';

function nimKeys() {
  return [process.env.NIM_API_KEY, process.env.NIM_API_KEY_2].filter((k) => k && k.trim());
}

// ---------------------------------------------------------------------------
// Static preference tables, ranked best-first. `provider: 'nim'` entries are expanded
// by chain.js into one attempt per configured NIM key (key rotation).
//
// Brain types (from BRAIN-MAP.md, locked 2026-07-08):
//   voice  — Groq 70b → Mistral Large → Ollama qwen3:8b
//   build  — Mistral Large → NIM GLM-5.2 → Ollama ornith:9b
//   simple — Ollama qwen3:8b only
//   vision — NIM MiniMax-M3 → Ollama qwen2.5vl:7b
//
// Legacy text/vision chains kept as fallbacks for generic chain.complete() calls.
//
// Env overrides: CHAIN_VOICE / CHAIN_BUILD / CHAIN_SIMPLE / CHAIN_TEXT /
//   CHAIN_VISION as comma lists of "provider:model".
// ---------------------------------------------------------------------------

// 🎙️ Voice brain — speed is everything
const PREF_VOICE = [
  { provider: 'groq',   model: 'llama-3.3-70b-versatile' },
  { provider: 'mistral', model: 'mistral-large-2512' },
  { provider: 'ollama',  model: 'qwen3:8b' },
];

// 🏗️ Build brain — quality over speed
const PREF_BUILD = [
  { provider: 'mistral', model: 'mistral-large-2512' },
  { provider: 'zcode',   model: 'glm-5.2' },
  { provider: 'ollama',  model: 'ornith:9b' },
];

// ✉️ Simple tasks — local only
const PREF_SIMPLE = [
  { provider: 'ollama', model: 'qwen3:8b' },
];

// Legacy generic text chain (fallback if no brain specified)
const PREF_TEXT = [
  { provider: 'nim', model: 'deepseek-ai/deepseek-r1' },
  { provider: 'nim', model: 'meta/llama-3.1-405b-instruct' },
  { provider: 'ollama', model: 'kimi-k2.5:cloud' },
  { provider: 'ollama', model: 'qwen3:14b' },
  { provider: 'ollama', model: 'qwen3:8b' },
];

// 👁️ Vision brain
const PREF_VISION = [
  { provider: 'ollama', model: 'qwen3.5:latest' },
  { provider: 'ollama', model: 'qwen2.5vl:7b' },
];

// Map brain type to its preference table and env override variable
const BRAIN_TABLES = {
  voice:  { prefs: PREF_VOICE,  env: 'CHAIN_VOICE' },
  build:  { prefs: PREF_BUILD,  env: 'CHAIN_BUILD' },
  simple: { prefs: PREF_SIMPLE, env: 'CHAIN_SIMPLE' },
  text:   { prefs: PREF_TEXT,   env: 'CHAIN_TEXT' },
  vision: { prefs: PREF_VISION, env: 'CHAIN_VISION' },
};

// ---------------------------------------------------------------------------
// Provider probing
// ---------------------------------------------------------------------------

let cache = { at: 0, nimModels: [], ollamaModels: [], groqAlive: false, mistralAlive: false, probing: null };
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

async function probeGroq() {
  if (!groq.isAvailable()) return false;
  try {
    const res = await fetch(`${GROQ_URL}/models`, {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeMistral() {
  if (!mistral.isAvailable()) return false;
  try {
    const res = await fetch(`${MISTRAL_URL}/models`, {
      headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
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
    const [nimModels, ollamaModels, groqAlive, mistralAlive] = await Promise.all([
      probeNim(), probeOllama(), probeGroq(), probeMistral(),
    ]);
    cache = { at: Date.now(), nimModels, ollamaModels, groqAlive, mistralAlive, probing: null };
    return cache;
  })();
  return cache.probing;
}

// ---------------------------------------------------------------------------
// Override parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// chainFor — ranked, alive-only chain for a brain type or legacy kind.
// ---------------------------------------------------------------------------

function isProviderAlive(provider, model, c) {
  switch (provider) {
    case 'nim':    return c.nimModels.includes(model) && nimKeys().length > 0;
    case 'groq':   return c.groqAlive;
    case 'mistral': return c.mistralAlive;
    case 'ollama': return c.ollamaModels.includes(model);
    case 'zcode':  return !!process.env.ZCODE_API_KEY;
    default:       return false;
  }
}

// Ranked, alive-only chain for a brain type. Never throws; empty array = nothing alive.
// Supported kinds: 'voice' | 'build' | 'simple' | 'text' | 'vision'
async function chainFor(kind) {
  const c = await refresh();
  const table = BRAIN_TABLES[kind] || BRAIN_TABLES.text;
  const override = parseOverride(process.env[table.env]);
  const prefs = override.length ? override : table.prefs;
  return prefs.filter((p) => isProviderAlive(p.provider, p.model, c));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function getStatus() {
  const c = await refresh();
  return {
    nim:     { configured: nimKeys().length, aliveModels: c.nimModels.length },
    ollama:  { aliveModels: c.ollamaModels.length, models: c.ollamaModels },
    groq:    { alive: c.groqAlive },
    mistral: { alive: c.mistralAlive },
    chains: {
      voice:  await chainFor('voice'),
      build:  await chainFor('build'),
      simple: await chainFor('simple'),
      text:   await chainFor('text'),
      vision: await chainFor('vision'),
    },
    probedAt: c.at,
  };
}

module.exports = {
  chainFor,
  getStatus,
  refresh,
  _internal: { PREF_TEXT, PREF_VISION, PREF_VOICE, PREF_BUILD, PREF_SIMPLE, BRAIN_TABLES, parseOverride },
};
