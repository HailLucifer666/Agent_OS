// lanes.default.js — brain lane preference tables, ranked best-first.
// Re-verified 2026-07-29 with a real completion call per entry (never catalog
// listing alone — listings lie: several models list fine and then 404, 429 or
// hang). Latencies in the comments below are measured, not estimated.
//
// RE-MEASURED 2026-08-14 against all five live keys — four probes per model
// (two reasoning, one strict-JSON contract, one refuse-to-invent), plus live
// rate-limit headers. Full data and method: docs/free-tier-model-map.md. That
// run is what motivated the reordering below, and its own stated weakness is
// worth carrying here: ONE SAMPLE PER PROBE, ~50-token prompts. Real prompts
// are 10k+ tokens, where latency and quota both change. Treat the scores as a
// screen, not a ranking, and re-probe before demoting anything on them alone.
//
// Three things the revision before 2026-08-14 got wrong, all fixed here:
//   1. Every lane ended in an OpenRouter `:free` slug that no longer exists
//      (`qwen/qwen3-coder:free`, `nousresearch/hermes-3-llama-3.1-405b:free`,
//      `meta-llama/llama-3.3-70b-instruct:free` all 404 with "unavailable for
//      free — use this slug instead"). registry.js counted them alive on key
//      presence alone, so each one burned a real chain attempt. Its replacement,
//      inclusionai/ling-3.0-flash:free, went the same way within three weeks —
//      404 "unavailable for free. The paid version..." on 2026-08-14 — so it is
//      now deleted from PREF_TEXT and PREF_BUILD rather than re-described. NO
//      free 262K-context option remains on any wired provider; do not re-add one
//      without a real completion call behind it.
//   2. `nim:` entries were silently vanishing because NIM_API_KEY was unset,
//      which left the vision lane one model deep with NO fallback at all.
//   3. The old header claimed nim:z-ai/glm-5.2 "hangs indefinitely". It does not
//      hang — it completes, at 177-185s. That distinction matters: it is
//      queue-starvation on NVIDIA's free tier, not a broken endpoint.
//
// LOAD SPREADING IS A FIRST-CLASS REASON TO RANK A MODEL, not just quality.
// Measured budgets (live response headers, 2026-08-14): Cerebras 5 req/min
// (2400/day, 1M tokens/day), Mistral 4 req/min, Groq 12,000 TOKENS per ~1min
// window PER MODEL, Google ~6-10 RPM per project PER MODEL. Two consequences
// the tables below are built around:
//   - Groq's 12k-token window cannot carry the voice lane at all: that lane's
//     prompt is ~40k chars (~10k tokens), so one turn nearly exhausts the
//     window. Groq is now last-resort everywhere except PREF_SIMPLE, whose
//     small prompts are the only thing that window genuinely suits.
//   - Google's quota is per MODEL, so putting vision, memory and voice on three
//     DIFFERENT Google models buys three independent buckets rather than
//     splitting one. That is why the same provider appears at the head of three
//     lanes below and it is not an oversight.
//
// DELIBERATELY EXCLUDED (all verified working — excluded for a reason):
//   - Over CHAIN_ATTEMPT_TIMEOUT_MS (30s default), so they would abort on every
//     attempt: nim:z-ai/glm-5.2 (177-185s, timed out twice),
//     nim:minimaxai/minimax-m3 (68-93s), nim:mistralai/mistral-nemotron (95s),
//     mistral:devstral-medium-latest (41s), nim:meta/llama-3.3-70b-instruct
//     (timed out at 120s). Batch/offline use only.
//   - Leak raw chain-of-thought into `content` instead of a separate field, so
//     the voice lane would speak its own reasoning aloud: google:gemma-4-31b-it,
//     google:gemma-4-26b-a4b-it, groq:qwen/qwen3.6-27b.
//   - Return array-shaped `content` (renders as "[object Object]" through string
//     extraction): mistral:magistral-medium-latest, mistral:magistral-small-latest.
//   - No quota on a free Google key (429 every call): Pro-tier Gemini
//     gemini-pro-latest and gemini-3.1-pro-preview. Flash only. Re-measured
//     2026-08-14 with real generateContent calls: both still 429 ("You exceeded
//     your current quota"), in ~190-200ms — i.e. rejected at the quota gate, not
//     attempted, so the 429 is a billing state and not a capability claim.
//     gemini-2.5-pro has since changed failure mode and is now 404, "no longer
//     available to new users" — it would not come back with billing, so do not
//     list it as a billing-blocked candidate. Controls that DID answer on the
//     same key, same run: gemini-3.6-flash 1261ms, gemini-flash-latest 1274ms.
//   - Absent from this account (404/503): cerebras:llama-3.3-70b,
//     nim:deepseek-ai/deepseek-v4-flash, mistral:pixtral-large-latest.
//
// No local model is required in any lane — each ends in optional ollama entries
// that are simply filtered out of the alive-ranked list if Ollama isn't running
// (registry.js's probeOllama() already degrades to [] on connection failure).
// Each entry: { provider, model }. Provider 'nim' entries are expanded by
// chain.js into one attempt per configured NIM key (key rotation).

