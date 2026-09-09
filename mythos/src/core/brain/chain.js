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
// BUG-419: the verdict a REAL completion returns about an account, kept instead
// of thrown away. The liveness probe reads a free /models catalog and therefore
// cannot see a 402.
const providerHealth = require('./provider-health');
const { createLogger } = require('../logger');
const log = createLogger(process.env.LOG_LEVEL || 'info');

const LANES = { zcode, nim, nim2, groq, mistral, cerebras, openrouter, google, ollama };

// BUG-336 (2026-08-24): provider-fault identity. Pure so tests need no
// providers or network. Priority: explicit kind > numeric status > libuv
// code > legacy message prose. The prose tier exists only so OLD providers
// keep today's behaviour; every prose hit is counted and logged by the
// caller (once per lane per hour) because B1 (2026-08-14) proved prose-only
// matching lets a dead lane head answer nothing for a whole day when wording
// drifts ("This operation was aborted" matched none of the patterns).
function classifyProviderError(err) {
  if (err && typeof err.kind === 'string' && ['rate-limit', 'server', 'network'].indexOf(err.kind) !== -1) return { basis: 'kind', kind: err.kind };
  var status = err && err.status;
  if (status === 429) return { basis: 'status', kind: 'rate-limit' };
  if (typeof status === 'number' && status >= 500 && status < 600) return { basis: 'status', kind: 'server' };
  var code = err && err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { basis: 'code', kind: 'network' };
  var msg = String((err && err.message) || '');
  if (/:\s*429\b/.test(msg)) return { basis: 'prose', kind: 'rate-limit' };
  if (/:\s*5\d\d\b/.test(msg)) return { basis: 'prose', kind: 'server' };
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return { basis: 'prose', kind: 'network' };
  return { basis: 'none', kind: null };
}

