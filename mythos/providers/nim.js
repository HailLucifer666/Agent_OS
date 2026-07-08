// nim.js — NVIDIA NIM provider (OpenAI-compatible).
// Docs: https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html
// Base URL ends at /v1. NIM requires max_tokens on many models, so alwaysMaxTokens is on.
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'nim',
  baseURL: process.env.NIM_API_URL || 'https://integrate.api.nvidia.com/v1',
  apiKeyEnv: 'NIM_API_KEY',
  defaultModelEnv: 'NIM_MODEL',
  defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
  alwaysMaxTokens: true,
});

module.exports = provider;
