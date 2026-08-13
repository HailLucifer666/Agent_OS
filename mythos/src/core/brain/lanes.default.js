// lanes.default.js — brain lane preference tables, ranked best-first.
// Re-verified 2026-07-29 with a real completion call per entry (never catalog
// listing alone — listings lie: several models list fine and then 404, 429 or
// hang). Latencies in the comments below are measured, not estimated.
//
// Three things the previous revision got wrong, all fixed here:
//   1. Every lane ended in an OpenRouter `:free` slug that no longer exists
//      (`qwen/qwen3-coder:free`, `nousresearch/hermes-3-llama-3.1-405b:free`,
//      `meta-llama/llama-3.3-70b-instruct:free` all 404 with "unavailable for
//      free — use this slug instead"). registry.js counted them alive on key
//      presence alone, so each one burned a real chain attempt. The account's
//      guardrail allowlist now permits exactly one model, and it earns its place:
//      inclusionai/ling-3.0-flash:free has a 262K context (217,840 prompt tokens
//      verified with correct needle recall) — the largest of any wired provider.
//   2. `nim:` entries were silently vanishing because NIM_API_KEY was unset,
//      which left the vision lane one model deep with NO fallback at all.
//   3. The old header claimed nim:z-ai/glm-5.2 "hangs indefinitely". It does not
//      hang — it completes, at 177-185s. That distinction matters: it is
//      queue-starvation on NVIDIA's free tier, not a broken endpoint.
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
  { provider: 'groq',     model: 'llama-3.3-70b-versatile' },     // 656ms — fastest good 70B (Groq LPU)
  { provider: 'mistral',  model: 'mistral-medium-latest' },       // 414ms — 2x faster than -large for the same job
  { provider: 'cerebras', model: 'gemma-4-31b' },                 // 519ms
  // gemini-flash-lite is slower than the 8B below but far better at this lane's
  // actual job: persona-heavy JSON tool-calling against a ~40k-char prompt.
  // The 8B sat at position 4, so whenever the top three were rate-limited (the
  // shared-Mistral-key case) the operator heard the flattest model in the table
  // — exactly when personality matters most for trust. Latency order is not
  // capability order; only demote/promote entries with a real completion call
  // behind the claim (see this file's header discipline).
  { provider: 'google',   model: 'gemini-flash-lite-latest' },    // 643ms
  { provider: 'nim',      model: 'meta/llama-3.1-8b-instruct' },  // 271ms — fast but flat; last cloud resort
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
  { provider: 'mistral',    model: 'mistral-large-2512' },                   // 771ms — generalist fallback
  { provider: 'cerebras',   model: 'gpt-oss-120b' },                         // 371ms
  { provider: 'groq',       model: 'llama-3.3-70b-versatile' },              // 656ms
  { provider: 'cerebras',   model: 'zai-glm-4.7' },                          // 1267ms
  { provider: 'openrouter', model: 'inclusionai/ling-3.0-flash:free' },      // 853ms, 262K ctx — for builds with large context
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },           // 271ms
  { provider: 'ollama',     model: 'hermes3:8b' },                           // local, free, unlimited (ollama pull to activate; filtered if absent)
  { provider: 'ollama',     model: 'ornith:9b' },
];

const PREF_SIMPLE = [
  // Cheapest/fastest lane. Previously led with mistral-large-2512 — the most
  // expensive model available, in the lane that least needs it.
  { provider: 'groq',     model: 'llama-3.1-8b-instant' },        // 224ms — fastest measured anywhere
  { provider: 'mistral',  model: 'ministral-3b-latest' },         // 315ms
  { provider: 'nim',      model: 'meta/llama-3.1-8b-instruct' },  // 271ms
  { provider: 'cerebras', model: 'gemma-4-31b' },                 // 519ms
  { provider: 'google',   model: 'gemini-flash-lite-latest' },    // 643ms
  { provider: 'ollama',   model: 'qwen3:8b' },
];

const PREF_TEXT = [
  { provider: 'cerebras',   model: 'zai-glm-4.7' },                          // 1267ms — best Cerebras quality
  { provider: 'openrouter', model: 'inclusionai/ling-3.0-flash:free' },      // 853ms, 262K ctx — long-document workhorse
  { provider: 'nim',        model: 'nvidia/nemotron-3-super-120b-a12b' },    // 1225ms — large model that is genuinely fast
  { provider: 'cerebras',   model: 'gpt-oss-120b' },                         // 371ms
  { provider: 'google',     model: 'gemini-3.6-flash' },                     // 1382ms — newest Flash available on a free key
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },           // 271ms
  { provider: 'ollama',     model: 'kimi-k2.5:cloud' },
  { provider: 'ollama',     model: 'qwen3:14b' },
  { provider: 'ollama',     model: 'qwen3:8b' },
];

const PREF_VISION = [
  // Was ONE entry deep in practice (mistral-large-2512 alone, no fallback),
  // because both nim: entries were filtered out by the missing NIM_API_KEY.
  // Every model below correctly identified a generated test image.
  { provider: 'nim',     model: 'nvidia/nemotron-nano-12b-v2-vl' },      // 386ms — fastest vision measured
  { provider: 'mistral', model: 'mistral-small-latest' },                // 433ms — cheap and correct
  { provider: 'mistral', model: 'mistral-large-2512' },                  // 771ms — natively multimodal, same key as text
  { provider: 'nim',     model: 'meta/llama-3.2-11b-vision-instruct' },  // 1599ms
  { provider: 'google',  model: 'gemini-flash-latest' },                 // 1715ms
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

const BRAIN_TABLES = {
  voice:   { prefs: PREF_VOICE,  env: 'CHAIN_VOICE' },
  build:   { prefs: PREF_BUILD,  env: 'CHAIN_BUILD' },
  simple:  { prefs: PREF_SIMPLE, env: 'CHAIN_SIMPLE' },
  text:    { prefs: PREF_TEXT,   env: 'CHAIN_TEXT' },
  vision:  { prefs: PREF_VISION, env: 'CHAIN_VISION' },
  embed:   { prefs: PREF_EMBED,  env: 'CHAIN_EMBED' },
};

module.exports = { BRAIN_TABLES, PREF_VOICE, PREF_BUILD, PREF_SIMPLE, PREF_TEXT, PREF_VISION, PREF_EMBED };