var proseFallbackLogAt = {}; // lane -> last Date.now() we logged a prose fallback
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

  // BUG-273 C3 (2026-08-18) — WHY A TIMEOUT COOLDOWN IS NOW DEFERRED.
  //
  // MEASURED, two screen_look failures minutes apart:
  //   11:35:04  google gemini-3.5-flash-lite  ms:2672  ok:true      <- it worked
  //   11:38:18  google gemini-3.5-flash-lite  ms:4009  timedOut     <- and then
  //   11:38:22  mistral mistral-small-latest  ms:4001  timedOut
  //   11:38:26  mistral mistral-large-2512    ms:4000  timedOut
  //   11:38:30  google  gemini-flash-latest   ms:4001  timedOut
  //   11:38:34  nim     llama-3.2-11b-vision  ms:4004  timedOut
  //   11:38:38  nim2    llama-3.2-11b-vision  ms:4006  timedOut
  //   11:38:42  nim     nemotron-nano-12b-vl  ms:4009  timedOut
  //   11:38:44  EVERY entry skipped: 'cooldown'  -> "Vision providers are offline"
  //
  // Nine models across five unrelated providers aborting within 15ms of the same
  // 4000ms ceiling is not nine simultaneous provider outages. It is one shared
  // cause on this side — and the same signature this repo already records for
  // child-spawn ceilings: identical timings at a hardcoded bound every run.
  //
  // B1's fix (2026-08-14) made attemptTimedOut take a cooldown, on the reasoning
  // that "a provider that will not answer inside its own step budget plainly is at
  // fault". That reasoning holds only while the budget is generous next to known-
  // good latency. It was not: the lane's own recorded latencies include 3090ms and
  // the successful call three minutes earlier took 2672ms, against a 4000ms budget.
  // So a slightly slow minute condemned the entire lane, and the SECOND incident
  // ("Vision providers are offline") is a direct consequence of the first — one
  // causal chain reported as two independent failures.
  //
  // THE RULE: a timeout is provider-specific evidence only when some other
  // provider answered. If every attempt in one run timed out, the common factor is
  // this process, its network or its budget, so the cooldowns are dropped rather
  // than taken. Rate-limit, 5xx and network failures are UNAFFECTED and still cool
  // down immediately — those name a provider by themselves.
  //
  // Q2: the dropped decision is reported, not silent. An invisible non-cooldown is
  // how the opposite bug would hide for a week.
  const deferredTimeoutCooldowns = [];
  let nonTimeoutFailures = 0;
  let anyAttemptSucceeded = false;

  // Settle the deferred timeout cooldowns. There are THREE exits from the walk and
  // it is called on all of them: success (~line 430), caller abort (~line 375) and
  // exhaustion (~line 500). This comment used to say "EVERY exit — success and
  // exhaustion both", and that was already wrong when it was written: the abort exit
  // existed, was not counted, and dropped its cooldowns in silence for as long as
  // the sentence stood (BUG-392, 2026-08-28). The count is spelled out here rather
  // than asserted in prose because prose is what failed. If you add a fourth exit,
  // settle on it — bug-392-abort-drops-earned-cooldowns.test.js counts the exits in
  // this function and fails when a new one appears without a settle.
  //
  // History, which is why the count matters: the FIRST version ran it only on the
  // exhausted path, silently dropping the cooldown for every run that eventually got
  // an answer. That is the common case, so it disabled B1's fix almost entirely —
  // caught by chain-provider-breakers.test.js's very first assertion, not by
  // anything written for C3. Twice is a class, so the guard is now executable.
  //
  // anyAttemptSucceeded is part of the discriminator, and the reason is the whole
  // argument of this fix read backwards: the exemption exists because nine
  // simultaneous timeouts point at one shared local cause. A provider answering in
  // the SAME run disproves that — the network was fine, so the ones that timed out
  // really were slow. Without this a run of {nim hangs, nim2 hangs, mistral answers}
  // would exempt both dead NIM entries, which is exactly the all-day outage B1 was
  // written to stop.
  let deferredSettled = false;
  function settleDeferredTimeouts() {
    if (deferredSettled) return;
    deferredSettled = true;
    if (!deferredTimeoutCooldowns.length) return;
    const sharedCauseLikely = !anyAttemptSucceeded
      && nonTimeoutFailures === 0
      && deferredTimeoutCooldowns.length > 1;
    if (!sharedCauseLikely) {
      deferredTimeoutCooldowns.forEach(function (c) {
        markCooldown(c.lane, c.model, cooldownMs);
        if (c.breaker) c.breaker.recordFailure();
      });
      return;
    }
    const names = deferredTimeoutCooldowns.map(function (c) { return c.lane + ':' + c.model; });
    console.warn('[brain chain] whole-lane-timeout: ' + names.length + ' attempt(s) all timed out at the '
      + 'per-attempt ceiling (' + attemptTimeoutMs + 'ms), nothing answered, and no provider failed for a '
      + 'reason that names it — treating this as a local/network fault and NOT cooling down: '
      + JSON.stringify(names.slice(0, 8)));
    if (bus && typeof bus.emit === 'function') {
      try {
        bus.emit('health.anomaly', {
          kind: 'chain-whole-lane-timeout',
          reason: 'every ' + effectiveKind + ' attempt timed out at the ' + attemptTimeoutMs
            + 'ms per-attempt ceiling and nothing answered, which is one shared cause rather than '
            + names.length + ' provider outages — cooldowns were not taken',
          target: effectiveKind,
          attempts: names.length,
          attemptTimeoutMs: attemptTimeoutMs,
        });
      } catch (_) { /* telemetry must never break the chain */ }
    }
  }

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
    //
    // BUG-392 (2026-08-28): this exit used to throw WITHOUT settling, so every
    // cooldown a provider had already earned on its own merits was discarded, and
    // discarded in silence — no markCooldown, no recordFailure, no
    // whole-lane-timeout warn, no health.anomaly. THIS IS THE SAME OMISSION FOR THE
    // THIRD TIME: the first version of settleDeferredTimeouts ran only on the
    // exhausted path, the second added success, and the comment written then
    // ("Called on EVERY exit from the walk") was already false because this exit
    // existed and was not counted. See settleDeferredTimeouts above.
    //
    // WHAT THIS DOES **NOT** DO, and must not. It settles only what was ALREADY
    // deferred; it does not cool down the attempt the abort interrupted.
    // chain-provider-breakers.test.js:130-142 rules that a caller changing its mind
    // says nothing about the provider it interrupted, and that ruling stands. The
    // discriminator is attemptTimedOut, set by OUR timer at line ~365 and never by
    // the caller's signal: a provider killed by the caller never sets it, so it
    // never enters deferredTimeoutCooldowns and settling cannot reach it. When both
    // timers fire in the same tick the outcome follows whichever setTimeout ran
    // first, which is the honest answer for a genuinely simultaneous case.
    //
    // DOES THIS HIDE EVIDENCE? It could have. settleDeferredTimeouts guards its own
    // bus.emit, but breaker.recordFailure() reaches an UNGUARDED bus.emit at
    // immune/breakers.js:136, so a throwing health.anomaly subscriber would replace
    // the AbortError with its own error and the caller would lose the reason its
    // turn ended. The settle is therefore wrapped and fails open LOUDLY: the abort
    // still propagates unchanged, and the swallowed cause is named. Residual, NOT
    // fixed here because it needs a throwing subscriber and is a different ticket:
    // such a throw mid-loop leaves the remaining deferred cooldowns unapplied while
    // deferredSettled is already true, so they are dropped for good.
    //
    // REACHABILITY, measured 2026-08-28 — LATENT, not live, and the filed ticket's
    // "the window is wide" was wrong. Exactly one call site in the tree passes a
    // caller signal to brain.think (voice/voice-agent.js:413) and it does not
    // override attemptTimeoutMs, so the per-attempt ceiling and the voice turn's own
    // ceiling are both 30000ms and the caller's timer is armed FIRST (server/
    // index.js:3300, before the memory-recall work). The caller therefore aborts
    // before any attempt can reach its own ceiling, attemptTimedOut stays false, and
    // nothing is ever deferred to drop. It becomes live when an operator lowers
    // CHAIN_ATTEMPT_TIMEOUT_MS below the caller's budget, which schema.js:553
    // supports down to 1000.
    if (signal && signal.aborted) {
      try {
        settleDeferredTimeouts();
      } catch (settleErr) {
        console.warn('[brain chain] settle-on-abort failed, cooldowns for this run were not recorded: '
          + String(settleErr && settleErr.message || settleErr).slice(0, 200));
      }
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    }
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
    // BUG-392 (2026-08-28), the parity gap one line from the abort exit. This file
    // states the invariant about itself twice — "Telemetry must never be able to
    // break the chain walk it is measuring" — and wraps reportSkip and
    // reportAttemptEnd accordingly. onAttempt was the only instrumentation callback
    // left bare, and in production it is bus.emit('brain-spend', ...) from
    // brain/index.js, so one throwing subscriber killed the whole turn with an error
    // naming neither the chain nor the subscriber. Same swallow, same comment, so
    // the three callbacks can be reasoned about as one rule instead of two-and-a-half.
    if (onAttempt) {
      try { onAttempt({ provider: lane, model }); } catch (_) { /* instrumentation only */ }
    }
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
        // BUG-419: an answer is proof the ACCOUNT is fine, so any recorded
        // account-level refusal is out of date now — cleared immediately rather
        // than left to expire, so an operator who has just added billing does
        // not wait out a TTL.
        providerHealth.recordSuccess(lane);
        // BUG-273 C3: an answer here means any earlier timeout in this run was the
        // provider's own slowness, not a shared local fault — so the deferred
        // cooldowns are taken. Settled before the return, or a successful call
        // would drop them and B1's fix would apply to nothing.
        anyAttemptSucceeded = true;
        settleDeferredTimeouts();
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
      //
      // BUG-419 (2026-09-09) — THE LINE BELOW USED TO SAY "Auth failures
      // (401/403) won't recover in 60s — let isAvailable() handle them", AND
      // NOTHING HANDLED THEM. `isAvailable()` is `chainFor('text').length > 0`,
      // which resolves through registry.isProviderAlive, which for cerebras is
      // "a key is set AND the /models catalog listed this id". A catalog listing
      // is free and answers 200 on an unbilled account; the 402 only comes from
      // /chat/completions. So the refusal was never seen by anything, 402 was
      // not classified at all (classifyProviderError knows 429, 5xx and network
      // only), no cooldown and no breaker tick were taken, and cerebras stayed
      // the last cloud rung of every lane while refusing every call — with nine
      // dated source comments recording the fact and nothing MYTHOS could say.
      // A confident comment deferring to a mechanism that does not exist is how
      // it survived. providerHealth is that mechanism, now built.
      providerHealth.recordFailure(lane, err);
      // Bad-request (400) means the provider is healthy, the request was wrong — don't
      // penalize the provider. Caller-abort is not a provider fault either.
      // BUG-336: typed identity first (err.kind/err.status/err.code attached
      // at openai-compat.js, ollama.js, openrouter.js throw sites); prose is
      // the visible last resort. C7/B1 history preserved below because it is
      // why attemptTimedOut exists as its own arm.
      var isAbort = err && err.name === 'AbortError';
      var cls = classifyProviderError(err);
      var namesAProvider = cls.kind === 'rate-limit' || cls.kind === 'server' || cls.kind === 'network';
      if (cls.basis === 'prose') {
        var nowMs = Date.now();
        if (!proseFallbackLogAt[lane] || nowMs - proseFallbackLogAt[lane] > 3600000) {
          proseFallbackLogAt[lane] = nowMs;
          log.warn('chain.provider-error-classified-by-prose', { lane: lane, model: model, message: String(err && err.message || '').slice(0, 200) });
        }
      }
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
      if (namesAProvider) {
        // Unchanged: a 429, a 5xx or a dead socket is evidence about THIS provider
        // on its own, whatever the rest of the lane did.
        nonTimeoutFailures += 1;
        markCooldown(lane, model, cooldownMs);
        // And the escalating half — a flat 60s cooldown lapses between calls that
        // are minutes apart, which is exactly the measured pattern.
        if (breaker) breaker.recordFailure();
      } else if (attemptTimedOut) {
        // BUG-273 C3: held until the run ends. See deferredTimeoutCooldowns above.
        deferredTimeoutCooldowns.push({ lane: lane, model: model, breaker: breaker });
      }
    }
  }

  // BUG-273 C3: nothing answered, so this is the run the exemption is about — but
  // the decision still belongs to settleDeferredTimeouts, which also has to run on
  // the success path above.
  settleDeferredTimeouts();

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
    classifyProviderError: classifyProviderError,
    _resetCooldowns: () => cooldowns.clear(), LANES,
    // B1 test seams. breakers is null until the flag has been read, so a getter
    // rather than the value — capturing it at export time would always be null.
    getBreakers: () => breakers,
    breakersEnabledFor,
    _resetBreakers: () => { breakers = null; },
  },
};
