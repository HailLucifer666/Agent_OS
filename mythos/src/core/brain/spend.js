// spend.js — token spend tracking for the brain.
// CA from NOVA app/lib/activity-log.js.
// In-memory ring buffer + daily aggregates. Honest-inert: recording never throws.
// Token counts approximate: ~4 chars/token.

const MAX_RECENT = 200;
const RATE_WINDOW_MS = 60 * 1000;

const recent = [];
let aggregates = { totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, byProvider: {}, byDay: {} };

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function estimate(str) {
  if (!str) return 0;
  return Math.max(1, Math.ceil(String(str).length / 4));
}

function recordCall(entry) {
  try {
    if (!entry || typeof entry !== 'object') return null;
    const { provider, model, source, ok, latencyMs, inputTokens, outputTokens, inputText, outputText, error } = entry || {};
    const inTok = typeof inputTokens === 'number' ? inputTokens : estimate(inputText);
    const outTok = typeof outputTokens === 'number' ? outputTokens : estimate(outputText);
    const ts = Date.now();
    const record = {
      ts, provider: provider || 'unknown', model: model || null, source: source || null,
      ok: Boolean(ok), latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
      inputTokens: inTok, outputTokens: outTok, error: ok ? null : (error || 'unknown error'),
    };
    recent.push(record);
    while (recent.length > MAX_RECENT) recent.shift();
    aggregates.totalCalls += 1;
    aggregates.totalTokensIn += inTok;
    aggregates.totalTokensOut += outTok;
    const prov = record.provider;
    if (!aggregates.byProvider[prov]) aggregates.byProvider[prov] = { calls: 0, tokensIn: 0, tokensOut: 0, failures: 0 };
    aggregates.byProvider[prov].calls += 1;
    aggregates.byProvider[prov].tokensIn += inTok;
    aggregates.byProvider[prov].tokensOut += outTok;
    if (!ok) aggregates.byProvider[prov].failures += 1;
    const day = todayKey();
    if (!aggregates.byDay[day]) aggregates.byDay[day] = { calls: 0, tokensIn: 0, tokensOut: 0 };
    aggregates.byDay[day].calls += 1;
    aggregates.byDay[day].tokensIn += inTok;
    aggregates.byDay[day].tokensOut += outTok;
    return record;
  } catch { return null; }
}

function getRecent(limit) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_RECENT);
  return recent.slice(-n).reverse();
}

function getStats() {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const inWindow = recent.filter(r => r.ts >= windowStart);
  const callsInWindow = inWindow.length;
  const tokensInWindow = inWindow.reduce((s, r) => s + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
  const successes = recent.filter(r => r.ok).length;
  const successRate = recent.length ? Math.round((successes / recent.length) * 100) : 100;
  const byProvider = {};
  for (const r of recent) {
    if (!byProvider[r.provider]) byProvider[r.provider] = { calls: 0, tokens: 0, failures: 0, lastLatencyMs: null };
    byProvider[r.provider].calls += 1;
    byProvider[r.provider].tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    if (!r.ok) byProvider[r.provider].failures += 1;
    if (r.latencyMs !== null) byProvider[r.provider].lastLatencyMs = r.latencyMs;
  }
  return {
    windowMs: RATE_WINDOW_MS, callsPerMin: callsInWindow, tokensPerMin: tokensInWindow,
    successRate, recentCount: recent.length,
    aggregates: { totalCalls: aggregates.totalCalls, totalTokensIn: aggregates.totalTokensIn, totalTokensOut: aggregates.totalTokensOut },
    byProvider, today: aggregates.byDay[todayKey()] || { calls: 0, tokensIn: 0, tokensOut: 0 },
  };
}

function _reset() {
  recent.length = 0;
  aggregates = { totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, byProvider: {}, byDay: {} };
}

module.exports = { recordCall, getRecent, getStats, estimate, _reset };