// ---------------------------------------------------------------------------
// BUG-418 (2026-09-09) — the two BYO entries that head six of the eight lanes.
// ---------------------------------------------------------------------------
//
// Free tiers are the DEVELOPMENT constraint, not the product. The operator
// builds on free keys because paid calls are not affordable while building;
// the shipped product is bring-your-own-key with any provider. Until now
// mythos/providers/ held google, mistral, groq, nim, cerebras, ollama, zcode
// and openrouter -- so a buyer with an Anthropic or OpenAI key had to open an
// OpenRouter account and pay its margin to use a key they already owned.
//
// WHY AT THE HEAD, which is a product decision and not a measurement.
// Everything else in these tables is ranked on measured free-tier latency and
// quality (see the header above). These two are ranked on INTENT: a buyer who
// has gone to the trouble of supplying a paid key wants it used, and a paid
// key sitting below four free rungs would almost never be reached.
//
// THEY COST THIS MACHINE NOTHING, which is why the change is safe to make
// blind. registry.isProviderAlive returns false for either without its key, so
// on the development stack both are filtered out before a chain walk begins --
// measured after the change: chainFor(build) and chainFor(simple) are
// byte-identical to before.
//
// NO LATENCY OR QUALITY CLAIM IS MADE ABOUT EITHER. There is no Anthropic or
// OpenAI key on this machine, so neither has been probed the way every other
// entry here was. Deliberately left uncommented rather than given a plausible
// number -- a stale measurement at the head of a lane is the exact failure this
// file records three times.
//
// A BUYER WHO WANTS THEM ELSEWHERE NEEDS NO CODE CHANGE: CHAIN_VOICE,
// CHAIN_BUILD, CHAIN_REASONING, CHAIN_TEXT, CHAIN_SIMPLE and CHAIN_MEMORY each
// replace their table wholesale (see parseOverride in registry.js).
//
// NOT ADDED TO PREF_VISION or PREF_EMBED. Both models are vision-capable, but
// the vision lane passes provider-specific image payloads and the embed lane is
// a different API entirely; adding an untested entry to either would be a claim
// this session cannot support.
const BYO_PREMIUM = [
  { provider: 'anthropic', model: 'claude-sonnet-4-5' },   // ANTHROPIC_API_KEY; ANTHROPIC_MODEL overrides
  { provider: 'openai',    model: 'gpt-4.1' },             // OPENAI_API_KEY; OPENAI_MODEL overrides
];
const PREF_VOICE = [
  ...BYO_PREMIUM,   // BUG-418 — inert without a key; see BYO_PREMIUM above
  // gemini-flash-lite was already documented here as "slower than the 8B but far
  // better at this lane's actual job: persona-heavy JSON tool-calling against a
  // ~40k-char prompt". The 2026-08-14 run turned that argument into a
  // measurement and promoted it to the head: 4/4 at 961-1030ms and the ONLY
  // model in the whole run with zero disqualifier flags — no chain-of-thought
  // leaking into `content` (which this lane would SPEAK ALOUD) and no
  // array-shaped content. Latency order is not capability order; only
  // demote/promote entries with a real completion call behind the claim.
  // NOT PROMOTED HERE, and the near-miss is worth recording. groq/qwen3.8-27b
  // measured 280ms median (3 serial samples, 3/3 correct, no chain-of-thought
  // leak, emits real tool_calls) — the fastest qualifying model on any
  // configured key, by a factor of three, and it passed every disqualifier this
  // lane documents. It was staged at this head on 2026-09-11 and then REVERTED,
  // because none of those measurements is the binding constraint:
  //   Groq's free tier allows ~12,000 TOKENS PER MINUTE, and this lane's prompt
  //   is ~40k chars (~10k tokens). One utterance nearly exhausts the window, so
  //   the SECOND utterance inside a minute gets 429'd.
  // That is a RATE limit, not a context limit — qwen3.8-27b advertises a 131,042
  // token context, so a context check would have said it was fine. The header
  // budget above already said this ("Groq is now last-resort everywhere except
  // PREF_SIMPLE"), and brain.test.js pins it. A model that is three times faster
  // and unavailable every second turn is slower than one that always answers.
  { provider: 'google',   model: 'gemini-flash-lite-latest' },    // 906ms (2026-09-11); 961-1030ms, 4/4, no flags (2026-08-14)
  // DEMOTED 2026-09-11 from rank 2. Not dead and not removed: every call on this
  // key now returns `429 Rate limit exceeded`, and the same 429 hits
  // mistral-medium-3.5, -2604 and magistral-medium while ministral-8b/14b and
  // codestral answer in under 600ms on the SAME key. So this is a per-model TIER
  // boundary, not an account outage, and it returns if the plan changes.
  { provider: 'mistral',  model: 'mistral-medium-latest' },       // 429 tier-limited 2026-09-11; 783ms, 4/4 (2026-08-14)
  // REMOVED 2026-09-11: nim/meta/llama-3.1-8b-instruct. Not a rename — NVIDIA's
  // /models advertises 80 ids and no Llama 3.1 8B among them, so the id is
  // absent rather than moved and no guessing recovers it. Its 271ms measurement
  // is preserved in KNOWN_DEAD with the reason.
  // DEMOTED 2026-08-22 from rank 3 to last cloud, NOT deleted. `402 Payment
  // required` — the Cerebras account is unbilled, so this is a billing state and
  // not a dead model: it returns the moment the account is funded, and its
  // 336ms/3-of-4 measurement below still stands. Kept last so a lane call stops
  // paying an attempt for it while the account is dry.
  // REMOVED 2026-08-22: groq/llama-3.3-70b-versatile. It is not a renamed id —
  // Groq's /models advertises 13 ids and NONE of them is any Llama 3.3, so a
  // call returns `404 does not exist or you do not have access`. Its 2026-08-14
  // demotion note is preserved here because the reasoning is still instructive:
  // it was moved off rank 1 for scoring 2/4 (missing both reasoning probes) and
  // for Groq's 12,000-token window, which this lane's ~40k-char (~10k token)
  // prompt nearly exhausts in a single turn — fast and wrong, in the lane the
  // operator actually hears. See KNOWN_DEAD.
  { provider: 'ollama',   model: 'qwen3:8b' },
];

