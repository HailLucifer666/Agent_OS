// registry.js — probes configured model providers and produces ranked, alive-only
// model lists for brain lanes ('voice', 'build', 'simple', 'text', 'vision', 'embed').
// CA from NOVA app/lib/models/registry.js.
// Never throws; an unreachable provider just comes back empty (honest-inert).
const ollama = require('../../../providers/ollama');
const groq = require('../../../providers/groq');
const mistral = require('../../../providers/mistral');

const { BRAIN_TABLES } = require('./lanes.default');
// BUG-419: every probe in this file reads a free catalog endpoint, so none of
// them can see an account that refuses to bill. This holds what a real
// completion said.
const providerHealth = require('./provider-health');

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
  // BUG-419 (2026-09-09), and it is the same lesson as the paragraph above one
  // layer down. Every branch below asks a CATALOG question — is a key set, does
  // /models list this id — and a catalog listing is free. Cerebras answers 200
  // there on an unbilled account and `402 Payment Required` on every completion,
  // so this function reported it alive and it held the last cloud rung of every
  // lane while refusing every call. What a real completion said is the only
  // answer to "can this account actually be used", and now it outranks the probe.
  //
  // Narrow on purpose: 401/402 per account, 403/404 per model, until success/TTL
  // clears them. A 429 or a 5xx must NOT reach here — those are transient and
  // already handled by chain.js's cooldown and breaker, and holding a provider
  // down for a quota that resets in a minute would remove a working rung. The
  // boundary is enforced in provider-health.js and tested from both sides.
  // NIM is a catalog family; the chain expands it to separately entitled keys.
  if (provider === 'nim') return c.nimModels.includes(model) && [
    ['nim', process.env.NIM_API_KEY], ['nim2', process.env.NIM_API_KEY_2],
  ].some(([lane, key]) => key && key.trim() && !providerHealth.failureFor(lane) && !providerHealth.modelFailureFor(lane, model));
  if (providerHealth.failureFor(provider)) return false;
  if (providerHealth.modelFailureFor(provider, model)) return false;
  switch (provider) {
    case 'groq':       return c.groqAlive;
    case 'mistral':    return c.mistralAlive;
    case 'ollama':     return c.ollamaModels.includes(model);
    case 'zcode':      return !!process.env.ZCODE_API_KEY;
    // BUG-418. Key presence only, and that is deliberate rather than an
    // oversight: both are PAID APIs, so a /models catalog probe on every
    // registry refresh would be a billable request every five minutes on a
    // buyer's account for no benefit. The account-health record above is what
    // catches a bad key or an unpaid account, from the first real call, which
    // is the same door BUG-419 opened for cerebras.
    case 'openai':     return !!process.env.OPENAI_API_KEY;
    case 'anthropic':  return !!process.env.ANTHROPIC_API_KEY;
    case 'cerebras':   return !!process.env.CEREBRAS_API_KEY && c.cerebrasModels.includes(model);
    case 'google':     return !!process.env.GOOGLE_API_KEY && c.googleModels.includes(model);
    case 'openrouter': return !!process.env.OPENROUTER_API_KEY && c.openrouterAlive;
    default:           return false;
  }
}

// An unknown lane name used to substitute BRAIN_TABLES.text in silence. That is
// the worst shape a fallback can have: a misspelt lane name produced no error, no
// log line and no failure — just quietly worse answers, from the one lane that
// has no caller of its own and therefore nobody watching it. This repo has had
// the same class of bug three times (the skills loader searching one root, an
// act-tool shipped without its read-tool, and this very file counting dead
// OpenRouter slugs alive on key presence), so the fallback is now audible.
//
// Deduped per lane name, on purpose: the substitution is a coding error, so the
// FIRST report is the whole signal and a hot loop re-emitting it would only
// crowd out other health events. The bus's health channel is storm-exempt, so
// nothing else would throttle it.
const unknownLanesReported = new Set();
function reportUnknownLane(lane, bus) {
  const name = String(lane);
  if (unknownLanesReported.has(name)) return;
  unknownLanesReported.add(name);
  const detail = {
    kind: 'brain-lane-unknown',
    lane: name,
    fallback: 'text',
    known: Object.keys(BRAIN_TABLES),
    reason: 'brain.think was called with a lane that is not registered in BRAIN_TABLES; '
      + 'it fell back to the text lane, which no other caller uses',
  };
  try { if (bus && typeof bus.emit === 'function') bus.emit('health.anomaly', detail); } catch (_) { /* reporting must never break the call */ }
  // Also to stderr: chain.js only forwards a bus when its caller passed one, and
  // an unknown lane on a bus-less path is exactly as wrong as on a wired one.
  try { console.warn('[brain] unknown lane "' + name + '" — falling back to the text lane. Known lanes: ' + Object.keys(BRAIN_TABLES).join(', ')); } catch (_) {}
}

// Ranked, alive-only chain for a brain lane. Never throws; empty array = nothing alive.
// Supported kinds: 'voice' | 'build' | 'simple' | 'reasoning' | 'memory' | 'text' | 'vision' | 'embed'
// `opts.bus` is optional — supplied by chain.js so the unknown-lane report above
// reaches the Health view rather than only stderr.
async function chainFor(kind, opts) {
  const c = await refresh();
  let table = BRAIN_TABLES[kind];
  if (!table) {
    reportUnknownLane(kind, opts && opts.bus);
    table = BRAIN_TABLES.text;
  }
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
    openai:     { configured: !!process.env.OPENAI_API_KEY },
    anthropic:  { configured: !!process.env.ANTHROPIC_API_KEY },
    // BUG-419: what a REAL call last said about each account, which is the one
    // thing every field above is structurally unable to report — they all read
    // free catalog endpoints. Empty object means nothing has refused, which is
    // the healthy state and reads as such. This is what puts the 402 in front of
    // the operator: read_status returns probes.getStatus(), which returns this.
    accountFailures: providerHealth.snapshot(),
    modelFailures: providerHealth.modelSnapshot(),
    // Observability only — checked 2026-08-14, `chains` has NO consumer in src/
    // or ui/. It is here so an operator reading provider status can see which
    // models a lane would actually walk. Nothing depends on its shape, so adding
    // a lane here is safe; do not build on that.
    chains: {
      voice:     await chainFor('voice'),
      build:     await chainFor('build'),
      simple:    await chainFor('simple'),
      reasoning: await chainFor('reasoning'),
      memory:    await chainFor('memory'),
      text:      await chainFor('text'),
      vision:    await chainFor('vision'),
      embed:     await chainFor('embed'),
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
