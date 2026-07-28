// quota.js — free-tier quota tracking.
// CV from NOVA app/lib/quota.js.
// Decoupled from free-models.js and activity-log.js.
// Accepts spend.getStats() as parameter instead of reaching into activity-log.

const PROVIDER_QUOTAS = {
  groq: { requestsPerDay: 1000, tokensPerDay: 100000, resetsTz: 'UTC', note: '1,000 req/day, 100,000 tokens/day on Llama 3.3 70B Versatile.' },
  mistral: { requestsPerDay: 86400, tokensPerDay: null, resetsTz: 'UTC', note: '~1 req/sec (Experiment mode).' },
  zcode: { requestsPerDay: null, tokensPerDay: null, resetsTz: null, note: 'Z.AI GLM coding plan. Quota not publicly documented.' },
  nim: { requestsPerDay: null, tokensPerDay: null, resetsTz: null, trial: true, note: 'TRIAL — ~1,000 signup credits, finite. 40 RPM.' },
  ollama: { unlimited: true, note: 'Local. Bounded by your hardware, no provider cap.' },
};

const PROVIDER_IDS = Object.keys(PROVIDER_QUOTAS);

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function nextResetUTC() {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString();
}

// A provider can carry BOTH a requests/day and a tokens/day cap (e.g. groq's
// llama-3.3-70b-versatile: 1,000 RPD but only 100,000 TPD — at ~2,700
// tokens/call the token cap binds around call #37, long before the request
// cap ever would). Report whichever cap is tighter for actual usage, not
// just whichever field happens to be checked first — otherwise quota-low
// tracks a cap that never fires before the provider raw-429s.
function capsFor(providerId) {
  const q = PROVIDER_QUOTAS[providerId];
  if (!q || q.unlimited) return [];
  const out = [];
  if (q.requestsPerDay) out.push({ unit: 'requests', cap: q.requestsPerDay });
  if (q.tokensPerDay) out.push({ unit: 'tokens', cap: q.tokensPerDay });
  return out;
}

function capFor(providerId) {
  const q = PROVIDER_QUOTAS[providerId];
  if (!q) return null;
  if (q.unlimited) return { unit: 'unlimited', cap: null };
  const caps = capsFor(providerId);
  return caps.length ? caps[0] : null;
}

function getQuotaStatus(providerId, stats) {
  stats = stats || {};
  stats.byProvider = stats.byProvider || {};
  const q = PROVIDER_QUOTAS[providerId];
  if (!q) return null;

  if (q.unlimited) {
    return { provider: providerId, unlimited: true, used: null, cap: null, unit: 'unlimited', remaining: null, remainingPercent: null, resetsAt: null, isEstimate: false, trial: false, note: q.note };
  }

  const providerAgg = stats.byProvider[providerId] || { calls: 0, tokens: 0 };
  const caps = capsFor(providerId);

  // Compute usage against every cap this provider has, then surface the
  // tightest (lowest remainingPercent) — that's the one that will actually
  // 429 first, and the one quota-low needs to see. Ties keep the
  // first-declared cap (requests, by capsFor's push order).
  let tightest = null;
  for (let i = 0; i < caps.length; i += 1) {
    const c = caps[i];
    const used = c.unit === 'requests' ? providerAgg.calls : providerAgg.tokens;
    const remaining = Math.max(0, c.cap - used);
    const remainingPercent = Math.round((remaining / c.cap) * 100);
    if (!tightest || remainingPercent < tightest.remainingPercent) {
      tightest = { unit: c.unit, cap: c.cap, used, remaining, remainingPercent };
    }
  }

  return {
    provider: providerId, unlimited: false,
    used: tightest ? tightest.used : 0, cap: tightest ? tightest.cap : null,
    unit: tightest ? tightest.unit : 'unknown',
    remaining: tightest ? tightest.remaining : null,
    remainingPercent: tightest ? tightest.remainingPercent : null,
    resetsAt: q.resetsTz ? nextResetUTC() : null,
    isEstimate: true, trial: Boolean(q.trial), note: q.note,
  };
}

function getAllQuotas(stats) {
  return PROVIDER_IDS.map(function(id) { return getQuotaStatus(id, stats); });
}

module.exports = { PROVIDER_QUOTAS, PROVIDER_IDS, getQuotaStatus, getAllQuotas };