// reasoning lane (NEW 2026-08-14) — the deliberate slow-and-good lane. Every
// role that has to actually THINK routes here instead of PREF_SIMPLE, which is
// where they all sat: cortex's mull(), identity reflection, the reviewer and
// reality-checker seats, design verification, orchestrator synthesis, ask_agent
// seats, engagement interviews, and the new think_deeply effector.
//
// Why they were on PREF_SIMPLE at all: that lane leads with groq
// llama-3.1-8b-instant, picked for "224ms — fastest measured anywhere". Nothing
// waits on background reflection, so that latency bought nothing and cost the
// reasoning — mull()'s entire job is noticing loose ends worth raising, and it
// was doing it on the weakest model in the fleet.
//
// Cerebras leads on both score and budget: 4/4 at 778ms, reasoning emitted in a
// separate field rather than leaking into `content`, and the most generous
// measured quota of any provider (2400 req/day, 1M tokens/day) — tight only
// per-minute at 5/min. Seven low-frequency roles now share that 5/min; the
// fallbacks below are what absorbs a burst. Watch brain-spend for Cerebras 429s
// if a burst ever becomes routine.
const PREF_REASONING = [
  ...BYO_PREMIUM,   // BUG-418 — inert without a key; see BYO_PREMIUM above
  // REORDERED 2026-08-22, and this is the lane the change matters most for: ten
  // roles ride it (mull, think_deeply, self-reflection x2, reviewer,
  // reality-checker, design verify, orchestrator synthesize, ask_agent,
  // engagement interview) and its top TWO entries were both failing, so every one
  // of them burned two attempts before reaching a model that answers.
  //   * cerebras/gpt-oss-120b -> demoted to last cloud. `402 Payment required`,
  //     an unbilled account rather than a dead model; it returns when funded.
  //   * cerebras/zai-glm-4.7 -> REMOVED. `404 Model zai-glm-4.7 is archived and
  //     unavailable for the organization` — gone upstream, billing cannot revive
  //     it. See KNOWN_DEAD.
  // The new head was already rank 3 and is measured healthy, so this promotes
  // what the lane was reaching anyway rather than introducing anything new.
  // NEW HEAD 2026-09-11. This is the single highest-value change in this file:
  // ten roles ride this lane, and the head below had degraded from its recorded
  // 4123ms to a 21958ms MEDIAN (3 serial samples [17719, 21958, 40003], and it
  // failed 1 of 3 outright). Against a 30s per-attempt cap that is a coin flip,
  // which is exactly what the operator watched when think_deeply gave up and the
  // healer logged chain-whole-lane-timeout "repeated 30s timeout per-attempt".
  // The head is nemotron-3-super-120b and NOT groq/openai/gpt-oss-120b, even
  // though groq measured 687ms median against nemotron's 3866ms and groq
  // answered 7 of 7 models called that day. Groq's free tier is ~12,000 TOKENS
  // PER MINUTE, and this lane carries ten roles including think_deeply and the
  // reviewer, whose prompts are large. Putting it first would buy ~5x latency in
  // exchange for 429s under exactly the burst this lane produces. It stays a
  // rung, one place down, where a single call can use the window without
  // starving the next. See the budget header.
  { provider: 'nim',      model: 'nvidia/nemotron-3-super-120b-a12b' },       // 3866ms median, 3/3 (2026-09-11)
  { provider: 'groq',     model: 'openai/gpt-oss-120b' },                     // 687ms median, 3/3; 12k TPM window (2026-09-11)
  { provider: 'nim',      model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },   // 21958ms median, 2/3 (2026-09-11); was 4123ms, 4/4 (2026-08-22)
  // COT-LEAK flagged by the benchmark heuristic, which is why it sits here and
  // NOT in PREF_VOICE: nothing on this lane is spoken aloud, so a stray
  // reasoning preamble costs tokens rather than trust.
  { provider: 'mistral',  model: 'mistral-medium-2604' },                     // 461ms, 4/4 — fastest 4/4 measured; COT-LEAK flag
  // The demoted Cerebras head, kept as the last cloud rung rather than deleted:
  // 778ms/4-of-4 when it answers, and it answers again the moment the account is
  // billed. Last means a dry account costs one attempt at the END of the walk
  // instead of two at the start.
  { provider: 'cerebras', model: 'gpt-oss-120b' },                            // 778ms, 4/4; 402 unbilled 2026-08-22
  { provider: 'ollama',   model: 'qwen3:14b' },
  { provider: 'ollama',   model: 'qwen3:8b' },
];

