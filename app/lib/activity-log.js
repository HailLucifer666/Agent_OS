// activity-log.js — records every provider HTTP call so the dashboard can show
// what abtop fundamentally cannot: cloud API usage by ZCode/NIM/Groq/etc.
//
// In-memory ring buffer (last MAX_RECENT calls) + vault-persisted daily aggregates.
// Honest-inert: recording never throws into a caller; a broken log doesn't break a chat.
//
// Token counts are approximate: OpenAI-compatible streaming responses don't include
// usage in every SSE chunk. We estimate output tokens from the streamed text length
// (~4 chars/token) and input tokens from the prompt length. Marked as `estimatetokens`
// in the record so consumers can be honest about precision.

const vault = require('./vault');
const AGG_FILE = 'activity-aggregates.json';
const MAX_RECENT = 200;
const RATE_WINDOW_MS = 60 * 1000; // calls/min and tokens/min rolling window

const recent = []; // newest last
let aggregates = loadAggregates();

function loadAggregates() {
  const data = vault.readJSON(AGG_FILE, { totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, byProvider: {}, byDay: {} });
  return data;
}

function persistAggregates() {
  try {
    vault.writeJSON(AGG_FILE, aggregates);
  } catch {
    // best-effort: in-memory state stays authoritative
  }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Rough token estimate from a string (~4 chars/token, floored at 1 for non-empty).
function estimateTokens(str) {
  if (!str) return 0;
  return Math.max(1, Math.ceil(String(str).length / 4));
}

// Record one call. All fields optional except provider + ok. Never throws.
function recordCall(entry) {
  try {
    if (!entry || typeof entry !== 'object') return null;
    const {
      provider,
      model,
      source,        // 'chat' | 'orchestrator' | 'mastermind' | ...
      ok,            // boolean
      latencyMs,
      inputTokens,   // number or null (we estimate if null)
      outputTokens,  // number or null
      inputText,     // for estimation if inputTokens is null
      outputText,    // for estimation if outputTokens is null
      error,         // string if !ok
    } = entry || {};

    const inTok = typeof inputTokens === 'number' ? inputTokens : estimateTokens(inputText);
    const outTok = typeof outputTokens === 'number' ? outputTokens : estimateTokens(outputText);
    const ts = Date.now();

    const record = {
      ts,
      provider: provider || 'unknown',
      model: model || null,
      source: source || null,
      ok: Boolean(ok),
      latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
      inputTokens: inTok,
      outputTokens: outTok,
      error: ok ? null : (error || 'unknown error'),
    };

    recent.push(record);
    while (recent.length > MAX_RECENT) recent.shift();

    // Aggregate counters
    aggregates.totalCalls += 1;
    aggregates.totalTokensIn += inTok;
    aggregates.totalTokensOut += outTok;
    const prov = record.provider;
    if (!aggregates.byProvider[prov]) {
      aggregates.byProvider[prov] = { calls: 0, tokensIn: 0, tokensOut: 0, failures: 0 };
    }
    aggregates.byProvider[prov].calls += 1;
    aggregates.byProvider[prov].tokensIn += inTok;
    aggregates.byProvider[prov].tokensOut += outTok;
    if (!ok) aggregates.byProvider[prov].failures += 1;

    const day = todayKey();
    if (!aggregates.byDay[day]) aggregates.byDay[day] = { calls: 0, tokensIn: 0, tokensOut: 0 };
    aggregates.byDay[day].calls += 1;
    aggregates.byDay[day].tokensIn += inTok;
    aggregates.byDay[day].tokensOut += outTok;

    persistAggregates();
    return record;
  } catch {
    // never let logging break the caller
    return null;
  }
}

function getRecent(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), MAX_RECENT);
  return recent.slice(-n).reverse(); // newest first
}

function getStats() {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const inWindow = recent.filter((r) => r.ts >= windowStart);

  const callsInWindow = inWindow.length;
  const tokensInWindow = inWindow.reduce((s, r) => s + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
  const successes = recent.filter((r) => r.ok).length;
  const successRate = recent.length ? Math.round((successes / recent.length) * 100) : 100;

  // Per-provider live breakdown from the recent buffer
  const byProvider = {};
  for (const r of recent) {
    if (!byProvider[r.provider]) byProvider[r.provider] = { calls: 0, tokens: 0, failures: 0, lastLatencyMs: null };
    byProvider[r.provider].calls += 1;
    byProvider[r.provider].tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    if (!r.ok) byProvider[r.provider].failures += 1;
    if (r.latencyMs !== null) byProvider[r.provider].lastLatencyMs = r.latencyMs;
  }

  return {
    windowMs: RATE_WINDOW_MS,
    callsPerMin: callsInWindow,
    tokensPerMin: tokensInWindow,
    successRate,
    recentCount: recent.length,
    aggregates: {
      totalCalls: aggregates.totalCalls,
      totalTokensIn: aggregates.totalTokensIn,
      totalTokensOut: aggregates.totalTokensOut,
    },
    byProvider,
    today: aggregates.byDay[todayKey()] || { calls: 0, tokensIn: 0, tokensOut: 0 },
  };
}

// Reset (test helper).
function _reset() {
  recent.length = 0;
  aggregates = { totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, byProvider: {}, byDay: {} };
}

module.exports = { recordCall, getRecent, getStats, _reset, estimateTokens };
