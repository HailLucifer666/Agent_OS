// groq.js — Groq LPU provider (OpenAI-compatible).
// Free tier: ~30 RPM, ~14,400 RPD on Llama 3.3 70B. No card. Fastest LPU inference.
// Docs: https://console.groq.com/docs/openai
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'groq',
  baseURL: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1',
  apiKeyEnv: 'GROQ_API_KEY',
  defaultModelEnv: 'GROQ_MODEL',
  defaultModel: 'llama-3.3-70b-versatile',
});

module.exports = provider;