// memory lane (NEW 2026-08-14) — memory consolidation and document answering.
// Split off PREF_SIMPLE for LOAD, not only quality: consolidation is one of the
// two frequent brain consumers (vision is the other), and both were queued
// behind the same Groq 12k-token window. This lane leads on a DIFFERENT Google
// model from PREF_VISION and PREF_VOICE precisely because Google's quota is
// per-model — three heads, three independent buckets.
//
// Terse styling deliberately follows this lane (see schema.js's
// BRAIN_TERSE_LANES default): consolidated memory should stay compact.
const PREF_MEMORY = [
  ...BYO_PREMIUM,   // BUG-418 — inert without a key; see BYO_PREMIUM above
  { provider: 'google',   model: 'gemini-3-flash-preview' },      // 2129ms (2026-09-11); 3090ms, 4/4 — its own per-model quota bucket
  // ADDED 2026-09-11. This lane had 5 rungs and ONE that answered: two BYO
  // entries with no key, a tier-limited Mistral, and an ollama rung that died
  // when ollama was uninstalled. A second live cloud rung is the whole point.
  { provider: 'google',   model: 'gemini-3.1-flash-lite' },       // 2914ms median, 3/3 (2026-09-11)
  { provider: 'mistral',  model: 'mistral-medium-2604' },         // 429 tier-limited 2026-09-11; 461ms, 4/4 (2026-08-14)
  // Unchanged position — it was already last cloud. Noting only that it is
  // currently `402` (unbilled Cerebras account), so this lane is effectively
  // two-deep in the cloud until the account is funded.
  { provider: 'ollama',   model: 'qwen3:8b' },
];

const PREF_BUILD = [
  ...BYO_PREMIUM,   // BUG-418 — inert without a key; see BYO_PREMIUM above
  // Cloud-first (P22): this lane once led with ollama/hermes3:8b, which was never
  // `ollama pull`ed — silently filtered out, so every build fell through anyway.
  // Optional local models sit last so their absence never costs a build attempt.
  //
  // NOTE: since 2026-07-29 there has been exactly one build-CONTENT engine (see
  // CLAUDE.md / build-engine.js), so this lane no longer carries real build
  // traffic — it serves whatever still requests brain lane 'build'.
  //
  // W6 (2026-08-22) made that engine DeepSeek Harness (`dsh`) instead of
  // Hermes-Agent, and the entries BELOW are why the swap needed no key change:
  // dsh runs whatever this table ranks first that the machine can reach, so the
  // harness changed and the models did not. "DeepSeek Harness" is a program
  // name, not an instruction to run DeepSeek's models — there is no
  // DEEPSEEK_API_KEY anywhere in MYTHOS. Reorder this list and you have
  // reconfigured the build engine; that is deliberate.
  { provider: 'mistral',    model: 'codestral-latest' },                     // 344ms — code-specialist AND faster than -large
  // mistral-medium-2604 inserted ABOVE -large on 2026-08-14: 4/4 vs 3/4 (-large
  // missed a reasoning probe) and 461ms vs 701ms. Same key, same lane, strictly
  // better on both axes measured — the previous ranking predates this model.
  // NEW rank 2, 2026-09-11. This lane had NINE rungs and exactly ONE that
  // answered: everything below was BYO-without-a-key, tier-limited, unbilled,
  // or removed when ollama was uninstalled.
  //
  // NOT groq, though groq was the fastest option and answered 7/7 models called
  // that day. Two reasons, and the second is the binding one: brain.test.js
  // asserts no groq entry in this lane (inverted deliberately in 2026-08-22 so a
  // future session could not re-add the 404ing Llama from a stale note), and the
  // budget header puts Groq at last-resort outside PREF_SIMPLE because of its
  // ~12,000 tokens/minute window. Build prompts carry source files; they are
  // exactly the shape that window does not suit.
  { provider: 'nim',        model: 'nvidia/nemotron-3-super-120b-a12b' },    // 3866ms median, 3/3 (2026-09-11)
  { provider: 'mistral',    model: 'mistral-medium-2604' },                  // 429 tier-limited 2026-09-11; 461ms, 4/4 (2026-08-14)
  // REMOVED 2026-09-11: mistral/mistral-large-2512 — and this one had a cost.
  // It is ABSENT from Mistral's catalog on this key and answers
  // `403 This model is not available in your subscription tier` on every call,
  // permanently. It sat in BOTH this lane and PREF_VISION, where it burned
  // ~1.2s of screen_look's 12s budget per attempt before the operator was told
  // the screen could not be read. Filed as BUG-440; see KNOWN_DEAD.
  // openrouter:inclusionai/ling-3.0-flash:free DELETED 2026-08-14 — 404
  // "unavailable for free". See this file's header note 1.
  // REMOVED 2026-09-11: nim/meta/llama-3.1-8b-instruct — absent from NVIDIA's
  // catalog. Missed on the first pass of this change and caught by brain.test.js's
  // KNOWN_DEAD guard, which is the argument for that guard being data-driven
  // rather than a list someone keeps in their head. See KNOWN_DEAD.
  // 2026-08-22, ranks 4-6 resolved. Two deletions and one demotion, and the
  // three Mistral heads above are untouched because all three are measured
  // healthy — this lane's ordering is not being second-guessed, only its dead
  // rungs removed:
  //   * groq/llama-3.3-70b-versatile REMOVED — Groq advertises no Llama 3.3 at
  //     all, so `404`, and its 12k window never suited a build prompt anyway.
  //   * cerebras/zai-glm-4.7 REMOVED — archived upstream.
  //   * cerebras/gpt-oss-120b demoted below the NIM rung: `402`, unbilled
  //     account, returns when funded.
  { provider: 'cerebras',   model: 'gpt-oss-120b' },                         // 778ms, 4/4; 402 unbilled 2026-08-22
  { provider: 'ollama',     model: 'hermes3:8b' },                           // local, free, unlimited (ollama pull to activate; filtered if absent)
  { provider: 'ollama',     model: 'ornith:9b' },
];

