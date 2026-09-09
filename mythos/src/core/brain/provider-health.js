'use strict';

// provider-health.js — what a real call last said about a provider's ACCOUNT.
//
// BUG-419, measured on the operator's machine 2026-09-09:
//
//   registry.getStatus() -> cerebras: { configured: true, aliveModels: 3 }
//   chainFor('build')    -> [ ..., { provider:'cerebras', model:'gpt-oss-120b' } ]
//   chainFor('simple')   -> [ ..., { provider:'cerebras', model:'gemma-4-31b'  } ]
//
// Cerebras answers `402 Payment required` on every completion from this
// unbilled account — nine separate lane comments in lanes.default.js say so,
// dated 2026-08-22 — and the registry reported it ALIVE, so it stayed the last
// cloud rung on every lane and was walked into on every exhausted fallback.
//
// WHY THE PROBE COULD NOT SEE IT (gate E, verbatim: "a check that something
// parses, loads, exists, or is non-empty is a proxy for your real question,
// and proxies admit exactly the values that break you"). `probeCerebras()`
// fetches `/models`. A catalog listing is free and answers 200 on an unbilled
// account; the 402 only comes back from `/chat/completions`. The liveness probe
// asked the cheaper question standing next to the one that mattered — the same
// shape as GATES.md's `createPublicKey()` case, where a structurally valid key
// loaded cleanly, cached over the working set, and threw at every real use.
//
// AND THE CODE SAID SOMEONE ELSE WAS HANDLING IT. chain.js's failure arm reads:
// "Auth failures (401/403) won't recover in 60s — let isAvailable() handle
// them." `isAvailable()` is `chainFor('text').length > 0`, which resolves
// through the same catalog probe, so nothing handled them anywhere. A confident
// comment deferring to a mechanism that does not exist (/kee class 10) is why
// this survived nine dated comments.
//
// THE FIX IS NOT A SECOND PROBE. Adding a trial completion to every refresh
// would spend real tokens every five minutes, on a machine whose whole premise
// is free tiers. The real operation already runs on every call — this module
// just stops throwing its verdict away.
//
// DELIBERATELY NARROW: ACCOUNT-LEVEL STATUSES ONLY.
//   401 unauthorised · 402 payment required · 403 forbidden
// These are facts about the ACCOUNT, not the moment: they do not clear on their
// own, which is exactly why a 60-second cooldown never caught them. A 429 is a
// rate limit and a 5xx is an outage — both transient, both already handled by
// chain.js's cooldown and breaker, and both would be WRONG here, because
// holding a provider down for a quota that resets in a minute would remove a
// working rung. That boundary is the whole design and it is tested from both
// sides.
//
// A SUCCESS CLEARS IT IMMEDIATELY. The operator adding a card to their Cerebras
// account must not have to wait out a TTL, and a stale "dead" verdict is the
// failure mode this module could most easily cause itself. Entries also expire
// on their own (see TTL below), so a bug in the recorder degrades back to
// today's behaviour rather than permanently removing a provider.

// Account-level HTTP statuses. A rule, not a denylist of providers: any
// provider reporting one of these is unusable for the same reason.
const ACCOUNT_STATUSES = [401, 402, 403];

// Long enough that a dead account is not re-probed on every call, short enough
// that a fixed account recovers without a restart even if no other call
// succeeds first. Deliberately independent of the registry's own 5-minute TTL:
// this is a different fact with a different lifetime.
const HEALTH_TTL_MS = Number(process.env.PROVIDER_HEALTH_TTL_MS) || 15 * 60 * 1000;

// provider id -> { status, message, at }
const failures = new Map();

// Pure. Is this error a statement about the account rather than the moment?
// Reads the typed status first (attached at the openai-compat/ollama/openrouter
// throw sites by BUG-336) and falls back to prose in the same shape chain.js's
// classifyProviderError already uses, so an old provider that has not been
// re-pointed at typed errors is still readable.
function accountStatusOf(err) {
  const status = err && err.status;
  if (typeof status === 'number' && ACCOUNT_STATUSES.indexOf(status) !== -1) return status;
  const msg = String((err && err.message) || '');
  for (const candidate of ACCOUNT_STATUSES) {
    // The same `: <code>` anchor classifyProviderError uses for 429 and 5xx.
    // Deliberately NOT a bare /402/ — a model id, a token count or a timing
    // number containing 402 would match, and a provider wrongly held down is
    // worse than one wrongly kept.
    if (new RegExp(':\\s*' + candidate + '\\b').test(msg)) return candidate;
  }
  return null;
}

function isAccountFailure(err) {
  return accountStatusOf(err) !== null;
}

// Record an account-level refusal. Non-account errors are IGNORED rather than
// stored with a null status: a present entry means "unusable", and letting a
// 429 write one would take a working provider out of every lane for 15 minutes.
function recordFailure(provider, err, nowMs) {
  const id = String(provider || '').trim();
  if (!id) return null;
  const status = accountStatusOf(err);
  if (status === null) return null;
  const entry = {
    status,
    message: String((err && err.message) || '').slice(0, 200),
    at: typeof nowMs === 'number' ? nowMs : Date.now(),
  };
  failures.set(id, entry);
  return entry;
}

// A real completion came back. Whatever we thought about the account is now
// out of date, so the entry goes immediately — not on the next TTL.
function recordSuccess(provider) {
  const id = String(provider || '').trim();
  if (id) failures.delete(id);
}

// The live entry, or null. Expiry is applied on READ so nothing has to run a
// timer; a bug that stops recordSuccess from firing still degrades back to
// today's behaviour within one TTL instead of removing a provider forever.
function failureFor(provider, nowMs) {
  const id = String(provider || '').trim();
  const entry = failures.get(id);
  if (!entry) return null;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (now - entry.at >= HEALTH_TTL_MS) {
    failures.delete(id);
    return null;
  }
  return entry;
}

// What read_status shows: provider id -> { status, message, at, reason }.
// `reason` is operator-facing prose, because this is the sentence that has been
// missing — nine source comments recorded the 402 and nothing MYTHOS could say
// out loud did.
function snapshot(nowMs) {
  const out = {};
  for (const id of [...failures.keys()]) {
    const entry = failureFor(id, nowMs);
    if (!entry) continue;
    out[id] = Object.assign({}, entry, { reason: reasonFor(id, entry.status) });
  }
  return out;
}

function reasonFor(provider, status) {
  if (status === 402) {
    return provider + ' answers 402 Payment Required — the account has no billing set up, so every '
      + 'model on it refuses. It is skipped until a call succeeds or ' + Math.round(HEALTH_TTL_MS / 60000)
      + ' minutes pass. Add billing, or remove it from the lane tables.';
  }
  if (status === 401) {
    return provider + ' answers 401 Unauthorised — the API key is missing, wrong or revoked. Check its '
      + 'entry in mythos/.env against .env.example.';
  }
  return provider + ' answers 403 Forbidden — the key is recognised but not permitted to use this model. '
    + 'Check the plan or region on that account.';
}

// Test seam only. Production never needs this: an entry is cleared by a
// success or by its own expiry.
function _reset() {
  failures.clear();
}

module.exports = {
  ACCOUNT_STATUSES,
  HEALTH_TTL_MS,
  accountStatusOf,
  isAccountFailure,
  recordFailure,
  recordSuccess,
  failureFor,
  snapshot,
  _reset,
};
