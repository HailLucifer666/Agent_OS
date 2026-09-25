'use strict';

// route-policy.js — the single answer to "may MYTHOS send this request to this
// model right now, given what the operator is willing to pay for?"
//
// WHY THIS EXISTS (2026-09-24, Wave 0c of the 28-bug plan). The operator
// develops on free tiers only and said so explicitly. Nothing in the code knew
// that. registry.js makes a route eligible when its KEY IS PRESENT, and
// lanes.default.js deliberately puts BYO_PREMIUM (Anthropic, OpenAI) at the head
// of six lanes for future paying customers. Today no premium key exists on this
// machine, so nothing is being charged — this is closing a fragility, not a live
// bug. It bites the day a premium key appears in mythos/.env for any reason: the
// very next voice turn would go to a paid model, first in line, and nothing
// would say so. A key's presence silently deciding what gets billed is the
// defect class (13: two sources of one answer, and the implicit one wins).
//
// WHAT IT DOES. MODEL_BILLING_POLICY selects a mode:
//   unset / 'any'   today's behaviour, unchanged. BYO buyers keep their premium
//                   routes; this module allows everything and costs one call.
//   'free-only'     only routes classified below as free are allowed. Anything
//                   paid, or anything this file cannot classify, is REFUSED with
//                   a reason that names the route. Unknown is refused, not
//                   guessed: a route nobody has checked is not free by default.
//   anything else   refused as if free-only, and the reason names the bad value.
//                   A typo in a spending guard must fail closed, not open.
//
// A ROUTE IS provider + model + endpoint + mode. The provider name alone cannot
// tell free from paid: Google serves free and paid-only models on one key and
// one host, OpenRouter's free variants differ from their paid siblings only by
// a `:free` suffix, and an Ollama model tagged `:cloud` runs on Ollama's servers
// even though the request goes to localhost. The endpoint matters because a base
// URL override (MISTRAL_API_URL and friends) can point a free provider's name at
// a paid proxy.
//
// WHAT IT CANNOT DO — and nothing in code can. Account-level billing is not
// visible from here. A Google project with billing enabled, or a Mistral account
// on pay-as-you-go, charges for calls to the very models this file calls free.
// The operator checks that in each provider's console; this module never reads
// or changes a billing setting. "free" below means "this provider offers the
// route on a free plan", which is necessary for zero charges and not sufficient.
//
// SOURCES, read 2026-09-24 (not guessed): ai.google.dev/gemini-api/docs/pricing
// lists a free tier ("Free of charge") for each Google model in GOOGLE_FREE_TIER
// and "Not available" for gemini-3.1-flash-image; gemini-embedding-001 and the
// `-latest` aliases are not on that page at all, so they are unknown. Ollama's
// pricing page says the free cloud plan covers "a smaller set of starter models"
// and bills beyond it, so a `:cloud` model is unknown unless shown otherwise.
// Groq, Mistral, NVIDIA and Cerebras offer free plans at the account level
// (mythos/docs/UPSTREAM-BUG-FIX-RESEARCH-2026-09-24.md cites each); Cerebras's
// own 402 refusals are already handled by provider-health.js and cost nothing.
// Re-read the pricing page before adding a Google model here — a model missing
// from this table is refused in free-only mode, which is the safe direction.

const POLICY_ENV = 'MODEL_BILLING_POLICY';
const POLICY_ANY = 'any';
const POLICY_FREE_ONLY = 'free-only';

// The official host for each provider that offers a free plan. A request whose
// effective endpoint is anywhere else is not the route this file classified.
const OFFICIAL_HOSTS = Object.freeze({
  groq: 'api.groq.com',
  mistral: 'api.mistral.ai',
  nim: 'integrate.api.nvidia.com',
  nim2: 'integrate.api.nvidia.com',
  cerebras: 'api.cerebras.ai',
  google: 'generativelanguage.googleapis.com',
  openrouter: 'openrouter.ai',
});

// Free at the account level on the official host: every model the account can
// reach is on the provider's free plan (or refused, which costs nothing).
const ACCOUNT_FREE_PLAN = Object.freeze(['groq', 'mistral', 'nim', 'nim2', 'cerebras']);

// Providers with no free plan at all. Named so the refusal can say "paid" rather
// than "unknown", which is the more useful thing to hear.
const PAID_ONLY = Object.freeze(['openai', 'anthropic', 'deepseek']);

// Google is priced per MODEL on one key and one host. Exact ids only — an alias
// such as gemini-flash-latest can move to a model with no free tier without any
// change here, so aliases are unknown until pinned.
const GOOGLE_FREE_TIER = Object.freeze([
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.1-flash-live-preview',
  'gemini-3.1-flash-tts-preview',
]);
// Listed so a refusal names the reason instead of calling it unknown.
const GOOGLE_PAID_ONLY = Object.freeze(['gemini-3.1-flash-image']);

const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]', '::1']);

function currentPolicy(env) {
  const raw = String(((env || process.env)[POLICY_ENV]) || '').trim().toLowerCase();
  if (!raw || raw === POLICY_ANY) return { mode: POLICY_ANY, raw };
  if (raw === POLICY_FREE_ONLY) return { mode: POLICY_FREE_ONLY, raw };
  return { mode: POLICY_FREE_ONLY, raw, invalid: true };
}