const PREF_SIMPLE = [
  ...BYO_PREMIUM,   // BUG-418 — inert without a key; see BYO_PREMIUM above
  // Cheapest/fastest lane. Previously led with mistral-large-2512 — the most
  // expensive model available, in the lane that least needs it.
  // 2026-08-22: groq/llama-3.1-8b-instant REMOVED from the HEAD of this lane.
  // `404 does not exist or you do not have access` — and Groq's /models lists no
  // Llama of any version, so it is gone rather than renamed. Its "224ms, fastest
  // measured anywhere" note is why it led, and that is exactly why losing it
  // silently mattered: this lane exists for speed on tiny prompts, and every
  // call was paying a failed attempt first. Groq is NOT replaced here with
  // openai/gpt-oss-20b — that would be a new model in a lane the operator asked
  // to leave as wired; ministral-3b-latest below was already rank 2 and answers.
  // REORDERED 2026-09-11: the 8B is now FASTER than the 3B on this key, which is
  // not what a parameter count predicts and is why it was measured rather than
  // assumed — 417ms median [393, 417, 437] against the 3B's 1212ms. Both are
  // 3/3 correct, neither leaks chain-of-thought, both emit tool calls.
  { provider: 'mistral',  model: 'ministral-8b-latest' },         // 417ms median, 3/3 (2026-09-11)
  { provider: 'mistral',  model: 'ministral-3b-latest' },         // 1212ms (2026-09-11); 315ms (2026-08-14)
  // REMOVED 2026-09-11: nim/meta/llama-3.1-8b-instruct — absent from the NVIDIA
  // catalog, see KNOWN_DEAD.
  { provider: 'google',   model: 'gemini-flash-lite-latest' },    // 906ms (2026-09-11); 643ms (2026-08-14)
  // ADDED 2026-08-22 on the operator's instruction, restoring a Groq rung to
  // this lane after llama-3.1-8b-instant was deleted as a 404. Placed HERE and
  // not at the head, because the measurement disagreed with the assumption:
  // 776ms median over 4 samples in the shape MYTHOS actually sends, which is
  // slower than every entry above it. gpt-oss-20b is a reasoning model, and the
  // hidden reasoning is the latency — the deleted Llama was 224ms. It still
  // earns a place: Groq's window is what this lane's tiny prompts genuinely
  // suit, and it ranks above the unbilled Cerebras rung because it answers.
  //
  // NON-OBVIOUS, AND LOAD-BEARING: this model returns EMPTY `content` when the
  // output budget is small. Measured, 4 samples each — max_tokens 120: 2/4 empty
  // with finish_reason `length`, the whole budget consumed by the separate
  // `reasoning` field; max_tokens 512: 0/4; NO max_tokens: 0/4. MYTHOS is in the
  // last case, because providers/openai-compat.js only injects max_tokens when
  // `alwaysMaxTokens` is set and providers/groq.js does not set it. So this is
  // safe as wired — and it breaks silently, into empty replies rather than
  // errors, if that ever changes. test/brain.test.js pins it.
  // Not a chain-of-thought risk: reasoning arrives in its own `reasoning` field,
  // `content` is a clean string, 0/7 leaks across both probes.
  { provider: 'groq',     model: 'openai/gpt-oss-20b' },          // 546ms median, 3/3 (2026-09-11); 776ms, no max_tokens sent (2026-08-22)
  // Demoted below Google, not deleted: 402 unbilled, returns when funded.
  { provider: 'ollama',   model: 'qwen3:8b' },
];

