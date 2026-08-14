// chain.js — walks the ranked model list from registry.js, calling the matching provider's
// chat() with a per-lane cooldown so a rate-limited model is skipped for a while.
// CA from NOVA app/lib/models/chain.js.
// Throws only when every lane is exhausted (err.chainExhausted = true); callers must catch
// that and degrade honestly — this module never retries forever on its own.
const registry = require('./registry');
const zcode = require('../../../providers/zcode');
const nim = require('../../../providers/nim');
const nim2 = nim.createNimProvider('nim2', 'NIM_API_KEY_2');
const groq = require('../../../providers/groq');
const mistral = require('../../../providers/mistral');
const cerebras = require('../../../providers/cerebras');
const openrouter = require('../../../providers/openrouter');
const google = require('../../../providers/google');
const ollama = require('../../../providers/ollama');

const { createBreaker } = require('../immune/breakers');

const LANES = { zcode, nim, nim2, groq, mistral, cerebras, openrouter, google, ollama };
const COOLDOWN_MS = Number(process.env.CHAIN_COOLDOWN_MS) || 60000;
const ATTEMPT_TIMEOUT_MS = Number(process.env.CHAIN_ATTEMPT_TIMEOUT_MS) || 30000;
const cooldowns = new Map(); // "lane:model" -> until-timestamp

function laneKey(lane, model) {
  return `${lane}:${model}`;
}

// ---------------------------------------------------------------------------
// B1 (2026-08-14) — why a dead provider at the head of a lane cost 8 seconds a
// call, all day, and why the cooldown above did not catch it.
//
// MEASURED, from the audit's allow->completed pairs and 40 vision.attempt lines:
//   screen_look  n=5   median 10,254ms  max 12,341ms
//   camera_look  n=13  median  9,484ms  max  9,793ms
// against DEFAULT_VISION_TIMEOUT_MS = 12000 — the median call sitting at 85% of
// its own budget, and the max over it. Two screen_look calls failed outright
// (14:11:36, 14:13:52) while MYTHOS was hunting the Notepad Save dialog, so it
// ran that whole sequence blind.
//
// The attempt lines say why:
//   nim      nvidia/nemotron-nano-12b-v2-vl  ms:4015  timedOut:true
//   nim2     nvidia/nemotron-nano-12b-v2-vl  ms:4002  timedOut:true
//   nim      nvidia/nemotron-nano-12b-v2-vl  ms:2431  500 EngineCore encountered an issue
//   mistral  mistral-small-latest            ms:1943  ok:true
// PREF_VISION[0] is NVIDIA NIM, whose free tier is documented non-production, so
// intermittent 500s and hangs are its steady state rather than an incident. Every
// look therefore paid 4s + 4s + ~1.5s ≈ 9.5s (attemptsTried:3, ms:9457 in the
// log), of which 8s bought nothing.
//
// TWO ROOT CAUSES, and the plan for this wave only named the second.
//
// 1. THE EXISTING COOLDOWN NEVER FIRED FOR THE OBSERVED FAILURE. The catch block
//    cools on 429 / 5xx / network — and an attempt that hits its OWN per-attempt
//    timeout matches none of them. `attemptTimedOut` was already computed, for
//    telemetry, and never consulted for the cooldown decision. C7's comment
//    ("caller-initiated abort is not a provider fault") is right, but it lumped
//    both AbortError sources together: a caller giving up is not a provider
//    fault, while a provider that will not answer inside its own step budget
//    plainly is. That is fixed unconditionally below — it is a bug, not a
//    feature to be flag-gated.
//
// 2. A FLAT 60s COOLDOWN IS THE WRONG SHAPE FOR AN ALL-DAY OUTAGE. Even with
//    fix 1, the five screen_look calls were minutes apart, so every one of them
//    would arrive after the cooldown had lapsed and pay the full 9.5s again.
//    Escalation is what actually closes this: breakers.js's OPEN -> resetMs with
//    x2 backoff capped at maxResetMs means a sustained outage is skipped for
//    minutes at a time, while a genuine recovery is picked up automatically by
//    HALF_OPEN's single probe.
//
// Keyed per (provider, model) — deliberately NOT per provider. That is the unit
// that actually failed: a vision model going down must not open the breaker for
// the same provider's text lane, which chain.js also serves.
//
// NOT DONE, and deliberately: reordering PREF_VISION or deleting the nim entries.
// That throws away a genuinely fast model on a bad afternoon, and it is a
// hand-edit the next stale-measurement session repeats. The breaker is
// self-correcting; the edit is not. (The stale `386ms — fastest vision measured`
// comment in lanes.default.js IS corrected — it is what kept a dead provider at
// the head of the chain.)
//
// Blast radius: chain.js serves EVERY lane, not just vision, so the escalation is
// gated on CHAIN_BREAKERS_ENABLED (default true) and the Map is created inside
// that check — the Slice-5 lesson that an opt-in flag protects nothing
// constructed above where the flag is read.
let breakers = null;   // Map<"lane:model", breaker> — null until the flag is read

