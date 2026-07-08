// zcode.js — Z.AI / ZCode provider (OpenAI-compatible).
// Docs: https://docs.z.ai/api-reference/llm/chat-completion
// Base URL ends at /v4 — do NOT let callers append /v1.
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'zcode',
  baseURL: process.env.ZCODE_API_URL || 'https://api.z.ai/api/paas/v4',
  apiKeyEnv: 'ZCODE_API_KEY',
  defaultModelEnv: 'ZCODE_MODEL',
  defaultModel: 'glm-4.6',
});

module.exports = provider;
