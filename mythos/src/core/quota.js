// quota.js — free-tier quota tracking.
// CV from NOVA app/lib/quota.js.
// Decoupled from free-models.js and activity-log.js.
// Accepts spend.getStats() as parameter instead of reaching into activity-log.

const PROVIDER_QUOTAS = {
  groq: { requestsPerDay: 14400, tokensPerDay: null, resetsTz: 'UTC', note: '~30 RPM, ~14,400 req/day on Llama 3.3 70B.' },
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

function capFor(providerId) {
  const q = PROVIDER_QUOTAS[providerId];
  if (!q) return null;
  if (q.unlimited) return { unit: 'unlimited', cap: null };
  if (q.requestsPerDay) return { unit: 'requests', cap: q.requestsPerDay };
  if (q.tokensPerDay) return { unit: 'tokens', cap: q.tokensPerDay };
  return null;
}

function getQuotaStatus(providerId, stats) {
  stats = stats || {};
  stats.byProvider = stats.byProvider || {};
  stats.today = stats.today || { calls: 0, tokensIn: 0, tokensOut: 0 };
  const q = PROVIDER_QUOTAS[providerId];
  if (!q) return null;

  if (q.unlimited) {
    return { provider: providerId, unlimited: true, used: null, cap: null, unit: 'unlimited', remaining: null, remainingPercent: null, resetsAt: null, isEstimate: false, trial: false, note: q.note };
  }

  const cap = capFor(providerId);
  const todayAgg = stats.today || { calls: 0, tokensIn: 0, tokensOut: 0 };
  const providerAgg = stats.byProvider[providerId] || { calls: 0, tokens: 0 };

  let used = 0;
  if (cap && cap.unit === 'requests') used = todayAgg.calls;
  else if (cap && cap.unit === 'tokens') used = todayAgg.tokensIn + todayAgg.tokensOut;

  const remaining = cap && cap.cap ? Math.max(0, cap.cap - used) : null;
  const remainingPercent = cap && cap.cap ? Math.round((remaining / cap.cap) * 100) : null;

  return {
    provider: providerId, unlimited: false, used, cap: cap ? cap.cap : null,
    unit: cap ? cap.unit : 'unknown', remaining, remainingPercent,
    resetsAt: q.resetsTz ? nextResetUTC() : null,
    isEstimate: true, trial: Boolean(q.trial), note: q.note,
  };
}

function getAllQuotas(stats) {
  return PROVIDER_IDS.map(function(id) { return getQuotaStatus(id, stats); });
}

module.exports = { PROVIDER_QUOTAS, PROVIDER_IDS, getQuotaStatus, getAllQuotas };
