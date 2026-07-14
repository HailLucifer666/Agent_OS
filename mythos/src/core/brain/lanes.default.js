// lanes.default.js — brain lane preference tables, ranked best-first.
// Re-verified 2026-07-10 with a real completion call per entry (not catalog
// listing alone — several BRAIN-MAP.md 2026-07-08 entries had already gone
// stale: nim:z-ai/glm-5.2 now hangs indefinitely, nim:deepseek-ai/deepseek-r1
// is gone from NIM's catalog, and two Nemotron variants list but 404 on this
// account). Every provider:model pair below answered a real "OK" within
// ~100ms-ish at verification time. No local model is required in any lane —
// each ends in an optional ollama entry that's simply filtered out of the
// alive-ranked list if Ollama isn't running (registry.js's probeOllama()
// already degrades to [] on connection failure).
// Each entry: { provider, model }. Provider 'nim' entries expanded by chain.js
// into one attempt per configured NIM key (key rotation).

const PREF_VOICE = [
  { provider: 'groq',       model: 'llama-3.3-70b-versatile' },
  { provider: 'mistral',    model: 'mistral-large-2512' },
  { provider: 'cerebras',   model: 'gemma-4-31b' },
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { provider: 'ollama',     model: 'qwen3:8b' },
];

const PREF_BUILD = [
  { provider: 'ollama',     model: 'hermes3:8b' },                                // P22: local, free, unlimited (ollama pull hermes3:8b to activate)
  { provider: 'mistral',    model: 'mistral-large-2512' },
  { provider: 'cerebras',   model: 'zai-glm-4.7' },
  { provider: 'cerebras',   model: 'gpt-oss-120b' },
  { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  { provider: 'openrouter', model: 'nousresearch/hermes-3-llama-3.1-405b:free' }, // P22: Hermes fallback
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },
  { provider: 'ollama',     model: 'ornith:9b' },
];

const PREF_SIMPLE = [
  { provider: 'mistral',    model: 'mistral-large-2512' },
  { provider: 'cerebras',   model: 'gemma-4-31b' },
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },
  { provider: 'openrouter', model: 'nousresearch/hermes-3-llama-3.1-405b:free' },
  { provider: 'ollama',     model: 'qwen3:8b' },
];

const PREF_TEXT = [
  { provider: 'nim',        model: 'meta/llama-3.1-8b-instruct' },
  { provider: 'cerebras',   model: 'gpt-oss-120b' },
  { provider: 'cerebras',   model: 'zai-glm-4.7' },
  { provider: 'openrouter', model: 'nousresearch/hermes-3-llama-3.1-405b:free' },
  { provider: 'ollama',     model: 'kimi-k2.5:cloud' },
  { provider: 'ollama',     model: 'qwen3:14b' },
  { provider: 'ollama',     model: 'qwen3:8b' },
];

const PREF_VISION = [
  { provider: 'mistral', model: 'mistral-large-2512' }, // natively multimodal — same model/key as text, no separate Pixtral needed
  { provider: 'nim',     model: 'meta/llama-3.2-11b-vision-instruct' },
  { provider: 'ollama',  model: 'qwen3.5:latest' },
  { provider: 'ollama',  model: 'qwen2.5vl:7b' },
];

// embed lane — semantic-memory embeddings. NOTE: served by providers/
// embeddings.js (a different API shape than chat), not chain.js; these
// entries document the real chain order used there.
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