function breakersEnabledFor(config) {
  if (config && typeof config.CHAIN_BREAKERS_ENABLED === 'boolean') return config.CHAIN_BREAKERS_ENABLED;
  if (process.env.CHAIN_BREAKERS_ENABLED !== undefined) {
    return String(process.env.CHAIN_BREAKERS_ENABLED).toLowerCase() !== 'false';
  }
  return true;
}

// A breaker needs a bus to report a trip. When the caller did not supply one the
// FSM still runs — skipping a dead provider matters more than announcing it — so
// this swallows instead of throwing, which createBreaker would otherwise do.
const NULL_BUS = { emit() {} };

function breakerFor(lane, model, bus, config) {
  if (!breakers) breakers = new Map();
  const key = laneKey(lane, model);
  let breaker = breakers.get(key);
  if (!breaker) {
    breaker = createBreaker({
      name: key,
      bus: bus || NULL_BUS,
      config,
      // Its own kind, not 'effector-flapping': that one is matched by healer.js's
      // effector-flapping-breaker playbook, whose suppress-tool action would be
      // handed "nim:nvidia/nemotron-nano-12b-v2-vl" as a tool name. See
      // createBreaker's anomalyKind comment.
      anomalyKind: 'brain-provider-flapping',
    });
    breakers.set(key, breaker);
  }
  return breaker;
}
function isCooling(lane, model) {
  return (cooldowns.get(laneKey(lane, model)) || 0) > Date.now();
}
function markCooldown(lane, model, ms) {
  cooldowns.set(laneKey(lane, model), Date.now() + (ms || COOLDOWN_MS));
  // C6: Amortized eviction — sweep expired entries to prevent unbounded growth.
  var now = Date.now();
  for (var [key, until] of cooldowns) {
    if (until <= now) cooldowns.delete(key);
  }
}

function nimLanesAvailable() {
  return ['nim', 'nim2'].filter((id) => LANES[id].isAvailable());
}

// Expands a ranked registry entry into concrete (lane, model) attempts. A 'nim' entry fans
// out to every configured NIM key (key rotation); 'groq', 'mistral', and 'ollama' entries
// are single attempts (one lane per provider).
function expand(entries) {
  const out = [];
  for (const e of entries) {
    if (e.provider === 'nim') {
      for (const lane of nimLanesAvailable()) out.push({ lane, model: e.model });
    } else if (e.provider === 'ollama') {
      out.push({ lane: 'ollama', model: e.model });
    } else {
      // groq, mistral, zcode, or any future openai-compat lane
      out.push({ lane: e.provider, model: e.model });
    }
  }
  return out;
}

// Translates OpenAI-style multimodal content ([{type:'text'|'image_url', ...}]) into
// Ollama's native shape: one message with `content` (text) + `images` ([base64,...]).
function toOllamaVisionMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const images = m.content
      .filter((p) => p.type === 'image_url')
      .map((p) => (p.image_url.url || '').replace(/^data:image\/\w+;base64,/, ''));
    return { role: m.role, content: text, images };
  });
}

