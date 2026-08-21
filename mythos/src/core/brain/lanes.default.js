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

const PREF_VOICE = [
  // gemini-flash-lite was already documented here as "slower than the 8B but far
  // better at this lane's actual job: persona-heavy JSON tool-calling against a
  // ~40k-char prompt". The 2026-08-14 run turned that argument into a
  // measurement and promoted it to the head: 4/4 at 961-1030ms and the ONLY
  // model in the whole run with zero disqualifier flags — no chain-of-thought
  // leaking into `content` (which this lane would SPEAK ALOUD) and no
  // array-shaped content. Latency order is not capability order; only
  // demote/promote entries with a real completion call behind the claim.
  { provider: 'google',   model: 'gemini-flash-lite-latest' },    // 961-1030ms, 4/4, no flags (2026-08-14)
  { provider: 'mistral',  model: 'mistral-medium-latest' },       // 783ms, 4/4 (2026-08-14); 414ms measured 2026-07-29
  { provider: 'nim',      model: 'meta/llama-3.1-8b-instruct' },  // 271ms — fast but flat; last cloud resort
  // DEMOTED 2026-08-22 from rank 3 to last cloud, NOT deleted. `402 Payment
  // required` — the Cerebras account is unbilled, so this is a billing state and
  // not a dead model: it returns the moment the account is funded, and its
  // 336ms/3-of-4 measurement below still stands. Kept last so a lane call stops
  // paying an attempt for it while the account is dry.
  { provider: 'cerebras', model: 'gemma-4-31b' },                 // 336ms, 3/4 (2026-08-14); 402 unbilled 2026-08-22
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
  { provider: 'nim',      model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },   // 4123ms, 4/4 — different provider, absorbs a Cerebras burst
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
  { provider: 'google',   model: 'gemini-3-flash-preview' },      // 3090ms, 4/4 — its own per-model quota bucket
  { provider: 'mistral',  model: 'mistral-medium-2604' },         // 461ms, 4/4
  // Unchanged position — it was already last cloud. Noting only that it is
  // currently `402` (unbilled Cerebras account), so this lane is effectively
  // two-deep in the cloud until the account is funded.
  { provider: 'cerebras', model: 'gemma-4-31b' },                 // 336ms, 3/4; 402 unbilled 2026-08-22
  { provider: 'ollama',   model: 'qwen3:8b' },
];

const PREF_BUILD = [
  // Cloud-first (P22): this lane once led with ollama/hermes3:8b, which was never
  // `ollama pull`ed — silently filtered out, so every build fell through anyway.
  // Optional local models sit last so their absence never costs a build attempt.
  //
  // NOTE: since 2026-07-29 Hermes-Agent is the only build-CONTENT engine (see
  // CLAUDE.md / build-engine.js), so this lane no longer carries real build
  // traffic — it serves whatever still requests brain lane 'build'.
  { provider: 'mistral',    model: 'codestral-latest' },                     // 344ms — code-specialist AND faster than -large
  // mistral-medium-2604 inserted ABOVE -large on 2026-08-14: 4/4 vs 3/4 (-large
  // missed a reasoning probe) and 461ms vs 701ms. Same key, same lane, strictly
  // better on both axes measured — the previous ranking predates this model.
  { provider: 'mistral',    model: 'mistral-medium-2604' },                  // 461ms, 4/4
  { provider: 'mistral',    model: 'mistral-large-2512' },                   // 701ms, 3/4 — generalist fallback
  // openrouter:inclusionai/ling-3.0-flash:free DELETED 2026-08-14 — 404
  // "unavailable for free". See this file's header note 1.
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },           // 271ms
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
  { provider: 'mistral',  model: 'ministral-3b-latest' },         // 315ms
  { provider: 'nim',      model: 'meta/llama-3.1-8b-instruct' },  // 271ms
  { provider: 'google',   model: 'gemini-flash-lite-latest' },    // 643ms
  // Demoted below Google, not deleted: 402 unbilled, returns when funded.
  { provider: 'cerebras', model: 'gemma-4-31b' },                 // 519ms; 402 unbilled 2026-08-22
  { provider: 'ollama',   model: 'qwen3:8b' },
];

// text lane — long documents. NOTE (2026-08-14): this lane has NO caller in
// src/. It survives as registry.js's fallback table for an unrecognised lane
// name, which is exactly why the two dead entries below had to go: a typo used
// to route silently into a chain whose first two entries were a 404 and a
// 27.9-second model. registry.js now emits health.anomaly on that path as well,
// so the substitution is audible rather than merely slower.
const PREF_TEXT = [
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
  { provider: 'google',     model: 'gemini-3.6-flash' },                     // 4975ms, 4/4 on 2026-08-14 (1382ms on 2026-07-29) — see note below
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },           // 271ms
  { provider: 'cerebras',   model: 'gpt-oss-120b' },                         // 778ms, 4/4; 402 unbilled 2026-08-22
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
  { provider: 'mistral', model: 'mistral-small-latest' },                // 433ms measured ~2026-07-29; 1.8-2.0s and 100% success on 2026-08-14
  { provider: 'mistral', model: 'mistral-large-2512' },                  // 771ms — natively multimodal, same key as text
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
  { provider: 'nim',     model: 'nvidia/nemotron-nano-12b-v2-vl' },      // 500 after 100s (2026-08-22)
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
const PREF_EMBED = [
  { provider: 'ollama',  model: 'nomic-embed-text' },
  { provider: 'mistral', model: 'mistral-embed' },
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
];

// NOT in KNOWN_DEAD on purpose, because they are not dead: every `cerebras/*`
// entry currently returns `402 Payment required` because that ACCOUNT is
// unbilled, and Cerebras advertises only `gpt-oss-120b` and `gemma-4-31b` at
// all. Billing the account restores both. They were demoted to last-cloud in
// their lanes on 2026-08-22 rather than deleted, so a dry account costs one
// attempt at the end of a walk instead of two at the start — and funding it
// needs no code change. A test asserting no PREF_* lists a KNOWN_DEAD entry
// would delete them permanently, which is the wrong call for a billing state.
const UNBILLED_NOT_DEAD = [
  { provider: 'cerebras', model: 'gpt-oss-120b', reason: '402 Payment required — unbilled account, not a dead model' },
  { provider: 'cerebras', model: 'gemma-4-31b',  reason: '402 Payment required — unbilled account, not a dead model' },
];

module.exports = {
  BRAIN_TABLES, KNOWN_DEAD, UNBILLED_NOT_DEAD,
  PREF_VOICE, PREF_BUILD, PREF_SIMPLE, PREF_REASONING, PREF_MEMORY,
  PREF_TEXT, PREF_VISION, PREF_EMBED,
};
