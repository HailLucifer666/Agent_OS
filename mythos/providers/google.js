// google.js — Google Gemini provider via its OpenAI-compatible endpoint.
// Verified live 2026-07-29: the /v1beta/openai base speaks the same SSE protocol
// as NIM/Cerebras (text/event-stream, deltas in choices[0].delta.content,
// terminating in `data: [DONE]`), accepts OpenAI-shaped multimodal content for
// vision, and does NOT require max_tokens — so the existing openai-compat
// factory covers it with no new transport code.
//
// Two account-shape gotchas worth knowing before changing the default model:
//   - Free keys have NO Pro-tier quota: gemini-2.5-pro / gemini-pro-latest /
//     gemini-3.1-pro-preview all return 429. Only Flash-tier models answer.
//   - The catalog endpoint returns ids prefixed `models/` while chat calls take
//     the bare id; registry.js strips that prefix when probing.
// Docs: https://ai.google.dev/gemini-api/docs/openai
const { createOpenAICompatProvider } = require('./openai-compat');

const provider = createOpenAICompatProvider({
  name: 'google',
  baseURL: process.env.GOOGLE_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKeyEnv: 'GOOGLE_API_KEY',
  defaultModelEnv: 'GOOGLE_MODEL',
  defaultModel: 'gemini-flash-lite-latest',
});

module.exports = provider;
