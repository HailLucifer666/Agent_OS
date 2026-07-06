// quota.js — free-tier quota tracking for the provider fleet.
// Reads today's usage from activity-log.js aggregates and computes used/cap/remaining
// per provider. HONEST: no free API exposes a "remaining quota" endpoint, so every
// number here is an ESTIMATE computed as (known cap - our recorded usage). If you use
// a provider's API outside this dashboard, our count won't reflect that — the estimate
// drifts. We can't fix that without provider cooperation. isEstimate is always true.

const activityLog = require('./activity-log');
const { FREE_PROVIDERS } = require('./free-models');

// Known free-tier caps per provider, from the Sprint 4 research (mid-2026).
// `null` means "we don't know the cap" — render as "unknown cap" honestly.
// `unlimited: true` means local/no cap.
// Daily caps reset at midnight provider-local (we approximate as 00:00 UTC for display).
const PROVIDER_QUOTAS = {
  groq: {
    requestsPerDay: 14400,
    tokensPerDay: null,
    resetsTz: 'UTC',
    note: '~30 RPM · ~14,400 req/day on Llama 3.3 70B. Per-model limits vary.',
  },
  'openrouter-free': {
    requestsPerDay: 50,
    tokensPerDay: null,
    resetsTz: 'UTC',
    note: '~50 req/day default. $10 one-time top-up lifts to ~1,000/day.',
  },
  cerebras: {
    requestsPerDay: null,
    tokensPerDay: 1000000,
    resetsTz: 'UTC',
    note: '~1M tokens/day. 8,192-token context cap on free tier.',
  },
  mistral: {
    requestsPerDay: 86400, // ~1 req/sec
    tokensPerDay: null,
    resetsTz: 'UTC',
    note: '~1 req/sec (Experiment mode). Per-model token caps in dashboard.',
  },
  cloudflare: {
    requestsPerDay: null,
    tokensPerDay: null,
    neuronsPerDay: 10000,
    resetsTz: 'UTC',
    note: '10,000 Neurons/day. ~20-30 SDXL images or hundreds of small chats.',
  },
  zcode: {
    requestsPerDay: null,
    tokensPerDay: null,
    resetsTz: null,
    note: 'Z.AI GLM coding plan. Quota not publicly documented.',
  },
  nim: {
    requestsPerDay: null,
    tokensPerDay: null,
    resetsTz: null,
    trial: true,
    note: 'TRIAL · ~1,000 signup credits, finite. 40 RPM. Credit balance not exposed via API.',
  },
  ollama: {
    unlimited: true,
    note: 'Local. Bounded by your hardware, no provider cap.',
  },
  'edge-tts': {
    unlimited: true,
    note: 'UNOFFICIAL · Microsoft Neural via edge-tts. No key, no account. Personal/hobby use only — commercial use violates MS ToS.',
  },
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Compute the next reset timestamp (00:00 UTC tomorrow) for display.
function nextResetUTC() {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString();
}

// Pick the relevant cap dimension for a provider. Some are request-capped, some
// token-capped, some Neuron-capped. Return {unit, cap} or null if unknown.
function capFor(providerId) {
  const q = PROVIDER_QUOTAS[providerId];
  if (!q) return null;
  if (q.unlimited) return { unit: 'unlimited', cap: null };
  if (q.requestsPerDay) return { unit: 'requests', cap: q.requestsPerDay };
  if (q.tokensPerDay) return { unit: 'tokens', cap: q.tokensPerDay };
  if (q.neuronsPerDay) return { unit: 'neurons', cap: q.neuronsPerDay };
  return null;
}

// Map provider id -> activity-log provider name. The fleet logs under the
// provider `name` from openai-compat (e.g. 'groq', 'openrouter-free'). Ollama
// logs under 'hermes' historically — we map that here.
function logProviderName(providerId) {
  if (providerId === 'ollama') return 'hermes';
  return providerId;
}

// Returns one provider's quota status. Reads today's usage from activity-log aggregates.
function getQuotaStatus(providerId) {
  const q = PROVIDER_QUOTAS[providerId];
  const meta = FREE_PROVIDERS.find((p) => p.id === providerId);
  if (!q) return null;

  if (q.unlimited) {
    return {
      provider: providerId,
      label: meta ? meta.label : providerId,
      unlimited: true,
      used: null,
      cap: null,
      unit: 'unlimited',
      remaining: null,
      remainingPercent: null,
      resetsAt: null,
      isEstimate: false,
      trial: false,
      note: q.note,
    };
  }

  const cap = capFor(providerId);
  const stats = activityLog.getStats();
  const todayAgg = stats.today || { calls: 0, tokensIn: 0, tokensOut: 0 };
  const providerAgg = stats.byProvider[logProviderName(providerId)] || { calls: 0, tokens: 0 };

  // Determine "used" in the relevant unit.
  let used = 0;
  if (cap && cap.unit === 'requests') used = todayAgg.calls;
  else if (cap && cap.unit === 'tokens') used = todayAgg.tokensIn + todayAgg.tokensOut;
  else if (cap && cap.unit === 'neurons') {
    // Neurons aren't 1:1 with tokens; approximate as tokens for display.
    // Real Neuron accounting requires Cloudflare's usage API (not exposed free).
    used = todayAgg.tokensIn + todayAgg.tokensOut;
  }

  const remaining = cap && cap.cap ? Math.max(0, cap.cap - used) : null;
  const remainingPercent = cap && cap.cap ? Math.round((remaining / cap.cap) * 100) : null;

  return {
    provider: providerId,
    label: meta ? meta.label : providerId,
    unlimited: false,
    used,
    cap: cap ? cap.cap : null,
    unit: cap ? cap.unit : 'unknown',
    remaining,
    remainingPercent,
    resetsAt: q.resetsTz ? nextResetUTC() : null,
    isEstimate: true, // always — no free API exposes real remaining quota
    trial: Boolean(q.trial),
    note: q.note,
  };
}

function getAllQuotas() {
  // All providers we know about: the free fleet + ollama.
  const ids = [...FREE_PROVIDERS.map((p) => p.id), 'ollama'];
  return ids.map(getQuotaStatus).filter(Boolean);
}

module.exports = { PROVIDER_QUOTAS, getQuotaStatus, getAllQuotas };