// text lane — long documents. NOTE (2026-08-14): this lane has NO caller in
// src/. It survives as registry.js's fallback table for an unrecognised lane
// name, which is exactly why the two dead entries below had to go: a typo used
// to route silently into a chain whose first two entries were a 404 and a
// 27.9-second model. registry.js now emits health.anomaly on that path as well,
// so the substitution is audible rather than merely slower.
const PREF_TEXT = [
  ...BYO_PREMIUM,   // BUG-418 — inert without a key; see BYO_PREMIUM above
  // DELETED 2026-08-14: openrouter:inclusionai/ling-3.0-flash:free (404,
  // "unavailable for free") and nim:nvidia/nemotron-3-super-120b-a12b (27.9s —
  // unusable interactively, and past CHAIN_ATTEMPT_TIMEOUT_MS on any tightened
  // per-attempt budget). Both burned a real chain attempt every walk.
  //
  // 2026-08-22, and the comment above turned out to be describing the present
  // rather than the past: the top two entries were dead AGAIN, this time
  // cerebras/zai-glm-4.7 (`404`, archived upstream — REMOVED) and
  // cerebras/gpt-oss-120b (`402`, unbilled — demoted below). This lane is
  // registry.js's fallback for an UNRECOGNISED lane name, so a typo'd `lane:`
  // string was walking two failures before answering. That is the exact
  // condition the 2026-08-14 deletions were made to end.
  // NEW HEAD 2026-09-11. gemini-3.6-flash is DEMOTED, not removed, and the
  // reason is a caution about sampling as much as about the model: a single
  // concurrent sample put it at 3054ms, and three SERIAL samples put its median
  // at 24985ms [14248, 24985, 29207]. Had this file been rewritten on the first
  // number it would have kept a ~25s model at the head of a lane and called it
  // measured. It still answers 3/3 correctly, so it is a fallback, not a head.
  { provider: 'nim',        model: 'nvidia/nemotron-3-super-120b-a12b' },    // 3866ms median, 3/3 (2026-09-11)
  { provider: 'groq',       model: 'openai/gpt-oss-120b' },                  // 687ms median, 3/3; 12k TPM window keeps it off the head (2026-09-11)
  { provider: 'google',     model: 'gemini-3.6-flash' },                     // 24985ms median, 3/3 (2026-09-11); 4975ms, 4/4 (2026-08-14)
  // REMOVED 2026-09-11: nim/meta/llama-3.1-8b-instruct — absent from NVIDIA's
  // catalog entirely, see KNOWN_DEAD.
  { provider: 'cerebras',   model: 'gpt-oss-120b' },                         // 402 unbilled, re-confirmed 2026-09-11; 778ms, 4/4 when funded
  { provider: 'ollama',     model: 'kimi-k2.5:cloud' },
  { provider: 'ollama',     model: 'qwen3:14b' },
  { provider: 'ollama',     model: 'qwen3:8b' },
];

const PREF_VISION = [
  // Was ONE entry deep in practice (mistral-large-2512 alone, no fallback),
  // because both nim: entries were filtered out by the missing NIM_API_KEY.
  // Every model below correctly identified a generated test image.
  // WARNING ON THE NUMBERS BELOW: every one of them is a point-in-time
  // measurement, and this first line is what a stale one costs. `386ms — fastest
  // vision measured` was true when written and was, by 2026-08-14, the reason a
  // dead provider sat at the head of the lane: 40 vision.attempt lines that day
  // show this exact entry either timing out at its 4s per-attempt ceiling or
  // returning `500 EngineCore encountered an issue`, never once answering, while
  // mistral-small (rank 2) answered in 1.8-2.0s every time. Each look therefore
  // paid ~8s for nothing. NVIDIA's free NIM tier is documented non-production, so
  // that is its steady state rather than an incident.
  //
  // The lane was deliberately NOT reordered by hand on 2026-08-14 morning — that
  // discards a genuinely fast model over one bad afternoon, and is the same
  // hand-edit a future stale measurement would prompt again. chain.js
  // circuit-breaks per (provider, model), which routes around a dead entry
  // within a call or two and restores it automatically when it recovers.
  //
  // REORDERED LATER THAT DAY ANYWAY, and the reason matters because it is NOT
  // "NIM had a bad afternoon":
  //
  //   1. A NEW HEAD WAS MEASURED. google:gemini-3.5-flash-lite answered a real
  //      320KB screenshot in 1473ms, correctly, three times running. (Measure
  //      vision with a REAL screenshot: an 8x8 test PNG returns "Unable to
  //      process input image" on Google and is a false negative — do not
  //      conclude a model is dead from one.) NIM's nemotron-nano-12b-v2-vl in
  //      the same 3-sample test took 7509/14965/13187ms, disagreed with itself,
  //      and hallucinated a Roman numeral that was not on screen.
  //   2. THE REORDER IS JUSTIFIED BY LOAD, NOT BY QUALITY. Google and Mistral
  //      scored equally well and read DIFFERENT parts of the same screen (Google
  //      took the nav chrome, Mistral took the column headers actually asked
  //      about). Google leads because Mistral's 4 req/min is shared with
  //      Hermes-Agent builds and with embeddings, and vision is one of the two
  //      frequent consumers. Keeping Mistral free for builds is the point. If a
  //      future session "fixes" this back on a quality argument, it will be
  //      re-fixing something that was never a quality decision.
  //   3. NIM STAYS, LAST, rather than being deleted. NVIDIA's free NIM tier is
  //      documented non-production, so slow/500 is its steady state and not an
  //      incident — but a deletion is not self-correcting and the breakers are.
  //
  // The per-attempt bound that produced the "4015ms/4002ms timeout" lines is
  // vision-call.js's DEFAULT_VISION_ATTEMPT_TIMEOUT_MS = 4000, i.e. that cap
  // firing — NOT proof the provider is dead. It stays at 4000: the new head
  // measures 1378-2293ms, comfortably inside it.
  // If you re-measure, put the DATE next to the number.
  { provider: 'google',  model: 'gemini-3.5-flash-lite' },               // 1473ms on a real 320KB screenshot, 3/3 correct (2026-08-14)
  // DEMOTED 2026-09-11: every call returns `429 Rate limit exceeded` on this
  // key. Tier-limited rather than dead — ministral and codestral answer fine on
  // the same key — so it is kept and moved down, not removed.
  { provider: 'mistral', model: 'mistral-small-latest' },                // 429 tier-limited 2026-09-11; 1.8-2.0s, 100% (2026-08-14)
  // REMOVED 2026-09-11: mistral/mistral-large-2512. Absent from the catalog and
  // a permanent `403 not available in your subscription tier`. THIS LANE is
  // where it did the damage: screen_look spends a 12s budget across three rungs,
  // and this one consumed ~1.2s of it on every single look while being incapable
  // of ever answering. BUG-440. See KNOWN_DEAD.
  //
  // NOT PROMOTED, deliberately: nim/meta/llama-3.2-11b-vision-instruct measured
  // 445ms on 2026-09-11 and is the fastest entry here — but that was a TEXT
  // prompt, and this lane's job is reading screenshots. The head below is the
  // only entry with a real image measurement behind it (1473ms on a 320KB
  // screenshot, 3/3 correct). Promoting on a text latency would be exactly the
  // "latency order is not capability order" mistake this file warns about.
  // SWAPPED with the NIM entry below, 2026-08-22. Not deleted, because a
  // non-response is not a 404 and this repo has already written off a working
  // model twice on an abort that was really a cold start. But it has now failed
  // to answer on two separate runs (60s abort each), on top of the HTTP 503
  // recorded on 2026-08-14, so it should not sit above a model that answers.
  { provider: 'nim',     model: 'meta/llama-3.2-11b-vision-instruct' },  // 1599ms; ALIVE 2026-08-22
  { provider: 'google',  model: 'gemini-flash-latest' },                 // 1715ms on 2026-07-29; HTTP 503 on 2026-08-14; no response x2 on 2026-08-22
  // Kept last-cloud and flagged rather than deleted, but this one is DEGRADING
  // rather than flapping, and the trend is the point: 386ms ~2026-07-29 →
  // 7.5-15s with hallucinated content 2026-08-14 → `500 EngineCore encountered
  // an issue` after 100s on 2026-08-22. If it is still 500ing next check, delete
  // it; three consecutive measurements in one direction is not noise.
  // REMOVED 2026-09-11: nim/nvidia/nemotron-nano-12b-v2-vl. Its 2026-08-22 note
  // read "500 after 100s"; the id is now absent from NVIDIA's catalog outright,
  // so the earlier 500 was the model going away rather than a transient. See
  // KNOWN_DEAD.
  { provider: 'ollama',  model: 'qwen3.5:latest' },
  { provider: 'ollama',  model: 'qwen2.5vl:7b' },
];

