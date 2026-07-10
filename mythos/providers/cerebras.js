// cerebras.js — Cerebras Cloud provider (OpenAI-compatible).
// Free tier: 5 RPM / 150 RPH / 2,400 RPD, 30K TPM / 1M TPH / 1M TPD, shared
// across all models on one key. Fastest completions of any wired provider
// (sub-100ms observed on gemma-4-31b/gpt-oss-120b/zai-glm-4.7).
// Docs: https://inference-docs.cerebras.ai/
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'cerebras',
  baseURL: process.env.CEREBRAS_API_URL || 'https://api.cerebras.ai/v1',
  apiKeyEnv: 'CEREBRAS_API_KEY',
  defaultModelEnv: 'CEREBRAS_MODEL',
  defaultModel: 'gemma-4-31b',
});

module.exports = provider;