// complete({ messages, kind, brain, signal, onAttempt, onToken }) -> { content, provider, model }
// kind:  'text' | 'json' | 'vision' (json shares the text chain; JSON discipline lives in
//        the prompt, not in provider selection).
// brain: 'voice' | 'build' | 'simple' | 'text' | 'vision' | 'embed' — selects the
//        preference list. Defaults to 'text' for backward compatibility.
// onToken: optional (delta:string) => void — every provider below already speaks
// SSE/NDJSON streaming and already accepts an onToken passthrough (openai-compat.js,
// openrouter.js, ollama.js); this was simply never threaded above the provider layer
// until P20. Forwarded verbatim to whichever provider actually answers — a provider
// that fails mid-stream still falls through to the next attempt exactly as before,
// onToken just stops firing for that attempt (the caller only trusts the final
// resolved `content`, same as always).
// attemptTimeoutMs: optional PER-CALL override of CHAIN_ATTEMPT_TIMEOUT_MS, and the
// most specific of the three sources (call > config > env). It exists because a
// caller that bounds its OWN total budget below the per-attempt timeout gets no
// failover at all: visionThink() races the whole call against 12s while each
// attempt here had 30s, so a merely-slow first-ranked vision model consumed the
// entire budget inside attempt #1 and models 2-5 were never tried — reported to
// the operator as "the vision model did not answer in time" with a live lane
// (2026-08-14, two screen_look calls). A caller whose budget is shorter than the
// chain's step size must be able to shorten the step, not just give up sooner.
//
// onAttemptEnd({ provider, model, ms, ok, timedOut, error }): per-attempt outcome,
// fired for every attempt including the one that succeeds. onAttempt fires BEFORE
// an attempt and is already spoken for (brain-spend); this is the other edge, and
// its absence is exactly what BUG-209 named as the reason the vision lane could
// not be reordered on evidence — no per-provider latency was recorded anywhere.
async function complete({ messages, kind, brain, signal, onAttempt, onAttemptEnd, onToken, config, bus, attemptTimeoutMs: attemptTimeoutOverride }) {
  // F2: Use config-provided values if available, falling back to env-based defaults.
  const cooldownMs = (config && config.CHAIN_COOLDOWN_MS) || COOLDOWN_MS;
  const attemptTimeoutMs = (Number.isFinite(attemptTimeoutOverride) && attemptTimeoutOverride > 0)
    ? attemptTimeoutOverride
    : ((config && config.CHAIN_ATTEMPT_TIMEOUT_MS) || ATTEMPT_TIMEOUT_MS);
  // brain takes priority if explicitly set; otherwise fall back to kind-based routing.
  const effectiveKind = brain || (kind === 'vision' ? 'vision' : 'text');
  // bus forwarded so registry's unknown-lane report reaches the Health view
  // rather than only stderr — see registry.js's reportUnknownLane().
  const ranked = await registry.chainFor(effectiveKind, { bus });
  const attempts = expand(ranked);
  const errors = [];
  const useBreakers = breakersEnabledFor(config);

  // B1: a SKIPPED attempt must be as visible as a failed one. Both skip paths
  // below used to `continue` in silence, which is how a provider could be dead
  // all day while the only trace was an unexplained latency. Turning a loud 8s
  // failure into an invisible one would be worse than the 8s, so every skip
  // reports through the same channel an attempt outcome does, tagged with why.
  const reportSkip = (lane, model, reason) => {
    if (!onAttemptEnd) return;
    try {
      onAttemptEnd({ provider: lane, model, ms: 0, ok: false, timedOut: false, skipped: reason });
    } catch (_) { /* instrumentation only */ }
  };

  for (const { lane, model } of attempts) {
    // B4: Use AbortError name so downstream catch blocks recognize it as a caller abort.
    if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (isCooling(lane, model)) { reportSkip(lane, model, 'cooldown'); continue; }
    // Skip lanes whose provider isn't configured (e.g. GROQ_API_KEY not set).
    if (LANES[lane] && typeof LANES[lane].isAvailable === 'function' && !LANES[lane].isAvailable()) continue;
    // B1: the escalating skip. allow() is what advances OPEN -> HALF_OPEN when
    // resetMs has passed, so calling it here is also how a recovered provider
    // gets its single probe back.
    const breaker = useBreakers ? breakerFor(lane, model, bus, config) : null;
    if (breaker && !breaker.allow()) {
      reportSkip(lane, model, 'breaker-open');
      continue;
    }
    if (onAttempt) onAttempt({ provider: lane, model });
    const attemptStartedAt = Date.now();
    // Declared out here, not inside the try below: the catch block has to be able
    // to tell "this attempt hit ITS OWN timeout" apart from a provider error, and
    // that is the single most useful field in the telemetry.
    let attemptTimedOut = false;
    // Telemetry must never be able to break the chain walk it is measuring.
    const reportAttemptEnd = (fields) => {
      if (!onAttemptEnd) return;
      try {
        onAttemptEnd({ provider: lane, model, ms: Date.now() - attemptStartedAt, ...fields });
      } catch (_) { /* instrumentation only */ }
    };
    try {
      // Per-attempt timeout prevents a slow/hanging provider from blocking the
      // entire chain walk (critical on cloud depots where cold starts or
      // network latency can stall a single provider for 30+ seconds).
      const attemptCtrl = new AbortController();
      const attemptTimer = setTimeout(() => { attemptTimedOut = true; attemptCtrl.abort(); }, attemptTimeoutMs);
      // If the caller already has an abort signal, forward it.
      const onCallerAbort = () => attemptCtrl.abort();
      signal && signal.addEventListener('abort', onCallerAbort, { once: true });

      try {
        let content;
        if (lane === 'ollama') {
          const msgs = effectiveKind === 'vision' ? toOllamaVisionMessages(messages) : messages;
          content = await ollama.chat(msgs, { model, keepAlive: process.env.VOICE_OLLAMA_KEEP_ALIVE || '10m', signal: attemptCtrl.signal, onToken });
        } else {
          content = await LANES[lane].chat(messages, { model, signal: attemptCtrl.signal, source: 'voice-chain', onToken });
        }
        reportAttemptEnd({ ok: true, timedOut: false });
        // B1: a success in HALF_OPEN is what closes the breaker and resets the
        // backoff to its base delay, so a recovered provider returns to the head
        // of the lane on its own. No hand-edit, no restart.
        if (breaker) breaker.recordSuccess();
        return { content, provider: lane, model };
      } finally {
        // Cleanup MUST run on BOTH success and error paths. Previously this was
        // before the return only — the catch block leaked the timer and the
        // abort listener on every failed provider attempt. Over a long-running
        // process each chain walk accumulated N stale 30s timers + N permanent
        // listeners on the caller's signal (slow memory + listener leak).
        clearTimeout(attemptTimer);
        signal && signal.removeEventListener('abort', onCallerAbort);
      }
    } catch (err) {
      errors.push(`${lane}:${model}: ${err.message}`);
      reportAttemptEnd({ ok: false, timedOut: attemptTimedOut, error: String(err && err.message || err).slice(0, 200) });
      // Error discrimination: only cooldown on rate-limit (429) or network errors.
      // Auth failures (401/403) won't recover in 60s — let isAvailable() handle them.
      // Bad-request (400) means the provider is healthy, the request was wrong — don't
      // penalize the provider. Caller-abort is not a provider fault either.
      var msg = String(err && err.message || '');
      var isAbort = err && err.name === 'AbortError';
      var isRateLimit = /:\s*429\b/.test(msg);
      var isServerError = /:\s*5\d\d\b/.test(msg);
      var isNetwork = /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
      // C7: Caller-initiated abort is not a provider fault — don't penalize with cooldown.
      //
      // B1 (2026-08-14): attemptTimedOut JOINS that list, and its absence is why
      // NIM stayed at the head of the vision lane while answering nothing for a
      // whole day. The 40 vision.attempt lines are all `timedOut:true` at ~4002ms
      // — the attempt's own ceiling — and none of the three patterns above match
      // "This operation was aborted", so no cooldown was ever taken. The flag
      // already existed for telemetry and was never consulted for the decision.
      //
      // isAbort alone would be wrong here, which is presumably why C7 excluded
      // the whole class: a CALLER giving up says nothing about the provider.
      // attemptTimedOut is specifically OUR timer, i.e. the provider failing to
      // answer inside its own step budget, which is a provider fault by
      // definition. Both are AbortError; only one is evidence.
      var isProviderFault = isRateLimit || isServerError || isNetwork || attemptTimedOut;
      if (isProviderFault) {
        markCooldown(lane, model, cooldownMs);
        // And the escalating half — a flat 60s cooldown lapses between calls that
        // are minutes apart, which is exactly the measured pattern.
        if (breaker) breaker.recordFailure();
      }
    }
  }

  // A4: Use generic error message — avoid leaking provider lane/model details to clients.
  // Full details are in the `errors` array for server-side logging only.
  if (errors.length > 0) console.warn('[brain chain] chain-exhausted:', JSON.stringify(errors.map(function(e) { return String(e).slice(0, 120); })));
  const err = new Error('All AI providers are currently unavailable. Please try again later.');
  err.chainExhausted = true;
  throw err;
}

async function isAvailable() {
  return (await registry.chainFor('text')).length > 0;
}

module.exports = {
  complete,
  isAvailable,
  _internal: {
    cooldowns, markCooldown, expand, toOllamaVisionMessages,
    _resetCooldowns: () => cooldowns.clear(), LANES,
    // B1 test seams. breakers is null until the flag has been read, so a getter
    // rather than the value — capturing it at export time would always be null.
    getBreakers: () => breakers,
    breakersEnabledFor,
    _resetBreakers: () => { breakers = null; },
  },
};