// embed lane — semantic-memory embeddings. NOTE: served by providers/
// embeddings.js (a different API shape than chat), not chain.js; these
// entries document the real chain order used there.
// Google's gemini-embedding-001 also works (verified 2026-07-29) but is
// 3072-dim against mistral-embed's 1024 — swapping it in would invalidate
// every stored vector in semantic memory. That is a migration, not a re-rank,
// so this table is deliberately unchanged.
//
// REVISITED 2026-09-11 and the caution above, while correct about dimensions,
// was answering the wrong question. It reads as though a second provider would
// corrupt the index; embeddings.js's own contract says the opposite — "vectors
// from different providers are NEVER comparable" and vector-index.js PARTITIONS
// BY PROVIDER. So an added provider gets its own partition and invalidates
// nothing. Two measurements settled it:
//   * gemini-embedding-001 accepts outputDimensionality and returned exactly
//     1024 dims in 521ms, so it need not be 3072 at all.
//   * ollama was uninstalled from this machine on 2026-09-11, which left
//     mistral-embed as the ONLY rung — while Mistral was returning 429 on four
//     other models on the same key. A one-rung embed chain is one rate limit
//     away from keyword-only recall.
// Google is added LAST in embeddings.js: it shares GOOGLE_API_KEY with the
// voice, vision, memory and text lanes, and memory writes must not be what
// exhausts the quota the operator hears.
const PREF_EMBED = [
  { provider: 'ollama',  model: 'nomic-embed-text' },
  { provider: 'mistral', model: 'mistral-embed' },        // 334ms, 1024 dims (2026-09-11)
  { provider: 'google',  model: 'gemini-embedding-001' }, // 521ms at outputDimensionality 1024 (2026-09-11)
];

// Every lane a caller may name MUST be registered here. registry.js's chainFor()
// falls back to BRAIN_TABLES.text for an unknown kind, so an unregistered name
// (or a typo — 'resoning') produces no error, just quietly worse answers from a
// lane nobody calls. test/brain-lane-registration.test.js asserts that every
// literal `lane:` string in src/ resolves to a key here.
const BRAIN_TABLES = {
  voice:     { prefs: PREF_VOICE,     env: 'CHAIN_VOICE' },
  build:     { prefs: PREF_BUILD,     env: 'CHAIN_BUILD' },
  simple:    { prefs: PREF_SIMPLE,    env: 'CHAIN_SIMPLE' },
  reasoning: { prefs: PREF_REASONING, env: 'CHAIN_REASONING' },
  memory:    { prefs: PREF_MEMORY,    env: 'CHAIN_MEMORY' },
  text:      { prefs: PREF_TEXT,      env: 'CHAIN_TEXT' },
  vision:    { prefs: PREF_VISION,    env: 'CHAIN_VISION' },
  embed:     { prefs: PREF_EMBED,     env: 'CHAIN_EMBED' },
};

