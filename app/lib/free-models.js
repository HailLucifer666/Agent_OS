// free-models.js — single source of truth for the free-provider fleet.
// Each entry describes one provider that ships with Agentic OS. Downstream consumers
// (probes, sidebar, mission control, mastermind seats, orchestrator resolver) read
// from FREE_PROVIDERS so adding/removing a provider = one edit here + its wrapper file.
//
// Fields:
//   id          — stable identifier (matches provider module's `name`, used as the
//                 WS `agent` field, sidebar route, and status-tile key)
//   label       — display name
//   kind        — 'openai-compat' (HTTP) or 'ollama' (local) or 'claude-cli' (binary)
//   provider    — the required provider module (lazy getter via function to avoid
//                 load-order issues with env vars)
//   apiKeyEnv   — env var checked for "is this configured?" (null for local providers)
//   accentVar   — CSS custom property for the sidebar dot / tile tint
//   freeTier    — human-readable description of the free quota (shown in detail strings)
//   trial       — true if the "free" tier is actually a finite credit grant (honest labeling)
//   notes       — short pitch for tooltips / route subtitles
//
// Providers whose APIs are OpenAI-compatible reuse the openai-compat.js factory;
// `provider` is just the wrapper module that constructed them.

const groq = require('./providers/groq');
const cerebras = require('./providers/cerebras');
const mistral = require('./providers/mistral');
const cloudflare = require('./providers/cloudflare');
const openrouterFree = require('./providers/openrouter-free');
const zcode = require('./providers/zcode');
const nim = require('./providers/nim');

const FREE_PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compat',
    provider: groq,
    apiKeyEnv: 'GROQ_API_KEY',
    accentVar: '#f55036',        // Groq brand red-orange
    freeTier: '~30 RPM · ~14,400 req/day · Llama 3.3 70B',
    trial: false,
    notes: 'Fastest LPU inference. Llama 3.3 70B, Llama 4 Scout, Gemma 2.',
  },
  {
    id: 'openrouter-free',
    label: 'OpenRouter Free',
    kind: 'openai-compat',
    provider: openrouterFree,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    accentVar: '#8b5cf6',        // purple
    freeTier: '~50 req/day default (1000/day with $10 top-up) · :free models',
    trial: false,
    notes: 'One key, dozens of $0 models. auto-router picks a free model for you.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai-compat',
    provider: cerebras,
    apiKeyEnv: 'CEREBRAS_API_KEY',
    accentVar: '#e45550',        // Cerebras red
    freeTier: '~1M tokens/day · 8K context cap',
    trial: false,
    notes: 'Fastest inference available (~2600 tok/s). Llama 3.1 8B, Llama 4 Scout.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai-compat',
    provider: mistral,
    apiKeyEnv: 'MISTRAL_API_KEY',
    accentVar: '#ff7000',        // Mistral orange
    freeTier: '~1 req/sec · Experiment mode',
    trial: false,
    notes: 'Non-Llama family. Mistral Small, Nemo, Codestral.',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare AI',
    kind: 'openai-compat',
    provider: cloudflare,
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    accentVar: '#f38020',        // Cloudflare orange
    freeTier: '10,000 Neurons/day · resets 00:00 UTC',
    trial: false,
    notes: 'Global edge. Llama 3.3 70B fp8. Needs account ID + API token.',
  },
  {
    id: 'zcode',
    label: 'ZCode',
    kind: 'openai-compat',
    provider: zcode,
    apiKeyEnv: 'ZCODE_API_KEY',
    accentVar: '#2dd4bf',
    freeTier: 'Z.AI GLM coding plan',
    trial: false,
    notes: 'Z.AI GLM-4.6. Coding, reasoning, planning.',
  },
  {
    id: 'nim',
    label: 'NIM',
    kind: 'openai-compat',
    provider: nim,
    apiKeyEnv: 'NIM_API_KEY',
    accentVar: '#76b900',        // NVIDIA green
    freeTier: '~1,000 credits on signup · 40 RPM',
    trial: true,                 // finite credits, not perpetual
    notes: 'NVIDIA NIM. Llama / Nemotron / DeepSeek-R1. TRIAL — credits are finite.',
  },
];

// Lookup helpers consumed by server.js / probes.js
function findById(id) {
  return FREE_PROVIDERS.find((p) => p.id === id) || null;
}

function availableProviders() {
  return FREE_PROVIDERS.filter((p) => p.provider && typeof p.provider.isAvailable === 'function' && p.provider.isAvailable());
}

module.exports = { FREE_PROVIDERS, findById, availableProviders };
