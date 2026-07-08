// mistral.js — Mistral La Plateforme provider (OpenAI-compatible).
// Free "Experiment" mode: ~1 req/sec, perpetual. Owns its model family (non-Llama).
// Docs: https://docs.mistral.ai/
// Note: mistral-tiny is deprecated — default is mistral-small-latest.
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'mistral',
  baseURL: process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1',
  apiKeyEnv: 'MISTRAL_API_KEY',
  defaultModelEnv: 'MISTRAL_MODEL',
  defaultModel: 'mistral-small-latest',
});

module.exports = provider;