// Models confirmed DEAD on these keys by a real call on 2026-08-14 — kept as
// data, not prose, so a test can assert no PREF_* table lists one. Prose alone
// is what let inclusionai/ling-3.0-flash:free sit in two lanes for three weeks
// after it started 404ing.
const KNOWN_DEAD = [
  { provider: 'cerebras', model: 'gemma-4-31b', reason: '404 measured 2026-09-09 — unavailable despite catalog listing' },
  { provider: 'openrouter', model: 'inclusionai/ling-3.0-flash:free', reason: '404 unavailable for free' },
  { provider: 'google',     model: 'gemini-2.5-pro',                  reason: '404 no longer available to new users' },
  { provider: 'google',     model: 'gemini-2.5-flash',                reason: '404 no longer available to new users' },
  { provider: 'google',     model: 'gemini-pro-latest',               reason: '429 free tier has zero Pro quota' },
  { provider: 'google',     model: 'gemini-3.1-pro-preview',          reason: '429 free tier has zero Pro quota' },
  { provider: 'mistral',    model: 'pixtral-large-latest',            reason: '404 absent from this account' },
  // KEPT, but the reason was wrong and the wrongness cost real time. This id
  // does not exist; the served one is `deepseek-ai/deepseek-v4-flash-0731`, and
  // THAT model is healthy — it answers, emits tool calls, and accepts a
  // 10.7k-token request. It was also written off a second time on 2026-08-22 by
  // a 45s abort that was a cold start; it needs ~100-150s on a first call. Do
  // not use this row as evidence that NVIDIA cannot serve DeepSeek.
  { provider: 'nim',        model: 'deepseek-ai/deepseek-v4-flash',   reason: '404 — WRONG ID, the real one is deepseek-v4-flash-0731 and it works' },
  // Added 2026-08-22, all three by a real call. The first two are the important
  // kind: Groq advertises 13 model ids and NOT ONE is a Llama of any version, so
  // these are absent rather than renamed and no id-guessing will recover them.
  { provider: 'groq',       model: 'llama-3.3-70b-versatile',         reason: '404 — Groq advertises no Llama 3.3 at all (was rank 4 of voice, rank 5 of build)' },
  { provider: 'groq',       model: 'llama-3.1-8b-instant',            reason: '404 — Groq advertises no Llama 3.1 at all (was the HEAD of simple)' },
  { provider: 'cerebras',   model: 'zai-glm-4.7',                     reason: '404 archived and unavailable for the organization (was rank 2 of reasoning, head of text)' },
  // Added 2026-09-11 by a live sweep that CALLED all 159 chat-capable models
  // advertised across the six configured keys. Every reason below is an HTTP
  // response, not a catalog absence — the two are different and this file has
  // already been burned by treating a listing as availability.
  { provider: 'mistral',    model: 'mistral-large-2512',              reason: '403 not available in your subscription tier, and absent from the catalog — permanent. Sat in BOTH build and vision, burning ~1.2s of screen_look\'s 12s budget per look. BUG-440' },
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct',      reason: '404 — absent from NVIDIA\'s 80-id catalog, not renamed (was in voice, build, simple and text; measured 271ms when it existed)' },
  { provider: 'nim',        model: 'nvidia/nemotron-nano-12b-v2-vl',  reason: '404 — absent from the catalog; the 2026-08-22 "500 after 100s" was it going away, not a transient' },
  { provider: 'google',     model: 'gemini-2.5-flash-lite',           reason: '404 no longer available to new users (measured 2026-09-11, same family as the 2.5-flash/2.5-pro removals above)' },
];

// Models that ANSWER but are too slow to be worth a rung, kept separate from
// KNOWN_DEAD because the distinction is load-bearing: a dead model can never
// return, a slow one returns the moment the provider adds capacity. Recorded as
// data so a future session does not "discover" them and promote one.
//
// All measured 2026-09-11. The 180s figures were re-run at that bound
// specifically because BUGS.md records deepseek-v4-flash being written off TWICE
// by a premature abort that was really a cold start.
const TOO_SLOW_NOT_DEAD = [
  { provider: 'nim',    model: 'moonshotai/kimi-k3',                 reason: 'no answer within 180s, twice' },
  { provider: 'nim',    model: 'deepseek-ai/deepseek-v4-pro-0813',   reason: 'no answer within 180s, twice (the -flash-0731 sibling answers in 6341ms and is healthy)' },
  { provider: 'nim',    model: 'meta/llama-3.2-90b-vision-instruct', reason: 'no answer within 180s, twice' },
  { provider: 'google', model: 'gemini-3.8-flash',                   reason: '503 "experiencing high demand" on 2 of 3 attempts; the one success took 38134ms. Newest Google flash and the most rationed' },
];

// gpt-oss-120b remains: its measured 402 is billing state. gemma's later 404
// supersedes the older unbilled diagnosis (2026-09-09), so it moved above.
const UNBILLED_NOT_DEAD = [
  { provider: 'cerebras', model: 'gpt-oss-120b', reason: '402 Payment required — unbilled account, not a dead model' },
];

module.exports = {
  BRAIN_TABLES, KNOWN_DEAD, UNBILLED_NOT_DEAD, TOO_SLOW_NOT_DEAD,
  // BUG-418: exported so a guard can derive "the free-tier head of this lane"
  // rather than typing the BYO provider names a second time (gate D).
  BYO_PREMIUM,
  PREF_VOICE, PREF_BUILD, PREF_SIMPLE, PREF_REASONING, PREF_MEMORY,
  PREF_TEXT, PREF_VISION, PREF_EMBED,
};