function hostOf(endpoint) {
  if (!endpoint) return null;
  try { return new URL(String(endpoint)).hostname.toLowerCase(); } catch (_) { return null; }
}

function stripModelsPrefix(model) {
  return String(model || '').replace(/^models\//, '');
}

function label(route) {
  return route.provider + ':' + route.model + (route.mode ? ' (' + route.mode + ')' : '');
}

// Classify one route, independent of the policy mode. Returns
// { classification: 'free' | 'local' | 'paid' | 'unknown', why }.
function classifyRoute(route) {
  const provider = String(route.provider || '').toLowerCase();
  const model = stripModelsPrefix(route.model);
  const host = hostOf(route.endpoint);

  if (PAID_ONLY.includes(provider)) return { classification: 'paid', why: provider + ' has no free plan' };

  if (provider === 'ollama') {
    if (!host || !LOOPBACK_HOSTS.includes(host)) {
      return { classification: 'unknown', why: 'ollama endpoint ' + (host || 'unset') + ' is not this machine' };
    }
    if (/[:-]cloud$/i.test(model)) {
      return { classification: 'unknown', why: model + ' runs on Ollama\'s cloud, whose free plan covers only its starter models' };
    }
    return { classification: 'local', why: 'runs on this machine' };
  }

  const official = OFFICIAL_HOSTS[provider];
  if (!official) return { classification: 'unknown', why: 'no billing classification exists for provider "' + provider + '"' };
  if (host !== official) {
    return { classification: 'unknown', why: provider + ' endpoint ' + (host || 'unset') + ' is not the official ' + official };
  }

  if (ACCOUNT_FREE_PLAN.includes(provider)) return { classification: 'free', why: provider + ' offers a free plan' };

  if (provider === 'openrouter') {
    return /:free$/.test(model)
      ? { classification: 'free', why: 'an explicit :free variant' }
      : { classification: 'paid', why: model + ' is not a :free variant' };
  }

  if (provider === 'google') {
    if (GOOGLE_FREE_TIER.includes(model)) return { classification: 'free', why: model + ' has a free tier' };
    if (GOOGLE_PAID_ONLY.includes(model)) return { classification: 'paid', why: model + ' has no free tier' };
    return { classification: 'unknown', why: model + ' is not on the free-tier list this policy was checked against' };
  }

  return { classification: 'unknown', why: 'unclassified' };
}

// The decision every caller asks for, immediately before it sends a request.
// route: { provider, model, endpoint, mode } — endpoint is the EFFECTIVE base
// URL the request will go to, after every env override.
function decide(route, env) {
  const policy = currentPolicy(env);
  if (policy.mode === POLICY_ANY) return { allowed: true, policy: POLICY_ANY };
  const { classification, why } = classifyRoute(route);
  if (classification === 'free' || classification === 'local') {
    return { allowed: true, policy: policy.mode, classification };
  }
  const badValue = policy.invalid
    ? ' (' + POLICY_ENV + '="' + policy.raw + '" is not a recognised value, so it is treated as free-only)'
    : '';
  return {
    allowed: false,
    policy: policy.mode,
    classification,
    reason: label(route) + ' is refused by ' + POLICY_ENV + '=free-only: ' + why + badValue,
  };
}

// For the direct request paths (speech, embeddings, image) whose failure shape is
// already "throw an Error": refuse the same way, with a typed code so a chain
// above can tell a policy refusal from a provider fault without reading prose.
function assertAllowed(route, env) {
  const d = decide(route, env);
  if (d.allowed) return d;
  const err = new Error(d.reason);
  err.code = 'billing-policy';
  err.classification = d.classification;
  throw err;
}

// For a caller whose own refusal channel can drop the reason — the Gemini Live
// session is the case. live-session.js's setState ignores a transition to the
// state it is already in, and a session that never opened is already 'closed',
// so a reason handed only to setState would vanish in silence. (Its 'no-key'
// refusal has that same silent drop; it predates Wave 0c and is left alone.)
// Returns null when allowed, otherwise the reason — already announced on the
// bus's health channel, which is storm-exempt.
function refusalFor(route, bus, env) {
  const d = decide(route, env);
  if (d.allowed) return null;
  if (bus && typeof bus.emit === 'function') {
    try { bus.emit('health.anomaly', { kind: 'route-refused-by-billing-policy', reason: d.reason, classification: d.classification }); } catch (_) { /* reporting must never break the caller */ }
  }
  return d.reason;
}

// Env vars that exist only to reach a paid-only provider. The MCP client must not
// hand these to a server in free-only mode, because nothing here can see what the
// server does with them. Derived from PAID_ONLY, not typed twice.
function paidOnlyKeyEnvs() {
  return PAID_ONLY.map(function (p) { return p.toUpperCase() + '_API_KEY'; });
}

module.exports = {
  POLICY_ENV,
  POLICY_ANY,
  POLICY_FREE_ONLY,
  OFFICIAL_HOSTS,
  GOOGLE_FREE_TIER,
  GOOGLE_PAID_ONLY,
  currentPolicy,
  classifyRoute,
  decide,
  assertAllowed,
  refusalFor,
  paidOnlyKeyEnvs,
};
