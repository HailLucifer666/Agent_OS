// registry.js — probes configured model providers and produces ranked, alive-only
// model lists for brain lanes ('voice', 'build', 'simple', 'text', 'vision', 'embed').
// CA from NOVA app/lib/models/registry.js.
// Never throws; an unreachable provider just comes back empty (honest-inert).
const ollama = require('../../../providers/ollama');
const groq = require('../../../providers/groq');
const mistral = require('../../../providers/mistral');

const { BRAIN_TABLES } = require('./lanes.default');

const NIM_URL = process.env.NIM_API_URL || 'https://integrate.api.nvidia.com/v1';
const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
const MISTRAL_URL = process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1';
const CEREBRAS_URL = process.env.CEREBRAS_API_URL || 'https://api.cerebras.ai/v1';
const GOOGLE_URL = process.env.GOOGLE_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai';
const OPENROUTER_URL = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1';

function nimKeys() {
  return [process.env.NIM_API_KEY, process.env.NIM_API_KEY_2].filter((k) => k && k.trim());
}

// ---------------------------------------------------------------------------
// Provider probing
// ---------------------------------------------------------------------------

let cache = {
  at: 0, nimModels: [], ollamaModels: [], groqAlive: false, mistralAlive: false,
  cerebrasModels: [], googleModels: [], openrouterAlive: false, probing: null,
};
const TTL_MS = Number(process.env.MODEL_REGISTRY_TTL_MS) || 5 * 60 * 1000;

// Shared helper for the OpenAI-compatible /models catalog probes below.
// Returns [] on any failure — never throws (honest-inert contract).
// `strip` removes a provider-specific id prefix: Google's catalog returns
// `models/gemini-flash-latest` while its chat endpoint wants the bare id, so
// without stripping every lookup would miss.
async function probeModelCatalog(baseURL, apiKey, strip) {
  if (!apiKey) return [];
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .map((m) => (strip && typeof m.id === 'string' ? m.id.replace(strip, '') : m.id))
      .filter(Boolean);
  } catch {
    return [];
  }
}

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

async function probeCerebras() {
  return probeModelCatalog(CEREBRAS_URL, process.env.CEREBRAS_API_KEY);
}

async function probeGoogle() {
  return probeModelCatalog(GOOGLE_URL, process.env.GOOGLE_API_KEY, /^models\//);
}

// OpenRouter is boolean-only by necessity: its public /models catalog lists every
// model on the platform regardless of the account's guardrail allowlist, so a
// catalog membership test would happily report an allowlist-blocked model alive.
// /key authenticates the key without claiming per-model granularity we can't see.
async function probeOpenrouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch(`${OPENROUTER_URL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Coalesces concurrent refreshes into one in-flight probe so N simultaneous callers
// never fire N redundant probe round-trips.
async function refresh(force) {
  const now = Date.now();
  if (!force && now - cache.at < TTL_MS) return cache;
  if (cache.probing) return cache.probing;
  cache.probing = (async () => {
    const [nimModels, ollamaModels, groqAlive, mistralAlive, cerebrasModels, googleModels, openrouterAlive] =
      await Promise.all([
        probeNim(), probeOllama(), probeGroq(), probeMistral(),
        probeCerebras(), probeGoogle(), probeOpenrouter(),
      ]);
    cache = {
      at: Date.now(), nimModels, ollamaModels, groqAlive, mistralAlive,
      cerebrasModels, googleModels, openrouterAlive, probing: null,
    };
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
// chainFor — ranked, alive-only chain for a brain lane.
// ---------------------------------------------------------------------------

// A provider is alive only when its key is configured AND a real probe confirmed
// it. Until 2026-07-29 cerebras/openrouter/zcode short-circuited on key presence
// alone, so four retired OpenRouter `:free` slugs (and cerebras models absent
// from the account) counted as alive and burned a full chain attempt each.
function isProviderAlive(provider, model, c) {
  switch (provider) {
    case 'nim':        return c.nimModels.includes(model) && nimKeys().length > 0;
    case 'groq':       return c.groqAlive;
    case 'mistral':    return c.mistralAlive;
    case 'ollama':     return c.ollamaModels.includes(model);
    case 'zcode':      return !!process.env.ZCODE_API_KEY;
    case 'cerebras':   return !!process.env.CEREBRAS_API_KEY && c.cerebrasModels.includes(model);
    case 'google':     return !!process.env.GOOGLE_API_KEY && c.googleModels.includes(model);
    case 'openrouter': return !!process.env.OPENROUTER_API_KEY && c.openrouterAlive;
    default:           return false;
  }
}

// Ranked, alive-only chain for a brain lane. Never throws; empty array = nothing alive.
// Supported kinds: 'voice' | 'build' | 'simple' | 'text' | 'vision' | 'embed'
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
    nim:        { configured: nimKeys().length, aliveModels: c.nimModels.length },
    ollama:     { aliveModels: c.ollamaModels.length, models: c.ollamaModels },
    groq:       { alive: c.groqAlive },
    mistral:    { alive: c.mistralAlive },
    cerebras:   { configured: !!process.env.CEREBRAS_API_KEY, aliveModels: c.cerebrasModels.length },
    google:     { configured: !!process.env.GOOGLE_API_KEY, aliveModels: c.googleModels.length },
    openrouter: { configured: !!process.env.OPENROUTER_API_KEY, alive: c.openrouterAlive },
    chains: {
      voice:  await chainFor('voice'),
      build:  await chainFor('build'),
      simple: await chainFor('simple'),
      text:   await chainFor('text'),
      vision: await chainFor('vision'),
      embed:  await chainFor('embed'),
    },
    probedAt: c.at,
  };
}

module.exports = {
  chainFor,
  getStatus,
  refresh,
  _internal: { BRAIN_TABLES, parseOverride, isProviderAlive },
};
