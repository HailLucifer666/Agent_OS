// cerebras.js — Cerebras inference provider (OpenAI-compatible).
// Free tier: ~1M tokens/day, 8192-token context cap. No card. Fastest inference (~2600 tok/s).
// Docs: https://inference-docs.cerebras.ai/resources/openai
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'cerebras',
  baseURL: process.env.CEREBRAS_API_URL || 'https://api.cerebras.ai/v1',
  apiKeyEnv: 'CEREBRAS_API_KEY',
  defaultModelEnv: 'CEREBRAS_MODEL',
  defaultModel: 'llama3.1-8b',
});

module.exports = provider;
