// lanes.default.js — brain lane preference tables, ranked best-first.
// Source: BRAIN-MAP.md (locked 2026-07-08).
// Each entry: { provider, model }. Provider 'nim' entries expanded by chain.js
// into one attempt per configured NIM key (key rotation).

const PREF_VOICE = [
  { provider: 'groq',   model: 'llama-3.3-70b-versatile' },
  { provider: 'mistral', model: 'mistral-large-2512' },
  { provider: 'ollama',  model: 'qwen3:8b' },
];

const PREF_BUILD = [
  { provider: 'mistral', model: 'mistral-large-2512' },
  { provider: 'zcode',   model: 'glm-5.2' },
  { provider: 'ollama',  model: 'ornith:9b' },
];

const PREF_SIMPLE = [
  { provider: 'ollama', model: 'qwen3:8b' },
];

const PREF_TEXT = [
  { provider: 'nim', model: 'deepseek-ai/deepseek-r1' },
  { provider: 'nim', model: 'meta/llama-3.1-405b-instruct' },
  { provider: 'ollama', model: 'kimi-k2.5:cloud' },
  { provider: 'ollama', model: 'qwen3:14b' },
  { provider: 'ollama', model: 'qwen3:8b' },
];

const PREF_VISION = [
  { provider: 'ollama', model: 'qwen3.5:latest' },
  { provider: 'ollama', model: 'qwen2.5vl:7b' },
];

// embed lane — placeholder, always returns empty chain
const PREF_EMBED = [];

const BRAIN_TABLES = {
  voice:   { prefs: PREF_VOICE,  env: 'CHAIN_VOICE' },
  build:   { prefs: PREF_BUILD,  env: 'CHAIN_BUILD' },
  simple:  { prefs: PREF_SIMPLE, env: 'CHAIN_SIMPLE' },
  text:    { prefs: PREF_TEXT,   env: 'CHAIN_TEXT' },
  vision:  { prefs: PREF_VISION, env: 'CHAIN_VISION' },
  embed:   { prefs: PREF_EMBED,  env: 'CHAIN_EMBED' },
};

module.exports = { BRAIN_TABLES, PREF_VOICE, PREF_BUILD, PREF_SIMPLE, PREF_TEXT, PREF_VISION, PREF_EMBED };
